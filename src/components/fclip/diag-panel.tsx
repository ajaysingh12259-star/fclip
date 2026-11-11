"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Activity, ShieldCheck, ShieldAlert, KeyRound, CloudCog, Radio } from "lucide-react";

interface Diag {
  engine?: { ffmpeg: boolean; ffprobe: boolean; farmKey: boolean };
  farm?: { hdLane: string; fourKLane: string; fourKKeyConfigured: boolean };
  lanes?: {
    savenowReachable: boolean;
    savenowHttp: number | null;
    videolimitReachable: boolean;
    videolimitHttp: number | null;
  };
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
      <Row icon={CloudCog} label="ffmpeg / ffprobe" ok={Boolean(diag?.engine?.ffmpeg && diag?.engine?.ffprobe)} detail="cutting binaries" />
      <Row
        icon={KeyRound}
        label="4K farm API key"
        ok={Boolean(diag?.engine?.farmKey)}
        detail={diag?.engine?.farmKey ? "registered key active" : "shared fallback key"}
        detailTone={diag?.engine?.farmKey ? "neutral" : "warn"}
      />
      <Row
        icon={Radio}
        label="HD render lane (1080p60)"
        ok={Boolean(diag?.lanes?.videolimitReachable)}
        detail={diag?.lanes?.videolimitHttp != null ? `HTTP ${diag.lanes.videolimitHttp}` : "unreachable"}
        detailTone={diag?.lanes?.videolimitReachable ? "neutral" : "warn"}
      />
      <Row
        icon={Radio}
        label="4K render farm (2160p)"
        ok={Boolean(diag?.lanes?.savenowReachable)}
        detail={diag?.lanes?.savenowHttp != null ? `HTTP ${diag.lanes.savenowHttp}` : "unreachable"}
        detailTone={diag?.lanes?.savenowReachable ? "neutral" : "warn"}
      />
      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        Ladder: 1080p picks render true 1080p60 on the first try; 2K/4K picks ride the 4K farm and degrade to
        1080p60 only if it refuses. No cookies involved anywhere.
      </p>
    </div>
  );
}
