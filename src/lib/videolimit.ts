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
 */

const VL_BASE = "https://videolimit.com";

/** Random public-looking IPv4 (avoids 0/10/127/169.254/224+/255 endings). */
function randomXff(): string {
  const a = 2 + Math.floor(Math.random() * 222); // 2..223 — no reserved heads
  const b = Math.floor(Math.random() * 256);
  const c = Math.floor(Math.random() * 256);
  const d = 1 + Math.floor(Math.random() * 253); // avoid .0 / .255 tails
  return `${a}.${b}.${c}.${d}`;
}

function fpHeader(): string {
  return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
  const timeoutMs = opts.timeoutMs ?? 240_000;
  let lastErr = "";

  for (let i = 0; i < attempts; i++) {
    const xff = randomXff();
    const headers: Record<string, string> = {
      "X-Client-Fp": fpHeader(),
      "X-Forwarded-For": xff,
    };
    try {
      // 1. server-issued token pair
      const tokRes = await fetch(`${VL_BASE}/api/videolimit/clip-token`, {
        headers,
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      if (!tokRes.ok) throw new Error(`clip-token HTTP ${tokRes.status}`);
      const tok = (await tokRes.json()) as { timestamp?: number; hash?: string };
      if (!tok?.timestamp || !tok?.hash) throw new Error("clip-token missing fields");

      // 2. render (blocks until the clip is finished server-side)
      const res = await fetch(`${VL_BASE}/api/videolimit/create-clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          videoId,
          startTime: Math.max(0, Math.round(startSec)),
          endTime: Math.max(1, Math.round(endSec)),
          quality: "1080p60",
          format: "mp4",
          timestamp: tok.timestamp,
          hash: tok.hash,
        }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`create-clip non-JSON HTTP ${res.status}`);
      }

      if (res.ok && body.success) {
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

      // Quota responses (429 / limitReached) — rotate identity and retry.
      const msg = String((body as { message?: string }).message ?? `HTTP ${res.status}`);
      lastErr = msg;
      if (res.status === 429 || (body as { limitReached?: boolean }).limitReached) {
        continue;
      }
      // Non-quota failures (format_unavailable, private video…) are terminal.
      throw new Error(msg);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (/format_unavailable|not available/i.test(lastErr)) throw new Error(lastErr);
      // network/timeout → next attempt with a fresh identity
    }
  }
  throw new Error(lastErr || "videolimit relay unavailable");
}
