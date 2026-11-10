"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";
import { Timeline } from "@/components/fclip/timeline";
import { YtPlayer, type YtPlayerHandle } from "@/components/fclip/yt-player";
import { CookiesDialog } from "@/components/fclip/cookies-dialog";
import {
  Scissors,
  Link2,
  Download,
  Loader2,
  KeyRound,
  Clapperboard,
  Timer,
  Eye,
  CalendarDays,
  UserRound,
  FlaskConical,
  TriangleAlert,
  XCircle,
  CheckCircle2,
  Trash2,
  SlidersHorizontal,
  ShieldCheck,
  Globe,
  Play,
  Square,
  PencilLine,
  ExternalLink,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

interface VideoInfo {
  id: string | null;
  title: string;
  channel: string | null;
  duration: number;
  thumbnail: string | null;
  viewCount: number | null;
  uploadDate: string | null;
  isLive: boolean;
  chapters: { start: number; end: number; title: string }[] | null;
  qualities: { height: number; tbr: number | null; ext: string }[];
  webpageUrl: string;
}

interface JobView {
  id: string;
  url: string;
  start: number;
  end: number;
  maxHeight: number | null;
  precise: boolean;
  title: string;
  status: "queued" | "running" | "done" | "error" | "canceled";
  stage: string;
  progress: number;
  logTail: string[];
  filename: string | null;
  filesize: number | null;
  clipDuration: number | null;
  error: string | null;
  createdAt: number;
}

interface InfoError {
  code: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const YT_ID_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

function parseVideoId(url: string): string | null {
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

function extractT(url: string): number | null {
  const m = url.match(/[?&](?:t|start)=([\dhms.]+)/);
  if (!m) return null;
  const raw = m[1];
  if (/^\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
  const h = raw.match(/(\d+(?:\.\d+)?)h/);
  const min = raw.match(/(\d+(?:\.\d+)?)m/);
  const s = raw.match(/(\d+(?:\.\d+)?)s/);
  const v = (h ? parseFloat(h[1]) * 3600 : 0) + (min ? parseFloat(min[1]) * 60 : 0) + (s ? parseFloat(s[1]) : 0);
  return v > 0 ? v : null;
}

function parseTimeInput(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p) || p < 0)) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function fmtClock(t: number): string {
  const s = Math.floor(t % 60);
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(b: number | null): string {
  if (!b || b <= 0) return "—";
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const BITRATE_TABLE: Record<number, number> = { 2160: 22, 1440: 11, 1080: 6, 720: 3, 480: 1.5 };

function estimateSizeMB(
  start: number,
  end: number,
  quality: string,
  qualities: { height: number; tbr: number | null }[]
): number {
  const dur = Math.max(0, end - start);
  let mbps = 8;
  if (quality === "best") {
    const top = qualities[0];
    if (top) mbps = top.tbr ? top.tbr / 1000 : BITRATE_TABLE[top.height] ?? 8;
  } else {
    const h = Number(quality);
    const q = qualities.find((x) => x.height === h);
    mbps = q ? (q.tbr ? q.tbr / 1000 : BITRATE_TABLE[h] ?? 5) : BITRATE_TABLE[h] ?? 5;
  }
  return Math.max(1, Math.round((dur * mbps) / 8));
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T;
  return { ok: res.ok, data };
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const { toast } = useToast();

  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<InfoError | null>(null);
  const [thumbError, setThumbError] = useState(false);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(10);
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("0:10");

  const [quality, setQuality] = useState("best");
  const [precise, setPrecise] = useState(false);

  const [job, setJob] = useState<JobView | null>(null);
  const [recent, setRecent] = useState<JobView[]>([]);
  const [startingClip, setStartingClip] = useState(false);

  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [cookiesPresent, setCookiesPresent] = useState(false);

  /** Server hit the YouTube bot wall — we keep going using the in-browser player. */
  const [fallbackPending, setFallbackPending] = useState(false);
  const [serverBlocked, setServerBlocked] = useState(false);
  /** User chose to type times blind (no info, no player). */
  const [manualMode, setManualMode] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const playerRef = useRef<YtPlayerHandle>(null);

  const ytId = useMemo(() => info?.id ?? parseVideoId(url), [info, url]);
  const busyJob = job && (job.status === "running" || job.status === "queued");

  /* ---------------- data loading ---------------- */

  const refreshRecent = useCallback(async () => {
    const { ok, data } = await jsonFetch<{ jobs: JobView[] }>("/api/clip");
    if (ok) setRecent(data.jobs);
  }, []);

  useEffect(() => {
    void refreshRecent();
    void jsonFetch<{ present: boolean }>("/api/cookies").then(({ ok, data }) => {
      if (ok) setCookiesPresent(data.present);
    });
  }, [refreshRecent]);

  const fetchInfoFor = useCallback(
    async (target: string) => {
      setInfoLoading(true);
      setInfoError(null);
      setInfo(null);
      setJob(null);
      setFallbackPending(false);
      setServerBlocked(false);
      setManualMode(false);
      setPreviewing(false);
      try {
        const { ok, data } = await jsonFetch<{ info?: VideoInfo; error?: InfoError }>("/api/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: target }),
        });
        if (!ok || !data.info) {
          setInfoError(data.error ?? { code: "unknown", message: "Could not fetch video info." });
          // The bot wall only blocks the server — the YouTube player still works
          // in the browser, so fall back to it for the preview + times.
          if (data.error?.code === "bot_check" && parseVideoId(target)) {
            setFallbackPending(true);
          }
          return;
        }
        const v = data.info;
        setInfo(v);
        setThumbError(false);
        const t = extractT(target);
        const s = t !== null ? Math.min(t, Math.max(0, v.duration - 1)) : 0;
        const e = Math.min(s + 30, v.duration || s + 30);
        setStart(Math.round(s * 10) / 10);
        setEnd(Math.round(Math.max(s + 1, e) * 10) / 10);
        setQuality("best");
      } catch {
        setInfoError({
          code: "network",
          message:
            "Could not reach the fclip server. If this is a fresh deployment, check the platform logs — serverless hosts such as Vercel can't run fclip (it needs a Docker-capable host).",
        });
      } finally {
        setInfoLoading(false);
      }
    },
    []
  );

  const submitUrl = () => {
    const u = url.trim();
    if (!u) {
      toast({ title: "Paste a video link first", variant: "destructive" });
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      toast({
        title: "That does not look like a URL",
        description: "It should start with http:// or https://",
        variant: "destructive",
      });
      return;
    }
    void fetchInfoFor(u);
  };

  const loadDemo = async () => {
    setInfoLoading(true);
    try {
      const { ok, data } = await jsonFetch<{ url?: string; error?: string }>("/api/demo", { method: "POST" });
      if (ok && data.url) {
        setUrl(data.url);
        await fetchInfoFor(data.url);
        toast({ title: "Demo video loaded", description: "A local test clip you can cut & download right away." });
      } else {
        toast({ title: "Demo failed", description: data.error ?? "Unknown error", variant: "destructive" });
      }
    } finally {
      setInfoLoading(false);
    }
  };

  /* ------- fallback: build info from the in-browser YouTube player ------- */

  useEffect(() => {
    if (!fallbackPending || !ytId) return;
    const startedAt = Date.now();
    const iv = setInterval(() => {
      const player = playerRef.current;
      const d = player?.getDuration() ?? 0;
      if (d > 0) {
        clearInterval(iv);
        setFallbackPending(false);
        setServerBlocked(true);
        const vd = player?.getVideoData();
        const webpage = url.includes(ytId) ? url.trim() : `https://www.youtube.com/watch?v=${ytId}`;
        setInfo({
          id: ytId,
          title: vd?.title || "YouTube video",
          channel: vd?.author ?? null,
          duration: d,
          thumbnail: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
          viewCount: null,
          uploadDate: null,
          isLive: false,
          chapters: null,
          qualities: [],
          webpageUrl: webpage,
        });
        setInfoError(null);
        setStart(0);
        setEnd(Math.min(30, d));
        setQuality("best");
        toast({
          title: "Preview loaded from your browser",
          description:
            "YouTube blocked the server from indexing this video. Scrub the player and set your crop times — cutting will retry through alternate clients.",
        });
        return;
      }
      if (Date.now() - startedAt > 20000) {
        clearInterval(iv);
        setFallbackPending(false);
        toast({
          title: "Automatic preview not available",
          description: "Use “Enter times manually” below and type the crop points yourself.",
          variant: "destructive",
        });
      }
    }, 400);
    return () => clearInterval(iv);
  }, [fallbackPending, ytId, url, toast]);

  /* ------- preview the selected range inside the player ------- */

  useEffect(() => {
    if (!previewing) return;
    const player = playerRef.current;
    if (!player) {
      setPreviewing(false);
      return;
    }
    player.seekTo(start, true);
    player.play();
    const iv = setInterval(() => {
      const t = player.getCurrentTime();
      if (t >= end - 0.05) {
        player.pause();
        player.seekTo(start, false);
        setPreviewing(false);
      }
    }, 250);
    return () => clearInterval(iv);
  }, [previewing, start, end]);

  const enterManualMode = () => {
    setManualMode(true);
    setFallbackPending(false);
    setServerBlocked(false);
    setPreviewing(false);
    setInfoError(null);
    setInfo({
      id: null,
      title: "Manual clip",
      channel: null,
      duration: 14400,
      thumbnail: null,
      viewCount: null,
      uploadDate: null,
      isLive: false,
      chapters: null,
      qualities: [],
      webpageUrl: url.trim(),
    });
    setStart(0);
    setEnd(30);
    setQuality("best");
    toast({
      title: "Manual mode",
      description: "Type the crop points below (e.g. 2:20:00 and 2:40:00) and press Cut.",
    });
  };

  /* ---------------- time sync ---------------- */

  const applyRange = useCallback((s: number, e: number) => {
    setStart(s);
    setEnd(e);
    setStartText(fmtClock(s));
    setEndText(fmtClock(e));
  }, []);

  useEffect(() => {
    setStartText(fmtClock(start));
    setEndText(fmtClock(end));
  }, [start, end]);

  const commitTime = (which: "start" | "end") => {
    const parsed = parseTimeInput(which === "start" ? startText : endText);
    if (parsed === null) {
      toast({
        title: "Could not read that time",
        description: "Use formats like 90, 1:30 or 1:02:30",
        variant: "destructive",
      });
      applyRange(start, end);
      return;
    }
    const max = info?.duration ?? 36000;
    if (which === "start") {
      const s = Math.min(parsed, Math.max(0, end - 1), Math.max(0, max - 1));
      applyRange(Math.round(s * 10) / 10, end);
    } else {
      const e = Math.max(parsed, start + 1, Math.min(max, start + 1));
      applyRange(start, Math.round(Math.min(e, max) * 10) / 10);
    }
  };

  const grabPlayerTime = (which: "start" | "end") => {
    const t = playerRef.current?.getCurrentTime() ?? null;
    if (t === null) {
      toast({ title: "Player not ready yet", variant: "destructive" });
      return;
    }
    if (which === "start") applyRange(Math.round(Math.min(t, end - 1) * 10) / 10, end);
    else applyRange(start, Math.round(Math.max(t, start + 1) * 10) / 10);
  };

  /* ---------------- clip actions ---------------- */

  const startClip = async () => {
    if (!info) return;
    if (end <= start) {
      toast({ title: "End must be after start", variant: "destructive" });
      return;
    }
    setStartingClip(true);
    try {
      const { ok, data } = await jsonFetch<{ job?: JobView; error?: string }>("/api/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: info.webpageUrl,
          start,
          end,
          maxHeight: quality === "best" ? null : Number(quality),
          precise,
          title: info.title,
        }),
      });
      if (ok && data.job) {
        setJob(data.job);
        void refreshRecent();
        toast({ title: "Cutting started", description: "Only the selected byte-ranges are being fetched." });
      } else {
        toast({ title: "Could not start the clip", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setStartingClip(false);
    }
  };

  const removeJobById = async (id: string) => {
    await fetch(`/api/clip?jobId=${id}`, { method: "DELETE" });
    if (job?.id === id) setJob(null);
    void refreshRecent();
  };

  const jobActive = job?.status === "running" || job?.status === "queued";

  /* poll the active job */
  useEffect(() => {
    if (!job || !jobActive) return;
    const id = job.id;
    const iv = setInterval(async () => {
      const { ok, data } = await jsonFetch<{ job: JobView }>(`/api/clip?jobId=${id}`);
      if (ok) {
        setJob(data.job);
        if (data.job.status === "done") {
          toast({ title: "Clip ready 🎬", description: "Your download is waiting below." });
          void refreshRecent();
        } else if (data.job.status === "error") {
          void refreshRecent();
        }
      }
    }, 1200);
    return () => clearInterval(iv);
  }, [job?.id, jobActive, job?.status, refreshRecent, toast]);

  /* ---------------- derived UI data ---------------- */

  const duration = info?.duration ?? 0;
  const clipLen = Math.max(0, end - start);
  const estMB = info ? estimateSizeMB(start, end, quality, info.qualities) : 0;
  const topQualities = (info?.qualities ?? []).slice(0, 3);
  const selectedHeight = quality === "best" ? null : Number(quality);
  const isWebmPick = selectedHeight !== null && selectedHeight >= 1440;
  const clipInvalid = end <= start;
  const recentOthers = recent.filter((j) => j.id !== job?.id);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* ambient glow */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-red-500/10 via-orange-500/5 to-transparent" />

      {/* header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-red-500 to-orange-500 shadow-sm">
              <Scissors className="h-4.5 w-4.5 text-white" aria-hidden />
            </div>
            <span className="text-lg font-bold tracking-tight">fclip</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              free · no login
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCookiesOpen(true)}
            aria-label="Cookie settings"
            className="gap-2"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Cookies {cookiesPresent ? "· saved ✓" : ""}</span>
          </Button>
        </div>
      </header>

      {/* main */}
      <main className="relative mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-10">
        {/* hero */}
        <section className="mb-8 text-center">
          <h1 className="text-balance text-3xl font-extrabold tracking-tight sm:text-4xl">
            Cut YouTube clips online — <span className="bg-gradient-to-r from-red-500 to-orange-500 bg-clip-text text-transparent">free & in up to 4K</span>
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
            Paste a link, pick the exact seconds, download just that part. fclip fetches
            <strong className="text-foreground"> only the byte-ranges it needs</strong> — a 30-second cut from a
            4 GB 4K video transfers a fraction of the file. No account, no watermark.
          </p>
        </section>

        {/* URL bar */}
        <section aria-label="Video URL" className="mb-6">
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !infoLoading && submitUrl()}
                    placeholder="https://www.youtube.com/watch?v=…"
                    className="h-11 pl-9 text-sm sm:text-base"
                    aria-label="Video URL"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={submitUrl}
                    disabled={infoLoading}
                    className="h-11 flex-1 gap-2 bg-gradient-to-r from-red-500 to-orange-500 text-white hover:opacity-90 sm:flex-none sm:px-6"
                  >
                    {infoLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Clapperboard className="h-4 w-4" aria-hidden />}
                    Fetch video
                  </Button>
                  <Button onClick={loadDemo} disabled={infoLoading} variant="outline" className="h-11 gap-2">
                    <FlaskConical className="h-4 w-4" aria-hidden />
                    Demo
                  </Button>
                </div>
              </div>
              <p className="mt-2.5 text-xs text-muted-foreground">
                Works with youtube.com, youtu.be, Shorts, and any direct video URL — timestamps in the link
                (<code className="rounded bg-muted px-1">&amp;t=90</code>) pre-fill the clip start.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* info error */}
        {infoError && (
          <section className="mb-6" aria-live="polite">
            <Alert className={infoError.code === "bot_check" ? "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200" : "border-red-500/50 bg-red-500/10"}>
              <TriangleAlert className="h-4 w-4" aria-hidden />
              <AlertTitle>
                {infoError.code === "bot_check"
                  ? "YouTube wants to verify this server"
                  : infoError.code === "engine_missing"
                    ? "This server can't run fclip"
                    : "Could not fetch this video"}
              </AlertTitle>
              <AlertDescription className="mt-1.5 space-y-3 text-sm">
                <p>{infoError.message}</p>
                {infoError.code === "engine_missing" && (
                  <div className="flex flex-wrap gap-2">
                    <a
                      href="https://github.com/ajay122596-rgb/fclip/blob/main/DEPLOY.md"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Button size="sm" variant="outline" className="gap-2">
                        <ExternalLink className="h-4 w-4" aria-hidden /> How to deploy fclip properly
                      </Button>
                    </a>
                  </div>
                )}
                {infoError.code === "bot_check" && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setCookiesOpen(true)} className="gap-2 bg-gradient-to-r from-red-500 to-orange-500 text-white hover:opacity-90">
                      <KeyRound className="h-4 w-4" aria-hidden /> Add browser cookies
                    </Button>
                    <Button size="sm" variant="outline" onClick={enterManualMode} className="gap-2">
                      <PencilLine className="h-4 w-4" aria-hidden /> Enter times manually
                    </Button>
                    <span className="py-1.5 text-xs text-muted-foreground">or try again — it can be a transient rate-limit.</span>
                  </div>
                )}
              </AlertDescription>
            </Alert>

            {/* The preview still streams from YouTube inside the browser even when the
                server is bot-walled — attach the player so the crop tools can use it. */}
            {infoError.code === "bot_check" && ytId && (
              <div className="mt-4 space-y-2">
                <YtPlayer ref={playerRef} videoId={ytId} />
                {fallbackPending && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Waiting for the player so the crop tools can attach…
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* loading skeleton */}
        {infoLoading && (
          <section className="mb-6">
            <Card><CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:p-6">
              <Skeleton className="aspect-video w-full rounded-lg sm:w-80" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-9 w-full" />
              </div>
            </CardContent></Card>
          </section>
        )}

        {/* video info + editor */}
        {info && !infoLoading && (
          <section className="mb-6 space-y-4">
            <Card className="border-border/60 shadow-sm">
              <CardContent className="p-4 sm:p-6">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,22rem)_1fr] sm:gap-6">
                  {/* thumbnail */}
                  <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-gradient-to-br from-red-500/15 to-orange-500/15">
                    {info.thumbnail && !thumbError ? (
                      <img
                        src={info.thumbnail}
                        alt={`Thumbnail of ${info.title}`}
                        className="h-full w-full object-cover"
                        onError={() => setThumbError(true)}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Clapperboard className="h-10 w-10 text-muted-foreground" aria-hidden />
                      </div>
                    )}
                    {!manualMode && (
                      <Badge className="absolute bottom-2 right-2 bg-black/80 text-white tabular-nums">
                        {fmtClock(info.duration)}
                      </Badge>
                    )}
                  </div>
                  {/* meta */}
                  <div className="min-w-0">
                    <h2 className="line-clamp-2 text-base font-semibold leading-snug sm:text-lg">{info.title}</h2>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground sm:text-sm">
                      {info.channel && (
                        <span className="inline-flex items-center gap-1.5">
                          <UserRound className="h-3.5 w-3.5" aria-hidden /> {info.channel}
                        </span>
                      )}
                      {info.viewCount != null && (
                        <span className="inline-flex items-center gap-1.5">
                          <Eye className="h-3.5 w-3.5" aria-hidden /> {info.viewCount.toLocaleString()} views
                        </span>
                      )}
                      {info.uploadDate && (
                        <span className="inline-flex items-center gap-1.5">
                          <CalendarDays className="h-3.5 w-3.5" aria-hidden /> {info.uploadDate.slice(0, 4)}-{info.uploadDate.slice(4, 6)}-{info.uploadDate.slice(6, 8)}
                        </span>
                      )}
                    </div>
                    {topQualities.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">Available:</span>
                        {topQualities.map((q) => (
                          <Badge key={q.height} variant="outline" className="tabular-nums">
                            {q.height}p{q.height >= 2160 ? " · 4K" : q.height >= 1440 ? " · 2K" : ""}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {info.chapters && info.chapters.length > 0 && (
                      <div className="mt-3">
                        <p className="mb-1.5 text-xs text-muted-foreground">Chapters — tap to load one into the cutter:</p>
                        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                          {info.chapters.slice(0, 14).map((c, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => applyRange(c.start, Math.min(c.end, duration))}
                              className="rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-red-400 hover:bg-red-500/10"
                              title={`${fmtClock(c.start)} → ${fmtClock(c.end)}`}
                            >
                              {c.title} <span className="tabular-nums text-muted-foreground">{fmtClock(c.start)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {info.isLive && (
                      <Alert className="mt-3 border-amber-500/50 bg-amber-500/10">
                        <TriangleAlert className="h-4 w-4" aria-hidden />
                        <AlertDescription className="text-xs">
                          This is a live stream — fclip can only cut finished videos.
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* clip editor */}
            <Card className="border-border/60 shadow-sm">
              <CardContent className="space-y-5 p-4 sm:p-6">
                {serverBlocked && (
                  <Alert className="border-amber-500/50 bg-amber-500/10">
                    <TriangleAlert className="h-4 w-4" aria-hidden />
                    <AlertDescription className="text-xs leading-relaxed">
                      Preview &amp; times come straight from your browser. The server itself is blocked by YouTube
                      from indexing this video, so cutting will auto-retry with alternate clients — if it still
                      fails, add cookies in Settings or run fclip on your own machine.
                    </AlertDescription>
                  </Alert>
                )}

                {ytId && !manualMode && (
                  <div className="space-y-2">
                    <YtPlayer ref={playerRef} videoId={ytId} />
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => grabPlayerTime("start")} className="gap-1.5">
                        <Timer className="h-3.5 w-3.5 text-red-500" aria-hidden /> Set start to player time
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => grabPlayerTime("end")} className="gap-1.5">
                        <Timer className="h-3.5 w-3.5 text-orange-500" aria-hidden /> Set end to player time
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewing((v) => !v)}
                        disabled={previewing ? false : !info || end <= start}
                        className="gap-1.5"
                      >
                        {previewing ? <Square className="h-3.5 w-3.5 text-foreground" aria-hidden /> : <Play className="h-3.5 w-3.5 text-emerald-500" aria-hidden />}
                        {previewing ? "Stop preview" : "Preview selection"}
                      </Button>
                      <span className="py-1 text-xs text-muted-foreground">Scrub the video above, then grab the exact second here.</span>
                    </div>
                  </div>
                )}

                {!manualMode && (
                  <Timeline
                    duration={duration || 60}
                    start={start}
                    end={end}
                    chapters={info.chapters}
                    onChange={applyRange}
                  />
                )}

                {/* precise time inputs */}
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div>
                    <label htmlFor="clip-start" className="mb-1.5 block text-xs font-medium text-muted-foreground">Start</label>
                    <Input
                      id="clip-start"
                      value={startText}
                      onChange={(e) => setStartText(e.target.value)}
                      onBlur={() => commitTime("start")}
                      onKeyDown={(e) => e.key === "Enter" && commitTime("start")}
                      className="h-10 font-mono tabular-nums"
                      inputMode="numeric"
                      aria-describedby="clip-length-hint"
                    />
                  </div>
                  <div>
                    <label htmlFor="clip-end" className="mb-1.5 block text-xs font-medium text-muted-foreground">End</label>
                    <Input
                      id="clip-end"
                      value={endText}
                      onChange={(e) => setEndText(e.target.value)}
                      onBlur={() => commitTime("end")}
                      onKeyDown={(e) => e.key === "Enter" && commitTime("end")}
                      className="h-10 font-mono tabular-nums"
                      inputMode="numeric"
                    />
                  </div>
                  <div id="clip-length-hint" className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 sm:mb-0">
                    <div>
                      <p className="text-xs text-muted-foreground">Selected</p>
                      <p className="text-sm font-semibold tabular-nums">
                        {fmtClock(clipLen)} <span className="font-normal text-muted-foreground">· ≈ {estMB} MB</span>
                      </p>
                    </div>
                  </div>
                </div>

                <p className="-mt-1 text-xs text-muted-foreground">
                  Accepts <code className="rounded bg-muted px-1">90</code>, <code className="rounded bg-muted px-1">1:30</code> or{" "}
                  <code className="rounded bg-muted px-1">2:20:00</code> (h:mm:ss).
                </p>

                {clipInvalid && (
                  <p className="text-xs text-red-500">The end time must be after the start time.</p>
                )}

                {/* quality + precision */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Quality</label>
                    <Select value={quality} onValueChange={setQuality}>
                      <SelectTrigger className="h-10 w-full" aria-label="Clip quality">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="best">Best available</SelectItem>
                        {(info.qualities ?? []).map((q) => (
                          <SelectItem key={q.height} value={String(q.height)}>
                            {q.height}p{q.height >= 2160 ? " (4K)" : q.height >= 1440 ? " (2K)" : ""}
                            {q.ext === "webm" ? " · VP9" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {info.qualities.length === 0 && (
                      <p className="text-xs text-muted-foreground">Only &ldquo;best&rdquo; is offered for this source.</p>
                    )}
                    {isWebmPick && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        2K/4K on YouTube use VP9 (webm) — plays in browsers & VLC. Pick 1080p for classic MP4 (H.264).
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="precise-switch" className="text-xs font-medium text-muted-foreground">Cut precision</label>
                    <div className="flex h-10 items-center gap-3 rounded-lg border px-3">
                      <Switch id="precise-switch" checked={precise} onCheckedChange={setPrecise} />
                      <span className="text-sm">{precise ? "Frame-accurate" : "Fast (keyframe-aligned)"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {precise
                        ? "Re-encodes at the boundaries for exact timing — slower on high resolutions."
                        : "Snaps to the nearest keyframe (±2 s) — instant, no re-encoding."}
                    </p>
                  </div>
                </div>

                {/* CTA */}
                <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground sm:max-w-sm">
                    fclip streams only the fragments covering {fmtClock(start)} → {fmtClock(end)} — it never
                    pulls the full {fmtClock(duration)} file.
                  </p>
                  <Button
                    onClick={startClip}
                    disabled={clipInvalid || info.isLive || !!busyJob || startingClip}
                    className="h-11 gap-2 bg-gradient-to-r from-red-500 to-orange-500 text-white hover:opacity-90"
                  >
                    {busyJob || startingClip ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Scissors className="h-4 w-4" aria-hidden />}
                    {busyJob ? "Cutting…" : "Cut & download clip"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* active job */}
        {job && (
          <section className="mb-6" aria-live="polite">
            <Card className={job.status === "error" ? "border-red-500/40" : job.status === "done" ? "border-emerald-500/40" : "border-border/60"}>
              <CardContent className="space-y-3 p-4 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      {job.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />}
                      {job.status === "error" && <XCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden />}
                      {busyJob && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-red-500" aria-hidden />}
                      <span className="truncate">
                        {job.status === "done" ? "Clip ready" : job.status === "error" ? "Clip failed" : job.stage}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {job.title} · {fmtClock(job.start)} → {fmtClock(job.end)}
                      {job.maxHeight ? ` · ≤${job.maxHeight}p` : " · best"}
                      {job.precise ? " · frame-accurate" : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Remove this job" onClick={() => removeJobById(job.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>

                {busyJob && (
                  <div className="space-y-1">
                    <Progress value={job.progress >= 0 ? job.progress : undefined} className="h-2.5" />
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {job.progress >= 0 ? `${job.progress.toFixed(0)}%` : "working…"} — downloading only the needed ranges
                    </p>
                  </div>
                )}

                {job.status === "error" && job.error && (
                  <p className="text-sm text-red-500">{job.error}</p>
                )}

                {job.status === "done" && (
                  <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-medium">{job.filename}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {fmtBytes(job.filesize)}
                        {job.clipDuration ? ` · ${fmtClock(job.clipDuration)}` : ""} · saved for 2 hours
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <a href={`/api/clip/file?jobId=${job.id}`} download>
                        <Button className="gap-2 bg-gradient-to-r from-red-500 to-orange-500 text-white hover:opacity-90">
                          <Download className="h-4 w-4" aria-hidden /> Download clip
                        </Button>
                      </a>
                    </div>
                  </div>
                )}

                {job.logTail.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      Processing log ({job.logTail.length} lines)
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {job.logTail.join("\n")}
                    </pre>
                  </details>
                )}
              </CardContent>
            </Card>
          </section>
        )}

        {/* recent clips */}
        {recentOthers.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recent clips (this session)</h2>
            <Card>
              <CardContent className="max-h-72 space-y-2 overflow-y-auto p-3">
                {recentOthers.map((j) => (
                  <div key={j.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{j.title}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {fmtClock(j.start)} → {fmtClock(j.end)} · {fmtBytes(j.filesize)} ·{" "}
                        <span
                          className={
                            j.status === "done"
                              ? "text-emerald-500"
                              : j.status === "error"
                              ? "text-red-500"
                              : j.status === "canceled"
                              ? "text-muted-foreground"
                              : "text-amber-500"
                          }
                        >
                          {j.status}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {j.status === "done" && (
                        <a href={`/api/clip/file?jobId=${j.id}`} download aria-label={`Download ${j.title} clip`}>
                          <Button variant="outline" size="icon" className="h-8 w-8">
                            <Download className="h-4 w-4" aria-hidden />
                          </Button>
                        </a>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Remove" onClick={() => removeJobById(j.id)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        )}

        {/* how it works */}
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-bold">How fclip works</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: Link2, title: "1 · Paste the link", text: "Any YouTube video, Shorts link, or direct video URL. Timestamped links pre-fill the start point." },
              { icon: SlidersHorizontal, title: "2 · Pick seconds & quality", text: "Drag the timeline or use the built-in player to grab exact times — up to 2160p (4K) where available." },
              { icon: Download, title: "3 · Download the clip", text: "yt-dlp fetches only the needed byte-ranges, ffmpeg trims & muxes, and your clip is ready — no watermark." },
            ].map((s) => (
              <Card key={s.title} className="border-border/60">
                <CardContent className="p-4">
                  <s.icon className="mb-2 h-5 w-5 text-red-500" aria-hidden />
                  <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section>
          <h2 className="mb-3 text-lg font-bold">FAQ</h2>
          <Accordion type="single" collapsible className="rounded-lg border bg-card">
            <AccordionItem value="q1" className="border-b px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">Is fclip really free?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Yes — no account, no watermark, no per-clip limits. fclip is a self-hostable web app built on
                the open-source <strong className="text-foreground">yt-dlp</strong> and{" "}
                <strong className="text-foreground">ffmpeg</strong> engines. Self-hosting it on your own
                machine keeps everything free and private.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="q2" className="border-b px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">How can it cut 4K without downloading the whole 4 GB file?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Modern video streams are split into small segments that players request over HTTP. yt-dlp
                seeks into the stream with byte-range requests and downloads only the fragments covering your
                selected seconds (plus a little padding to the previous keyframe), then ffmpeg trims and
                remuxes locally. A 30-second 4K cut typically transfers a few hundred megabytes instead of
                gigabytes.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="q3" className="border-b px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">Why does YouTube sometimes ask for cookies?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                YouTube aggressively rate-limits cloud and datacenter IPs with a &ldquo;confirm you&rsquo;re not a
                bot&rdquo; wall. Adding your browser cookies (the official yt-dlp recommendation) or running
                fclip on your own machine both fix it. The Cookies button in the header walks you through it.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="q4" className="px-4">
              <AccordionTrigger className="text-sm">What may I download?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Use fclip for content you have the right to use — your own uploads, Creative-Commons or
                public-domain material, or content whose license permits downloading. Respect creators and
                the platform&rsquo;s terms of service.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>
      </main>

      {/* footer */}
      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-2 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:flex-row sm:text-left">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
            Use only with content you own or that is licensed for reuse — respect creators&rsquo; rights and
            YouTube&rsquo;s Terms of Service.
          </p>
          <p className="flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5" aria-hidden />
            fclip · powered by yt-dlp + ffmpeg
          </p>
        </div>
      </footer>

      <CookiesDialog
        open={cookiesOpen}
        onOpenChange={setCookiesOpen}
        cookiesPresent={cookiesPresent}
        onSaved={() => {
          setCookiesPresent(true);
          toast({ title: "Cookies saved", description: "They will be used for all fetches from now on." });
        }}
        onCleared={() => {
          setCookiesPresent(false);
          toast({ title: "Cookies removed" });
        }}
      />
    </div>
  );
}
