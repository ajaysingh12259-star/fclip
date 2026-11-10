import { NextResponse } from "next/server";
import { fetchInfo, checkEngine, engineMissingMessage, isVercel } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { url?: string };
    const url = (body.url ?? "").trim();
    if (!url) {
      return NextResponse.json({ error: { code: "bad_input", message: "Please paste a video URL." } }, { status: 400 });
    }
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { error: { code: "bad_input", message: "That does not look like a valid URL. It should start with http(s)://" } },
        { status: 400 }
      );
    }
    // Fail fast (and clearly) on hosts that cannot run yt-dlp/ffmpeg, e.g. Vercel.
    const engine = await checkEngine();
    if (!engine.ytDlp || !engine.ffmpeg) {
      return NextResponse.json(
        { error: { code: "engine_missing", message: engineMissingMessage() }, engine, vercel: isVercel() },
        { status: 500 }
      );
    }
    const result = await fetchInfo(url);
    if (!result.ok) {
      const status = result.error.code === "bot_check" ? 403 : 502;
      return NextResponse.json({ error: result.error, detail: result.detail }, { status });
    }
    return NextResponse.json({ info: result.info });
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Malformed request." } },
      { status: 400 }
    );
  }
}
