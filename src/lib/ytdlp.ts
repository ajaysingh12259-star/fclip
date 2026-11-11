/**
 * fclip render-farm engine — NO yt-dlp, NO YouTube direct extraction.
 *
 * The yt-dlp path (client storms, WARP egress, PO-token provider, cookies,
 * Piped/Invidious relays, cobalt tunnels) is gone: from a datacenter IP it
 * was slow and unreliable. The engine now talks ONLY to two render-farm
 * relays, both reverse-engineered and live-verified from a datacenter IP
 * with zero cookies:
 *
 *  1. 1080p FIRST TRY — VideoLimit HD relay (sn---s.clipscutter.com premium
 *     render farm): sends just the requested range, gets back a finished
 *     1080p60 h264+aac clip. Measured live, ffprobe-verified (see
 *     src/lib/videolimit.ts).
 *  2. THEN 4K — savenow/loader.to 4K farm (video-download-api.com): renders
 *     the whole source in TRUE 2160p (3840x2160 AV1@60 + AAC, mp4,
 *     moov-at-head) and fclip stream-copies the range locally. With the
 *     registered FCLIP_SAVENOW_API_KEY this lane skips the global shared-key
 *     quota pool entirely (see src/lib/savenow.ts).
 *
 * Ladder:
 *   - pick ≥ 1440p: 4K farm first → degrade to true 1080p60 (never 360p)
 *   - pick ≤ 1080p: 1080p60 farm on the first try → (rare) 4K farm + local cut
 *
 * ffmpeg/ffprobe stay: local range-cut of whole-source renders, duration
 * probes, finalize. Metadata (title/channel/thumb) comes from YouTube
 * oEmbed — one fast cookie-free call that works from datacenter IPs.
 * Duration is patched client-side from the in-browser YouTube player
 * (YouTube walls datacenter IPs on every metadata endpoint — never the
 * user's own browser).
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, rmSync, createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { randomUUID } from "crypto";
import { vlCreateClip } from "@/lib/videolimit";
import { savenowRender } from "@/lib/savenow";

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

export const DATA_DIR = process.env.FCLIP_DATA_DIR
  ? path.resolve(process.env.FCLIP_DATA_DIR)
  : path.join(process.cwd(), ".data");
export const CLIPS_DIR = path.join(DATA_DIR, "clips");
export const DEMO_PATH = path.join(DATA_DIR, "demo.mp4");

mkdirSync(CLIPS_DIR, { recursive: true });

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function findFfmpeg(): string {
  return firstExisting([process.env.FFMPEG_PATH, "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) ?? "ffmpeg";
}

function findFfprobe(): string {
  return firstExisting([process.env.FFPROBE_PATH, "/usr/bin/ffprobe", "/usr/local/bin/ffprobe"]) ?? "ffprobe";
}

const FFMPEG = findFfmpeg();
const FFPROBE = findFfprobe();

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface ClipJob {
  id: string;
  url: string;
  start: number;
  end: number;
  maxHeight: number | null;
  precise: boolean;
  title: string;
  status: JobStatus;
  stage: string;
  progress: number; // 0-100, -1 unknown
  log: string[];
  filename: string | null;
  filesize: number | null; // bytes
  clipDuration: number | null;
  error: string | null;
  createdAt: number;
  proc?: ChildProcess;
}

export interface VideoInfo {
  id: string | null;
  title: string;
  channel: string | null;
  duration: number;
  thumbnail: string | null;
  viewCount: number | null;
  uploadDate: string | null;
  isLive: boolean;
  chapters: { start: number; end: number; title: string }[] | null;
  qualities: { height: number; tbr: number | null; ext: string }[];
  qualityHint?: string | null;
  /** Which pipeline served this info: the render-farm engine. */
  route?: "farm";
  webpageUrl: string;
}

/* ------------------------------------------------------------------ */
/* Job store (in-memory, survives module reloads via globalThis)      */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as {
  __fclipJobs: Map<string, ClipJob> | undefined;
  __fclipEngine: { at: number; status: EngineStatus } | undefined;
  __fclipDuration: { at: number; videoId: string; duration: number | null } | undefined;
};

