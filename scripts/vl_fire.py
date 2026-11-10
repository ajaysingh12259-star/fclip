#!/usr/bin/env python3
"""Live-fire videolimit.com: clip-token -> create-clip 1080p/2160p anonymous."""
import json, sys, urllib.request, http.cookiejar, time

BASE = "https://videolimit.com"
VID = sys.argv[1] if len(sys.argv) > 1 else "aqz-KE-bpKQ"
QUAL = sys.argv[2] if len(sys.argv) > 2 else "1080p"
FMT = sys.argv[3] if len(sys.argv) > 3 else "mp4"
START = sys.argv[4] if len(sys.argv) > 4 else "0"
END = sys.argv[5] if len(sys.argv) > 5 else "10"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, body=None, headers=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Origin", BASE)
    r.add_header("Referer", BASE + "/")
    r.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with opener.open(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")

# 1. clip-token
st, raw = req("GET", "/api/videolimit/clip-token")
print("[1] clip-token:", st, raw[:300])
try:
    tok = json.loads(raw)
except Exception:
    print("!! token not json"); sys.exit(1)

fp = "fp_" + str(int(time.time())) + "a1b2c3d4e5"
hdrs = {"X-Client-Fp": fp}

# 2. create-clip
body = {"videoId": VID, "startTime": START, "endTime": END, "quality": QUAL, "format": FMT,
        "timestamp": tok.get("timestamp"), "hash": tok.get("hash")}
st, raw = req("POST", "/api/videolimit/create-clip", body, headers=hdrs, timeout=300)
print(f"[2] create-clip {QUAL} {FMT} [{START}-{END}]:", st)
print(raw[:900])
json.dump({"resp": raw, "code": st}, open("/tmp/osint3/create_resp.json", "w"))
