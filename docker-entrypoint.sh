#!/bin/sh
# fclip container entrypoint.
#
# Runs the bgutil PO-token provider (YouTube BotGuard token minting service)
# in a supervised background loop so yt-dlp can bypass the "confirm you're
# not a bot" wall from datacenter IPs, then starts the fclip server.
#
# The provider listens on 127.0.0.1:4416 — the yt-dlp plugin
# (bgutil-ytdlp-pot-provider, installed via pip) talks to it automatically.

( while true; do
    echo "[fclip] starting bgutil PO-token provider…"
    deno run --allow-all /opt/bgutil/server/src/main.ts
    echo "[fclip] bgutil provider exited — restarting in 2s"
    sleep 2
  done ) &

exec node server.js
