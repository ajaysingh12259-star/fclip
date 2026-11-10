import { statSync, createReadStream, existsSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { getJob, CLIPS_DIR } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeTitle(title: string): string {
  const cleaned = title.replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60).trim();
  return cleaned || "video";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId is required." }, { status: 400 });

  const job = getJob(jobId);
  if (!job || job.status !== "done" || !job.filename) {
    return NextResponse.json({ error: "Clip is not ready." }, { status: 404 });
  }
  const filePath = path.join(CLIPS_DIR, jobId, job.filename);
  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "File no longer exists (expired)." }, { status: 410 });
  }
  const stat = statSync(filePath);
  const ext = path.extname(job.filename).replace(".", "") || "mp4";
  const downloadName = `fclip-${safeTitle(job.title)}-${Math.round(job.start)}s-${Math.round(job.end)}s.${ext}`;

  const range = req.headers.get("range");
  // ?inline=1 lets the browser <video> preview play the clip in place;
  // the default stays "attachment" so plain links still download.
  const disposition = searchParams.get("inline") === "1" ? "inline" : "attachment";
  const headers = new Headers({
    "Content-Type": ext === "webm" ? "video/webm" : "video/mp4",
    "Content-Disposition": `${disposition}; filename="fclip-clip.${ext}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers });
  }

  headers.set("Content-Length", String(stat.size));
  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
}