const jobs: Map<string, ClipJob> = (g.__fclipJobs ??= new Map());

/* Source duration from the last successful info fetch (30 min TTL) — used
 * to sanity-gate the 4K farm (whole-source render). */
function rememberSourceDuration(videoId: string, duration: number | null) {
  g.__fclipDuration = { at: Date.now(), videoId, duration };
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                        */
/* ------------------------------------------------------------------ */

export function isYouTubeUrl(url: string): boolean {
  return /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(
    (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })()
  );
}

export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(host)) return null;
    if (host.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{6,}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Info extraction — YouTube oEmbed (title/channel/thumb) */
/* ------------------------------------------------------------------ */

interface Oembed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const QUALITY_LADDER = [2160, 1440, 1080, 720, 480];

export const QUALITY_HINT =
  "Render-farm engine: no cookies, no bot walls. 1080p picks render in true 1080p60 (h264+aac) on the first try; 2K/4K picks ride the 4K farm and come back as 3840x2160 AV1 in mp4. If the 4K farm is busy, a 4K pick degrades to true 1080p60 — never 360p.";

export async function fetchInfo(
  url: string
): Promise<{ ok: true; info: VideoInfo } | { ok: false; error: { code: string; message: string }; detail?: string }> {
  if (!isYouTubeUrl(url)) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "fclip's render-farm engine supports YouTube links only.",
      },
    };
  }
  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      ok: false,
      error: { code: "bad_input", message: "Could not find a video ID in that YouTube link." },
    };
  }

  const oembed = (await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    10_000
  )) as Oembed | null;

  if (!oembed) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message:
          "Could not fetch video info — the video may be private, removed, region-locked, or YouTube is refusing this server.",
      },
    };
  }

  // Duration is unknown server-side (YouTube walls every metadata endpoint
  // from datacenter IPs) — the browser player patches it in client-side.
  const duration = 0;
  rememberSourceDuration(videoId, null);

  const info: VideoInfo = {
    id: videoId,
    title: oembed.title ?? "Untitled video",
    channel: oembed.author_name ?? null,
    duration,
    thumbnail: oembed.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    viewCount: null,
    uploadDate: null,
    isLive: false,
    chapters: null,
    qualities: QUALITY_LADDER.map((h) => ({ height: h, tbr: null, ext: "mp4" })),
    qualityHint: QUALITY_HINT,
    route: "farm",
    webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
  return { ok: true, info };
}

/* ------------------------------------------------------------------ */
/* Clip jobs                                                          */
/* ------------------------------------------------------------------ */

export interface CreateJobParams {
  url: string;
  start: number;
  end: number;
  maxHeight: number | null;
  precise: boolean;
  title?: string;
}

