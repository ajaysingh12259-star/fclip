import { spawn, execFile, execFileSync, type ChildProcess } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

export const DATA_DIR = path.join(process.cwd(), ".data");
export const CLIPS_DIR = path.join(DATA_DIR, "clips");
export const COOKIES_PATH = path.join(DATA_DIR, "cookies.txt");
export const DEMO_PATH = path.join(DATA_DIR, "demo.mp4");

mkdirSync(CLIPS_DIR, { recursive: true });

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function findYtDlp(): string {
  return (
    firstExisting([
      process.env.YTDLP_PATH,
      "/home/z/.venv/bin/yt-dlp",
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "/opt/homebrew/bin/yt-dlp",
    ]) ?? "yt-dlp"
  );
}

function findFfmpeg(): string {
  return (
    firstExisting([
      process.env.FFMPEG_PATH,
      "/usr/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/opt/homebrew/bin/ffmpeg",
    ]) ?? "ffmpeg"
  );
}

function findFfprobe(): string {
  return (
    firstExisting([
      process.env.FFPROBE_PATH,
      "/usr/bin/ffprobe",
      "/usr/local/bin/ffprobe",
    ]) ?? "ffprobe"
  );
}

const YT_DLP = findYtDlp();
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
  webpageUrl: string;
}

/* ------------------------------------------------------------------ */
/* Job store (in-memory, survives module reloads via globalThis)      */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as {
  __fclipJobs: Map<string, ClipJob> | undefined;
  __fclipOptArgsOk: boolean | undefined;
};

const jobs: Map<string, ClipJob> = (g.__fclipJobs ??= new Map());

function getOptArgsOk(): boolean {
  return g.__fclipOptArgsOk ?? true;
}

function setOptArgsOk(v: boolean) {
  g.__fclipOptArgsOk = v;
}

/* ------------------------------------------------------------------ */
/* yt-dlp invocation helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Optional flags that improve compatibility but may not exist on older
 * yt-dlp versions. If yt-dlp rejects them we retry once without them.
 */
function optionalArgs(): string[][] {
  if (!getOptArgsOk()) return [];
  return [["--js-runtimes", "bun"], ["--remote-components", "ejs:github"]];
}

function impersonateArgs(): string[] {
  return ["--extractor-args", "generic:impersonate"];
}

/** Local test URLs must not use browser impersonation (it breaks against the dev server). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h === "0.0.0.0";
  } catch {
    return false;
  }
}

function cookieArgs(): string[] {
  return existsSync(COOKIES_PATH) ? ["--cookies", COOKIES_PATH] : [];
}

function coreArgs(): string[] {
  return [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "30",
    "--retries",
    "5",
    "--ffmpeg-location",
    path.dirname(FFMPEG),
  ];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runYtDlp(args: string[], timeoutMs: number, url?: string): Promise<RunResult> {
  const useOptional = getOptArgsOk();
  let r = await runOnce(useOptional, false, args, timeoutMs);
  const combined = r.stdout + r.stderr;
  if (
    useOptional &&
    r.code !== 0 &&
    /unrecognized arguments|no such option|unknown option|invalid choice/i.test(combined)
  ) {
    // Older yt-dlp without the optional flags — remember and retry without them.
    setOptArgsOk(false);
    r = await runOnce(false, false, args, timeoutMs);
  }
  // Cloudflare-protected direct URLs need browser impersonation — retry once with it.
  if (
    r.code !== 0 &&
    !isLocalUrl(url ?? "") &&
    /Cloudflare anti-bot challenge|impersonation dependency/i.test(r.stderr + r.stdout)
  ) {
    const r2 = await runOnce(getOptArgsOk(), true, args, timeoutMs);
    if (r2.code === 0) return r2;
  }
  return r;
}

function runOnce(useOptional: boolean, impersonate: boolean, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const full = [
      ...coreArgs(),
      ...(useOptional ? optionalArgs().flat() : []),
      ...(impersonate ? impersonateArgs() : []),
      ...cookieArgs(),
      ...args,
    ];
    const child = spawn(YT_DLP, full, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Info extraction                                                    */
