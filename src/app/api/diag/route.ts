import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { checkEngine, getBinaryPaths, farmStatus, DATA_DIR } from "@/lib/ytdlp";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe diagnostics for the render-farm engine: binary status, farm key
 * presence (never the key value) and live reachability of both farm lanes.
 */
export async function GET() {
  const engine = await checkEngine();

  /** HEAD-like reachability probe through curl (both farms sit behind
   *  Cloudflare TLS fingerprinting — curl passes where fetch 403s). */
  const probe = async (url: string, extra: string[] = []): Promise<number | null> => {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", ...extra, url],
        { timeout: 12_000, encoding: "utf8" }
      );
      const code = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(code) ? code : null;
    } catch {
      return null;
    }
  };

  const [savenow, videolimit] = await Promise.all([
    probe("https://p.savenow.to/api/pow/challenge"),
    probe("https://videolimit.com/api/videolimit/clip-token"),
  ]);

  return NextResponse.json({
    service: "fclip",
    engine,
    binaries: getBinaryPaths(),
    farm: farmStatus(),
    lanes: {
      savenowReachable: savenow !== null && savenow < 500,
      savenowHttp: savenow,
      videolimitReachable: videolimit !== null && videolimit < 500,
      videolimitHttp: videolimit,
    },
    clipsDir: DATA_DIR,
  });
}
