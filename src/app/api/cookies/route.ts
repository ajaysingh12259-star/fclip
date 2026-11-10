import { NextResponse } from "next/server";
import { existsSync, writeFileSync, unlinkSync, statSync } from "fs";
import { COOKIES_PATH } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* GET — whether cookies are configured */
export async function GET() {
  const present = existsSync(COOKIES_PATH);
  return NextResponse.json({
    present,
    savedAt: present ? statSync(COOKIES_PATH).mtime.toISOString() : null,
  });
}

/* POST — save cookies.txt content (Netscape format) */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { content?: string };
    const content = (body.content ?? "").replace(/\r\n/g, "\n").trim();
    if (!content) {
      return NextResponse.json({ error: "Cookie content is empty." }, { status: 400 });
    }
    if (!content.startsWith("# Netscape") && !content.includes("\t")) {
      return NextResponse.json(
        { error: "This does not look like a cookies.txt file (Netscape format). Export it with a 'Get cookies.txt' browser extension." },
        { status: 400 }
      );
    }
    writeFileSync(COOKIES_PATH, content + "\n", { mode: 0o600 });
    return NextResponse.json({ ok: true, present: true });
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
}

/* DELETE — clear cookies */
export async function DELETE() {
  try {
    if (existsSync(COOKIES_PATH)) unlinkSync(COOKIES_PATH);
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true, present: false });
}
