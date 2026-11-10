#!/usr/bin/env python3
"""Round 2: oceansaver/ddownr 4K render API + loader.to format discovery + nichind retry."""
import json, os, re, subprocess, time, sys

TEST_VIDEO = "aqz-KE-bpKQ"
TEST_URL = f"https://www.youtube.com/watch?v={TEST_VIDEO}"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def sh(args, timeout=30):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"

def head_probe(url, tag, max_mb=8, max_s=10):
    part = f"/tmp/head_{tag}.bin"
    if os.path.exists(part): os.remove(part)
    code, out, err = sh(["curl", "-sS", "-L", "--max-time", str(max_s),
                         "-H", f"Range: bytes=0-{max_mb*1024*1024-1}",
                         "-H", f"User-Agent: {UA}", "-o", part, url], timeout=max_s+8)
    if not os.path.exists(part) or os.path.getsize(part) < 50_000:
        return (0, 0, f"head-fetch failed ({os.path.getsize(part) if os.path.exists(part) else 0}B)")
    code2, out2, _ = sh(["ffprobe", "-v", "error", "-select_streams", "v:0",
                         "-show_entries", "stream=width,height,codec_name", "-of", "json", part], timeout=20)
    m = re.search(r'"width":\s*(\d+)', out2); h = re.search(r'"height":\s*(\d+)', out2)
    c = re.search(r'"codec_name":\s*"(\w+)"', out2)
    if m and h:
        return (int(m.group(1)), int(h.group(1)), f"codec={c.group(1) if c else '?'} {os.path.getsize(part)//1024}KB")
    return (0, 0, f"ffprobe unreadable ({os.path.getsize(part)//1024}KB)")

print("=" * 70)
print("A. ddownr/oceansaver render API — public static api key")
print("=" * 70)
# The api key ddownr.com ships in its own frontend JS (public, static).
API_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222"
for fmt in ["2160", "1440", "1080"]:
    u = f"https://p.oceansaver.in/ajax/download.php?copyright=0&format={fmt}&url={TEST_URL}&api={API_KEY}"
    code, out, err = sh(["curl", "-sS", "--max-time", "20", u,
                         "-H", f"User-Agent: {UA}", "-H", "Referer: https://ddownr.com/"], timeout=25)
    print(f"[format={fmt}] HTTP={code} raw={out[:200]!r}")
    try:
        j = json.loads(out)
        jid = j.get("id")
        if jid and fmt == "2160":
            print(f"  job id = {jid}; polling progress…")
            durl = None
            for i in range(40):
                time.sleep(8)
                code, out, _ = sh(["curl", "-sS", "--max-time", "15",
                                   f"https://p.oceansaver.in/ajax/progress.php?id={jid}",
                                   "-H", f"User-Agent: {UA}", "-H", "Referer: https://ddownr.com/"], timeout=18)
                try:
                    pj = json.loads(out)
                except Exception:
                    continue
                pr = pj.get("progress", 0)
                txt = pj.get("text", "")
                if pj.get("download_url"):
                    durl = pj["download_url"]; break
                if i % 3 == 0: print(f"  poll {i}: progress={pr} text={txt}")
            if durl:
                print(f"  DOWNLOAD_URL={durl[:150]}")
                w, h, note = head_probe(durl, "ocean2160", max_mb=12, max_s=14)
                print(f"  VERIFIED: {w}x{h} ({note})")
            else:
                print("  no download_url after ~5min")
    except Exception as e:
        print(f"  parse fail: {e}")

print()
print("=" * 70)
print("B. loader.to — discover valid format ids from its own frontend JS")
print("=" * 70)
code, out, _ = sh(["curl", "-sS", "--max-time", "20", "https://loader.to/",
                   "-H", f"User-Agent: {UA}"], timeout=25)