export function createClipJob(params: CreateJobParams): ClipJob {
  const id = randomUUID();
  const dir = path.join(CLIPS_DIR, id);
  mkdirSync(dir, { recursive: true });

  const job: ClipJob = {
    id,
    url: params.url,
    start: params.start,
    end: params.end,
    maxHeight: params.maxHeight,
    precise: params.precise,
    title: params.title ?? "video",
    status: "queued",
    stage: "Queued",
    progress: 0,
    log: [],
    filename: null,
    filesize: null,
    clipDuration: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  cleanupOldJobs();

  void runFarmLadder(job, params, dir).catch((e) => {
    if (job.status === "canceled") return;
    const msg = e instanceof Error ? e.message : String(e);
    job.log.push(`[fclip] engine error: ${msg.slice(0, 200)}`);
    job.status = "error";
    job.stage = "Failed";
    job.error = msg.slice(0, 300);
  });

  return job;
}

/* ------------------------------------------------------------------ */
/* The farm ladder                                                    */
/* ------------------------------------------------------------------ */



/**
 * THE LADDER.
 *  - 4K/2K picks: savenow 4K farm (registered API key) → videolimit 1080p60
 *    → savenow 1080 render (last resort).
 *  - ≤1080p picks: VideoLimit 1080p60 render FIRST TRY (fast when alive) →
 *    savenow 1080 whole-source render.
 *  Whole-source renders are STREAM-TRIMMED: the farm's download is piped
 *  straight into ffmpeg, which stream-copies just the requested range —
 *  zero disk usage, ranges anywhere in the source work.
 */
async function runFarmLadder(job: ClipJob, params: CreateJobParams, dir: string): Promise<void> {
  const dur = Math.max(0.2, params.end - params.start);
  const videoId = extractVideoId(params.url);
  if (!videoId) {
    job.status = "error";
    job.error = "This is not a YouTube link — the render-farm engine supports YouTube only.";
    job.stage = "Failed";
    return;
  }
  if ((job.status as string) === "canceled") return;

  const want4k = params.maxHeight != null && params.maxHeight >= 1440;
  const clipLen = params.end - params.start;

  /* ---- savenow farm: whole-source render in any format + stream-trim ----
   * "mislabeled" = trim succeeded but the file is smaller than the format
   * asked for (the farm's host pool is inconsistent — measured live). */
  const tryFarmSource = async (fmt: "4k" | "1080"): Promise<"ok" | "mislabeled" | "failed"> => {
    try {
      job.status = "running";
      job.stage = fmt === "4k" ? "Farm: rendering full source (4K)" : "Farm: rendering full source (1080p)";
      job.progress = 25;
      job.log.push(
        fmt === "4k"
          ? "[fclip] 4K farm — queueing the full source for a TRUE 2160p render (no cookies)…"
          : "[fclip] 4K farm — queueing the full source for a 1080p render…"
      );
      const render = await savenowRender(videoId, fmt, {
        timeoutMs: 10 * 60_000,
        onProgress: (pct, text) => {
          if (pct >= 0) job.progress = Math.min(58, 25 + Math.round(pct * 0.33));
          if (text) job.stage = `Farm: rendering ${fmt === "4k" ? "4K" : "1080p"} (${text.slice(0, 40)})`;
        },
      });
      if ((job.status as string) === "canceled") return "failed";
      job.log.push(`[fclip] farm returned ${render.fullFormat} — stream-trimming the range (no temp file)…`);
      job.stage = "Farm: stream-trimming the range";
      job.progress = 62;
      const ok = await streamTrimFromUrl(job, render.url, params.start, dur, dir);
      if (!ok) {
        job.log.push("[fclip] farm stream-trim failed — trying next lane…");
        return "failed";
      }
      // The farm's rotating hosts are NOT consistent: the same "4k" render
      // sometimes delivers an h264 1080p file (measured live). A 4K pick
      // only accepts a real ≥1440p file — otherwise drop it and let the
      // ladder deliver an honestly-labeled 1080p60 instead.
      if (fmt === "4k") {
        const clips = readdirSync(dir).filter((f) => f.startsWith("clip.") && !f.endsWith(".part"));
        const clipPath = clips.length > 0 ? path.join(dir, clips[0]) : null;
        const height = clipPath ? await probeMediaHeight(clipPath) : null;
        if (height !== null && height < 1440) {
          job.log.push(
            `[fclip] farm served a ${height}p file labeled 2160p — discarding it, degrading honestly…`
          );
          for (const f of clips) {
            try {
              rmSync(path.join(dir, f), { force: true });
            } catch {
              /* best effort */
            }
          }
          return "mislabeled";
        }
      }
      job.stage = "Finalizing";
      job.progress = 100;
      return "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      job.log.push(`[fclip] ${fmt === "4k" ? "4K" : "1080p"} farm unavailable: ${msg.slice(0, 140)}`);
      return "failed";
    }
  };

  /* ---- 1080p60 render farm: server-side cut of just the range ---- */
  const tryFarm1080 = async (): Promise<boolean> => {
    try {
      job.status = "running";
      job.stage = "Farm: rendering HD clip (1080p60)";
      job.progress = 55;
      job.log.push("[fclip] HD render farm — sending the range for a true 1080p60 cut…");
      const clip = await vlCreateClip(videoId, params.start, params.end, {
        timeoutMs: Math.min(900_000, 240_000 + clipLen * 500),
      });
      if ((job.status as string) === "canceled") return false;
      job.log.push(`[fclip] render farm returned ${clip.quality} ${clip.format} — downloading the finished clip…`);
      job.stage = "Farm: downloading rendered clip";
      job.progress = 75;
      const ok = await downloadTunnelFile(job, clip.url, path.join(dir, "clip.mp4"));
      if (!ok) {
        job.log.push("[fclip] rendered clip download failed — trying next lane…");
        return false;
      }
      job.stage = "Finalizing";
      job.progress = 100;
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      job.log.push(`[fclip] HD render farm unavailable (${msg.slice(0, 140)}) — trying next lane…`);
      return false;
    }
  };

  if (want4k) {
    let r = await tryFarmSource("4k");
    if (r === "mislabeled") {
      // Fresh request → fresh host roll; one retry is worth it for 4K.
      job.log.push("[fclip] retrying the 4K farm once (host pool is inconsistent)…");
      r = await tryFarmSource("4k");
    }
    if (r === "ok") {
      await finalizeJob(job, dir);
      return;
    }
    // Every 4K lane refused: degrade to true 1080p60 — never 360p.
    if (await tryFarm1080()) {
      await finalizeJob(job, dir);
      return;
    }
    if ((await tryFarmSource("1080")) === "ok") {
      await finalizeJob(job, dir);
      return;
    }
  } else {
    // 1080p60 on the FIRST TRY for everything ≤1080p.
    if (await tryFarm1080()) {
      await finalizeJob(job, dir);
      return;
    }
    // HD farm refused (credits gate, walled range…) — the savenow farm
    // renders the source in 1080p and we stream-trim the range. No disk
    // needed, so ranges anywhere in the source work.
    if ((await tryFarmSource("1080")) === "ok") {
      await finalizeJob(job, dir);
      return;
    }
  }

  job.status = "error";
  job.error =
    "All render lanes refused this clip. The 4K farm may be out of quota (its key needs a top-up) and the HD farm rejected the range — try again in a minute, or pick a shorter range.";
  job.stage = "Failed";
}

/* ------------------------------------------------------------------ */
/* Downloads + cutting                                                */
/* ------------------------------------------------------------------ */

/** Stream a farm URL to disk with download progress (0–90%).
 *  maxBytes: abort once the partial file reaches this size and report
 *  SUCCESS — moov-at-head mp4s stay cuttable, so a ranged cut only needs
 *  the prefix covering its range (measured: ENOSPC on Railway).
 *  partialOk: a non-zero exit with bytes already on disk counts as success
 *  (the farm's rotating hosts RST mid-transfer under load). */
async function downloadTunnelFile(
  job: ClipJob,
  url: string,
  dest: string,
  opts: { maxBytes?: number; partialOk?: boolean } = {}
): Promise<boolean> {
  // curl first — battle-tested against odd TLS/CDN setups and it streams
  // straight to disk with parseable progress. If curl is missing the spawn
  // fires "error" and we fall through to native fetch.
  {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "curl",
        ["-sS", "-L", "--fail", "--max-time", "900", "--retry", "2", "-#", "-o", dest, url],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      job.proc = child;
      let buf = "";
      let capHit = false;
      let capTimer: ReturnType<typeof setInterval> | null = null;
      if (opts.maxBytes && opts.maxBytes > 0) {
        capTimer = setInterval(() => {
          try {
            if (statSync(dest).size >= (opts.maxBytes ?? 0)) {
              capHit = true;
              try {
                child.kill("SIGKILL");
              } catch {
                /* already dead */
              }
            }
          } catch {
            /* file not created yet */
          }
        }, 400);
      }
      child.stderr?.on("data", (d) => {
        buf += d.toString();
        const m = /(\d+(?:\.\d+)?)%/.exec(buf);
        if (m) {
          job.progress = Math.min(88, Math.round(parseFloat(m[1]) * 0.88));
          buf = buf.slice(-40);
        }
      });
      child.on("error", () => {
        if (capTimer) clearInterval(capTimer);
        resolve(false);
      });
      child.on("close", (code) => {
        if (capTimer) clearInterval(capTimer);
        if ((job.status as string) === "canceled") return resolve(false);
        if (capHit) {
          job.log.push(`[fclip] prefix cap reached (${Math.round((opts.maxBytes ?? 0) / 1e6)} MB) — enough for the cut`);
          return resolve(true);
        }
        let size = 0;
        try {
          size = statSync(dest).size;
        } catch {
          /* no file */
        }
        if (code === 0 && size > 0) return resolve(true);
        if (opts.partialOk && size > 0) {
          job.log.push(`[fclip] partial download kept (${Math.round(size / 1e6)} MB on disk, moov-at-head cuttable)`);
          return resolve(true);
        }
        resolve(false);
      });
    });
    if (ok) return true;
    job.log.push("[fclip] curl download failed — trying native fetch…");
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15 * 60_000),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) fclip/1.0" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      job.log.push(`[fclip] farm responded HTTP ${res.status}`);
      return false;
    }
    const total = Number(res.headers.get("content-length") ?? "0");
    let got = 0;
    let capped = false;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        if (capped) return;
        got += chunk.byteLength;
        if (opts.maxBytes && got >= opts.maxBytes) {
          capped = true;
          ctrl.terminate();
          return;
        }
        if (total > 0) job.progress = Math.min(90, Math.round((got / total) * 90));
        else job.progress = Math.min(85, Math.round(got / 2_000_000));
        ctrl.enqueue(chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body.pipeThrough(counter) as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(dest)
      );
    } catch (e) {
      if (!capped) {
        if (opts.partialOk && got > 0) {
          job.log.push(`[fclip] partial download kept (${Math.round(got / 1e6)} MB on disk, moov-at-head cuttable)`);
          return true;
        }
        throw e;
      }
      job.log.push(`[fclip] prefix cap reached (${Math.round((opts.maxBytes ?? 0) / 1e6)} MB) — enough for the cut`);
    }
    return got > 0;
  } catch (e) {
    if ((job.status as string) !== "canceled") {
      const msg = e instanceof Error ? e.message : String(e);
      job.log.push(`[fclip] download error: ${msg.slice(0, 160)}`);
    }
    return false;
  }
}

