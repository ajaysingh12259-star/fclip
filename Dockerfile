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

# ffmpeg/ffprobe for the local range-cut + duration probes; curl for all
# farm API traffic and file downloads (Cloudflare-fingerprinted hosts
# reject undici fetch). No yt-dlp, no PO-token provider, no WARP — the
# render farms do YouTube's heavy lifting from their own networks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FCLIP_DATA_DIR=/app/.data

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

RUN mkdir -p /app/.data/clips
# NOTE: no docker VOLUME directive — Railway rejects it; Railway Volumes
# (mount path /app/.data) provide persistence on Railway, docker-compose.yml
# still declares its own named volume for local/VPS runs.

EXPOSE 3000
CMD ["node", "server.js"]
