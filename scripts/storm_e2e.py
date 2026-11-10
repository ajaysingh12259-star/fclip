#!/usr/bin/env python3
"""E2E proof: storm until android passes, then actually DOWNLOAD a 5-second
clip of itag-18 from googlevideo on this datacenter IP."""
import json
import re
import subprocess
import sys
import time

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
BOTWALL = re.compile(r"sign in to confirm|not a bot", re.I)

base = ["yt-dlp", "--no-playlist", "--no-warnings", "--socket-timeout", "20",
        "--retries", "1", "--extractor-args", "youtube:player_client=android", URL]

for attempt in range(1, 9):
    print(f"storm attempt {attempt}...", flush=True)
    p = subprocess.run(base + ["--print", "%(format_id)s %(height)s"], capture_output=True, text=True, timeout=100)
    if p.returncode == 0 and "sign in" not in (p.stderr + p.stdout).lower():
        print("PASS:", p.stdout.strip()[:80])
        break
    time.sleep(1.5 + attempt * 0.5)
else:
    sys.exit("STORM FAILED after 8 attempts")

out = "/tmp/storm-clip.mp4"
d = subprocess.run(base + ["-f", "18", "--download-sections", "*0-5", "-o", out,
                           "--force-keyframes-at-cuts", "--no-part"],
                   capture_output=True, text=True, timeout=180)
tail = (d.stderr or "").strip().splitlines()[-3:]
print("download-exit:", d.returncode)
for l in tail:
    print("  ", l[:120])
try:
    import os
    sz = os.path.getsize(out)
    print("file-size:", sz, "bytes")
    ff = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", out],
                        capture_output=True, text=True)
    meta = json.loads(ff.stdout or "{}")
    for s in meta.get("streams", []):
        print("  stream:", s.get("codec_type"), s.get("codec_name"),
              s.get("width") or "", s.get("height") or "", s.get("duration") or "")
except Exception as e:
    print("probe-fail:", e)