/**
 * STREAM-TRIM: pipe the farm's whole-source download through ffmpeg and
 * stream-copy just [startSec, startSec+durSec] into clip.mp4.
 *
 * The farm's hosts ignore HTTP Range (measured), so seeking means reading
 * from byte 0 — fine: ffmpeg reads the pipe LINEARLY (mp4 with moov at head
 * needs no seek to demux) and OUTPUT-side -ss drops every packet before the
 * range, stream-copying the rest. Measured live: a 60s-in range from a
 * 1080p whole-source render came back as an exact 9.99s h264 1080p60 clip,
 * ~2 MB, no temp file. NOTE: input-side -ss (demuxer index seek) FAILS on
 * a pipe ("partial file") — never move -ss before -i here.
 * Farm output is AV1+AAC (4K) or h264+AAC (1080) in mp4 — mp4 out, no mux
 * surprises.
 */
async function streamTrimFromUrl(
  job: ClipJob,
  url: string,
  startSec: number,
  durSec: number,
  dir: string
): Promise<boolean> {
  const out = path.join(dir, "clip.mp4");
  return new Promise<boolean>((resolve) => {
    const curl = spawn(
      "curl",
      ["-sS", "-L", "--fail", "--max-time", "900", "-o", "-", url],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const ff = spawn(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y",
        "-i", "pipe:0",
        // OUTPUT-side seek: linear read + packet drop (input-side seek would
        // need a seekable stream and dies on the pipe).
        "-ss", String(startSec),
        "-t", String(durSec),
        "-c", "copy",
        "-movflags", "faststart",
        out,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    job.proc = ff;

    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { curl.kill("SIGKILL"); } catch { /* already dead */ }
      try { ff.kill("SIGKILL"); } catch { /* already dead */ }
      if (!ok) {
        try { rmSync(out, { force: true }); } catch { /* best effort */ }
      }
      resolve(ok);
    };
    // Overall guard — farm downloads can stall; never wedge the job.
    const guard = setTimeout(() => {
      job.log.push("[fclip] stream-trim timed out");
      done(false);
    }, 15 * 60_000);

    let curlBytes = 0;
    curl.stdout.on("data", (d) => {
      curlBytes += d.length;
      // ffmpeg is reading/discarding the source prefix — show movement
      if (curlBytes > 4e6 && job.progress < 70) {
        job.progress = Math.min(70, 62 + Math.round(curlBytes / 8e6));
      }
    });
    curl.stdout.pipe(ff.stdin);
    curl.stderr?.on("data", (d) => {
      const l = d.toString().trim();
      if (l) job.log.push(`[farm-curl] ${l.slice(0, 200)}`);
    });
    curl.on("error", (e) => {
      job.log.push(`[fclip] farm download error: ${String(e.message).slice(0, 140)}`);
      done(false);
    });

    let ffErr = "";
    ff.stdout?.on("data", (d) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString());
      if (m) {
        const t = Number(m[1]) / 1e6;
        if (Number.isFinite(t) && durSec > 0) {
          job.progress = Math.min(96, Math.max(70, Math.round((t / durSec) * 34) + 62));
        }
      }
    });
    ff.stderr?.on("data", (d) => {
      ffErr += d.toString();
      if (ffErr.length > 4000) ffErr = ffErr.slice(-4000);
    });
    ff.on("error", () => done(false));
    ff.on("close", async (code) => {
      if (settled) return;
      if ((job.status as string) === "canceled") return done(false);
      if (code !== 0) {
        job.log.push(`[fclip] stream-trim ffmpeg exited ${code}: ${ffErr.trim().slice(-160)}`);
        return done(false);
      }
      // Verify the trimmed cut actually covers the requested range.
      const gotDur = await probeMediaDuration(out);
      if (gotDur === null || gotDur < durSec * 0.8) {
        job.log.push(
          `[fclip] stream-trim came back short (${gotDur?.toFixed(1) ?? "?"}s of ${durSec.toFixed(0)}s)`
        );
        return done(false);
      }
      done(true);
    });
  });
}