scripts = re.findall(r'src="([^"]+\.js[^"]*)"', out)
print(f"page {len(out)}B, scripts: {scripts[:8]}")
for s in scripts[:6]:
    if s.startswith("//"): s = "https:" + s
    elif s.startswith("/"): s = "https://loader.to" + s
    code, js, _ = sh(["curl", "-sS", "--max-time", "20", s, "-H", f"User-Agent: {UA}"], timeout=25)
    fmts = sorted(set(re.findall(r'format["\s=:]+["\']?(\d{3,4})["\']?', js)))[:40]
    hi = [x for x in fmts if int(x) >= 1440]
    kws = re.findall(r'.{60}(?:2160|4320|8K|4K).{60}', js)[:6]
    if hi or kws:
        print(f"  {s}\n    high formats: {hi}\n    keyword ctx: {[k.replace(chr(10),' ')[:110] for k in kws]}")

print()
print("=" * 70)
print("C. nichind tunnel retry (3x, transient wall check) + 1440 comparison")
print("=" * 70)
for attempt, q in [("2160/vp9", {"videoQuality": "2160", "youtubeVideoCodec": "vp9"}),
                   ("1440/vp9", {"videoQuality": "1440", "youtubeVideoCodec": "vp9"}),
                   ("2160/vp9-2", {"videoQuality": "2160", "youtubeVideoCodec": "vp9"})]:
    body = json.dumps({"url": TEST_URL, "downloadMode": "auto", **q})
    code, out, _ = sh(["curl", "-sS", "--max-time", "25", "-X", "POST", "https://dwnld.nichind.dev/",
                       "-H", "Accept: application/json", "-H", "Content-Type: application/json",
                       "-H", f"User-Agent: {UA}", "--data", body], timeout=30)
    try:
        j = json.loads(out)
        st = j.get("status"); url = j.get("url")
        err = (j.get("error") or {}).get("code") if isinstance(j.get("error"), dict) else j.get("text")
        print(f"[{attempt}] status={st} err={err}")
        if url:
            w, h, note = head_probe(url, f"nich{attempt.replace('/','')}", max_mb=8, max_s=12)
            print(f"   tunnel → {w}x{h} ({note})")
    except Exception:
        print(f"[{attempt}] non-JSON {out[:100]!r}")
    time.sleep(3)

print()
print("=" * 70)
print("D. manual spot-check: invidious + piped aliveness (30s, generous)")
print("=" * 70)
for name, u in [("inv.nadeko.net", f"https://inv.nadeko.net/api/v1/videos/{TEST_VIDEO}?local=true"),
                ("piped.private.coffee", f"https://api.piped.private.coffee/streams/{TEST_VIDEO}")]:
    code, out, _ = sh(["curl", "-sS", "--max-time", "30", u, "-H", f"User-Agent: {UA}"], timeout=35)
    print(f"[{name}] HTTP={code} bytes={len(out)}")
    if out.startswith("{"):
        try:
            j = json.loads(out)
            if "adaptiveFormats" in j:
                hts = sorted({f.get("qualityLabel","?") for f in j["adaptiveFormats"] if "video" in f.get("type","")})
                print(f"  heights: {hts}")
                f4k = [f for f in j["adaptiveFormats"] if (f.get("qualityLabel") or "").startswith("2160")]
                if f4k and f4k[0].get("url"):
                    w, h, note = head_probe(f4k[0]["url"], "inv4k")
                    print(f"  2160p proxied probe → {w}x{h} ({note})")
            elif "videoStreams" in j:
                hts = sorted({str(s.get("quality")) for s in j["videoStreams"]})
                print(f"  qualities: {hts}  audioStreams: {len(j.get('audioStreams') or [])}")
                f4k = [s for s in j["videoStreams"] if s.get("quality") == 2160 and s.get("url")]
                if f4k:
                    w, h, note = head_probe(f4k[0]["url"], "piped4k")
                    print(f"  2160p pipedproxy probe → {w}x{h} ({note})")
        except Exception as e:
            print(f"  parse: {e}")
