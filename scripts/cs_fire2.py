#!/usr/bin/env python3
"""Full chain: guest session -> formats -> create high-res clip -> poll socket status."""
import json, time, hmac, hashlib, base64, urllib.request, http.cookiejar, sys, re, socket, ssl

BASE = "https://api.clipscutter.com"
VID = sys.argv[1] if len(sys.argv) > 1 else "aqz-KE-bpKQ"
QUAL = sys.argv[2] if len(sys.argv) > 2 else "1080p60"
FMT = sys.argv[3] if len(sys.argv) > 3 else "mp4"
START = int(sys.argv[4]) if len(sys.argv) > 4 else 1
END = int(sys.argv[5]) if len(sys.argv) > 5 else 11
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def req(method, path, body=None, timeout=90, raw_url=None):
    url = raw_url or (BASE + path)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Origin", "https://www.clipscutter.com")
    r.add_header("Referer", "https://www.clipscutter.com/")
    r.add_header("User-Agent", UA)
    try:
        with opener.open(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")

# gv3
js = open("/tmp/osint2/cs_cutter.js", errors="ignore").read()
arr = json.loads(re.search(r"JSON\.parse\('(\[.*?\])'\)\.join\(\"\"\)", js).group(1))
SECRET = "".join(arr)
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def make_gv3():
    ts = int(time.time())
    hdr = b64u(json.dumps({"alg": "HS256"}, separators=(",", ":")).encode())
    pl = b64u(json.dumps({"ua": UA, "lang": "en-US", "ts": ts, "iat": ts, "exp": ts + 60}, separators=(",", ":")).encode())
    sig = b64u(hmac.new(SECRET.encode(), f"{hdr}.{pl}".encode(), hashlib.sha256).digest())
    return f"{hdr}.{pl}.{sig}"

# 1. guest session
st, raw = req("POST", "/auth/status", {})
print("[1] auth/status:", st, "cookies:", [c.name for c in jar])

# 2. formats
st, raw = req("POST", f"/youtube/{VID}/formats", {"source": f"https://www.youtube.com/watch?v={VID}", "httpDashFormats": False}, timeout=90)
d = json.loads(raw).get("data", {})
src_id = d.get("source_id")
lists = d.get(f"{FMT}_list") or []
item = next((x for x in lists if x["name"] == QUAL), None)
if not item:
    print(f"!! quality {QUAL} not in {FMT}_list:", [x["name"] for x in lists]); sys.exit(1)
print(f"[2] formats ok: source_id={src_id[:8]}... item={item}")

# 3. create
gv3 = make_gv3()
payload = {
    "videoId": VID, "startTime": START, "endTime": END,
    "title": d.get("title", "video"), "sourceID": src_id, "gv3": gv3,
    "type": "video", "format": FMT, "quality": QUAL,
    **item,  # spreads premium_format, is_available, cc_id (name gets overwritten by quality below)
}
payload["quality"] = QUAL
payload.pop("name", None)
st, raw = req("POST", "/clips/create", payload, timeout=180)
print(f"[3] create {QUAL} {FMT} [{START}-{END}s]: HTTP", st)
print("    ", raw[:800])
json.dump({"create": raw, "status_code": st}, open("/tmp/osint2/create_resp.json", "w"))

# 4. if clip accepted -> poll via socket.io (engine.io handshake)
try:
    cj = raw and json.loads(raw)
    if isinstance(cj, dict) and cj.get("data"):
        print("[4] create data:", json.dumps(cj["data"])[:400])
except Exception:
    pass
print("[*] cookies:", [c.name for c in jar])