async function finalizeJob(job: ClipJob, dir: string) {
  try {
    const files = readdirSync(dir).filter((f) => f.startsWith("clip.") && !f.endsWith(".part"));
    if (files.length === 0) {
      job.status = "error";
      job.error = "Clip finished but no output file was produced.";
      job.stage = "Failed";
      return;
    }
    const best = files
      .map((f) => ({ f, s: statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.s - a.s)[0];
    job.filename = best.f;
    job.filesize = best.s;
    try {
      const out = await probeMediaDuration(path.join(dir, best.f));
      job.clipDuration = out;
    } catch {
      job.clipDuration = null;
    }
    job.status = "done";
    job.stage = "Done";
    job.progress = 100;
  } catch {
    job.status = "error";
    job.error = "Unexpected error while locating the output file.";
    job.stage = "Failed";
  }
}

async function probeMediaDuration(source: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-print_format", "json", "-show_format", "-i", source],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const probe = JSON.parse(stdout) as { format?: { duration?: string } };
    const d = parseFloat(probe?.format?.duration ?? "0");
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Video height of the first stream (ffprobe; null when unreadable). */
async function probeMediaHeight(source: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", source],
      { timeout: 30_000 }
    );
    const h = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(h) && h > 0 ? h : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Job management                                                     */
/* ------------------------------------------------------------------ */

export function serializeJob(job: ClipJob) {
  const { proc, log, ...rest } = job;
  void proc;
  return { ...rest, logTail: log.slice(-30) };
}

export function getJob(id: string): ClipJob | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 12): ClipJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.proc) {
    job.status = "canceled";
    job.stage = "Canceled";
    job.error = null;
    try {
      job.proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          job.proc?.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000);
    } catch {
      /* already dead */
    }
    const dir = path.join(CLIPS_DIR, id);
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 1500);
    return true;
  }
  if (job.status === "done" || job.status === "error" || job.status === "canceled") {
    removeJob(id);
    return true;
  }
  return false;
}

