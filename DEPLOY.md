# fclip — deploy guide

fclip is a free, self-hostable YouTube clipper: paste a link, pick crop points,
download just that segment — a true **1080p60 cut on the first try**, and **real
3840×2160 4K** for 2K/4K picks.

Under the hood: a **render-farm engine**. fclip never scrapes YouTube's
bot-walled stream endpoints. Your range goes to two render-farm relays (the HD
farm cuts exactly your seconds in 1080p60 h264+aac; the 4K farm renders the
whole source in 2160p AV1 and fclip stream-cuts your range locally with
[ffmpeg](https://ffmpeg.org)). Nothing is re-encoded — the farm's bytes are
yours.

---

## 0 · Why did my Vercel / Netlify deploy fail?

fclip runs **ffmpeg/ffprobe** and **curl** as real binaries inside a long-lived
Node server. Serverless platforms can't do that: no executables in the function
bundle, a read-only filesystem, short execution timeouts. A Vercel deployment
therefore fails with `Could not reach the fclip server`. fclip detects that and
shows a clear **"This server can't run fclip"** banner. Use one of the supported
hosts below.

---

## 1 · Run it on your own computer

Requirements: **ffmpeg**, **curl**, and **bun** (or Node 20+).

```bash
# ffmpeg:  brew install ffmpeg  (macOS)  |  winget install ffmpeg  (Windows)  |  apt install ffmpeg (Linux)
bun install
bun run dev          # http://localhost:3000
```

Production on your machine:

```bash
bun run build
bun run start       # serves on :3000
```

## 2 · Deploy on a VPS with Docker (one command)

Any box with Docker works — Ubuntu 22/24, Debian 12, etc. Open port 3000 (or proxy it).

```bash
git clone <your-repo> fclip && cd fclip
docker compose up -d --build
# → http://YOUR_SERVER_IP:3000
```

What you get:

- Node runtime + **ffmpeg** + **curl** baked into the image (no host installs).
- Clips and the demo file live in the `fclip-data` volume (`/app/.data` inside
  the container). Finished clips are auto-deleted after ~2 h, with a ~1.5 GB disk guard.
- Auto-restart on reboot/crash.

Update to a new build:

```bash
git pull && docker compose up -d --build
```

Behind a domain? Caddy (auto-HTTPS) in front is two lines:

```
clip.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx equivalent: `proxy_pass http://127.0.0.1:3000;` plus the usual upgrade headers.

## 3 · Deploy on Railway (easiest cloud host)

Railway runs Docker images with persistent volumes — exactly what fclip needs.

1. Open [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo** →
   pick your `fclip` repo. Railway reads `railway.json` and builds the Dockerfile.
2. Add a volume: service → **Volumes** → mount path `/app/.data`.
3. **Settings → Networking → Generate Domain** to get a public URL.
4. **4K key (recommended):** set `FCLIP_SAVENOW_API_KEY` — your own key from
   [video-download-api.com](https://video-download-api.com) (free test tier:
   25 requests after email confirmation). The built-in shared key's quota pool
   is global and often dry; an owned key skips the queue and makes the TRUE 4K
   render lane (2160p AV1 60fps) reliable. When the 4K lane is out of quota,
   4K picks degrade to true 1080p60 — never 360p.

Healthchecks hit `/api/health`, so you can watch the deploy go green.

## 4 · Deploy on Render (blueprint)

This repo ships a `render.yaml` blueprint:

1. Easiest: open <https://render.com/deploy?repo=https://github.com/ajay122596-rgb/fclip>
   — Render creates the Docker web service and mounts a 1 GB disk at `/app/.data`.
2. Or manually: render.com → **New → Web Service** → pick the repo → runtime
   **Docker** → add a disk mounted at `/app/.data`.

## 5 · Limits & notes

| Thing | Value |
| --- | --- |
| Max clip length | 1 hour (per clip) |
| 1080p and below | Rendered true 1080p60 (h264+aac, mp4) by the HD farm on the first try — seconds, not minutes |
| 4K / 2K | Rendered by the 4K farm as 3840×2160 AV1 60fps + AAC in mp4 (needs the whole-source render — best for sources up to ~25 min; the range itself is stream-cut locally, so only a prefix crosses the wire). Degrades to true 1080p60 when the farm refuses |
| Fast mode | Keyframe-aligned cut (±2 s), instant, no re-encode |
| Frame-accurate mode | Exact times, but re-encodes the boundaries (slow at 4K) |
| Job list | In memory — restarting the app clears the *list* (files in the volume are cleaned by age/disk guard) |
| Legality | Only clip content you own or that's licensed for reuse; respect YouTube's ToS |

## 6 · Config reference (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FCLIP_DATA_DIR` | `./.data` | Where clips / demo file are stored (volume mount point) |
| `FCLIP_SAVENOW_API_KEY` | shared fallback key | Your registered [video-download-api.com](https://video-download-api.com) key — the guaranteed TRUE 4K path |
| `FFMPEG_PATH` / `FFPROBE_PATH` | auto-detected | Override binary locations |
| `PORT` | `3000` | HTTP port |
