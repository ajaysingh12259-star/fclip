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
function cachedSourceDuration(videoId: string): number | null {
  const r = g.__fclipDuration;
  if (r && r.videoId === videoId && Date.now() - r.at < 30 * 60_000) return r.duration;
  return null;
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
 * 1KB/1s header probe — sanity check that a farm URL serves bytes.
 */
async function urlServesBytes(url: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-sS", "-L", "--fail", "--max-time", "15", "-r", "0-1023", "-o", "/dev/null", "-w", "%{http_code}", url],
      { timeout: 20_000, encoding: "utf8" }
    );
    const code = Number.parseInt(stdout.trim(), 10);
    return code === 200 || code === 206;
  } catch {
    return false;
  }
}

/** Free bytes on the filesystem holding p (statfsSync with a df fallback). */
async function freeDiskBytes(p: string): Promise<number> {
  try {
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    try {
      const { stdout } = await execFileAsync("df", ["-k", "-P", p], { timeout: 8_000 });
      const cols = (stdout.trim().split("\n").pop() ?? "").split(/\s+/);
      const availKb = Number.parseInt(cols[3] ?? "0", 10);
      return Number.isFinite(availKb) ? availKb * 1024 : 0;
    } catch {
      return 0;
    }
  }
}

/**
 * THE LADDER.
 *  - 4K/2K picks: savenow 4K farm (registered API key) → degrade 1080p60.
 *  - ≤1080p picks: VideoLimit 1080p60 render FIRST TRY → (rare fallback)
 *    savenow 4K render + local range cut.
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
  if (job.status === "canceled") return;

  const want4k = params.maxHeight != null && params.maxHeight >= 1440;
  const clipLen = params.end - params.start;

  /* ---- 4K farm: whole-source render + local range cut ---- */
  const tryFarm4k = async (): Promise<boolean> => {
    try {
      job.status = "running";
      job.stage = "Farm: rendering full source (4K)";
      job.progress = 25;
      job.log.push("[fclip] 4K farm — queueing the full source for a TRUE 2160p render (no cookies)…");
      const render = await savenowRender(videoId, "4k", {
        timeoutMs: 10 * 60_000,
        onProgress: (pct, text) => {
          if (pct >= 0) job.progress = Math.min(58, 25 + Math.round(pct * 0.33));
          if (text) job.stage = `Farm: rendering 4K (${text.slice(0, 40)})`;
        },
      });
      if ((job.status as string) === "canceled") return false;
      job.log.push(`[fclip] 4K farm returned ${render.fullFormat} — streaming the needed prefix…`);
      job.stage = "Farm: downloading rendered source";
      job.progress = 60;

      // The farm serves the WHOLE source with no Range support; a full 2160p
      // render can blow the volume (measured: ENOSPC on Railway). The mp4 is
      // moov-at-head, so a truncated prefix stays cuttable — fetch only the
      // bytes covering [start, start+dur+8s], capped by disk headroom.
      // AV1 2160p60 worst case ≈ 5.2 MB/s of source time + 24 MB moov slack.
      cleanupOldJobs();
      const free = await freeDiskBytes(CLIPS_DIR);
      const needBytes = Math.round((params.start + dur + 8) * 5.2e6) + 24e6;
      const maxBytes = Math.max(48e6, Math.min(needBytes, Math.max(0, free - 150e6)));
      job.log.push(
        `[fclip] prefix cap ${Math.round(maxBytes / 1e6)} MB (need ${Math.round(needBytes / 1e6)} MB, disk free ${Math.round(free / 1e6)} MB)`
      );
      const full = path.join(dir, `farm-${videoId}.mp4`);
      const ok = await downloadTunnelFile(job, render.url, full, { maxBytes, partialOk: true });
      if (!ok) {
        try {
          rmSync(full, { force: true });
        } catch {
          /* best effort */
        }
        job.log.push("[fclip] 4K render download failed — trying next lane…");
        return false;
      }
      if ((job.status as string) === "canceled") return false;
      job.stage = "Farm: cutting the range locally";
      job.progress = 95;
      await ffmpegLocalCut(job, full, params.start, dur, dir);
      try {
        rmSync(full, { force: true });
      } catch {
        /* best effort */
      }
      // A disk-capped prefix can truncate the range: verify the cut covers
      // the request, else fall down the ladder.
      const clips = readdirSync(dir)
        .filter((f) => f.startsWith("clip.") && !f.endsWith(".part"))
        .map((f) => path.join(dir, f))
        .sort((a, b) => statSync(b).size - statSync(a).size);
      const gotDur = clips.length > 0 ? await probeMediaDuration(clips[0]) : null;
      if (gotDur === null || gotDur >= dur * 0.8) {
        job.stage = "Finalizing";
        job.progress = 100;
        return true;
      }
      job.log.push(
        `[fclip] 4K cut came back short (${gotDur.toFixed(1)}s of ${dur.toFixed(0)}s — disk cap hit) — falling back…`
      );
      for (const f of clips) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* best effort */
        }
      }
      return false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      job.log.push(`[fclip] 4K farm unavailable: ${msg.slice(0, 140)}`);
      return false;
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
    if (await tryFarm4k()) {
      await finalizeJob(job, dir);
      return;
    }
    // Every 4K lane refused: degrade to the true 1080p60 render — never 360p.
    if (await tryFarm1080()) {
      await finalizeJob(job, dir);
      return;
    }
  } else {
    // 1080p60 on the FIRST TRY for everything ≤1080p.
    if (await tryFarm1080()) {
      await finalizeJob(job, dir);
      return;
    }
    // Rare fallback: the 4K farm + local cut still delivers. Only sane when
    // the needed prefix actually fits the disk.
    const free = await freeDiskBytes(CLIPS_DIR);
    const needBytes = Math.round((params.start + dur + 8) * 5.2e6) + 24e6;
    if (needBytes <= free - 150e6) {
      if (await tryFarm4k()) {
        await finalizeJob(job, dir);
        return;
      }
    } else {
      job.log.push(
        `[fclip] 4K fallback skipped — prefix needs ${Math.round(needBytes / 1e6)} MB but only ${Math.round(free / 1e6)} MB free`
      );
    }
  }

  job.status = "error";
  job.error =
    "Both render lanes refused this clip. The 4K farm may be out of quota (its key needs a top-up) and the HD farm rejected the range — try again in a minute, or pick a shorter range.";
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

