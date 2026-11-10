import { spawn, execFile, execFileSync, type ChildProcess } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync, createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  fetchRelayInfo,
  fetchCobaltTunnels,
  pickRelayMedia,
  extractVideoId,
  type RelayFormat,
  type RelayInfo,
  type CobaltMedia,
} from "@/lib/instances";

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

export const DATA_DIR = process.env.FCLIP_DATA_DIR
  ? path.resolve(process.env.FCLIP_DATA_DIR)
  : path.join(process.cwd(), ".data");
export const CLIPS_DIR = path.join(DATA_DIR, "clips");
export const COOKIES_PATH = path.join(DATA_DIR, "cookies.txt");
export const DEMO_PATH = path.join(DATA_DIR, "demo.mp4");

mkdirSync(CLIPS_DIR, { recursive: true });

/* Cloud deploys (Railway / Render / Fly / VPS): paste a cookies.txt export into
 * the FCLIP_YT_COOKIES (or YOUTUBE_COOKIES / YTDLP_COOKIES) env var and fclip
 * materializes it as cookies.txt at boot. A file uploaded through the UI wins
 * if one is already present. */
const ENV_COOKIES =
  process.env.FCLIP_YT_COOKIES ?? process.env.YOUTUBE_COOKIES ?? process.env.YTDLP_COOKIES;
if (ENV_COOKIES && ENV_COOKIES.trim()) {
  try {
    if (!existsSync(COOKIES_PATH)) {
      let c = ENV_COOKIES.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t").trim();
      if (!c.startsWith("# Netscape")) c = `# Netscape HTTP Cookie File\n${c}`;
      writeFileSync(COOKIES_PATH, c.endsWith("\n") ? c : `${c}\n`, { mode: 0o600 });
    }
  } catch {
    /* non-fatal — yt-dlp will simply run without cookies */
  }
}

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function findYtDlp(): string {
  // An explicit override always wins — even if it doesn't exist — so a bad
  // YTDLP_PATH surfaces as a clear "engine missing" error instead of being
  // silently ignored in tests and CI.
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  return (
    firstExisting([
      "/home/z/.venv/bin/yt-dlp",
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "/opt/homebrew/bin/yt-dlp",
    ]) ?? "yt-dlp"
  );
}

function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return (
    firstExisting([
      "/usr/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/opt/homebrew/bin/ffmpeg",
    ]) ?? "ffmpeg"
  );
}

