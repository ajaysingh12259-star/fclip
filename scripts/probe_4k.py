#!/usr/bin/env python3
"""
fclip 4K source probe — reverse-engineers anonymous download APIs and verifies
REAL 2160p capability by pulling head bytes and ffprobe-ing dimensions.

Test video: aqz-KE-bpKQ (Big Buck Bunny 60fps 4K, CC-BY, 10:34) — canonical 4K.
Verification: curl head-chunk (≤8MB / 10s cap) → ffprobe width/height == 3840x2160.
"""
import json
import subprocess
import concurrent.futures as cf
import os
import re
import time

TEST_VIDEO = "aqz-KE-bpKQ"
TEST_URL = f"https://www.youtube.com/watch?v={TEST_VIDEO}"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
OUT = "/tmp/probe_results.json"

def sh(args, timeout=30, data=None):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           input=data)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"

def head_probe(url, tag, max_mb=8, max_s=10):
    """Range-fetch head bytes; ffprobe dimensions. Returns (w,h,note)."""
    part = f"/tmp/head_{tag}.bin"
    if os.path.exists(part):
        os.remove(part)
    code, out, err = sh(["curl", "-sS", "-L", "--max-time", str(max_s),
                         "-H", f"Range: bytes=0-{max_mb*1024*1024-1}",
                         "-H", f"User-Agent: {UA}", "-o", part, "-w", "%{http_code}",
                         url], timeout=max_s + 8)
    if not os.path.exists(part) or os.path.getsize(part) < 50_000:
        return (0, 0, f"head-fetch failed (http={out.strip()}, size={os.path.getsize(part) if os.path.exists(part) else 0})")
    code2, out2, err2 = sh(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height,codec_name",
                            "-of", "json", part], timeout=20)
    m = re.search(r'"width":\s*(\d+)', out2)
    h = re.search(r'"height":\s*(\d+)', out2)
    c = re.search(r'"codec_name":\s*"(\w+)"', out2)
    if m and h:
        return (int(m.group(1)), int(h.group(1)), f"codec={c.group(1) if c else '?'} size={os.path.getsize(part)//1024}KB")
    return (0, 0, f"ffprobe unreadable (partial={os.path.getsize(part)//1024}KB)")

# ---------------------------------------------------------------- phase 1: cobalt hosts
COBALT_HOSTS = [
    "dwnld.nichind.dev",          # known 4K from 2026-11-10 measurement
    "co.otomir23.me",             # known 1080p cap
    "api.cobalt.canine.su",
    "cobalt-backend.canine.su",
    "co.eepy.today",
    "cobalt-api.ayo.tf",
    "nyc1.coapi.ggtyler.dev",
    "cobalt.255x.ru",
    "api.cobalt.tools",
    "cobalt-api.kwiatekmiki.com",
    "co.fortheuser.xyz",
    "cobalt-backend.255x.ru",
    "y.coapi.ggtyler.dev",
    "cobalt.q444.eu.org",
    "api.c0b4lt.ru",
]

def probe_cobalt(host):
    body = json.dumps({"url": TEST_URL, "videoQuality": "2160",
                       "youtubeVideoCodec": "vp9", "downloadMode": "auto"})
    code, out, err = sh(["curl", "-sS", "--max-time", "20", "-X", "POST",
                         f"https://{host}/",
                         "-H", "Accept: application/json",
                         "-H", "Content-Type: application/json",
                         "-H", f"User-Agent: {UA}",
                         "--data", body], timeout=25)
    rec = {"host": host, "http": None, "status": None, "url": None, "w": 0, "h": 0, "note": ""}
    try:
        j = json.loads(out)
        rec["http"] = 200 if "status" in j else code
        rec["status"] = j.get("status")
        rec["url"] = j.get("url")
        rec["note"] = (j.get("error", {}) or {}).get("code", "") if isinstance(j.get("error"), dict) else str(j.get("text", ""))[:60]
    except Exception:
        rec["note"] = f"non-JSON ({out[:60]!r})"
    if rec["url"]:
        w, h, note = head_probe(rec["url"], f"cob_{host.replace('.', '_')}")
        rec["w"], rec["h"], rec["note"] = w, h, f"{note} tunnel-host={rec['url'].split('/')[2] if '/' in rec['url'] else '?'}"
    return rec

