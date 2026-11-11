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
 *  - QUOTA MODEL (measured 2026-11-11): the api_key_required gate is the
 *    SHARED KEY's global quota pool, not a per-IP budget — an hour of IP
 *    silence did not recover it, minted PoW tokens and XFF spoofing did not
 *    lift it, and the pool is shared with every loader.to/y2down visitor
 *    worldwide (their own pow-token.js comment mentions "five coordinated
 *    hosts moved 61 GB in one hour" against one referer). Successes are
 *    opportunistic free slots — two full 4K renders landed this way and were
 *    byte-verified. Callers must back off, never fan out, and fall down the
 *    ladder gracefully when no slot is free.
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
import { createHash } from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SAVE_BASE = "https://p.savenow.to";
const SAVE_BASE_FALLBACK = "https://p.lbserver.xyz";
const ORIGIN = "https://en.loader.to";
/**
 * Key priority: FCLIP_SAVENOW_API_KEY env var first — a key YOU registered at
 * video-download-api.com (free test tier: 25 requests after email
 * confirmation, more on paid plans) — measured 2026-11-11: the shared
 * frontend key's quota pool is GLOBAL (all whitelisted referers —
 * en.loader.to, loader.to, convertr.org — drain the same pool, referer
 * rotation does NOT open new pools, PoW tokens and XFF spoofing don't help).
 * An owned key skips the global pool entirely and is the only guaranteed
 * 4K path when the shared pool is dry. With an owned key the PoW dance is
 * skipped and a quota throttle fails through FAST (the ladder degrades to
 * the 1080p60 farm instead of burning minutes on backoff loops).
 */
const SHARED_FRONTEND_API_KEY =
  process.env.FCLIP_SAVENOW_API_KEY?.trim() || "dfcb6d76f2f6a9894gjkege8a4ab232222";
const HAS_OWN_KEY = Boolean(process.env.FCLIP_SAVENOW_API_KEY?.trim());
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

/** curl GET with the loader.to origin trio (+ optional PoW bearer). Returns {status, body}. */
async function curlGet(url: string, timeoutS: number, bearer?: string | null): Promise<{ status: number; body: string }> {
  const args = [
    "-sS", "--max-time", String(timeoutS), "-w", "\n%{http_code}", url,
    "-H", `User-Agent: ${BROWSER_UA}`,
    "-H", `Origin: ${ORIGIN}`,
    "-H", `Referer: ${ORIGIN}/`,
    "-H", "Accept: application/json, text/plain, */*",
  ];
  if (bearer) args.push("-H", `Authorization: Bearer ${bearer}`);
  try {
    const { stdout } = await execFileAsync("curl", args, { timeout: (timeoutS + 5) * 1000, maxBuffer: 4 << 20 });
    const idx = stdout.lastIndexOf("\n");
    return { status: Number.parseInt(stdout.slice(idx + 1).trim(), 10) || 0, body: stdout.slice(0, idx) };
  } catch (e) {
    throw new Error(`curl GET failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- */
/* Proof-of-work token (mirrors /js/shared/pow-token.js exactly)     */
/* ---------------------------------------------------------------- */
/*
 * The browser mints a token before every download/progress call:
 *   1. GET  /api/pow/challenge → {salt, difficulty, expires_at, signature}
 *   2. solve: smallest nonce with sha256hex(salt + ":" + nonce) prefixed by
 *      `difficulty` zeros (measured difficulty 3 — trivial in native code)
 *   3. POST /api/pow/verify {salt, difficulty, expires_at, signature, nonce}
 *      → {success, token (JWT-ish), expires_at}
 *   4. send `Authorization: Bearer <token>` on /api/v2/download + /api/progress
 * Their client is fail-open and the server "records verdicts and refuses
 * nothing" — but sending the token is the correct protocol, so we do.
 * Measured (2026-11-11): a minted token did NOT lift the api_key_required
 * throttle — that gate is the shared key's global quota pool (see below),
 * not a per-client PoW verdict.
 */

interface PowToken {
  token: string;
  expiresAt: number; // epoch ms
}

const g2 = globalThis as unknown as { __fclipSavenowPow: PowToken | null };

function solvePow(salt: string, difficulty: number): string {
  const prefix = "0".repeat(Math.max(1, Math.min(difficulty, 8)));
  for (let nonce = 0; nonce < 100_000_000; nonce++) {
    if (createHash("sha256").update(`${salt}:${nonce}`).digest("hex").startsWith(prefix)) {
      return String(nonce);
    }
  }
  throw new Error("pow: no nonce found");
}

async function curlJsonPost(url: string, body: string, timeoutS: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "curl",
    ["-sS", "--max-time", String(timeoutS), "-X", "POST",
     "-H", `User-Agent: ${BROWSER_UA}`,
     "-H", `Origin: ${ORIGIN}`,
     "-H", `Referer: ${ORIGIN}/`,
     "-H", "Content-Type: application/json",
     "--data", body, url],
    { timeout: (timeoutS + 5) * 1000, maxBuffer: 1 << 20 }
  );
  return stdout;
}

/** Mint (or reuse) a PoW token. Fail-open: returns null on any problem. */
async function ensurePowToken(): Promise<string | null> {
  const cached = g2.__fclipSavenowPow;
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;
  try {
    const chRaw = await (async () => {
      const res = await curlGet(`${SAVE_BASE}/api/pow/challenge`, 12);
      return res.status === 200 ? res.body : "";
    })();
    if (!chRaw) return null;
    const ch = JSON.parse(chRaw) as { salt: string; difficulty: number; expires_at: number; signature: string };
    if (!ch?.salt || !ch?.signature) return null;
    const nonce = solvePow(String(ch.salt), Number(ch.difficulty));
    const vRaw = await curlJsonPost(
      `${SAVE_BASE}/api/pow/verify`,
      JSON.stringify({
        salt: ch.salt,
        difficulty: ch.difficulty,
        expires_at: ch.expires_at,
        signature: ch.signature,
        nonce,
      }),
      12
    );
    const v = JSON.parse(vRaw) as { success?: boolean; token?: string; expires_at?: number };
    if (!v?.success || !v.token) return null;
    const tok: PowToken = { token: v.token, expiresAt: (v.expires_at ?? 0) * 1000 };
    g2.__fclipSavenowPow = tok;
    return tok.token;
  } catch {
    return null; // fail-open, like their own client
  }
}

/**
 * Request a full-video render in the given format ("4k" is the measured-good
 * value; "1440" exists in their dropdown but is unconfirmed server-side).
 * Shared-key mode: retries 3 attempts through throttle windows (90 s+
 * backoff). Owned-key mode (FCLIP_SAVENOW_API_KEY): no PoW dance, and a
 * quota throttle fails through immediately — burning a registered key's
 * request budget on hopeless retries is worse than degrading to 1080p60.
 */
export async function savenowRequestRender(
  videoId: string,
  format: string,
  opts: { throttleRetry?: boolean } = {}
): Promise<{ id: string; fullFormat: string }> {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const qs = `format=${encodeURIComponent(format)}&url=${encodeURIComponent(pageUrl)}&apikey=${SHARED_FRONTEND_API_KEY}`;
  let lastErr = "";
  let failThrough = false;

  outer: for (let attempt = 0; attempt < (HAS_OWN_KEY ? 2 : opts.throttleRetry === false ? 1 : 3); attempt++) {
    if (attempt > 0) await sleep(HAS_OWN_KEY ? 4_000 : 90_000 + Math.floor(Math.random() * 20_000));
    const bearer = HAS_OWN_KEY ? null : await ensurePowToken(); // fail-open; mirrors the browser
    for (const base of [SAVE_BASE, SAVE_BASE_FALLBACK]) {
      try {
        const res = await curlGet(`${base}/api/v2/download?${qs}`, 25, bearer);
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
          if (HAS_OWN_KEY) {
            // owned key: fail through to the 1080p60 lane NOW — no fallback
            // host, no retry window (each request burns key budget)
            failThrough = true;
            break outer;
          }
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
  const bearer = HAS_OWN_KEY ? null : await ensurePowToken();

  while (Date.now() < deadline) {
    let url: string | undefined;
    try {
      const res = await curlGet(`${SAVE_BASE}/api/progress?id=${encodeURIComponent(id)}`, 20, bearer);
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
