/**
 * savenow 4K render lane ("p.savenow.to/api/v2/download" — the loader.to /
 * en.loader.to streaming backend, a.k.a. video-download-api.com).
 *
 * OSINT provenance (2026-11-10/11, reverse-engineered from en.loader.to's own
 * frontend JS `main2.js` and verified LIVE, zero cookies, anonymous):
 *  - The loader.to family front-ends call a streaming render API:
 *      GET https://p.savenow.to/api/v2/download
 *          ?format=4k            ← literal "4k" (NOT 2160; "1440" also exists in
 *                                  the site dropdown but server-side validity
 *                                  was not confirmable — 4k is the safe value)
 *          &url=<YouTube watch URL, percent-encoded>
 *          &apikey=dfcb6d76f2f6a9894gjkege8a4ab232222
 *        ← SHARED_FRONTEND_API_KEY, embedded verbatim in their public JS.
 *    REQUIRED HEADERS (measured, repeatedly):
 *        Origin: https://en.loader.to      ← the actual gate. Without it the
 *        Referer: https://en.loader.to/      API answers error_code
 *        browser-ish User-Agent              "api_key_required" regardless of key.
 *  - Response: {success:true, id:"v2_stream_<hex>", full_format:"mp4 [2160p]",
 *    progress_url:"https://p.savenow.to/api/progress?id=<id>"}.
 *  - Poll GET <progress_url> (same headers) every ~6s → {progress (0..1000),
 *    text} until a non-empty download_url appears. progress=1000 with a URL
 *    means done. Renders are CACHED upstream per video+format — the second
 *    identical request for a video returns its URL within seconds.
 *  - download_url lives on a rotating host (leo3.savenow.to, penny83.savenow.to,
 *    …) and needs NO special headers. It does NOT support Range (measured
 *    HTTP 200 ignoring Range) — the file is downloaded whole.
 *  - VERIFIED OUTPUT (ffprobe on fetched bytes): 3840x2160 AV1 @60fps + AAC
 *    audio, muxed mp4 (moov at head, so even a truncated download stays
 *    cuttable). This is TRUE 4K from a datacenter IP with no cookies.
 *  - THROTTLE: bursts trip a per-IP budget that returns the misleading
 *    "api_key_required" error for EVERYTHING (even valid 4k calls). Measured
 *    recovery ≈ 45-90 s of quiet. Callers must back off and retry at most a
 *    couple of times, and must NOT fan this API out in parallel.
 *  - Transport: all API traffic goes through the curl binary (Cloudflare in
 *    front of the savenow hosts fingerprints TLS clients; undici fetch is
 *    unreliable against them — same pattern as videolimit.com).
 *
 * The lane renders the WHOLE source video (no server-side trim), so the flow
 * is: request render → poll → download full file → ffmpeg stream-copy the
 * requested range locally. Same shape as the cobalt tunnel lane, but alive
 * when the tunnel farm is walled (dwnld.nichind.dev measured
 * "content.no_valid_content" across all 15 backend instances on 2026-11-11).
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SAVE_BASE = "https://p.savenow.to";
const SAVE_BASE_FALLBACK = "https://p.lbserver.xyz";
const ORIGIN = "https://en.loader.to";
/** Shared frontend key shipped verbatim in en.loader.to's public JS. */
const SHARED_FRONTEND_API_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface SavenowRender {
  /** Full-file download URL (host rotates; no headers needed; no Range). */
  url: string;
  /** Server-labeled format, e.g. "mp4 [2160p]". */
  fullFormat: string;
}

function isThrottle(body: Record<string, unknown>): boolean {
  return body.error_code === "api_key_required" && body.success === false;
}