# ---------------------------------------------------------------- phase 2: loader.to render API
def probe_loader_to():
    recs = []
    # Known ajax entrypoints of the loader.to / 1conv / bpmgeeks family
    for base in ["https://loader.to/ajax/download.php",
                 "https://1conv.com/ajax/download.php"]:
        qs = f"?format=2160&url={TEST_URL}"
        code, out, err = sh(["curl", "-sS", "--max-time", "20",
                             f"{base}{qs}", "-H", f"User-Agent: {UA}",
                             "-H", "Referer: https://loader.to/"], timeout=25)
        rec = {"ep": base, "raw": out[:300], "id": None, "progress_host": None,
               "download_url": None, "w": 0, "h": 0, "note": ""}
        try:
            j = json.loads(out)
            rec["id"] = j.get("id") or j.get("success")
            rec["note"] = f"keys={list(j.keys())}"
        except Exception:
            pass
        recs.append(rec)
        # if we got a job id, poll progress on both known hosts
        if rec["id"] and isinstance(rec["id"], str):
            for ph in ["https://p.oceansaver.in/ajax/progress.php",
                       "https://loader.to/ajax/download-progress.php"]:
                ok = False
                for _ in range(20):
                    code, out, err = sh(["curl", "-sS", "--max-time", "15",
                                         f"{ph}?id={rec['id']}",
                                         "-H", f"User-Agent: {UA}",
                                         "-H", "Referer: https://loader.to/"], timeout=18)
                    try:
                        pj = json.loads(out)
                    except Exception:
                        break
                    if pj.get("download_url"):
                        rec["download_url"] = pj["download_url"]
                        rec["progress_host"] = ph
                        w, h, note = head_probe(pj["download_url"], "loader")
                        rec["w"], rec["h"], rec["note"] = w, h, note
                        ok = True
                        break
                    if pj.get("progress") in (1000, 100) and not pj.get("download_url"):
                        time.sleep(2)
                        continue
                    time.sleep(6)
                if ok:
                    break
    return recs

# ---------------------------------------------------------------- phase 3: invidious/piped 2160p
INVIDIOUS = ["inv.nadeko.net", "yewtu.be", "invidious.nerdvpn.de", "iv.duti.dev",
             "invidious.f5.si", "invidious.jing.rocks", "invidious.materialio.us",
             "yt.chocolatemoo53.com"]
PIPED = ["api.piped.private.coffee", "pipedapi.kavin.rocks", "pipedapi.adminforge.de",
         "pipedapi.ducks.party", "pipedapi.drgns.space", "papi.victr.me",
         "pipedapi.reallyaweso.me", "piped-api.lunar.icu"]

def probe_invidious(host):
    code, out, err = sh(["curl", "-sS", "--max-time", "15",
                         f"https://{host}/api/v1/videos/{TEST_VIDEO}?local=true",
                         "-H", f"User-Agent: {UA}"], timeout=18)
    try:
        j = json.loads(out)
    except Exception:
        return {"host": host, "note": f"dead/timeout", "w": 0, "h": 0}
    fmts = j.get("adaptiveFormats") or []
    v4k = [f for f in fmts if f.get("resolution", "").startswith("2160p") or f.get("qualityLabel") == "2160p"]
    best = v4k[0] if v4k else None
    if not best or not best.get("url"):
        hts = sorted({f.get("qualityLabel") or f.get("resolution") or "?" for f in fmts}, key=lambda x: -len(x))[:4]
        return {"host": host, "note": f"no 2160p (has: {hts})", "w": 0, "h": 0}
    u = best["url"]
    proxied = "googlevideo.com" not in u.split("/")[2] if "/" in u else False
    if not proxied:
        # force local proxy: replace googlevideo host with instance's local companion
        u2 = f"https://{host}/latest_version?id={TEST_VIDEO}&itag={best.get('itag','')}&local=true"
        w, h, note = head_probe(u2, f"inv_{host.replace('.', '_')}")
        return {"host": host, "note": f"2160p advertised, proxied-probe: {note}", "w": w, "h": h}
    w, h, note = head_probe(u, f"inv_{host.replace('.', '_')}")
    return {"host": host, "note": f"2160p proxied: {note}", "w": w, "h": h}

def probe_piped(host):
    code, out, err = sh(["curl", "-sS", "--max-time", "15",
                         f"https://{host}/streams/{TEST_VIDEO}",
                         "-H", f"User-Agent: {UA}"], timeout=18)
    try:
        j = json.loads(out)
    except Exception:
        return {"host": host, "note": "dead/timeout", "w": 0, "h": 0}
    vs = j.get("videoStreams") or []
    v4k = [s for s in vs if s.get("videoOnly") and (s.get("quality") in (2160, "2160", "2160p"))]
    if not v4k or not v4k[0].get("url"):
        hts = sorted({str(s.get("quality")) for s in vs if s.get("videoOnly")}, key=lambda x: -len(x))[:4]
        return {"host": host, "note": f"no 2160p (has: {hts})", "w": 0, "h": 0}
    u = v4k[0]["url"]
    proxied = "googlevideo.com" not in (u.split("/")[2] if "/" in u else "")
    if not proxied:
        return {"host": host, "note": "2160p direct googlevideo (IP-locked)", "w": 0, "h": 0}
    w, h, note = head_probe(u, f"piped_{host.replace('.', '_')}")
    return {"host": host, "note": f"2160p pipedproxy: {note}", "w": w, "h": h}

def main():
    results = {"cobalt": [], "loader": [], "invidious": [], "piped": []}
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(probe_cobalt, h): ("cobalt", h) for h in COBALT_HOSTS}
        futs.update({ex.submit(probe_invidious, h): ("invidious", h) for h in INVIDIOUS})
        futs.update({ex.submit(probe_piped, h): ("piped", h) for h in PIPED})
        for f in cf.as_completed(futs):
            kind, h = futs[f]
            try:
                results[kind].append(f.result())
            except Exception as e:
                results[kind].append({"host": h, "note": f"EXC {e}", "w": 0, "h": 0})
    results["loader"] = probe_loader_to()
    with open(OUT, "w") as fh:
        json.dump(results, fh, indent=1)
    print(json.dumps(results, indent=1))

if __name__ == "__main__":
    main()