/** Stream-copy the selected range out of a local file (fast, lossless). */
async function ffmpegLocalCut(job: ClipJob, src: string, start: number, dur: number, dir: string): Promise<void> {
  // Container must follow BOTH codecs: the 4K farm hands us AV1 + AAC — AAC
  // is NOT valid in WebM, so an AV1+AAC source must stay mp4. VP9/Opus
  // sources (relay tunnels of the past) went webm.
  let ext = "mp4";
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", src],
      { timeout: 15_000 }
    );
    const codecs = stdout
      .trim()
      .split("\n")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const v = codecs.find((c) => /^(h264|hevc|vp8|vp9|av1|mpeg4)$/.test(c)) ?? "";
    const a = codecs.find((c) => /^(aac|opus|vorbis|mp3|flac)$/.test(c)) ?? "";
    if (/^(vp8|vp9|av1)$/.test(v) && (a === "" || /^(opus|vorbis)$/.test(a))) ext = "webm";
  } catch {
    /* probe failed — default to mp4 */
  }
  const out = path.join(dir, ext === "webm" ? "clip.webm" : "clip.mp4");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error", "-nostats", "-y",
        "-ss", String(start),
        "-i", src,
        "-t", String(dur),
        "-c", "copy",
        ...(ext === "webm" ? [] : ["-movflags", "faststart"]),
        out,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    job.proc = child;
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((job.status as string) === "canceled") return resolve();
      if (code === 0) resolve();
      else reject(new Error(`local cut ffmpeg exited ${code}: ${err.trim().slice(-180)}`));
    });
  });
  if ((job.status as string) === "canceled") return;
  job.stage = "Processing with ffmpeg";
  job.progress = 100;
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
