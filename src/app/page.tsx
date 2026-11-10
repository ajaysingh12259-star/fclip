"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { DiagPanel } from "@/components/fclip/diag-panel";
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
  ShieldCheck,
  Globe,
  Play,
  Square,
  PencilLine,
  ExternalLink,
  Gauge,
  Activity,
  Wand2,
  Zap,
  MousePointerClick,
  ListVideo,
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
  qualityHint?: string | null;
  route?: "direct" | "storm" | "relay";
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

function qualityLabel(h: number): string {
  if (h >= 4320) return `${h}p · 8K`;
  if (h >= 2160) return `${h}p · 4K`;
  if (h >= 1440) return `${h}p · 2K`;
  return `${h}p`;
}

/** Map the server's stage text onto the 4-step tracker. */
function stageIndex(stage: string, status: JobView["status"]): number {
  if (status === "done") return 3;
  if (status === "error" || status === "canceled") return -1;
  const s = stage.toLowerCase();
  if (/merg|process|correct|ffmpeg/.test(s)) return 2;
  if (/download|byte|relay|cut/.test(s)) return 1;
  return 0;
}

const STAGES = ["Resolve", "Fetch ranges", "Mux", "Ready"];

const SAMPLES = [
  { label: "Me at the zoo", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  { label: "Big Buck Bunny (CC)", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
  { label: "Blender: Elephants Dream (CC)", url: "https://www.youtube.com/watch?v=TLkA0RELQ1g" },
];

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
  const [diagOpen, setDiagOpen] = useState(false);
  const [engineUp, setEngineUp] = useState<boolean | null>(null);

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
    void jsonFetch<{ ok: boolean }>("/api/health").then(({ ok, data }) => {
      setEngineUp(ok && data.ok !== false);
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
        if (v.qualityHint) {
          toast({ title: "Fetched via the cookie-free relay", description: v.qualityHint });
        }
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
    [toast]
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
            "YouTube blocked the server from indexing this video. Scrub the player and set your crop times — cutting will retry through the relay network.",
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
          toast({ title: "Clip ready 🎬", description: "Preview it right here, then download." });
          void refreshRecent();
        } else if (data.job.status === "error") {
          void refreshRecent();
        }
      }
    }, 1200);
    return () => clearInterval(iv);
  }, [job?.id, jobActive, job?.status, refreshRecent, toast]);

  /* Cmd/Ctrl+Enter: submit the URL, or cut when the editor is live */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (info && !busyJob) void startClip();
        else if (!infoLoading) submitUrl();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, busyJob, infoLoading, start, end, quality, precise, url]);

  /* ---------------- derived UI data ---------------- */

  const duration = info?.duration ?? 0;
  const clipLen = Math.max(0, end - start);
  const estMB = info ? estimateSizeMB(start, end, quality, info.qualities) : 0;
  const selectedHeight = quality === "best" ? null : Number(quality);
  const isWebmPick = selectedHeight !== null && selectedHeight >= 1440;
  const clipInvalid = end <= start;
  const recentOthers = recent.filter((j) => j.id !== job?.id);
  const qualityOptions = (info?.qualities ?? []).slice(0, 6);
  const activeStage = job ? stageIndex(job.stage, job.status) : -1;

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      {/* ambient background */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(60rem_32rem_at_15%_-5%,rgba(139,92,246,0.14),transparent),radial-gradient(48rem_30rem_at_85%_0%,rgba(217,70,239,0.10),transparent),radial-gradient(40rem_28rem_at_50%_110%,rgba(56,189,248,0.07),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      </div>

      {/* header */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-orange-400 shadow-lg shadow-fuchsia-500/20">
              <Scissors className="h-4 w-4 text-white" aria-hidden />
            </div>
            <span className="text-lg font-bold tracking-tight">fclip</span>
            <Badge variant="outline" className="hidden text-[10px] uppercase tracking-wide text-muted-foreground sm:inline-flex">
              cookie-free cutting
            </Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
              title={engineUp === null ? "Checking engine…" : engineUp ? "Engine healthy" : "Engine unreachable"}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  engineUp === null ? "animate-pulse bg-amber-400" : engineUp ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" : "bg-red-500"
                }`}
              />
              engine
            </span>
            <Button variant="ghost" size="sm" onClick={() => setDiagOpen(true)} className="gap-2">
              <Activity className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Diagnostics</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCookiesOpen(true)} aria-label="Cookie settings" className="gap-2">
              <KeyRound className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Cookies{cookiesPresent ? " ✓" : ""}</span>
            </Button>
          </div>
        </div>
      </header>

      {/* main */}
      <main className="relative mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-12">
        {/* hero */}
        <section className="mb-10 text-center">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <Badge variant="outline" className="mb-4 gap-1.5 border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground">
              <Zap className="h-3 w-3 text-fuchsia-400" aria-hidden />
              yt-dlp + ffmpeg · byte-range cutting · up to 4K
            </Badge>
            <h1 className="text-balance text-4xl font-extrabold tracking-tight sm:text-5xl">
              Cut YouTube clips,{" "}
              <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-orange-300 bg-clip-text text-transparent">
                no cookies needed
              </span>
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
              Paste a link, pick the exact seconds, download just that part. fclip streams
              <strong className="text-foreground"> only the byte-ranges it needs</strong> and, when YouTube walls the
              server, switches to its <strong className="text-foreground">turbo relay backbone</strong> — an account
              and cookies are never required.
            </p>
          </motion.div>

          {/* URL bar */}
          <motion.section
            aria-label="Video URL"
            className="mx-auto mt-8 max-w-3xl"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.08 }}
          >
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-2 shadow-2xl shadow-black/40 backdrop-blur">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !infoLoading && submitUrl()}
                    placeholder="Paste a YouTube or direct video link…"
                    className="h-12 border-transparent bg-transparent pl-9 text-sm focus-visible:ring-1 focus-visible:ring-fuchsia-500/40 sm:text-base"
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
                    className="h-12 flex-1 gap-2 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/25 hover:opacity-90 sm:flex-none sm:px-7"
                  >
                    {infoLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Clapperboard className="h-4 w-4" aria-hidden />}
                    Fetch video
                  </Button>
                  <Button onClick={loadDemo} disabled={infoLoading} variant="outline" className="h-12 gap-2 border-white/10 bg-white/5 hover:bg-white/10">
                    <FlaskConical className="h-4 w-4" aria-hidden />
                    Demo
                  </Button>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <span className="hidden sm:inline">Try:</span>
              {SAMPLES.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => {
                    setUrl(s.url);
                    void fetchInfoFor(s.url);
                  }}
                  className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 transition-colors hover:border-fuchsia-400/40 hover:bg-fuchsia-500/10 hover:text-foreground"
                >
                  {s.label}
                </button>
              ))}
              <span className="ml-1 hidden md:inline">· timestamps in the link (<code className="rounded bg-muted px-1">&amp;t=90</code>) pre-fill the start</span>
            </div>
          </motion.section>

          {/* steps */}
          <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs text-muted-foreground">
            {[
              { icon: MousePointerClick, text: "Paste the link" },
              { icon: Gauge, text: "Drag the timeline, pick a quality" },
              { icon: Download, text: "Download the clip" },
            ].map((s, i) => (
              <span key={s.text} className="inline-flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5">
                  <s.icon className="h-3 w-3 text-fuchsia-400" aria-hidden />
                </span>
                {s.text}
                {i < 2 && <span className="ml-4 hidden text-white/20 sm:inline">→</span>}
              </span>
            ))}
          </div>
        </section>

        {/* info error */}
        {infoError && (
          <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mb-6 max-w-3xl" aria-live="polite">
            <Alert className="border-amber-500/40 bg-amber-500/[0.07]">
              <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden />
              <AlertTitle>
                {infoError.code === "bot_check" || infoError.code === "no_formats"
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
                {(infoError.code === "bot_check" || infoError.code === "no_formats") && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setCookiesOpen(true)} className="gap-2 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:opacity-90">
                      <KeyRound className="h-4 w-4" aria-hidden /> Add browser cookies
                    </Button>
                    <Button size="sm" variant="outline" onClick={enterManualMode} className="gap-2 border-white/10 bg-white/5 hover:bg-white/10">
                      <PencilLine className="h-4 w-4" aria-hidden /> Enter times manually
                    </Button>
                    <span className="py-1.5 text-xs text-muted-foreground">or try again — the relay network may pick it up.</span>
                  </div>
                )}
              </AlertDescription>
            </Alert>

            {/* The preview still streams from YouTube inside the browser even when the
                server is bot-walled — attach the player so the crop tools can use it. */}
            {(infoError.code === "bot_check" || infoError.code === "no_formats") && ytId && (
              <div className="mt-4 space-y-2">
                <YtPlayer ref={playerRef} videoId={ytId} />
                {fallbackPending && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Waiting for the player so the crop tools can attach…
                  </p>
                )}
              </div>
            )}
          </motion.section>
        )}

        {/* loading skeleton */}
        {infoLoading && (
          <section className="mx-auto mb-6 max-w-3xl">
            <Card className="border-white/10 bg-white/[0.03]">
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:p-6">
                <Skeleton className="aspect-video w-full rounded-lg sm:w-80" />
                <div className="flex-1 space-y-3">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-9 w-full" />
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* video info + editor */}
        {info && !infoLoading && (
          <motion.section
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="grid items-start gap-4 lg:grid-cols-[1fr_360px]"
          >
            {/* left: player + timeline */}
            <div className="space-y-4">
              <Card className="border-white/10 bg-white/[0.03]">
                <CardContent className="p-3 sm:p-4">
                  {ytId && !manualMode ? (
                    <YtPlayer ref={playerRef} videoId={ytId} />
                  ) : (
                    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-violet-500/15 to-fuchsia-500/10">
                      {info.thumbnail && !thumbError ? (
                        // eslint-disable-next-line @next/next/no-img-element
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
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-start justify-between gap-2 px-1">
                    <div className="min-w-0">
                      <h2 className="line-clamp-2 text-base font-semibold leading-snug sm:text-lg">{info.title}</h2>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {info.route === "relay" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
                            title="Served through fclip's cookie-less turbo relay — residential-egress extraction, byte proxy, no bot wall"
                          >
                            <Zap className="h-3 w-3" aria-hidden /> Turbo route
                          </span>
                        )}
                        {info.route === "storm" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                            title="YouTube was bypassed via a parallel player-identity burst — no cookies used"
                          >
                            <Zap className="h-3 w-3" aria-hidden /> Storm breakthrough
                          </span>
                        )}
                        {(!info.route || info.route === "direct") && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
                            title="Fetched directly by the server — fastest path"
                          >
                            <ShieldCheck className="h-3 w-3" aria-hidden /> Direct
                          </span>
                        )}
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
                        {!manualMode && (
                          <span className="inline-flex items-center gap-1.5 tabular-nums">
                            <Timer className="h-3.5 w-3.5" aria-hidden /> {fmtClock(info.duration)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {info.chapters && info.chapters.length > 0 && (
                    <div className="mt-3 px-1">
                      <p className="mb-1.5 text-xs text-muted-foreground">Chapters — tap to load one into the cutter:</p>
                      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                        {info.chapters.slice(0, 14).map((c, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => applyRange(c.start, Math.min(c.end, duration))}
                            className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs transition-colors hover:border-fuchsia-400/40 hover:bg-fuchsia-500/10"
                            title={`${fmtClock(c.start)} → ${fmtClock(c.end)}`}
                          >
                            {c.title} <span className="tabular-nums text-muted-foreground">{fmtClock(c.start)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {serverBlocked && (
                    <Alert className="mt-3 border-amber-500/40 bg-amber-500/[0.07]">
                      <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden />
                      <AlertDescription className="text-xs leading-relaxed">
                        Preview &amp; times come straight from your browser. Cutting will auto-retry through
                        alternate clients and the cookie-free relay network.
                      </AlertDescription>
                    </Alert>
                  )}

                  {info.isLive && (
                    <Alert className="mt-3 border-amber-500/40 bg-amber-500/[0.07]">
                      <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden />
                      <AlertDescription className="text-xs">
                        This is a live stream — fclip can only cut finished videos.
                      </AlertDescription>
                    </Alert>
                  )}

                  {info.qualityHint && (
                    <p
                      className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                        info.route === "relay"
                          ? "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300"
                          : "border-fuchsia-500/30 bg-fuchsia-500/[0.08] text-fuchsia-300"
                      }`}
                    >
                      <Wand2 className="mr-1 inline h-3.5 w-3.5" aria-hidden /> {info.qualityHint}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="border-white/10 bg-white/[0.03]">
                <CardContent className="space-y-4 p-3 sm:p-4">
                  {!manualMode && (
                    <Timeline
                      duration={duration || 60}
                      start={start}
                      end={end}
                      chapters={info.chapters}
                      onChange={applyRange}
                    />
                  )}

                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div>
                      <label htmlFor="clip-start" className="mb-1.5 block text-xs font-medium text-muted-foreground">Start</label>
                      <Input
                        id="clip-start"
                        value={startText}
                        onChange={(e) => setStartText(e.target.value)}
                        onBlur={() => commitTime("start")}
                        onKeyDown={(e) => e.key === "Enter" && commitTime("start")}
                        className="h-10 border-white/10 bg-white/5 font-mono tabular-nums"
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
                        className="h-10 border-white/10 bg-white/5 font-mono tabular-nums"
                        inputMode="numeric"
                      />
                    </div>
                    <div id="clip-length-hint" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                      <div>
                        <p className="text-[11px] text-muted-foreground">Selected</p>
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

                  {ytId && !manualMode && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => grabPlayerTime("start")} className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10">
                        <Timer className="h-3.5 w-3.5 text-violet-400" aria-hidden /> Start = player time
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => grabPlayerTime("end")} className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10">
                        <Timer className="h-3.5 w-3.5 text-fuchsia-400" aria-hidden /> End = player time
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewing((v) => !v)}
                        disabled={previewing ? false : !info || end <= start}
                        className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10"
                      >
                        {previewing ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5 text-emerald-400" aria-hidden />}
                        {previewing ? "Stop preview" : "Preview selection"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* right: controls */}
            <div className="space-y-4 lg:sticky lg:top-20">
              <Card className="border-white/10 bg-white/[0.03]">
                <CardContent className="space-y-4 p-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Quality</label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setQuality("best")}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                          quality === "best"
                            ? "border-transparent bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-fuchsia-500/20"
                            : "border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10"
                        }`}
                      >
                        Best
                      </button>
                      {qualityOptions.map((q) => (
                        <button
                          key={q.height}
                          type="button"
                          onClick={() => setQuality(String(q.height))}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium tabular-nums transition-all ${
                            quality === String(q.height)
                              ? "border-transparent bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-fuchsia-500/20"
                              : "border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10"
                          }`}
                        >
                          {qualityLabel(q.height)}
                        </button>
                      ))}
                    </div>
                    {qualityOptions.length === 0 && (
                      <p className="text-xs text-muted-foreground">Only “best” is offered for this source.</p>
                    )}
                    {isWebmPick && (
                      <p className="text-xs text-amber-400">
                        2K/4K on YouTube use VP9 (webm) — plays in browsers &amp; VLC. Pick 1080p for classic MP4 (H.264).
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="precise-switch" className="text-xs font-medium text-muted-foreground">Cut precision</label>
                    <div className="flex h-10 items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3">
                      <Switch id="precise-switch" checked={precise} onCheckedChange={setPrecise} />
                      <span className="text-sm">{precise ? "Frame-accurate" : "Fast (keyframe-aligned)"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {precise
                        ? "Re-encodes at the boundaries for exact timing — slower on high resolutions."
                        : "Snaps to the nearest keyframe (±2 s) — instant, no re-encoding."}
                    </p>
                  </div>

                  {clipInvalid && (
                    <p className="text-xs text-red-500">The end time must be after the start time.</p>
                  )}

                  <Button
                    onClick={startClip}
                    disabled={clipInvalid || info.isLive || !!busyJob || startingClip}
                    className="h-12 w-full gap-2 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-base text-white shadow-lg shadow-fuchsia-500/25 hover:opacity-90"
                  >
                    {busyJob || startingClip ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Scissors className="h-4 w-4" aria-hidden />}
                    {busyJob ? "Cutting…" : "Cut & download clip"}
                  </Button>
                  <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                    Streams only the fragments covering {fmtClock(start)} → {fmtClock(end)} — never the full{" "}
                    {fmtClock(duration)} file. <kbd className="rounded bg-muted px-1">⌘/Ctrl</kbd>+
                    <kbd className="rounded bg-muted px-1">↵</kbd> works too.
                  </p>
                </CardContent>
              </Card>

              <Card className="hidden border-white/10 bg-white/[0.03] lg:block">
                <CardContent className="p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <ListVideo className="h-3.5 w-3.5" aria-hidden /> How the pipeline picks a route
                  </p>
                  <ol className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    <li><strong className="text-foreground">1 · Direct</strong> — yt-dlp with BotGuard PO tokens, no cookies.</li>
                    <li><strong className="text-foreground">2 · Storm</strong> — parallel player-identity bursts until one gets through.</li>
                    <li><strong className="text-foreground">3 · Turbo relay + HD render</strong> — residential-egress extraction + premium render farm: 1080p60 with zero cookies, beats the bot wall.</li>
                    <li><strong className="text-foreground">4 · Community relays</strong> — public Piped/Invidious instances as backup.</li>
                    <li><strong className="text-foreground">Cookies</strong> — optional booster, never a requirement.</li>
                  </ol>
                </CardContent>
              </Card>
            </div>
          </motion.section>
        )}

        {/* active job */}
        {job && (
          <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mb-6 mt-4 max-w-3xl" aria-live="polite">
            <Card
              className={
                job.status === "error"
                  ? "border-red-500/40 bg-red-500/[0.04]"
                  : job.status === "done"
                    ? "border-emerald-500/40 bg-emerald-500/[0.04]"
                    : "border-white/10 bg-white/[0.03]"
              }
            >
              <CardContent className="space-y-3 p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      {job.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />}
                      {job.status === "error" && <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />}
                      {busyJob && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fuchsia-400" aria-hidden />}
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

                {/* stage tracker */}
                {job.status !== "error" && (
                  <div className="flex items-center gap-1.5">
                    {STAGES.map((s, i) => {
                      const state = i < activeStage ? "done" : i === activeStage ? "active" : "todo";
                      return (
                        <div key={s} className="flex flex-1 flex-col gap-1">
                          <div
                            className={`h-1 rounded-full transition-colors duration-500 ${
                              state === "done"
                                ? "bg-emerald-400"
                                : state === "active"
                                  ? "bg-gradient-to-r from-violet-500 to-fuchsia-500"
                                  : "bg-white/10"
                            }`}
                          />
                          <span className={`text-[10px] ${state === "todo" ? "text-muted-foreground/60" : "text-foreground"}`}>{s}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {busyJob && (
                  <div className="space-y-1">
                    <Progress value={job.progress >= 0 ? job.progress : undefined} className="h-2" />
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {job.progress >= 0 ? `${job.progress.toFixed(0)}%` : "working…"} — fetching only the needed ranges
                    </p>
                  </div>
                )}

                {job.status === "error" && job.error && (
                  <p className="text-sm text-red-400">{job.error}</p>
                )}

                {job.status === "done" && (
                  <div className="space-y-3">
                    <video
                      key={job.id}
                      controls
                      playsInline
                      preload="metadata"
                      className="max-h-[420px] w-full rounded-lg border border-white/10 bg-black"
                      src={`/api/clip/file?jobId=${job.id}&inline=1`}
                    />
                    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 text-sm">
                        <p className="truncate font-medium">{job.filename}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {fmtBytes(job.filesize)}
                          {job.clipDuration ? ` · ${fmtClock(job.clipDuration)}` : ""} · saved for 2 hours
                        </p>
                      </div>
                      <a href={`/api/clip/file?jobId=${job.id}`} download className="shrink-0">
                        <Button className="gap-2 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/25 hover:opacity-90">
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
                    <pre className="mt-2 max-h-40 overflow-y-auto rounded-md border border-white/10 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {job.logTail.join("\n")}
                    </pre>
                  </details>
                )}
              </CardContent>
            </Card>
          </motion.section>
        )}

        {/* recent clips */}
        {recentOthers.length > 0 && (
          <section className="mx-auto mb-8 mt-4 max-w-3xl">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recent clips (this session)</h2>
            <Card className="border-white/10 bg-white/[0.03]">
              <CardContent className="max-h-72 space-y-2 overflow-y-auto p-3">
                {recentOthers.map((j) => (
                  <div key={j.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{j.title}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {fmtClock(j.start)} → {fmtClock(j.end)} · {fmtBytes(j.filesize)} ·{" "}
                        <span
                          className={
                            j.status === "done"
                              ? "text-emerald-400"
                              : j.status === "error"
                                ? "text-red-400"
                                : j.status === "canceled"
                                  ? "text-muted-foreground"
                                  : "text-amber-400"
                          }
                        >
                          {j.status}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {j.status === "done" && (
                        <a href={`/api/clip/file?jobId=${j.id}`} download aria-label={`Download ${j.title} clip`}>
                          <Button variant="outline" size="icon" className="h-8 w-8 border-white/10 bg-white/5 hover:bg-white/10">
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

        {/* features */}
        <section className="mx-auto mb-6 mt-10 max-w-4xl">
          <h2 className="mb-4 text-center text-lg font-bold">Why fclip</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: Zap, title: "Byte-range cutting", text: "A 30-second cut from a 4 GB 4K video transfers a fraction of the file — yt-dlp seeks straight into the stream." },
              { icon: Wand2, title: "Cookie-free by design", text: "PO-token sessions, client storms and a relay network get clips through without any YouTube login." },
              { icon: Gauge, title: "Original quality", text: "Up to 2160p with zero re-encoding — fast cuts are keyframe-snapped stream copies." },
            ].map((s) => (
              <Card key={s.title} className="border-white/10 bg-white/[0.03]">
                <CardContent className="p-4">
                  <s.icon className="mb-2 h-5 w-5 text-fuchsia-400" aria-hidden />
                  <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-3xl">
          <h2 className="mb-3 text-lg font-bold">FAQ</h2>
          <Accordion type="single" collapsible className="rounded-xl border border-white/10 bg-card">
            <AccordionItem value="q1" className="border-b border-white/5 px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">Is fclip really free?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Yes — no account, no watermark, no per-clip limits. fclip is a self-hostable web app built on
                the open-source <strong className="text-foreground">yt-dlp</strong> and{" "}
                <strong className="text-foreground">ffmpeg</strong> engines. Self-hosting it on your own
                machine keeps everything free and private.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="q2" className="border-b border-white/5 px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">How does it work without cookies?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Three independent routes, tried in order: (1) yt-dlp with automatically minted BotGuard
                proof-of-origin tokens; (2) a parallel &ldquo;storm&rdquo; of YouTube player identities until one
                breaks through the bot wall; (3) a relay network of public Piped/Invidious instances that fetch
                and proxy the media through their own IPs. Cookies are an optional booster for edge cases
                (private or age-restricted videos) — never a requirement.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="q3" className="border-b border-white/5 px-4 last:border-b-0">
              <AccordionTrigger className="text-sm">How can it cut 4K without downloading the whole 4 GB file?</AccordionTrigger>
              <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                Modern video streams are split into small segments that players request over HTTP. yt-dlp
                seeks into the stream with byte-range requests and downloads only the fragments covering your
                selected seconds (plus a little padding to the previous keyframe), then ffmpeg trims and
                remuxes locally. A 30-second 4K cut typically transfers a few hundred megabytes instead of
                gigabytes.
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
      <footer className="mt-auto border-t border-white/5 bg-background/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:flex-row sm:text-left">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
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

      <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
        <DialogContent className="border-white/10 bg-background/95 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-fuchsia-400" aria-hidden /> Engine diagnostics
            </DialogTitle>
            <DialogDescription className="text-xs">
              Live status of the cutting pipeline — cookie names are never shown, only health.
            </DialogDescription>
          </DialogHeader>
          <DiagPanel open={diagOpen} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
