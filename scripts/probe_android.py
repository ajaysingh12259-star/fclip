#!/usr/bin/env python3
"""Probe android/android_vr pass-rate (5 attempts each) and inspect
the format payload of a successful pass (resolution, itag, dl-ability)."""
import concurrent.futures as cf
import json
import re
import subprocess

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
BOTWALL = re.compile(r"sign in to confirm|not a bot", re.I)

ARGS = ["yt-dlp", "--dump-single-json", "--no-playlist", "--no-warnings",
        "--socket-timeout", "20", "--retries", "1", URL]


def run(client):
    cmd = ARGS + (["--extractor-args", f"youtube:player_client={client}"] if client else [])
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=100)
    except subprocess.TimeoutExpired:
        return client, "TIMEOUT", None
    if p.returncode == 0 and p.stdout.strip().startswith("{"):
        info = json.loads(p.stdout)
        fmts = info.get("formats") or []
        pick = fmts[-1] if fmts else {}
        detail = {k: pick.get(k) for k in ("format_id", "ext", "height", "vcodec", "acodec", "tbr", "protocol")}
        return client, "PASS", detail
    blob = p.stderr + p.stdout
    return client, ("BOTWALL" if BOTWALL.search(blob) else "OTHER:" + blob[:60]), None


def main():
    jobs = []
    for c in ("android", "android_vr"):
        for i in range(5):
            jobs.append((c, i))
    with cf.ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(run, c): (c, i) for c, i in jobs}
        for fut in cf.as_completed(futs):
            c, i = futs[fut]
            client, status, detail = fut.result()
            line = f"attempt{i+1} {client:<12} -> {status}"
            if detail:
                line += f"  {json.dumps(detail)}"
            print(line, flush=True)


if __name__ == "__main__":
    main()
