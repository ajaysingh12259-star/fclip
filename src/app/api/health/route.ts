import { NextResponse } from "next/server";
import { checkEngine, farmStatus, isVercel, DATA_DIR } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reachability + diagnostics endpoint used by Railway/Render healthchecks. */
export async function GET() {
  const engine = await checkEngine();
  return NextResponse.json({
    ok: true,
    service: "fclip",
    engine,
    farm: farmStatus(),
    dataDir: DATA_DIR,
    vercel: isVercel(),
  });
}
