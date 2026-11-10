#!/bin/sh
# fclip container entrypoint.
#
# Runs two supervised background services so yt-dlp can survive YouTube's
# "confirm you're not a bot" wall from datacenter IPs:
#
# 1. bgutil PO-token provider (127.0.0.1:4416) — mints YouTube BotGuard
#    tokens; the yt-dlp plugin (bgutil-ytdlp-pot-provider, installed via pip)
#    talks to it automatically.
# 2. Cloudflare WARP socks5 sidecar (127.0.0.1:1080) — routes requests
#    through Cloudflare's network, whose egress IPs score far better with
#    YouTube's bot scoring than raw datacenter ranges (approach proven in
#    production by yt-dlp-rescue). The WARP profile is registered ONCE and
#    persisted under $FCLIP_DATA_DIR/warp/ so redeploys reuse it. If UDP
#    egress is blocked on the host, wireproxy exits and loops — fclip
#    detects the dead port and runs direct + client storms instead.

( while true; do
    echo "[fclip] starting bgutil PO-token provider…"
    deno run --allow-all /opt/bgutil/server/src/main.ts
    echo "[fclip] bgutil provider exited — restarting in 2s"
    sleep 2
  done ) &

WARP_DIR="${FCLIP_DATA_DIR:-/app/.data}/warp"
mkdir -p "$WARP_DIR"

( while true; do
    if [ ! -f "$WARP_DIR/wgcf-profile.conf" ]; then
      echo "[fclip] WARP: registering a Cloudflare WARP account (one-time)…"
      if (cd "$WARP_DIR" && wgcf register --accept-tos && wgcf generate); then
        echo "[fclip] WARP: profile created"
      else
        echo "[fclip] WARP: registration failed — retrying in 60s"
        sleep 60
        continue
      fi
    fi
    # wireproxy wants the wireguard profile inline plus a [Socks5] section.
    sed '/^$/d' "$WARP_DIR/wgcf-profile.conf" > "$WARP_DIR/wireproxy.conf"
    printf '\n[Socks5]\nBindAddress = 127.0.0.1:1080\n' >> "$WARP_DIR/wireproxy.conf"
    echo "[fclip] WARP: starting socks5 sidecar on 127.0.0.1:1080"
    wireproxy -c "$WARP_DIR/wireproxy.conf"
    echo "[fclip] WARP: wireproxy exited (UDP egress blocked?) — retrying in 30s"
    sleep 30
  done ) &

exec node server.js
