import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Relay network (cookie-less tier)                                    */
/* ------------------------------------------------------------------ */

/**
 * When YouTube walls fclip's own IP ("sign in to confirm you're not a bot"),
 * we can borrow somebody else's: public Piped / Invidious instances expose a
 * JSON API for video metadata AND proxy the media bytes through their own
 * hosts (`local=true` on Invidious, the pipedproxy host on Piped). Requests
 * then look like ordinary traffic to YouTube and fclip never touches a
 * googlevideo URL from its flagged IP — no cookies involved.
 *
 * The instance ecosystem is volatile (post-SABR many public instances are
 * dead or half-broken), so this module fans each request out to every known
 * host in parallel and takes the first healthy answer, with a short cache.
 * Live probe (2026-11): api.piped.private.coffee answered with proxied
 * /videoplayback URLs while 5/6 other Piped APIs and all probed Invidious
 * hosts failed — exactly why the fan-out exists.
 */

export interface RelayFormat {
  url: string;
  kind: "progressive" | "video" | "audio";
  height: number | null;
  mime: string;
  ext: string;
  bitrate: number | null;
  proxied: boolean;
}

export interface RelayInfo {
  source: "piped" | "invidious";
  instance: string;
  id: string;
  title: string;
  uploader: string | null;
  duration: number;
  thumbnail: string | null;
  formats: RelayFormat[];
}

const PIPED_HOSTS = [
  "api.piped.private.coffee",
  "pipedapi.kavin.rocks",
  "pipedapi.ducks.party",
  "pipedapi.adminforge.de",
  "pipedapi.drgns.space",
  "pipedapi.reallyaweso.me",
  "pipedapi.leptons.xyz",
  "papi.victr.me",
  "piped-api.lunar.icu",
  "pipedapi.moomoo.me",
  "pipedapi.orangenet.cc",
];

const INVIDIOUS_HOSTS = [
  "inv.nadeko.net",
  "yewtu.be",
  "invidious.nerdvpn.de",
  "iv.duti.dev",
  "invidious.f5.si",
  "yt.chocolatemoo53.com",
  "invidious.jing.rocks",
  "invidious.materialio.us",
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const HEALTH_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  at: number;
  info: RelayInfo | null;
}

const g = globalThis as unknown as {
  __fclipRelayCache: Map<string, CacheEntry> | undefined;
  __fclipRelayHealth: { at: number; ok: string[] } | undefined;
  __fclipCurlOk: boolean | undefined;
};

const cache: Map<string, CacheEntry> = (g.__fclipRelayCache ??= new Map());

/*
 * Node's undici TLS stack fails against some instance hosts that curl
 * handles fine (measured live: undici AggregateError/ETIMEDOUT while curl
 * returned 200 in ~1s), so relay JSON is fetched through curl first and
 * only falls back to native fetch when curl is unavailable.
 */
async function curlAvailable(): Promise<boolean> {
  if (g.__fclipCurlOk !== undefined) return g.__fclipCurlOk;
  try {
    await execFileAsync("curl", ["--version"], { timeout: 5000 });
    g.__fclipCurlOk = true;
  } catch {
    g.__fclipCurlOk = false;
  }
  return g.__fclipCurlOk;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const secs = Math.max(3, Math.ceil(timeoutMs / 1000));
  const headers = ["-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) fclip/1.0", "-H", "Accept: application/json"];
  if (await curlAvailable()) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        ["-sS", "--fail", "--max-time", String(secs), ...headers, url],
        { timeout: timeoutMs + 3000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }
      );
      return JSON.parse(stdout) as unknown;
    } catch (e) {
      const err = e as { code?: number | string; killed?: boolean };
      // Only surface timeouts/kills — exit 6 (dns) and 22 (http error) are the
      // normal state of a dying instance ecosystem and would spam the logs.
      if (err.killed || err.code === 28) {
        console.log(`[fclip-relay] curl timeout ${url.split("/")[2]}`);
      }
      return null;
    }
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) fclip/1.0" },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function isProxiedUrl(u: string): boolean {
  try {
    return !/(^|\.)googlevideo\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "?";
  }
}

