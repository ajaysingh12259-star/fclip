import { NextResponse } from "next/server";
import {
  createClipJob,
  getJob,
  listJobs,
  cancelJob,
  removeJob,
  serializeJob,
  checkEngine,
  engineMissingMessage,
} from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* POST — start a new clip job */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      url?: string;
      start?: number;
      end?: number;
      maxHeight?: number | null;
      precise?: boolean;
      title?: string;
    };
    const url = (body.url ?? "").trim();
    const start = Number(body.start);
    const end = Number(body.end);
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "A valid video URL is required." }, { status: 400 });
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return NextResponse.json({ error: "Clip range is invalid — the end must be after the start." }, { status: 400 });
    }
    if (end - start > 3600) {
      return NextResponse.json({ error: "Clip is longer than 1 hour — please pick a shorter range." }, { status: 400 });
    }
    // Fail fast (and clearly) on hosts that cannot run yt-dlp/ffmpeg, e.g. Vercel.
    const engine = await checkEngine();
    if (!engine.ytDlp || !engine.ffmpeg) {
      return NextResponse.json({ error: engineMissingMessage() }, { status: 500 });
    }
    const job = createClipJob({
      url,
      start,
      end,
      maxHeight: body.maxHeight ?? null,
      precise: Boolean(body.precise),
      title: body.title,
    });
    return NextResponse.json({ job: serializeJob(job) });
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
}

/* GET — status of one job (?jobId=) or the recent list */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (jobId) {
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    return NextResponse.json({ job: serializeJob(job) });
  }
  return NextResponse.json({ jobs: listJobs().map(serializeJob) });
}

/* DELETE — cancel a running job or remove a finished one */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  const canceled = cancelJob(jobId);
  const removed = removeJob(jobId);
  if (!canceled && !removed) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