function findFfprobe(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  return (
    firstExisting([
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
  /** Set when extraction only succeeded via the bot-wall storm (no cookies): quality may be capped. */
  qualityHint?: string | null;
  /** Which pipeline served this info: direct yt-dlp, bot-wall storm, or cookie-less relay. */
  route?: "direct" | "storm" | "relay";
  webpageUrl: string;
}

/* ------------------------------------------------------------------ */
/* Job store (in-memory, survives module reloads via globalThis)      */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as {
  __fclipJobs: Map<string, ClipJob> | undefined;
  __fclipOptArgsOk: boolean | undefined;
  __fclipTvClientOk: boolean | undefined;
  __fclipMwebOk: boolean | undefined;
  __fclipStormClient: { at: number; client: string } | undefined;
  __fclipProxyOk: { at: number; ok: boolean } | undefined;
  __fclipEngine: { at: number; status: EngineStatus } | undefined;
  __fclipRelay: { at: number; videoId: string; formats: RelayFormat[]; duration: number | null } | undefined;
};

/* Relay formats from the last successful relay fetch — the clip job reuses
 * them (30 min TTL) so a video that fell back to the relay tier for info
 * also cuts through the relay without a second fan-out. */
function rememberRelayFormats(videoId: string, formats: RelayFormat[], duration: number | null = null) {
  g.__fclipRelay = { at: Date.now(), videoId, formats, duration };
}
function cachedRelayFormats(videoId: string): RelayFormat[] | null {
  const r = g.__fclipRelay;
  if (r && r.videoId === videoId && Date.now() - r.at < 30 * 60_000) return r.formats;
  return null;
}
function cachedRelayDuration(videoId: string): number | null {
  const r = g.__fclipRelay;
  if (r && r.videoId === videoId && Date.now() - r.at < 30 * 60_000) return r.duration;
  return null;
}

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
 * Previously we forced --js-runtimes bun + --remote-components ejs:github here.
 * Testing against YouTube's bot wall showed that forcing a JS runtime makes
 * yt-dlp prefer token-gated clients WITHOUT a working PO-token provider, which
 * *worsened* survival from datacenter IPs. The default client cascade plus the
 * bgutil PO-token provider (baked into the Docker image) performs best, so
 * these flags are gone. Everything here stays optional for old yt-dlp versions.
 */
function optionalArgs(): string[][] {
  if (!getOptArgsOk()) return [];
  return [];
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

/**
 * The YouTube `tv` / `android_vr` player clients frequently skip the
 * "Sign in to confirm you're not a bot" wall that cloud IPs get — try them
 * once before giving up so a fresh deployment can work with zero setup.
 */
// "No video formats found!" is a bot-wall variant: cookies on android-family
// clients and SABR-only responses from tv-family clients both yield metadata
// with an empty format list, so it must trigger the same retry ladder.
const BOT_WALL_RE = /sign in to confirm|not a bot|bot check|no video formats found/i;
const GVS_403_RE = /HTTP error 403|Server returned 403|Forbidden[\s\S]*googlevideo|googlevideo[\s\S]*403/i;

function tvClientArgs(): string[] {
  if (g.__fclipTvClientOk === false) return [];
  return ["--extractor-args", "youtube:player_client=tv,android_vr"];
}

/**
 * The `mweb` client works together with the bgutil PO-token provider for BOTH
 * the player request and the googlevideo media bytes (the tv/android_vr
 * clients can resolve metadata but their GVS URLs 403 without tokens).
 */
function mwebClientArgs(): string[] {
  if (g.__fclipMwebOk === false) return [];
  return ["--extractor-args", "youtube:player_client=mweb"];
}

/* ------------------------------------------------------------------ */
/* Bot-wall storm                                                     */
/* ------------------------------------------------------------------ */

/**
 * Brute-force the YouTube "sign in to confirm you're not a bot" wall from
 * datacenter IPs. The wall is probabilistic per request: measured from a
 * flagged IP, PARALLEL bursts of different player clients passed ~2/10 while
 * sequential retries passed 0/8. So: fire a burst of yt-dlp processes, each
 * claiming a different player identity, take the first breakthrough, kill
 * the rest, and persist the winner so later requests start from it.
 */
const STORM_CLIENTS_COOKIELESS = ["android_vr", "android", "ios"];
const STORM_CLIENTS_COOKIED = ["mweb", "web_safari", "tv"];
const STORM_PATH = path.join(DATA_DIR, "storm.json");

/* ------------------------------------------------------------------ */
/* Cloudflare WARP egress (socks5 sidecar)                            */
/* ------------------------------------------------------------------ */

/**
 * Raw datacenter IPs get hard-flagged by YouTube's bot scoring; egress
 * through Cloudflare's WARP network scores far better (the approach used in
 * production by yt-dlp-rescue). The container entrypoint runs a wireproxy
 * socks5 sidecar on 127.0.0.1:1080 when WARP is reachable; we probe it and
 * route YouTube attempts through it. Disable with FCLIP_WARP_PROXY="".
 */
const WARP_PROXY = process.env.FCLIP_WARP_PROXY ?? "socks5h://127.0.0.1:1080";

async function probeProxy(hold: number): Promise<boolean> {
  // End-to-end check: an open socks5 port is NOT enough — the wireguard
  // tunnel behind it can be dead (UDP egress blocked), which would silently
  // hang every request routed through it. Verify a real HTTPS fetch works.
  if (!WARP_PROXY) return false;
  const target = WARP_PROXY.replace(/^socks5h?:\/\//, "");
  try {
    await execFileAsync(
      "curl",
      ["-s", "--socks5-hostname", target, "-m", String(Math.max(2, Math.ceil(hold / 1000))), "https://api.ipify.org"],
      { timeout: hold + 3000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function warpProxyArgs(): Promise<string[]> {
  if (!WARP_PROXY) return [];
  const cached = g.__fclipProxyOk;
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.ok ? ["--proxy", WARP_PROXY] : [];
  }
  const ok = await probeProxy(400);
  console.log(`[fclip-warp] probe ${WARP_PROXY}: ${ok ? "healthy" : "dead"}`);
  g.__fclipProxyOk = { at: Date.now(), ok };
  return ok ? ["--proxy", WARP_PROXY] : [];
}

/** Sync cache-only read for contexts that cannot await (job retry handlers). */
function warpProxyArgsSync(): string[] {
  if (!WARP_PROXY) return [];
  const cached = g.__fclipProxyOk;
  return cached?.ok ? ["--proxy", WARP_PROXY] : [];
}

/** Diagnostics: is the WARP tunnel actually passing traffic end-to-end? */
export async function warpHealth(): Promise<{ socks5: boolean }> {
  return { socks5: await probeProxy(3000) };
}

function recordStormWinner(client: string): void {
  g.__fclipStormClient = { at: Date.now(), client };
  try {
    writeFileSync(STORM_PATH, JSON.stringify({ at: Date.now(), client }));
  } catch {
    /* persistence is best-effort */
  }
}

function preferredStormClient(): string | null {
  const mem = g.__fclipStormClient;
  if (mem && Date.now() - mem.at < 24 * 60 * 60 * 1000) return mem.client;
  try {
    const j = JSON.parse(readFileSync(STORM_PATH, "utf8")) as { at?: number; client?: string };
    if (j?.client && typeof j.at === "number" && Date.now() - j.at < 24 * 60 * 60 * 1000) {
      g.__fclipStormClient = { at: j.at, client: j.client };
      return j.client;
    }
  } catch {
    /* no storm history yet */
  }
  return null;
}

export function stormStatus(): { winner: string | null; at: number | null } {
  const c = preferredStormClient();
  const mem = g.__fclipStormClient;
  return { winner: c, at: mem ? mem.at : null };
}

interface StormResult {
  res: RunResult;
  client: string;
}

function stormAttempt(
  client: string,
  args: string[],
  timeoutMs: number,
  extraArgs: string[] = [],
  cookies: string[] = []
): { promise: Promise<StormResult>; kill: () => void } {
  const full = [
    ...coreArgs(),
    ...cookies,
    ...extraArgs,
    ...args,
    "--extractor-args",
    `youtube:player_client=${client}`,
  ];
  const child = spawn(YT_DLP, full, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const settle = (r: StormResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveOuter(r);
  };
  let resolveOuter: (r: StormResult) => void = () => {};
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, timeoutMs);
  const promise = new Promise<StormResult>((resolve) => {
    resolveOuter = resolve;
    child.on("error", (err) => {
      settle({ res: { code: 127, stdout: "", stderr: `fclip engine error: ${err.message}`, timedOut: false }, client });
    });
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      settle({ res: { code: code ?? 1, stdout, stderr, timedOut: false }, client });
    });
  });
  return {
    promise,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
}

async function stormBurst(args: string[], timeoutMs: number, rounds: number): Promise<StormResult | null> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs - 10_000, 60_000), 170_000);
  // Even rounds (2, 4…) attack through the Cloudflare WARP sidecar when it is
  // up — alternating identity AND egress multiplies the dice rolls.
  const proxyArgs = await warpProxyArgs();
  for (let round = 1; round <= rounds; round++) {
    if (Date.now() >= deadline) break;
    // android-family clients are cookie-HOSTILE (cookies on them yield empty
    // format lists), so they always run without cookies. Web-family clients
    // are cookie-friendly and join the burst only when a jar exists.
    const hasCookies = cookieArgs().length > 0;
    const preferred = preferredStormClient();
    const cookieless = [...STORM_CLIENTS_COOKIELESS];
    const cookied = hasCookies ? [...STORM_CLIENTS_COOKIED] : [];
    // Round 1 leads with the last known breakthrough client, if any.
    if (preferred && round === 1) {
      if (cookied.includes(preferred)) cookied.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
      else cookieless.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    }
    const clients = [...cookieless, ...cookied];
    const egress = round % 2 === 0 && proxyArgs.length > 0 ? proxyArgs : [];
    console.log(
      `[fclip-storm] round ${round}/${rounds}: ${clients.join(",")}${
        cookied.length ? " (web-family with cookies)" : " (cookie-less)"
      }${egress.length ? " via WARP" : ""}`
    );
    const attempts = clients.map((c) =>
      stormAttempt(
        c,
        args,
        Math.min(45_000, Math.max(20_000, deadline - Date.now())),
        egress,
        cookied.includes(c) ? cookieArgs() : []
      )
    );
    // Wait for the FIRST breakthrough; kill every loser the moment it appears.
    const wrapped = attempts.map((a, i) => a.promise.then((r) => ({ i, ...r })));
    const pending = new Set(attempts.map((_, i) => i));
    let winner: { i: number; res: RunResult; client: string } | null = null;
    while (pending.size > 0 && !winner) {
      const done = await Promise.race([...pending].map((i) => wrapped[i]));
      pending.delete(done.i);
      if (done.res.code === 0 && done.res.stdout.trim().startsWith("{")) {
        winner = done;
      }
    }
    for (const a of attempts) a.kill(); // stragglers die; finished ones unaffected
    if (winner) {
      console.log(`[fclip-storm] breakthrough via "${winner.client}" in round ${round}`);
      recordStormWinner(winner.client);
      return { res: winner.res, client: winner.client };
    }
    console.log(`[fclip-storm] round ${round} exhausted`);
    if (round < rounds) {
      await new Promise((r2) => setTimeout(r2, 1500 + Math.round(Math.random() * 1500)));
    }
  }
  return null;
}

function cookieArgs(): string[] {
  // Browser-cookie import is the quickest fix for the bot wall when fclip runs
  // on a desktop machine, e.g. FCLIP_COOKIES_FROM_BROWSER=chrome (or firefox,
  // edge, brave, vivaldi…). Both env spellings are accepted.
  const browser = process.env.FCLIP_COOKIES_FROM_BROWSER || process.env.YTDLP_COOKIES_FROM_BROWSER;
  if (browser) return ["--cookies-from-browser", browser];
  return existsSync(COOKIES_PATH) ? ["--cookies", COOKIES_PATH] : [];
}

function coreArgs(): string[] {
  return [
    "--no-playlist",
    "--no-warnings",
    // YouTube scores a whole IPv6 /64 as one unit and cloud IPv6 ranges are
    // walled even harder than IPv4 — always go out over IPv4.
    "--force-ipv4",
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
  /** Set when this result came from a bot-wall storm breakthrough. */
  stormClient?: string;
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
  // YouTube bot wall — retry once with the tv/android_vr player clients,
  // which usually do not require sign-in from server IPs.
  if (
    r.code !== 0 &&
    BOT_WALL_RE.test(r.stderr + r.stdout) &&
    isYouTubeUrl(url ?? "") &&
    g.__fclipTvClientOk !== false &&
    tvClientArgs().length > 0
  ) {
    const r3 = await runOnce(getOptArgsOk(), false, [...args, ...tvClientArgs()], timeoutMs);
    if (r3.code === 0) {
      g.__fclipTvClientOk = true;
      return r3;
    }
    if (/invalid choice|unrecognized|no such option/i.test(r3.stderr + r3.stdout)) {
      g.__fclipTvClientOk = false; // yt-dlp too old for these clients — stop trying
    }
  }
  // Brute-force storm: parallel bursts of player-client identities until one
  // breaks through the wall (see the storm block comment for the data).
  if (r.code !== 0 && BOT_WALL_RE.test(r.stderr + r.stdout) && isYouTubeUrl(url ?? "")) {
    // Cheap first shot through the Cloudflare WARP sidecar if it is running —
    // a fresh Cloudflare egress IP passes where the raw datacenter IP walls.
    const proxyArgs = await warpProxyArgs();
    if (proxyArgs.length > 0) {
      const rp = await runOnce(getOptArgsOk(), false, [...args, ...proxyArgs], Math.min(timeoutMs, 45_000));
      if (rp.code === 0) return rp;
    }
    const storm = await stormBurst(args, timeoutMs, 3);
    if (storm) return { ...storm.res, stormClient: storm.client };
  }
  // Token-gated mweb client — with the bgutil PO-token provider this passes
  // both the player check and the googlevideo byte-range requests.
  if (
    r.code !== 0 &&
    (BOT_WALL_RE.test(r.stderr + r.stdout) || GVS_403_RE.test(r.stderr + r.stdout)) &&
    isYouTubeUrl(url ?? "") &&
    mwebClientArgs().length > 0
  ) {
    const r5 = await runOnce(getOptArgsOk(), false, [...args, ...mwebClientArgs()], timeoutMs);
    if (r5.code === 0) {
      g.__fclipMwebOk = true;
      return r5;
    }
    if (/invalid choice|unrecognized|no such option/i.test(r5.stderr + r5.stdout)) {
      g.__fclipMwebOk = false;
    }
  }
  // Final attempt: PO tokens are minted per request by the bgutil provider and
  // the bot wall is probabilistic on soft-flagged IPs — a fresh plain attempt
  // after a short pause often passes.
  if (r.code !== 0 && BOT_WALL_RE.test(r.stderr + r.stdout) && isYouTubeUrl(url ?? "")) {
    await new Promise((res) => setTimeout(res, 1500));
    const r4 = await runOnce(getOptArgsOk(), false, args, timeoutMs);
    if (r4.code === 0) return r4;
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
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // Without this handler a missing/broken binary (ENOENT) would leave the
    // promise pending forever or crash the function — e.g. on serverless hosts.
    child.on("error", (err) => {
      finish({
        code: 127,
        stdout: "",
        stderr: `fclip engine error: ${err.message}`,
        timedOut: false,
      });
    });
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr, timedOut });
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

const ENGINE_MISSING_RE =
  /\benoent\b|engine error|no such file|command not found|cannot execute|not executable|permission denied/i;

export function classifyError(stderrTail: string): { code: string; message: string } {
  if (ENGINE_MISSING_RE.test(stderrTail)) {
    return { code: "engine_missing", message: engineMissingMessage() };
  }
  const s = stderrTail.toLowerCase();
  if (s.includes("sign in to confirm") || s.includes("not a bot")) {
    return { code: "bot_check", message: botCheckMessage() };
  }
  if (s.includes("no video formats found")) {
    return {
      code: "no_formats",
      message:
        "YouTube returned no playable streams (a bot-wall variant). fclip automatically retries with alternate clients and, if needed, its cookie-less relay network.",
    };
  }
  if (s.includes("server returned 403") || s.includes("http error 403")) {
    return {
      code: "stream_blocked",
      message:
        "YouTube refused to serve the media stream (403). The PO-token session did not cover it — try again, or add your cookies in Settings for a guaranteed path.",
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

function relayToVideoInfo(relay: RelayInfo, url: string): VideoInfo {
  const heights = new Map<number, { height: number; tbr: number | null; ext: string }>();
  for (const f of relay.formats) {
    if (f.height == null || f.kind === "audio") continue;
    const prev = heights.get(f.height);
    if (!prev || (f.bitrate ?? 0) > (prev.tbr ?? 0)) {
      heights.set(f.height, { height: f.height, tbr: f.bitrate, ext: f.ext });
    }
  }
  const qualities = [...heights.values()].sort((a, b) => b.height - a.height).slice(0, 8);
  const turbo = relay.source === "clipscutter";
  if (turbo) {
    // The turbo route guarantees 360p; higher options are attemptable through
    // the 4K-capable tunnel relays (measured live: 3840x2160 VP9, no cookies).
    // If every relay refuses, the cut silently lands on the 360p floor.
    for (const h of [2160, 1440, 1080, 720, 480]) {
      if (!heights.has(h)) heights.set(h, { height: h, tbr: null, ext: h >= 1440 ? "webm" : "mp4" });
    }
  }
  const qualitiesFinal = [...heights.values()].sort((a, b) => b.height - a.height).slice(0, 8);
  return {
    id: relay.id,
    title: relay.title,
    channel: relay.uploader,
    duration: relay.duration,
    thumbnail: relay.thumbnail,
    viewCount: null,
    uploadDate: null,
    isLive: false,
    chapters: null,
    qualities: qualitiesFinal,
    route: "relay",
    qualityHint: turbo
      ? "Turbo route active: served through fclip's cookie-less relay backbone — no bot wall, no login. 360p is guaranteed; higher options are attempted through 4K-capable tunnel relays (measured live up to 2160p VP9). If every relay refuses, your clip still lands in 360p."
      : "Served through fclip's cookie-less relay network (public Piped/Invidious instances) — no YouTube cookies involved. Relay quality usually tops out around 360–720p; for full 4K add cookies in Settings.",
    webpageUrl: url,
  };
}

export async function fetchInfo(url: string): Promise<{ ok: true; info: VideoInfo } | { ok: false; error: { code: string; message: string }; detail?: string }> {
  const res = await runYtDlp(["-J", "--no-playlist", url], 180_000, url);
  if (res.timedOut) {
    return { ok: false, error: { code: "timeout", message: "Fetching video info timed out. Please try again." } };
  }
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout).split("\n").filter(Boolean).slice(-3).join(" ");
    const err = classifyError(tail);
    // Cookie-less relay tier: when yt-dlp is walled, public Piped/Invidious
    // instances fetch the metadata — and later the media bytes — through
    // their own IPs. No cookies, no fclip IP reputation involved.
    if (isYouTubeUrl(url)) {
      const videoId = extractVideoId(url);
      const relay = videoId ? await fetchRelayInfo(videoId) : null;
      if (relay) {
        rememberRelayFormats(relay.id, relay.formats, relay.duration);
        return { ok: true, info: relayToVideoInfo(relay, url) };
      }
    }
    return { ok: false, error: err, detail: tail.slice(-500) };
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
    route: res.stormClient ? "storm" : "direct",
    qualityHint:
      res.stormClient && getCookiesMode() === "none"
        ? "This clip was extracted through the bot-wall storm — YouTube may cap quality at ~360p for servers without login cookies. Upload your cookies in Settings for full HD."
        : null,
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

  const attempt = (extraArgs: string[], stageLabel: string) => {
    const child = spawn(
      YT_DLP,
      [
        ...coreArgs(),
        ...optionalArgs().flat(),
        ...(isLocalUrl(params.url) ? [] : impersonateArgs()),
        ...extraArgs,
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    job.proc = child;
    job.status = "running";
    job.stage = stageLabel;
    // A spawn failure (binary missing → ENOENT) fires "error", not "close".
    child.on("error", (err) => {
      if (job.status === "canceled" || job.status === "done") return;
      const msg = `[fclip] engine error: ${err.message}`;
      job.log.push(msg);
      job.status = "error";
      job.stage = "Failed";
      job.error = classifyError(msg).message;
    });
    return child;
  };

  let retriedStorm = false;
  let retriedMweb = false;
  let retriedTvClient = false;
  let retriedPlain = false;
  let retriedRelay = false;
  let relayError: string | null = null;
  let child = attempt([], "Resolving video streams");

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

  const onClose = async (code: number | null): Promise<void> => {
    if (job.status === "canceled") return;
    job.proc = undefined;
    if (stderrBuf.trim()) pushLine(stderrBuf.trim());
    if (code === 0) {
      finalizeJob(job, dir);
      return;
    }
    const combined = job.log.join(" ") + stderrBuf;
    // Bot wall during download — reuse the player client that broke through
    // the wall during info extraction (persisted by the storm), or android,
    // which measures as the most likely breakthrough client.
    if (!retriedStorm && BOT_WALL_RE.test(combined) && isYouTubeUrl(params.url)) {
      retriedStorm = true;
      const client = preferredStormClient() ?? "android";
      job.log.push(`[fclip] Bot wall — retrying download via the "${client}" client…`);
      stdoutBuf = "";
      stderrBuf = "";
      child = attempt(
        ["--extractor-args", `youtube:player_client=${client}`, ...warpProxyArgsSync()],
        `Retrying via ${client} client`
      );
      child.stdout?.on("data", (d) => {
        stdoutBuf += d.toString();
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop() ?? "";
        parts.forEach(pushLine);
      });
      child.stderr?.on("data", (d) => {
        stderrBuf += d.toString();
        const parts = stderrBuf.split("\n");
        stderrBuf = parts.pop() ?? "";
        parts.forEach((p) => pushLine(p));
      });
      child.on("close", onClose);
      return;
    }
    // Bot wall or missing GVS token — retry with the token-gated mweb client,
    // which the bgutil PO-token provider can fully satisfy.
    if (
      !retriedMweb &&
      (BOT_WALL_RE.test(combined) || GVS_403_RE.test(combined)) &&
      isYouTubeUrl(params.url) &&
      mwebClientArgs().length > 0
    ) {
      retriedMweb = true;
      job.log.push("[fclip] Bot wall / stream block — retrying with PO-token session…");
      stdoutBuf = "";
      stderrBuf = "";
      child = attempt(mwebClientArgs(), "Retrying with PO-token session");
      child.stdout?.on("data", (d) => {
        stdoutBuf += d.toString();
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop() ?? "";
        parts.forEach(pushLine);
      });
      child.stderr?.on("data", (d) => {
        stderrBuf += d.toString();
        const parts = stderrBuf.split("\n");
        stderrBuf = parts.pop() ?? "";
        parts.forEach((p) => pushLine(p));
      });
      child.on("close", onClose);
      return;
    }
    // YouTube bot wall mid-download — one retry with tv/android_vr clients.
    if (!retriedTvClient && BOT_WALL_RE.test(combined) && isYouTubeUrl(params.url) && tvClientArgs().length > 0) {
      retriedTvClient = true;
      job.log.push("[fclip] Bot wall hit — retrying with alternate YouTube clients…");
      stdoutBuf = "";
      stderrBuf = "";
      child = attempt(tvClientArgs(), "Retrying with alternate YouTube clients");
      child.stdout?.on("data", (d) => {
        stdoutBuf += d.toString();
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop() ?? "";
        parts.forEach(pushLine);
      });
      child.stderr?.on("data", (d) => {
        stderrBuf += d.toString();
        const parts = stderrBuf.split("\n");
        stderrBuf = parts.pop() ?? "";
        parts.forEach((p) => pushLine(p));
      });
      child.on("close", onClose);
      return;
    }
    // Final chance: the PO-token provider mints fresh tokens per request and
    // the wall is probabilistic — one more plain attempt after a pause.
    if (!retriedPlain && BOT_WALL_RE.test(combined) && isYouTubeUrl(params.url)) {
      retriedPlain = true;
      job.log.push("[fclip] Bot wall persists — trying once more with a fresh session…");
      stdoutBuf = "";
      stderrBuf = "";
      setTimeout(() => {
        if (job.status === "canceled") return;
        child = attempt([], "Retrying with a fresh session");
        child.stdout?.on("data", (d) => {
          stdoutBuf += d.toString();
          const parts = stdoutBuf.split("\n");
          stdoutBuf = parts.pop() ?? "";
          parts.forEach(pushLine);
        });
        child.stderr?.on("data", (d) => {
          stderrBuf += d.toString();
          const parts = stderrBuf.split("\n");
          stderrBuf = parts.pop() ?? "";
          parts.forEach((p) => pushLine(p));
        });
        child.on("close", onClose);
      }, 2000);
      return;
    }
    // Last resort, fully cookie-less: cut through the relay network with
    // ffmpeg directly over the instance-proxied media URLs.
    if (!retriedRelay && isYouTubeUrl(params.url)) {
      retriedRelay = true;
      const videoId = extractVideoId(params.url);
      let formats = videoId ? cachedRelayFormats(videoId) : null;
      if (!formats && videoId) {
        const relay = await fetchRelayInfo(videoId);
        if (relay) {
          rememberRelayFormats(relay.id, relay.formats, relay.duration);
          formats = relay.formats;
        }
      }
      {
        job.log.push("[fclip] yt-dlp exhausted — switching to the cookie-less relay network…");
        job.stage = "Cutting via relay network";
        try {
          await relayCut(job, dir, formats, params);
          if ((job.status as string) !== "canceled") finalizeJob(job, dir);
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          job.log.push(`[fclip] relay cut failed: ${msg}`);
          relayError = /403|Forbidden|denied/i.test(msg)
            ? "The relay network served this video's info but its media proxy refused the byte stream (YouTube IP-locks relayed streams). The client storm or cookies provide the reliable cutting path — try again, or add cookies in Settings."
            : `Relay cut failed: ${msg}`;
        }
      }
    }
    job.status = "error";
    const tail = job.log.slice(-4).join(" ");
    job.error = relayError ?? classifyError(tail).message;
    job.stage = "Failed";
  };

  child.on("close", onClose);

  return job;
}

/**
 * 1 KB range probe — true when this URL serves real bytes to whoever asks
 * (any IP, no cookies). Distinguishes the clipscutter byte proxy (measured
 * HTTP 206 from a datacenter IP) from Piped proxies that 403 ranged reads.
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

/**
 * Cookie-less relay cut, ordered as a quality ladder:
 *  1. For ≤480p requests: the turbo fast path (ranged stream-cut, cheapest).
 *  2. For HD/4K requests: cobalt tunnels first — measured live, one host
 *     tunnels TRUE 4K (3840x2160 VP9) from datacenter IPs with zero cookies.
 *     Tunnels relay the full stream (no ranges), so the whole source is
 *     downloaded once and ffmpeg stream-copies the range locally.
 *  3. Turbo fast path as the HD fallback (360p floor — never dead).
 *  4. Instance-proxied googlevideo URLs (rare).
 */
async function relayCut(
  job: ClipJob,
  dir: string,
  formats: RelayFormat[] | null,
  params: CreateJobParams
): Promise<void> {
  const dur = Math.max(0.2, params.end - params.start);
  const out = path.join(dir, "clip.mp4");
  const wantHd = params.maxHeight == null || params.maxHeight > 480;

  // 1. Cheap ranged cut — only sane for low-height requests.
  if (!wantHd && formats) {
    const done = await tryTurboFastPath(job, formats, params, dur, out);
    if (done) return;
  }

  // 2. HD/4K: tunnel relays (full download → local range cut).
  const videoLen = cachedRelayDuration(extractVideoId(params.url) ?? "");
  // Tunneling means downloading the whole video once — only sane up to ~45 min.
  const cobaltAllowed = videoLen === null || videoLen <= 45 * 60;
  if (cobaltAllowed && isYouTubeUrl(params.url)) {
    const tunnels = await fetchCobaltTunnels(params.url, params.maxHeight).catch(() => [] as CobaltMedia[]);
    for (const cobalt of tunnels) {
      const full = path.join(dir, `source-${cobalt.host}.mp4`);
      job.status = "running";
      job.stage = "Relay: downloading through cobalt tunnel";
      job.log.push(`[fclip] cobalt relay (${cobalt.host}) — fetching media bytes…`);
      const ok = await downloadTunnelFile(job, cobalt.url, full);
      if (ok) {
        job.stage = "Relay: cutting locally";
        job.progress = 95;
        await ffmpegLocalCut(job, full, params.start, dur, dir);
        try {
          rmSync(full, { force: true });
        } catch {
          /* best effort */
        }
        return;
      }
      try {
        rmSync(full, { force: true });
      } catch {
        /* best effort */
      }
      job.log.push(`[fclip] cobalt tunnel (${cobalt.host}) gave no bytes — trying next relay…`);
    }
  }

  // 3. HD fallback: the turbo ranged cut (360p floor — never dead).
  if (formats) {
    const done = await tryTurboFastPath(job, formats, params, dur, out);
    if (done) return;
  }

  // 4. Last resort: instance-proxied URLs (usually 403 — kept for completeness).
  const { video, audio } = formats ? pickRelayMedia(formats, params.maxHeight) : { video: undefined, audio: undefined };
  if (!video) throw new Error("relay network had no media for this video");
  await ffmpegRelayUrlCut(job, { video, audio }, params, dur, out);
  if ((job.status as string) === "canceled") return;
  job.stage = "Processing with ffmpeg";
  job.progress = 100;
}

/** Turbo fast path: proxied progressive stream + verified ranged access →
 *  ffmpeg stream-cuts straight off the remote URL (downloads ~clip length
 *  only). Returns true when the cut was completed. */
async function tryTurboFastPath(
  job: ClipJob,
  formats: RelayFormat[],
  params: CreateJobParams,
  dur: number,
  out: string
): Promise<boolean> {
  const pick = pickRelayMedia(formats, params.maxHeight);
  const turboVideo = pick.video;
  if (!turboVideo || turboVideo.kind !== "progressive" || !turboVideo.proxied) return false;
  job.status = "running";
  job.stage = "Relay: probing turbo stream";
  job.log.push("[fclip] probing the turbo relay for ranged byte access…");
  const ok = await urlServesBytes(turboVideo.url);
  if (!ok) {
    job.log.push("[fclip] turbo relay refused ranged reads — trying next relay…");
    return false;
  }
  job.stage = "Relay: streaming cut via turbo proxy";
  job.log.push("[fclip] turbo relay verified — cutting directly from the ranged stream…");
  await ffmpegRelayUrlCut(job, { video: turboVideo, audio: pick.audio }, params, dur, out);
  return true;
}

/** ffmpeg stream-copy cut straight from remote URL(s) with progress parsing. */
async function ffmpegRelayUrlCut(
  job: ClipJob,
  pick: { video: RelayFormat; audio?: RelayFormat },
  params: CreateJobParams,
  dur: number,
  out: string
): Promise<void> {
  const { video, audio } = pick;
  const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
  // -ss before each -i seeks that input; -t bounds the output duration.
  args.push("-ss", String(params.start), "-i", video.url);
  if (audio) args.push("-ss", String(params.start), "-i", audio.url);
  args.push("-t", String(dur));
  if (audio) {
    args.push("-map", "0:v:0", "-map", "1:a:0");
    if (video.ext === "mp4" && audio.ext === "m4a") args.push("-c:v", "copy", "-c:a", "copy");
    else args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "160k"); // opus/webm cannot live in mp4
  } else {
    args.push("-c", "copy");
  }
  args.push("-movflags", "faststart", out);

  job.status = "running";
  job.stage = audio ? "Relay: cutting video + audio" : "Relay: cutting clip";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    job.proc = child;
    let buf = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(new Error("relay cut timed out"));
    }, Math.min(15 * 60_000, dur * 8_000 + 120_000));
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        const m = /out_time_ms=(\d+)/.exec(line);
        if (m) {
          const t = Number(m[1]) / 1e6;
          if (Number.isFinite(t) && dur > 0) job.progress = Math.min(99, Math.round((t / dur) * 100));
        }
      }
    });
    child.stderr?.on("data", (d) => {
      const l = d.toString().trim();
      if (l) job.log.push(`[relay-ffmpeg] ${l.slice(0, 260)}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if ((job.status as string) === "canceled") return resolve();
      if (code === 0) resolve();
      else reject(new Error(`relay ffmpeg exited ${code}`));
    });
  });
  if ((job.status as string) === "canceled") return;
  job.stage = "Processing with ffmpeg";
  job.progress = 100;
}

/** Stream a tunnel URL to disk with download progress (0–90%). */
async function downloadTunnelFile(job: ClipJob, url: string, dest: string): Promise<boolean> {
  // curl first — battle-tested against odd TLS/CDN setups and it streams
  // straight to disk with parseable progress. Native fetch failed on large
  // tunnel responses from Railway (measured live). If curl is missing the
  // spawn fires "error" and we fall through to native fetch.
  {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "curl",
        ["-sS", "-L", "--fail", "--max-time", "900", "--retry", "2", "-#", "-o", dest, url],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      job.proc = child;
      let buf = "";
      child.stderr?.on("data", (d) => {
        buf += d.toString();
        const m = /(\d+(?:\.\d+)?)%/.exec(buf);
        if (m) {
          job.progress = Math.min(88, Math.round(parseFloat(m[1]) * 0.88));
          buf = buf.slice(-40);
        }
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => {
        if ((job.status as string) === "canceled") return resolve(false);
        let size = 0;
        try {
          size = statSync(dest).size;
        } catch {
          /* no file */
        }
        resolve(code === 0 && size > 0);
      });
    });
    if (ok) return true;
    job.log.push("[fclip] curl tunnel download failed — trying native fetch…");
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15 * 60_000),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) fclip/1.0" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      job.log.push(`[fclip] tunnel responded HTTP ${res.status}`);
      return false;
    }
    const total = Number(res.headers.get("content-length") ?? "0");
    let got = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        got += chunk.byteLength;
        if (total > 0) job.progress = Math.min(90, Math.round((got / total) * 90));
        else job.progress = Math.min(85, Math.round(got / 2_000_000));
        ctrl.enqueue(chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(counter) as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest)
    );
    return got > 0;
  } catch (e) {
    if ((job.status as string) !== "canceled") {
      const msg = e instanceof Error ? e.message : String(e);
      job.log.push(`[fclip] tunnel download error: ${msg.slice(0, 160)}`);
    }
    return false;
  }
}

/** Stream-copy the selected range out of a local file (fast, lossless). */
async function ffmpegLocalCut(job: ClipJob, src: string, start: number, dur: number, dir: string): Promise<void> {
  // Container must follow the codecs: tunnel relays can hand us 4K VP9/Opus
  // (even with an .mp4 filename) — that belongs in a webm, not mp4.
  let ext = "mp4";
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", src],
      { timeout: 15_000 }
    );
    const v = stdout.trim().split("\n")[0] ?? "";
    if (/^(vp9|vp8|av1)$/i.test(v)) ext = "webm";
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

export function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

export function engineMissingMessage(): string {
  const base =
    "The fclip server is missing its yt-dlp/ffmpeg engine. fclip needs a host that runs Docker or a long-lived Node process — Railway, Render, Fly.io, a VPS, or your own computer. Serverless platforms (Vercel, Netlify, Cloudflare) cannot run these binaries.";
  return isVercel()
    ? "This deployment is on Vercel, which can't run yt-dlp or ffmpeg. " + base
    : base;
}

export interface EngineStatus {
  ytDlp: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
}

async function probeBin(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Cheap, cached reachability check of the yt-dlp/ffmpeg engine. */
export async function checkEngine(force = false): Promise<EngineStatus> {
  const cached = g.__fclipEngine;
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
  const status: EngineStatus = {
    ytDlp: await probeBin(YT_DLP, ["--version"]),
    ffmpeg: await probeBin(FFMPEG, ["-version"]),
    ffprobe: await probeBin(FFPROBE, ["-version"]),
  };
  g.__fclipEngine = { at: Date.now(), status };
  return status;
}

export function getCookiesMode(): "browser" | "file" | "none" {
  const browser = process.env.FCLIP_COOKIES_FROM_BROWSER || process.env.YTDLP_COOKIES_FROM_BROWSER;
  if (browser) return "browser";
  return existsSync(COOKIES_PATH) ? "file" : "none";
}

/* ------------------------------------------------------------------ */
/* Cookie health (names only — never values)                          */
/* ------------------------------------------------------------------ */

export interface CookieHealth {
  present: boolean;
  /** True when the export contains YouTube login-session cookies. */
  loggedIn: boolean;
  /** Cookie NAMES only — values are never read or reported. */
  names: string[];
  lineCount: number;
}

const LOGIN_COOKIE_MARKERS = [
  "SID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "LOGIN_INFO",
  "SAPISID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
];

export function cookieHealth(): CookieHealth {
  if (getCookiesMode() === "browser") {
    return { present: true, loggedIn: true, names: [], lineCount: 0 };
  }
  if (!existsSync(COOKIES_PATH)) {
    return { present: false, loggedIn: false, names: [], lineCount: 0 };
  }
  try {
    const lines = readFileSync(COOKIES_PATH, "utf8").split("\n");
    const names = new Set<string>();
    let count = 0;
    for (const line of lines) {
      if (!line.trim() || line.startsWith("#")) continue;
      count++;
      const name = line.split("\t")[5]?.trim();
      if (name) names.add(name);
    }
    return {
      present: count > 0,
      loggedIn: LOGIN_COOKIE_MARKERS.some((m) => names.has(m)),
      names: [...names].slice(0, 40),
      lineCount: count,
    };
  } catch {
    return { present: true, loggedIn: false, names: [], lineCount: 0 };
  }
}

function botCheckMessage(): string {
  const health = cookieHealth();
  if (health.present && !health.loggedIn) {
    return (
      "YouTube is asking this server to verify it is not a bot. A cookies.txt is present, but it does not contain any " +
      "YouTube login cookies (no SID / __Secure-1PSID / LOGIN_INFO) — it looks like an export made while signed out, " +
      "so it cannot unlock the wall. fclip will keep retrying automatically with its client storm; for reliable HD " +
      "clipping, export cookies again while signed in to YouTube and re-upload them in Settings."
    );
  }
  if (health.present && health.loggedIn) {
    return (
      "YouTube is asking this server to verify it is not a bot even though login cookies are present. YouTube rotates " +
      "session cookies fast — export a FRESH cookies.txt from a signed-in browser and re-upload it in Settings. fclip " +
      "will also keep retrying automatically with its client storm."
    );
  }
  return (
    "YouTube is asking this server to verify it is not a bot (common for cloud IPs). fclip automatically retries with " +
    "parallel client storms — but for reliable, full-quality clipping add your browser cookies in Settings, or run " +
    "fclip locally where your own IP is used."
  );
}
