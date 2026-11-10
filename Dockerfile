# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

# ffmpeg/ffprobe for cutting & muxing, python3 for yt-dlp, git/curl for the
# PO-token provider below
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates git curl \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider \
 && yt-dlp --version \
 && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && python3 -c "import zipfile; zipfile.ZipFile('/tmp/deno.zip').extractall('/usr/local/bin')" \
 && chmod +x /usr/local/bin/deno && rm -f /tmp/deno.zip \
 && git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
 && cd /opt/bgutil/server \
 && DENO_DIR=/opt/deno-cache deno install \
 && DENO_DIR=/opt/deno-cache deno cache src/main.ts \
 && deno --version \
 && curl -fsSL -o /usr/local/bin/wgcf https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_amd64 \
 && chmod +x /usr/local/bin/wgcf \
 && curl -fsSL -o /tmp/wireproxy.tar.gz https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz \
 && tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin wireproxy && chmod +x /usr/local/bin/wireproxy && rm -f /tmp/wireproxy.tar.gz \
 && wgcf --version && wireproxy --version

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FCLIP_DATA_DIR=/app/.data \
    DENO_DIR=/opt/deno-cache

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

RUN mkdir -p /app/.data/clips
# NOTE: no docker VOLUME directive — Railway rejects it; Railway Volumes
# (mount path /app/.data) provide persistence on Railway, docker-compose.yml
# still declares its own named volume for local/VPS runs.

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000
# Entrypoint keeps the bgutil PO-token provider (port 4416) AND the Cloudflare
# WARP socks5 sidecar (port 1080) running in the background: the provider mints
# YouTube BotGuard tokens and the sidecar provides Cloudflare egress so yt-dlp
# survives the "confirm you're not a bot" wall from datacenter IPs.
CMD ["/app/docker-entrypoint.sh"]
