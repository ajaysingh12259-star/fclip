# fclip — deploy guide

fclip is a free, self-hostable YouTube clipper: paste a link, preview the video, pick
crop points (e.g. `2:20:00 → 2:40:00`), download just that segment in up to 4K —
**without downloading the whole file**. It only fetches the byte-ranges covering your
selection, so a 20-minute cut from a 3-hour video transfers megabytes, not gigabytes.

Under the hood: [yt-dlp](https://github.com/yt-dlp/yt-dlp) seeks directly into
YouTube's streams with HTTP range requests and [ffmpeg](https://ffmpeg.org) trims &
remuxes the fragments. Nothing is re-encoded unless you enable *Frame-accurate* mode.

---

## 0 · Why did my Vercel / Netlify deploy fail?

fclip runs **yt-dlp** and **ffmpeg** as real binaries inside a long-lived Node
server. Serverless platforms can't do that: no executables in the function
bundle, a read-only filesystem, short execution timeouts, and YouTube
aggressively blocks their datacenter IPs. A Vercel deployment therefore fails
with `Could not fetch this video` / `Could not reach the fclip server`.

Since this update, fclip detects that situation and shows a clear
**"This server can't run fclip"** banner instead of a cryptic error. Use one of
the supported hosts below — Railway and Render take about 3 minutes and have a
free tier-adjacent starter plan.

---

## 1 · Run it on your own computer (fastest, zero bot-walls)

Your home IP is trusted by YouTube, so this "just works" — the bot wall mostly hits
cloud/datacenter IPs.

Requirements: **Python 3.9+**, **ffmpeg**, and **bun** (or Node 20+) installed.

```bash
# 1. binaries
python3 -m pip install yt-dlp
# ffmpeg:  brew install ffmpeg  (macOS)  |  winget install ffmpeg  (Windows)  |  apt install ffmpeg (Linux)

# 2. fclip
bun install
bun run dev          # http://localhost:3000
```

**Optional but magic:** tell yt-dlp to reuse your own browser's cookies so even
age-restricted / bot-walled videos work with zero exporting:

```bash
FCLIP_COOKIES_FROM_BROWSER=chrome bun run dev      # or firefox, edge, brave, vivaldi
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

- Node runtime + **ffmpeg** + **yt-dlp** baked into the image (no host installs).
- Clips, cookies and the demo file live in the `fclip-data` volume (`/app/.data` inside
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
3. (Recommended) Set the `FCLIP_YT_COOKIES` variable with a `cookies.txt` export
   from a throwaway Google account — see section 5.
4. **Settings → Networking → Generate Domain** to get a public URL.
5. **4K tuning (optional):**
   - `FCLIP_SAVENOW_API_KEY` — your own key from
     [video-download-api.com](https://video-download-api.com) (free test tier:
     25 requests after email confirmation). The built-in shared key's quota
     pool is global and often dry; an owned key skips the queue and makes the
     TRUE 4K render lane (2160p AV1) reliable.
   - `FCLIP_EGRESS_PROXIES` — comma/whitespace separated `socks5h://` or
     `http://` proxy URLs (residential/ISP exits). fclip health-checks each
     one by fetching its real egress IP through it, then round-robins across
     the healthy ones for every YouTube request — better bot-scoring than
     raw datacenter IPs, and native (non-relay) 4K becomes possible when
     YouTube unlists 2160p for DC ranges. Leave empty to use the built-in
     Cloudflare WARP sidecar, which is tried after the pool.

Healthchecks hit `/api/health`, so you can watch the deploy go green.

## 4 · Deploy on Render (blueprint)

This repo ships a `render.yaml` blueprint:

1. Easiest: open <https://render.com/deploy?repo=https://github.com/ajay122596-rgb/fclip>
   — Render creates the Docker web service, mounts a 1 GB disk at `/app/.data`
   and asks for the optional `FCLIP_YT_COOKIES` variable.
2. Or manually: render.com → **New → Web Service** → pick the repo → runtime
   **Docker** → add a disk mounted at `/app/.data`.

## 5 · If YouTube shows the "confirm you're not a bot" wall

Cloud IPs get rate-limited by YouTube. fclip already fights back for you:

1. **Built-in retry** — info fetches and cuts automatically retry once with YouTube's
   `tv`/`android_vr` player clients, and once more with a fresh session. Fresh deployments
   often work with zero setup — just try the link again.
2. **Built-in PO-token provider** — the Docker image runs the
   [bgutil BotGuard provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
   on `localhost:4416` automatically. It mints the PO tokens YouTube demands from
   server IPs — the same mechanism YoutubeDownloader uses internally — so Docker
   deployments can fetch videos with zero setup.
3. **Preview always works** — the video preview streams from YouTube inside *your*
   browser (never through the server), so even on a bot-walled server you can scrub,
   use *Set start/end to player time*, and *Preview selection*. fclip shows a yellow
   banner when it's in this mode.
4. **Paste cookies** — Cookies button (header) accepts a standard `cookies.txt` export.
5. **Cookies-from-browser env** — see the local-run trick above (desktop only).
6. **Cookies via env var** — set `FCLIP_YT_COOKIES` to the full `cookies.txt`
   content (Netscape format); fclip materializes it at boot. Best option for
   Railway / Render / Fly / VPS where there is no local browser.
7. **Run locally** — your home IP is the most reliable path; see section 1.

> ⚠️ Cookie safety (per the yt-dlp wiki): use a **throwaway Google account** when
> exporting cookies, not your main one — Google occasionally restricts accounts whose
> cookies are used by automated tools.

## 6 · Limits & notes

| Thing | Value |
| --- | --- |
| Max clip length | 1 hour (per clip) |
| 4K / 2K | With cookies: VP9/AV1 in WebM/MKV (that's how YouTube serves it) — plays in browsers & VLC. Cookie-less: explicit 4K/2K picks ride the 4K render relays (measured live: 3840x2160 AV1 60fps + AAC mp4, no cookies) — the render farm processes the whole source, so keep it under ~25 min; if every relay is busy the clip lands in 1080p60, then 360p. Pick 1080p for classic MP4/H.264 output. |
| Fast mode | Keyframe-aligned cut (±2 s), instant, no re-encode |
| Frame-accurate mode | Exact times, but re-encodes the boundaries (slow at 4K) |
| Job list | In memory — restarting the app clears the *list* (files in the volume are cleaned by age/disk guard) |
| Legality | Only clip content you own or that's licensed for reuse; respect YouTube's ToS |

## 7 · Config reference (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FCLIP_DATA_DIR` | `./.data` | Where clips / cookies / demo file are stored (volume mount point) |
| `FCLIP_COOKIES_FROM_BROWSER` | — | Import cookies from a local browser (`chrome`, `firefox`, `edge`, `brave`, …) |
| `YTDLP_COOKIES_FROM_BROWSER` | — | Alias of the above |
| `FCLIP_YT_COOKIES` | — | Full `cookies.txt` (Netscape) content as an env var — the cloud-friendly way to beat the bot wall. Aliases: `YOUTUBE_COOKIES`, `YTDLP_COOKIES` |
| `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | auto-detected | Override binary locations (an explicit override must exist — no silent fallback) |
| `PORT` | `3000` | HTTP port |
