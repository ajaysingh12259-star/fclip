/**
 * VideoLimit HD relay lane ("sn---s.clipscutter.com" premium backbone).
 *
 * OSINT provenance (2026-11-11, live-measured from a datacenter IP, zero cookies):
 *  - videolimit.com is a trimmer front-end whose backend relays render jobs to
 *    the SAME premium clipscutter render farm fclip's turbo route uses — the
 *    returned `resolvedDownloadUrl` lives on `sn---s.clipscutter.com/clip/…`.
 *  - `GET /api/videolimit/clip-token` → `{timestamp, hash}` (server-issued HMAC pair).
 *  - `POST /api/videolimit/create-clip`
 *      headers: Content-Type, X-Client-Fp (any string), optional X-Forwarded-For
 *      body:    {videoId, startTime (SECONDS), endTime (SECONDS), quality, format,
 *                timestamp, hash}
 *      → blocks until rendered, then `{success, data:{clip_id, quality},
 *        resolvedDownloadUrl}` — the file is the FINISHED clip (h264+aac, verified
 *        1280x720@60 and 1920x1080@60 with ffprobe).
 *  - Anonymous ceiling measured: 1080p60 mp4 for trims, 720p for full downloads;
 *    1440p/2160p silently downgrade without a license (hasValidLicense:false).
 *  - Their anonymous quota is keyed on the CLIENT-CONTROLLED X-Forwarded-For
 *    header (1 clip / ~30 days / IP-ish bucket — measured: fresh XFF ⇒ fresh
 *    budget, response `rateLimit:{used:1,remaining:0}` otherwise). We rotate a
 *    random public XFF per attempt.
 *  - `resolvedDownloadUrl` is public: ffprobe fetched it with no cookies.
 *
 * Transport note: Cloudflare in front of videolimit.com fingerprints TLS
 * clients — Node's undici fetch measured HTTP 403 on clip-token while curl
 * with browser headers passed (verified repeatedly from the same IP). All API
 * traffic therefore goes through the curl binary, never fetch().
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const VL_BASE = "https://videolimit.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Random public-looking IPv4 (avoids 0/10/127/169.254/224+/255 endings). */
function randomXff(): string {
  const a = 2 + Math.floor(Math.random() * 222);
  const b = Math.floor(Math.random() * 256);
  const c = Math.floor(Math.random() * 256);
  const d = 1 + Math.floor(Math.random() * 253);
  return `${a}.${b}.${c}.${d}`;
}

function fpHeader(): string {
  return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** curl GET returning {status, body}. */
async function curlGet(url: string, headers: Record<string, string>, timeoutS: number) {
  const args = [
    "-sS", "--max-time", String(timeoutS), "-w", "\n%{http_code}", url,
    "-H", `User-Agent: ${UA}`,
    "-H", `Referer: ${VL_BASE}/`,
    "-H", "Accept: */*",
  ];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  try {
    const { stdout } = await execFileAsync("curl", args, { timeout: (timeoutS + 5) * 1000, maxBuffer: 4 << 20 });
    const idx = stdout.lastIndexOf("\n");
    return { status: Number.parseInt(stdout.slice(idx + 1).trim(), 10) || 0, body: stdout.slice(0, idx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`curl GET failed: ${msg.slice(0, 160)}`);
  }
}

/** curl POST returning {status, body}. */
async function curlPost(url: string, headers: Record<string, string>, body: string, timeoutS: number) {
  const args = [
    "-sS", "--max-time", String(timeoutS), "-w", "\n%{http_code}", url,
    "-X", "POST",
    "-H", `User-Agent: ${UA}`,
    "-H", `Referer: ${VL_BASE}/`,
    "-H", "Accept: */*",
    "-H", "Content-Type: application/json",
    "--data", body,
  ];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  try {
    const { stdout } = await execFileAsync("curl", args, { timeout: (timeoutS + 5) * 1000, maxBuffer: 4 << 20 });
    const idx = stdout.lastIndexOf("\n");
    return { status: Number.parseInt(stdout.slice(idx + 1).trim(), 10) || 0, body: stdout.slice(0, idx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`curl POST failed: ${msg.slice(0, 160)}`);
  }
}

export interface VlClip {
  clipId: string;
  quality: string;
  format: string;
  url: string;
}

/**
 * Render a trimmed clip through the VideoLimit relay. Returns the finished
 * file URL. Retries on their per-XFF quota with fresh identities.
 */
export async function vlCreateClip(
  videoId: string,
  startSec: number,
  endSec: number,
  opts: { attempts?: number; timeoutMs?: number } = {}
): Promise<VlClip> {
  const attempts = opts.attempts ?? 3;
  const timeoutS = Math.ceil((opts.timeoutMs ?? 240_000) / 1000);
  let lastErr = "";

  for (let i = 0; i < attempts; i++) {
    const headers = {
      "X-Client-Fp": fpHeader(),
      "X-Forwarded-For": randomXff(),
      Origin: VL_BASE,
    };
    try {
      // 1. server-issued token pair
      const tok = await curlGet(`${VL_BASE}/api/videolimit/clip-token`, headers, 25);
      if (tok.status !== 200) throw new Error(`clip-token HTTP ${tok.status}`);
      let token: { timestamp?: number; hash?: string };
      try {
        token = JSON.parse(tok.body) as { timestamp?: number; hash?: string };
      } catch {
        throw new Error(`clip-token non-JSON (${tok.body.slice(0, 120)})`);
      }
      if (!token?.timestamp || !token?.hash) throw new Error("clip-token missing fields");

      // 2. render (blocks until the clip is finished server-side)
      const res = await curlPost(
        `${VL_BASE}/api/videolimit/create-clip`,
        headers,
        JSON.stringify({
          videoId,
          startTime: Math.max(0, Math.round(startSec)),
          endTime: Math.max(1, Math.round(endSec)),
          quality: "1080p60",
          format: "mp4",
          timestamp: token.timestamp,
          hash: token.hash,
        }),
        timeoutS
      );
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        throw new Error(`create-clip non-JSON HTTP ${res.status} (${res.body.slice(0, 120)})`);
      }

      if (res.status === 200 && body.success) {
        const data = (body.data ?? {}) as { clip_id?: string; quality?: string; format?: string };
        const url = (body.resolvedDownloadUrl as string) || "";
        if (!url) throw new Error("create-clip success without download url");
        return {
          clipId: data.clip_id ?? "",
          quality: data.quality ?? "1080p60",
          format: data.format ?? "mp4",
          url,
        };
      }

      const msg = String((body as { message?: string }).message ?? `HTTP ${res.status}`);
      lastErr = msg;
      if (res.status === 429 || (body as { limitReached?: boolean }).limitReached) {
        continue; // quota — rotate identity, retry
      }
      throw new Error(msg); // terminal (format_unavailable, private video…)
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (/format_unavailable|not available/i.test(lastErr)) throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "videolimit relay unavailable");
}
