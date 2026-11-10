# fclip — deploy guide

fclip is a free, self-hostable YouTube clipper: paste a link, preview the video, pick
crop points (e.g. `2:20:00 → 2:40:00`), download just that segment in up to 4K —
**without downloading the whole file**. It only fetches the byte-ranges covering your
selection, so a 20-minute cut from a 3-hour video transfers megabytes, not gigabytes.

Under the hood: [yt-dlp](https://github.com/yt-dlp/yt-dlp) seeks directly into
YouTube's streams with HTTP range requests and [ffmpeg](https://ffmpeg.org) trims &
remuxes the fragments. Nothing is re-encoded unless you enable *Frame-accurate* mode.

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

## 3 · If YouTube shows the "confirm you're not a bot" wall

Cloud IPs get rate-limited by YouTube. fclip already fights back for you:

1. **Built-in retry** — info fetches and cuts automatically retry once with YouTube's
   `tv`/`android_vr` player clients, which usually skip the wall. Fresh deployments
   often work with zero setup — just try the link again.
2. **Preview always works** — the video preview streams from YouTube inside *your*
   browser (never through the server), so even on a bot-walled server you can scrub,
   use *Set start/end to player time*, and *Preview selection*. fclip shows a yellow
   banner when it's in this mode.
3. **Paste cookies** — Cookies button (header) accepts a standard `cookies.txt` export.
4. **Cookies-from-browser env** — see the local-run trick above (desktop only).
5. **Run locally** — your home IP is the most reliable path; see section 1.

> ⚠️ Cookie safety (per the yt-dlp wiki): use a **throwaway Google account** when
> exporting cookies, not your main one — Google occasionally restricts accounts whose
> cookies are used by automated tools.

## 4 · Limits & notes

| Thing | Value |
| --- | --- |
| Max clip length | 1 hour (per clip) |
| 4K / 2K | Delivered as VP9/AV1 in WebM/MKV (that's how YouTube serves it) — plays in browsers & VLC. Pick 1080p for classic MP4/H.264. |
| Fast mode | Keyframe-aligned cut (±2 s), instant, no re-encode |
| Frame-accurate mode | Exact times, but re-encodes the boundaries (slow at 4K) |
| Job list | In memory — restarting the app clears the *list* (files in the volume are cleaned by age/disk guard) |
| Legality | Only clip content you own or that's licensed for reuse; respect YouTube's ToS |

## 5 · Config reference (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FCLIP_DATA_DIR` | `./.data` | Where clips / cookies / demo file are stored (volume mount point) |
| `FCLIP_COOKIES_FROM_BROWSER` | — | Import cookies from a local browser (`chrome`, `firefox`, `edge`, `brave`, …) |
| `YTDLP_COOKIES_FROM_BROWSER` | — | Alias of the above |
| `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | auto-detected | Override binary locations |
| `PORT` | `3000` | HTTP port |