/** curl GET with the loader.to origin trio. Returns {status, body}. */
async function curlGet(url: string, timeoutS: number): Promise<{ status: number; body: string }> {
  const args = [
    "-sS", "--max-time", String(timeoutS), "-w", "\n%{http_code}", url,
    "-H", `User-Agent: ${BROWSER_UA}`,
    "-H", `Origin: ${ORIGIN}`,
    "-H", `Referer: ${ORIGIN}/`,
    "-H", "Accept: application/json, text/plain, */*",
  ];
  try {
    const { stdout } = await execFileAsync("curl", args, { timeout: (timeoutS + 5) * 1000, maxBuffer: 4 << 20 });
    const idx = stdout.lastIndexOf("\n");
    return { status: Number.parseInt(stdout.slice(idx + 1).trim(), 10) || 0, body: stdout.slice(0, idx) };
  } catch (e) {
    throw new Error(`curl GET failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Request a full-video render in the given format ("4k" is the measured-good
 * value; "1440" exists in their dropdown but is unconfirmed server-side).
 * Retries up to 3 attempts through throttle windows (90 s+ backoff) because
 * bursts trip the misleading "api_key_required" budget even with the correct key.
 */
export async function savenowRequestRender(
  videoId: string,
  format: string,
  opts: { throttleRetry?: boolean } = {}
): Promise<{ id: string; fullFormat: string }> {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const qs = `format=${encodeURIComponent(format)}&url=${encodeURIComponent(pageUrl)}&apikey=${SHARED_FRONTEND_API_KEY}`;
  let lastErr = "";

  // The per-IP budget refills on the order of minutes (measured: burst →
  // ~6 min drought → success). 90 s waits × up to 3 total attempts ride out
  // a brief drought without stalling a job for ages; a fully spent hourly
  // budget still fails fast enough for the ladder to fall back to 1080p60.
  for (let attempt = 0; attempt < (opts.throttleRetry === false ? 1 : 3); attempt++) {
    if (attempt > 0) await sleep(90_000 + Math.floor(Math.random() * 20_000));
    for (const base of [SAVE_BASE, SAVE_BASE_FALLBACK]) {
      try {
        const res = await curlGet(`${base}/api/v2/download?${qs}`, 25);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(res.body) as Record<string, unknown>;
        } catch {
          lastErr = `non-JSON HTTP ${res.status}`;
          continue;
        }
        if (body.success && typeof body.id === "string" && body.id) {
          return {
            id: body.id,
            fullFormat: typeof body.full_format === "string" ? body.full_format : format,
          };
        }
        if (isThrottle(body)) {
          lastErr = "throttled (api_key_required)";
          break; // don't hammer the fallback host too — wait instead
        }
        lastErr = String(body.error_code ?? body.message ?? `HTTP ${res.status}`);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(lastErr || "savenow render request failed");
}

/**
 * Poll a render to completion. Returns the finished-file download URL.
 * Upstream caches renders per video+format, so repeat requests land fast.
 */
export async function savenowPoll(
  id: string,
  opts: { timeoutMs?: number; onProgress?: (pct: number, text: string) => void } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    let url: string | undefined;
    try {
      const res = await curlGet(`${SAVE_BASE}/api/progress?id=${encodeURIComponent(id)}`, 20);
      if (res.status === 200) {
        const j = JSON.parse(res.body) as {
          download_url?: string; progress?: number; text?: string;
        };
        const text = j.text ?? "";
        if (text && text !== lastText) {
          lastText = text;
          opts.onProgress?.(-1, text);
        }
        if (typeof j.progress === "number" && j.progress >= 0 && j.progress <= 1000) {
          opts.onProgress?.(Math.round(j.progress / 10), text);
        }
        if (j.download_url && typeof j.download_url === "string") url = j.download_url;
      }
    } catch {
      /* transient poll error — keep polling until the deadline */
    }
    if (url) return url;
    await sleep(6_000);
  }
  throw new Error(`savenow render timed out after ${Math.round(timeoutMs / 60_000)} min`);
}

/** High-level: render the full source video in `format`, return the file URL. */
export async function savenowRender(
  videoId: string,
  format: string,
  opts: { timeoutMs?: number; onProgress?: (pct: number, text: string) => void } = {}
): Promise<SavenowRender> {
  const { id, fullFormat } = await savenowRequestRender(videoId, format);
  const url = await savenowPoll(id, opts);
  return { url, fullFormat };
}
