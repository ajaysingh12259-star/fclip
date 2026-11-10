#!/usr/bin/env python3
"""Burst on an HD video to learn available quality from android-family
clients without cookies/PO tokens, from a datacenter IP."""
import concurrent.futures as cf
import json
import re
import subprocess
import sys

URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
BOTWALL = re.compile(r"sign in to confirm|not a bot", re.I)

def run(i):
    c = ["android", "android_vr", "tv", "mweb", "ios", "android"][i % 6]
    p = subprocess.run(
        ["yt-dlp", "--dump-single-json", "--no-playlist", "--no-warnings",
         "--socket-timeout", "25", "--retries", "1",
         "--extractor-args", f"youtube:player_client={c}", URL],
        capture_output=True, text=True, timeout=110)
    if p.returncode == 0 and p.stdout.strip().startswith("{"):
        info = json.loads(p.stdout)
        fmts = [f for f in (info.get("formats") or []) if f.get("vcodec") != "none" or f.get("acodec") != "none"]
        heights = sorted({f.get("height") for f in fmts if f.get("height")}, reverse=True)
        progressives = [(f["format_id"], f.get("height"), f.get("protocol")) for f in fmts if f.get("protocol") == "https"]
        return c, True, {"n_fmts": len(fmts), "heights": heights[:8], "https_progressive": progressives[:6]}
    blob = p.stderr + p.stdout
    m = re.search(r"ERROR: (.{0,110})", blob)
    return c, False, m.group(1) if m else blob[:110]

with cf.ThreadPoolExecutor(max_workers=6) as ex:
    for fut in cf.as_completed([ex.submit(run, i) for i in range(6)]):
        c, ok, detail = fut.result()
        print(f"{c:<10} {'PASS' if ok else 'WALL/ERR'}  {json.dumps(detail) if ok else detail}", flush=True)
