import { NextResponse } from "next/server";
import { readFileSync, existsSync, statSync } from "fs";
import { checkEngine, getBinaryPaths, getCookiesMode, cookieHealth, stormStatus, warpHealth, COOKIES_PATH } from "@/lib/ytdlp";
import { relayHealth } from "@/lib/instances";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe diagnostics: reports cookie *domains* (never values), provider
 * reachability and engine status. Helps troubleshoot bot-wall issues
 * (e.g. detecting that a non-YouTube cookies.txt was pasted by mistake).
 */
export async function GET() {
  const engine = await checkEngine();

  let provider: { reachable: boolean; version?: string } = { reachable: false };
  try {
    const res = await fetch("http://127.0.0.1:4416/ping", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      provider = { reachable: true, version: body.version };
    }
  } catch {
    /* provider not running */
  }

  let cookies: Record<string, unknown> = { present: false };
  if (existsSync(COOKIES_PATH)) {
    try {
      const lines = readFileSync(COOKIES_PATH, "utf8").split("\n");
      const domainCounts = new Map<string, number>();
      let cookieLines = 0;
      for (const line of lines) {
        if (!line.trim() || line.startsWith("#")) continue;
        cookieLines++;
        const domain = line.split("\t")[0]?.trim() ?? "?";
        domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      }
      const domains = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([domain, count]) => ({ domain, count }));
      cookies = {
        present: true,
        savedAt: statSync(COOKIES_PATH).mtime.toISOString(),
        cookieLines,
        domains,
      };
    } catch {
      cookies = { present: true, error: "unreadable" };
    }
  }

  return NextResponse.json({
    service: "fclip",
    engine,
    provider,
    cookies,
    cookieHealth: cookieHealth(),
    storm: stormStatus(),
    warp: await warpHealth(),
    relay: relayHealth(),
    cookiesMode: getCookiesMode(),
    binaries: getBinaryPaths(),
  });
}
