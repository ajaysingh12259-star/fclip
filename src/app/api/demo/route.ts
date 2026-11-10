import { NextResponse } from "next/server";
import { ensureDemoVideo } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* POST — make sure the demo clip exists, return a yt-dlp-fetchable URL for it */
export async function POST() {
  try {
    await ensureDemoVideo();
    const port = process.env.PORT ?? 3000;
    return NextResponse.json({ url: `http://127.0.0.1:${port}/api/demo-video` });
  } catch {
    return NextResponse.json({ error: "Could not prepare the demo video." }, { status: 500 });
  }
}
