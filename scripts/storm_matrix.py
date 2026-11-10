#!/usr/bin/env python3
"""Brute-force YouTube player-client matrix against the bot wall.

Tests every yt-dlp player_client from this datacenter IP, N rounds,
concurrently per round, classifying outcomes. The winners feed the
client-storm fallback built into fclip's ytdlp.ts.
"""
import concurrent.futures as cf
import json
import re
import subprocess
import sys
import time

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
CLIENTS = [
    "",                  # default cascade
    "tv",
    "tv_embedded",
    "mweb",
    "web_simplificated",
    "web_embedded",
    "android_vr",
    "android",
    "ios",
]
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 2

BOTWALL = re.compile(r"sign in to confirm|not a bot|bot check", re.I)
GVS403 = re.compile(r"HTTP error 403|returned 403|forbidden", re.I)


def run_client(client: str):
    args = [
        "yt-dlp", "--dump-single-json", "--no-playlist", "--no-warnings",
        "--socket-timeout", "20", "--retries", "1",
        "--extractor-args", f"youtube:player_client={client}",
        URL,
    ]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=100)
    except subprocess.TimeoutExpired:
        return client, "TIMEOUT", 0
    if p.returncode == 0 and p.stdout.strip().startswith("{"):
        try:
            info = json.loads(p.stdout)
            return client, "PASS", len(info.get("formats") or [])
        except Exception:
            return client, "PASS(badjson)", 0
    blob = (p.stderr or "") + (p.stdout or "")
    if BOTWALL.search(blob):
        return client, "BOTWALL", 0
    if GVS403.search(blob):
        return client, "GVS403", 0
    first = blob.strip().splitlines()[:1]
    return client, "OTHER: " + (first[0][:90] if first else "?"), 0


def main():
    results = {}  # client -> [statuses]
    for rnd in range(1, ROUNDS + 1):
        print(f"=== ROUND {rnd} ===", flush=True)
        with cf.ThreadPoolExecutor(max_workers=len(CLIENTS)) as ex:
            futs = {ex.submit(run_client, c): c for c in CLIENTS}
            for fut in cf.as_completed(futs):
                client, status, nfmt = fut.result()
                results.setdefault(client, []).append(status)
                print(f"  {client or '(default)':<20} -> {status} fmts={nfmt}", flush=True)
        if rnd < ROUNDS:
            time.sleep(2)
    print("\n=== SUMMARY ===")
    for c in CLIENTS:
        sts = results.get(c, [])
        passes = sum(1 for s in sts if s.startswith("PASS"))
        print(f"{c or '(default)':<20} {passes}/{len(sts)} pass   {' | '.join(sts[:3])}")


if __name__ == "__main__":
    main()