/* ------------------------------------------------------------------ */

interface RawFormat {
  height?: number;
  tbr?: number;
  ext?: string;
  vcodec?: string;
  acodec?: string;
}

interface RawInfo {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  view_count?: number;
  upload_date?: string;
  is_live?: boolean;
  chapters?: { start_time?: number; end_time?: number; title?: string }[];
  formats?: RawFormat[];
  webpage_url?: string;
}

export function classifyError(stderrTail: string): { code: string; message: string } {
  const s = stderrTail.toLowerCase();
  if (s.includes("sign in to confirm") || s.includes("not a bot")) {
    return {
      code: "bot_check",
      message:
        "YouTube is asking this server to verify it is not a bot (common for cloud IPs). You can fix this by adding your browser cookies below, or run fclip locally where your own IP is used.",
    };
  }
  if (s.includes("video unavailable") || s.includes("not available")) {
    return { code: "unavailable", message: "This video is unavailable (removed, private, or region-locked)." };
  }
  if (s.includes("private video")) {
    return { code: "private", message: "This video is private. If it is yours, cookies with access can unlock it." };
  }
  if (s.includes("age-restricted") || s.includes("confirm your age") || s.includes("inappropriate")) {
    return { code: "age_locked", message: "Age-restricted video — add your cookies in Settings to access it." };
  }
  if (s.includes("timed out") || s.includes("timeout") || s.includes("unreachable")) {
    return { code: "network", message: "Network error while contacting the video host. Please try again." };
  }
  return { code: "unknown", message: "Could not fetch video info. Double-check the link and try again." };
}