export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(host)) return null;
    if (host.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

function parsePiped(d: unknown, host: string): RelayInfo | null {
  const j = d as {
    title?: string;
    uploader?: string;
    duration?: number;
    thumbnailUrl?: string;
    videoStreams?: {
      url?: string;
      quality?: string;
      mimeType?: string;
      videoOnly?: boolean;
      bitrate?: number;
    }[];
    audioStreams?: {
      url?: string;
      quality?: string;
      mimeType?: string;
      bitrate?: number;
    }[];
    error?: string;
  };
  if (!j || typeof j.title !== "string" || j.error) return null;
  const formats: RelayFormat[] = [];
  for (const s of j.videoStreams ?? []) {
    if (!s.url) continue;
    const m = /\/(\w+)\/(\w+)/.exec(s.mimeType ?? "") ?? /(\w+)\/(\w+)/.exec(s.mimeType ?? "");
    formats.push({
      url: s.url,
      kind: s.videoOnly ? "video" : "progressive",
      height: Number.parseInt(s.quality ?? "", 10) || null,
      mime: s.mimeType ?? "video/mp4",
      ext: m?.[2] === "webm" ? "webm" : "mp4",
      bitrate: typeof s.bitrate === "number" ? s.bitrate : null,
      proxied: isProxiedUrl(s.url),
    });
  }
  for (const s of j.audioStreams ?? []) {
    if (!s.url) continue;
    const m4a = /m4a|mp4|aac/i.test(s.mimeType ?? "");
    formats.push({
      url: s.url,
      kind: "audio",
      height: null,
      mime: s.mimeType ?? "audio/mp4",
      ext: m4a ? "m4a" : "webm",
      bitrate: typeof s.bitrate === "number" ? s.bitrate : null,
      proxied: isProxiedUrl(s.url),
    });
  }
  if (formats.length === 0) return null;
  return {
    source: "piped",
    instance: host,
    id: "",
    title: j.title,
    uploader: j.uploader ?? null,
    duration: Math.round(j.duration ?? 0),
    thumbnail: j.thumbnailUrl ?? null,
    formats,
  };
}

function parseInvidious(d: unknown, host: string): RelayInfo | null {
  const j = d as {
    title?: string;
    author?: string;
    lengthSeconds?: number;
    videoThumbnails?: { url?: string; quality?: string }[];
    formatStreams?: { url?: string; qualityLabel?: string; type?: string; bitrate?: string }[];
    adaptiveFormats?: { url?: string; qualityLabel?: string; type?: string; bitrate?: string; resolution?: string }[];
    error?: string;
  };
  if (!j || typeof j.title !== "string" || j.error) return null;
  const formats: RelayFormat[] = [];
  const add = (s: { url?: string; qualityLabel?: string; type?: string; bitrate?: string; resolution?: string }, kind: RelayFormat["kind"]) => {
    if (!s.url) return;
    const mime = (s.type ?? "video/mp4").split(";")[0].trim();
    const m = /\/(\w+)/.exec(s.type ?? "");
    formats.push({
      url: s.url,
      kind,
      height: Number.parseInt(s.qualityLabel ?? s.resolution ?? "", 10) || null,
      mime,
      ext: m?.[1] === "webm" ? "webm" : m?.[1] === "audio" ? "m4a" : "mp4",
      bitrate: s.bitrate ? Number.parseInt(s.bitrate, 10) || null : null,
      proxied: isProxiedUrl(s.url),
    });
  };
  for (const s of j.formatStreams ?? []) add(s, "progressive");
  for (const s of j.adaptiveFormats ?? []) {
    const isAudio = /^audio\//i.test(s.type ?? "");
    add(s, isAudio ? "audio" : "video");
  }
  if (formats.length === 0) return null;
  return {
    source: "invidious",
    instance: host,
    id: "",
    title: j.title,
    uploader: j.author ?? null,
    duration: Math.round(j.lengthSeconds ?? 0),
    thumbnail: j.videoThumbnails?.find((t) => t.url)?.url ?? null,
    formats,
  };
}

async function tryHost(host: string, videoId: string, timeoutMs: number): Promise<RelayInfo | null> {
  const piped = await fetchJson(`https://${host}/streams/${encodeURIComponent(videoId)}`, timeoutMs);
  if (piped) {
    const info = parsePiped(piped, host);
    if (info) return info;
  }
  const inv = await fetchJson(`https://${host}/api/v1/videos/${encodeURIComponent(videoId)}?local=true`, timeoutMs);
  if (inv) {
    const info = parseInvidious(inv, host);
    if (info) return info;
  }
  return null;
}

/** Race every known instance; first healthy answer wins. Cached per video. */
export async function fetchRelayInfo(videoId: string, timeoutMs = 9000): Promise<RelayInfo | null> {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;

  // Hosts that answered recently are retried first.
  const lastOk =
    g.__fclipRelayHealth && Date.now() - g.__fclipRelayHealth.at < HEALTH_TTL_MS ? g.__fclipRelayHealth.ok : [];
  const all = [...PIPED_HOSTS, ...INVIDIOUS_HOSTS];
  const hosts = [...lastOk, ...all.filter((h) => !lastOk.includes(h))];
  const attempts = hosts.map(async (h) => ({ h, info: await tryHost(h, videoId, timeoutMs) }));
  console.log(`[fclip-relay] fan-out started: ${hosts.length} hosts, per-req timeout ${timeoutMs}ms`);
  let first: RelayInfo | null = null;
  const okHosts: string[] = [];
  const overallDeadline = Date.now() + Math.min(timeoutMs * 2.5, 25_000);
  for (const a of attempts) {
    // Stop as soon as a winner exists — awaiting the remaining (mostly dead)
    // hosts would add up to 2×timeout each, sequentially.
    if (first || Date.now() > overallDeadline) break;
    try {
      const r = await a;
      if (r.info) {
        okHosts.push(r.h);
        if (!first) first = r.info;
      }
    } catch {
      /* unreachable host — ignore */
    }
  }
  g.__fclipRelayHealth = { at: Date.now(), ok: okHosts };
  if (first) {
    first.id = videoId;
    if (!first.thumbnail) first.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    cache.set(videoId, { at: Date.now(), info: first });
    console.log(`[fclip-relay] ${videoId} served by ${first.source}:${first.instance} (${okHosts.length} hosts healthy)`);
  } else {
    console.log(`[fclip-relay] ${videoId}: no relay host answered`);
  }
  return first;
}

/**
 * Pick the best cuttable media from a relay response, honoring maxHeight:
 * progressive (video+audio in one URL) first; otherwise the best video-only
 * stream plus an audio stream. Proxied URLs always beat direct googlevideo
 * URLs (which are IP-locked to the instance and usually 403 elsewhere).
 */
export function pickRelayMedia(
  formats: RelayFormat[],
  maxHeight: number | null
): { video?: RelayFormat; audio?: RelayFormat } {
  const usable = formats.filter((f) => f.proxied || f.kind === "progressive");
  const pool = usable.length > 0 ? usable : formats;

  const progressive = pool
    .filter((f) => f.kind === "progressive")
    .filter((f) => maxHeight == null || f.height == null || f.height <= maxHeight)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (progressive.length > 0) return { video: progressive[0] };

  const videos = pool
    .filter((f) => f.kind === "video")
    .filter((f) => maxHeight == null || f.height == null || f.height <= maxHeight)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const audios = pool
    .filter((f) => f.kind === "audio")
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (videos.length > 0 && audios.length > 0) return { video: videos[0], audio: audios[0] };
  if (videos.length > 0) return { video: videos[0] };
  return {};
}

export function relayHealth(): { ok: string[]; checkedAt: number | null; known: number } {
  const h = g.__fclipRelayHealth;
  const fresh = h && Date.now() - h.at < HEALTH_TTL_MS;
  return { ok: fresh ? h!.ok : [], checkedAt: fresh ? h!.at : null, known: PIPED_HOSTS.length + INVIDIOUS_HOSTS.length };
}

/** Test-visible reset. */
export function clearRelayCache() {
  cache.clear();
}
