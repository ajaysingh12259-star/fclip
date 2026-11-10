#!/usr/bin/env python3
"""Burst hypothesis test: fire N parallel android/android_vr requests.
Earlier passes only happened during parallel bursts - verify correlation."""
import concurrent.futures as cf
import re
import subprocess
import sys

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
BOTWALL = re.compile(r"sign in to confirm|not a bot", re.I)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
CLIENTS = ["android", "android_vr"]

def run(i):
    c = CLIENTS[i % len(CLIENTS)]
    p = subprocess.run(
        ["yt-dlp", "--dump-single-json", "--no-playlist", "--no-warnings",
         "--socket-timeout", "20", "--retries", "1",
         "--extractor-args", f"youtube:player_client={c}", URL],
        capture_output=True, text=True, timeout=100)
    ok = p.returncode == 0 and p.stdout.strip().startswith("{")
    return c, ("PASS" if ok else ("BOTWALL" if BOTWALL.search(p.stderr + p.stdout) else "OTHER"))

with cf.ThreadPoolExecutor(max_workers=N) as ex:
    results = list(ex.map(run, range(N)))

passes = [c for c, s in results if s == "PASS"]
print(f"parallel-burst N={N}: passes={len(passes)}/{N} -> {results}")