export async function fetchInfo(url: string): Promise<{ ok: true; info: VideoInfo } | { ok: false; error: { code: string; message: string }; detail?: string }> {
  const res = await runYtDlp(["-J", "--no-playlist", url], 180_000, url);
  if (res.timedOut) {
    return { ok: false, error: { code: "timeout", message: "Fetching video info timed out. Please try again." } };
  }
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout).split("\n").filter(Boolean).slice(-3).join(" ");
    return { ok: false, error: classifyError(tail), detail: tail.slice(-500) };
  }
  let raw: RawInfo;
  try {
    raw = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
  } catch {
    return { ok: false, error: { code: "parse", message: "Unexpected response from yt-dlp. Please try again." } };
  }
  const formats = (raw.formats ?? []).filter((f) => f.vcodec && f.vcodec !== "none" && f.height);
  const byHeight = new Map<number, { height: number; tbr: number | null; ext: string }>();
  for (const f of formats) {
    const h = f.height as number;
    const prev = byHeight.get(h);
    if (!prev || (f.tbr ?? 0) > (prev.tbr ?? 0)) {
      byHeight.set(h, { height: h, tbr: f.tbr ?? null, ext: f.ext ?? "mp4" });
    }
  }
  const qualities = [...byHeight.values()].sort((a, b) => b.height - a.height).slice(0, 8);

  // Duration fallback: generic direct-media URLs often lack duration in the initial
  // extraction — probe the stream with ffprobe (async: never block the event loop).
  let duration = Math.round(raw.duration ?? 0);
  if (!duration || duration <= 0) {
    duration = (await probeMediaDuration(url)) ?? 0;
  }

  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(raw.webpage_url ?? url);
  const ytThumb =
    isYouTube && raw.id && /^[\w-]{11}$/.test(raw.id)
      ? `https://i.ytimg.com/vi/${raw.id}/maxresdefault.jpg`
      : null;
  const thumbnail = raw.thumbnail ?? ytThumb;
  const info: VideoInfo = {
    id: raw.id ?? null,
    title: raw.title ?? "Untitled video",
    channel: raw.channel ?? raw.uploader ?? null,
    duration,
    thumbnail,
    viewCount: raw.view_count ?? null,
    uploadDate: raw.upload_date ?? null,
    isLive: raw.is_live ?? false,
    chapters: (raw.chapters ?? [])
      .filter((c) => typeof c.start_time === "number" && typeof c.end_time === "number")
      .map((c) => ({ start: c.start_time as number, end: c.end_time as number, title: c.title ?? "Chapter" })),
    qualities,
    webpageUrl: raw.webpage_url ?? url,
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

function formatSelector(maxHeight: number | null): string {
  if (maxHeight === null) return "bv*+ba/b";
  if (maxHeight >= 1440) {
    // 1440p+/4K on YouTube are VP9/AV1 (webm); let yt-dlp pick a compatible container.
    return `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  }
  return `bv*[ext=mp4][height<=${maxHeight}]+ba[ext=m4a]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
}

function fmtClock(t: number): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${sec.padStart(5, "0")}`;
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

  const args = [
    "--newline",
    "--no-part",
    "-f",
    formatSelector(params.maxHeight),
    "--download-sections",
    `*${fmtClock(params.start)}-${fmtClock(params.end)}`,
    ...(params.precise ? ["--force-keyframes-at-cuts"] : []),
    ...cookieArgs(),
    "-o",
    path.join(dir, "clip.%(ext)s"),
    params.url,
  ];

  const child = spawn(YT_DLP, [...coreArgs(), ...optionalArgs().flat(), ...(isLocalUrl(params.url) ? [] : impersonateArgs()), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.proc = child;
  job.status = "running";
  job.stage = "Resolving video streams";

  const pushLine = (line: string) => {
    const l = line.trim();
    if (!l) return;
    job.log.push(l);
    if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    const dl = l.match(/^\[download\]\s+([\d.]+)%/);
    if (dl) {
      job.status = "running";
      job.progress = Math.min(100, parseFloat(dl[1]));
      job.stage = job.stage.includes("audio")
        ? "Downloading audio stream"
        : "Downloading only the clip's byte-ranges";
      if (job.stage === "Resolving video streams") job.stage = "Downloading clip byte-ranges";
      return;
    }
    if (/Merging formats|Merger/i.test(l)) {
      job.stage = "Merging video + audio";
      job.progress = 100;
    } else if (/\[ffmpeg\]|Correcting container|force-keyframes/i.test(l)) {
      job.stage = "Processing with ffmpeg";
    } else if (/Downloading (webpage|player|api|formats|m3u8|manifest)/i.test(l)) {
      job.stage = "Resolving video streams";
    }
  };

  let stdoutBuf = "";
  child.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
    const parts = stdoutBuf.split("\n");
    stdoutBuf = parts.pop() ?? "";
    parts.forEach(pushLine);
  });
  let stderrBuf = "";
  child.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    const parts = stderrBuf.split("\n");
    stderrBuf = parts.pop() ?? "";
    parts.forEach((p) => pushLine(p));
  });

  child.on("close", (code) => {
    if (job.status === "canceled") return;
    job.proc = undefined;
    if (stderrBuf.trim()) pushLine(stderrBuf.trim());
    if (code === 0) {
      finalizeJob(job, dir);
    } else {
      job.status = "error";
      const tail = job.log.slice(-4).join(" ");
      job.error = classifyError(tail).message;
      job.stage = "Failed";
    }
  });

  return job;
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

function execFileSyncSafe(cmd: string, args: string[], timeoutMs = 15_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  } catch {
    return "{}";
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
  // Disk guard: cap finished clips at ~1.5 GB total.
  try {
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
    while (total > 1.5e9 && entries.length > 0) {
      const oldest = entries.shift() as { id: string; size: number };
      const job = jobs.get(oldest.id);
      if (job && job.status !== "running") removeJob(oldest.id);
      else if (!job) {
        try {
          rmSync(path.join(CLIPS_DIR, oldest.id), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      total -= oldest.size;
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

export function getBinaryPaths() {
  return { ytDlp: YT_DLP, ffmpeg: FFMPEG, ffprobe: FFPROBE };
}
