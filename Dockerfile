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

# ffmpeg/ffprobe for cutting & muxing, python3 for yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --no-cache-dir yt-dlp \
 && yt-dlp --version && ffmpeg -version | head -1

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
VOLUME ["/app/.data"]

EXPOSE 3000
CMD ["node", "server.js"]
