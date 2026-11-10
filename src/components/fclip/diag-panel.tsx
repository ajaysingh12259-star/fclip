"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Activity, ShieldCheck, ShieldAlert, KeyRound, Radio, CloudCog, Swords } from "lucide-react";

interface Diag {
  engine?: { ytDlp: boolean; ffmpeg: boolean; ffprobe: boolean };
  provider?: { reachable: boolean; version?: string };
  cookieHealth?: { present: boolean; loggedIn: boolean; names: string[]; lineCount: number };
  storm?: { winner: string | null; at: number | null };
  warp?: { socks5: boolean };
  relay?: { ok: string[]; checkedAt: number | null; known: number };
  cookiesMode?: string;
}

function Row({
  icon: Icon,
  label,
  ok,
  detail,
  detailTone = "neutral",
}: {
  icon: typeof Activity;
  label: string;
  ok: boolean;
  detail: string;
  detailTone?: "neutral" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 py-2 last:border-b-0">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={`hidden text-xs sm:inline ${detailTone === "warn" ? "text-amber-400" : "text-muted-foreground"}`}>{detail}</span>
        {ok ? (
          <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
            <ShieldCheck className="h-3 w-3" aria-hidden /> ok
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 border-red-500/40 bg-red-500/10 text-red-400">
            <ShieldAlert className="h-3 w-3" aria-hidden /> off
          </Badge>
        )}
      </span>
    </div>
  );
}

export function DiagPanel({ open }: { open: boolean }) {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/diag");
      if (res.ok) setDiag((await res.json()) as Diag);
    } catch {
      /* panel stays empty */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!open) return null;

  return (
    <div className="space-y-1 rounded-xl border bg-card/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Activity className="h-3.5 w-3.5" aria-hidden /> Engine diagnostics
        </p>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} aria-label="Refresh diagnostics">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        </Button>
      </div>
      <Row icon={CloudCog} label="yt-dlp / ffmpeg / ffprobe" ok={Boolean(diag?.engine?.ytDlp && diag?.engine?.ffmpeg && diag?.engine?.ffprobe)} detail="binaries" />
      <Row icon={Radio} label="PO-token provider (BotGuard)" ok={Boolean(diag?.provider?.reachable)} detail={diag?.provider?.version ? `v${diag.provider.version}` : "bgutil"} />
      <Row
        icon={Swords}
        label="Client storm"
        ok={Boolean(diag?.storm?.winner)}
        detail={diag?.storm?.winner ? `winner: ${diag.storm.winner}` : "no breakthrough yet"}
        detailTone={diag?.storm?.winner ? "neutral" : "warn"}
      />
      <Row icon={CloudCog} label="WARP egress (Cloudflare)" ok={Boolean(diag?.warp?.socks5)} detail="socks5 sidecar" detailTone="warn" />
      <Row
        icon={Radio}
        label="Relay network (Piped/Invidious)"
        ok={(diag?.relay?.ok?.length ?? 0) > 0}
        detail={diag?.relay ? `${diag.relay.ok.length}/${diag.relay.known} hosts alive` : "not probed yet"}
        detailTone={(diag?.relay?.ok?.length ?? 0) > 0 ? "neutral" : "warn"}
      />
      <Row
        icon={KeyRound}
        label="Cookies"
        ok={Boolean(diag?.cookieHealth?.loggedIn)}
        detail={
          diag?.cookieHealth?.present
            ? diag.cookieHealth.loggedIn
              ? `${diag.cookieHealth.lineCount} lines · logged in`
              : "present but signed out"
            : "none uploaded"
        }
        detailTone={diag?.cookieHealth?.loggedIn ? "neutral" : "warn"}
      />
      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        Cutting works best when at least one of: cookies, a storm winner, or the relay network is green — they are
        tried in that order and the relay tier never needs cookies.
      </p>
    </div>
  );
}