export function removeJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.proc) {
    try {
      job.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(path.join(CLIPS_DIR, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  jobs.delete(id);
  return true;
}

export function cleanupOldJobs() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running" && j.status !== "queued")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const j of finished) {
    if (now - j.createdAt > TWO_HOURS || finished.length > 15) {
      removeJob(j.id);
    }
  }
  // Disk guard: cap finished clips at ~1.5 GB total AND keep real free
  // space on the filesystem. Two hard lessons from live traffic:
  //  1. NEVER remove queued/running jobs — their dir holds the clip being
  //     written right now.
  //  2. The free target must be PROPORTIONAL to the volume — target =
  //     max(300 MB, 8% of volume), capped at 450 MB — enough headroom for
  //     the 4K prefix download.
  try {
    const freeNow = (): number => {
      try {
        const s = statfsSync(CLIPS_DIR);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return Infinity;
      }
    };
    let target = 450e6;
    try {
      const s = statfsSync(CLIPS_DIR);
      const volume = Number(s.blocks) * Number(s.bsize);
      target = Math.min(450e6, Math.max(300e6, volume * 0.08));
    } catch {
      /* keep the default target */
    }
    let total = 0;
    const entries: { id: string; size: number; mtime: number }[] = [];
    for (const dir of readdirSync(CLIPS_DIR)) {
      try {
        const st = statSync(path.join(CLIPS_DIR, dir));
        let size = 0;
        for (const f of readdirSync(path.join(CLIPS_DIR, dir))) {
          size += statSync(path.join(CLIPS_DIR, dir, f)).size;
        }
        total += size;
        entries.push({ id: dir, size, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    let free = freeNow();
    let guard = 200; // absolute bound on pruning iterations
    while ((total > 1.5e9 || free < target) && entries.length > 0 && guard-- > 0) {
      const oldest = entries.shift() as { id: string; size: number };
      const job = jobs.get(oldest.id);
      if (job && (job.status === "running" || job.status === "queued")) {
        continue; // live work — never touch, never count as freed
      }
      if (job) removeJob(oldest.id);
      else {
        try {
          rmSync(path.join(CLIPS_DIR, oldest.id), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      total -= oldest.size;
      free = freeNow();
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Demo video                                                         */
/* ------------------------------------------------------------------ */

export async function ensureDemoVideo(): Promise<string> {
  if (!existsSync(DEMO_PATH)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG, [
        "-y",
        "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=45",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=45",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "faststart", "-shortest",
        DEMO_PATH,
      ]);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      child.on("error", reject);
    });
  }
  return DEMO_PATH;
}

/* ------------------------------------------------------------------ */
/* Engine status                                                      */
/* ------------------------------------------------------------------ */

export function getBinaryPaths() {
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

export function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

export function engineMissingMessage(): string {
  const base =
    "The fclip server is missing ffmpeg/ffprobe. fclip needs a host that runs Docker or a long-lived Node process — Railway, Render, Fly.io, a VPS, or your own computer. Serverless platforms (Vercel, Netlify, Cloudflare) cannot run these binaries.";
  return isVercel() ? "This deployment is on Vercel, which can't run ffmpeg. " + base : base;
}

export interface EngineStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  /** True when a registered savenow/video-download-api.com key is configured. */
  farmKey: boolean;
}

async function probeBin(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Cheap, cached reachability check of the ffmpeg engine + farm key. */
export async function checkEngine(force = false): Promise<EngineStatus> {
  const cached = g.__fclipEngine;
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
  const status: EngineStatus = {
    ffmpeg: await probeBin(FFMPEG, ["-version"]),
    ffprobe: await probeBin(FFPROBE, ["-version"]),
    farmKey: Boolean(process.env.FCLIP_SAVENOW_API_KEY?.trim()),
  };
  g.__fclipEngine = { at: Date.now(), status };
  return status;
}

/** Lane summary for diagnostics (no secrets). */
export function farmStatus() {
  return {
    hdLane: "videolimit.com → clipscutter render farm (1080p60, first try)",
    fourKLane: "p.savenow.to / loader.to backend (TRUE 2160p, API key)",
    fourKKeyConfigured: Boolean(process.env.FCLIP_SAVENOW_API_KEY?.trim()),
  };
}
