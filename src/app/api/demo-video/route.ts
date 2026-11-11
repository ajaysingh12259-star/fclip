import { statSync, createReadStream, existsSync } from "fs";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { DEMO_PATH, ensureDemoVideo } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* GET — stream the demo video with HTTP Range support so yt-dlp/ffmpeg can seek into it */

/** Abort-safe response wrapper — see api/clip/file/route.ts for the why. */
function toWebResponse(stream: Readable, status: number, headers: Headers): Response {
  stream.on("error", () => {
    /* client aborts are expected — do not crash the process */
  });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}

export async function GET(req: Request) {
  if (!existsSync(DEMO_PATH)) {
    try {
      await ensureDemoVideo();
    } catch {
      return NextResponse.json({ error: "Demo video not ready." }, { status: 500 });
    }
  }
  const stat = statSync(DEMO_PATH);
  const range = req.headers.get("range");
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    const headers = new Headers(baseHeaders);
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = createReadStream(DEMO_PATH, { start, end });
    return toWebResponse(stream, 206, headers);
  }

  const headers = new Headers(baseHeaders);
  headers.set("Content-Length", String(stat.size));
  const stream = createReadStream(DEMO_PATH);
  return toWebResponse(stream, 200, headers);
}
