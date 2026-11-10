#!/usr/bin/env python3
"""OSINT live-fire: clipscutter /clips/create with high quality on free scope."""
import json, time, hmac, hashlib, base64, urllib.request, http.cookiejar, sys, re

BASE = "https://api.clipscutter.com"
VID = sys.argv[1] if len(sys.argv) > 1 else "aqz-KE-bpKQ"  # Big Buck Bunny 4K60
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, body=None, timeout=60):
    url = BASE + path if path.startswith("/") else path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Origin", "https://www.clipscutter.com")
    r.add_header("Referer", "https://www.clipscutter.com/")
    r.add_header("User-Agent", UA)
    r.add_header("Accept", "*/*")
    try:
        with opener.open(r, timeout=timeout) as resp:
            raw = resp.read().decode(errors="replace")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")

# --- reconstruct secret EXACTLY from the JS char array ---
js = open("/tmp/osint2/cs_cutter.js", errors="ignore").read()
m = re.search(r"JSON\.parse\('(\[.*?\])'\)\.join\(\"\"\)", js)
arr = json.loads(m.group(1))
SECRET = "".join(arr)
print(f"[*] secret len={len(SECRET)} head={SECRET[:16]!r}")

def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def make_gv3():
    ts = int(time.time())
    hdr = b64u(json.dumps({"alg": "HS256"}, separators=(",", ":")).encode())
    pl = b64u(json.dumps({"ua": UA, "lang": "en-US", "ts": ts, "iat": ts, "exp": ts + 60}, separators=(",", ":")).encode())
    sig = b64u(hmac.new(SECRET.encode(), f"{hdr}.{pl}".encode(), hashlib.sha256).digest())
    return f"{hdr}.{pl}.{sig}"

# 1. bootstrap: homepage cookies
r = urllib.request.Request("https://www.clipscutter.com/cutter/youtube-downloader", headers={"User-Agent": UA})
with opener.open(r, timeout=30) as resp:
    pass
print("[*] cookies after homepage:", [(c.name, c.value[:12] + "...") for c in jar])

# 2. auth/status -> guest user
st, raw = req("GET", "/auth/status")
print("[*] auth/status:", st, raw[:400])
print("[*] cookies now:", [(c.name, c.value[:12] + "...") for c in jar])

# 3. formats -> source_id
st, raw = req("POST", f"/youtube/{VID}/formats", {"source": f"https://www.youtube.com/watch?v={VID}", "httpDashFormats": False}, timeout=90)
fmt = json.loads(raw)
d = fmt.get("data", {})
print(f"[*] formats: status={st} code={fmt.get('statusCode')} success={fmt.get('success')} details={fmt.get('details')}")
print("    source_id:", d.get("source_id"))
print("    user_scope:", d.get("user_scope"), "title:", (d.get("title") or "")[:50])
print("    mp4_list:", json.dumps(d.get("mp4_list")))
print("    webm_list:", json.dumps(d.get("webm_list")))
if not d.get("source_id"):
    print("!! no source_id, raw:", raw[:800]); sys.exit(1)

# 4. create 1080p mp4 clip (1-11s)
gv3 = make_gv3()
payload = {
    "videoId": VID, "startTime": 1, "endTime": 11,
    "title": d.get("title", "video"), "sourceID": d.get("source_id"), "gv3": gv3,
    "type": "video", "format": "mp4", "quality": "1080p",
    "max_duration": 720, "is_available": True, "premium_format": False,
}
st, raw = req("POST", "/clips/create", payload, timeout=120)
print("[*] clips/create 1080p:", st)
print(raw[:1500])
json.dump({"fmt": d, "create_resp": raw}, open("/tmp/osint2/last_resp.json", "w"))
