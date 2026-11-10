"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface Chapter {
  start: number;
  end: number;
  title: string;
}

interface TimelineProps {
  duration: number;
  start: number;
  end: number;
  chapters?: Chapter[] | null;
  onChange: (start: number, end: number) => void;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function Timeline({ duration, start, end, chapters, onChange }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "start" | "end" | "mid">(null);
  const dragOffsetRef = useRef(0);

  const timeFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return Math.round(ratio * duration * 10) / 10;
    },
    [duration]
  );

  const applyDrag = useCallback(
    (clientX: number) => {
      const mode = dragRef.current;
      if (!mode) return;
      const t = timeFromEvent(clientX);
      if (mode === "start") {
        onChange(clamp(t, 0, end - 1), end);
      } else if (mode === "end") {
        onChange(start, clamp(t, start + 1, duration));
      } else {
        const len = end - start;
        const newStart = clamp(t - dragOffsetRef.current, 0, duration - len);
        onChange(Math.round(newStart * 10) / 10, Math.round((newStart + len) * 10) / 10);
      }
    },
    [duration, end, onChange, start, timeFromEvent]
  );

  const onPointerDown = (mode: "start" | "end" | "mid") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = mode;
    dragOffsetRef.current = mode === "mid" ? timeFromEvent(e.clientX) - start : 0;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    applyDrag(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    applyDrag(e.clientX);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (dragRef.current) return;
    const t = timeFromEvent(e.clientX);
    // Move the nearest handle to the clicked time.
    if (Math.abs(t - start) <= Math.abs(t - end)) {
      onChange(clamp(t, 0, end - 1), end);
    } else {
      onChange(start, clamp(t, start + 1, duration));
    }
  };

  const keyAdjust = (mode: "start" | "end") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (mode === "start") onChange(clamp(start - step, 0, end - 1), end);
      else onChange(start, clamp(end - step, start + 1, duration));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (mode === "start") onChange(clamp(start + step, 0, end - 1), end);
      else onChange(start, clamp(end + step, start + 1, duration));
    }
  };

  if (duration <= 0) return null;

  const pct = (t: number) => `${(t / duration) * 100}%`;
  const midLen = Math.max(0, ((end - start) / duration) * 100);

  return (
    <div className="select-none" data-testid="clip-timeline">
      <div
        ref={trackRef}
        role="slider-group"
        aria-label="Clip range timeline"
        className="relative h-12 w-full cursor-pointer rounded-lg border bg-muted/40 touch-none"
        onClick={onTrackClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* chapter ticks */}
        {(chapters ?? []).map((c, i) => (
          <div
            key={i}
            title={c.title}
            className="absolute top-0 h-full w-px bg-foreground/15"
            style={{ left: pct(c.start) }}
          />
        ))}

        {/* dimmed regions */}
        <div className="absolute inset-y-0 left-0 bg-foreground/10" style={{ width: pct(start) }} />
        <div className="absolute inset-y-0 right-0 bg-foreground/10" style={{ width: `${Math.max(0, 100 - (end / duration) * 100)}%` }} />

        {/* selected range */}
        <div
          className="absolute inset-y-1 rounded-md bg-gradient-to-r from-red-500/70 to-orange-500/70 ring-1 ring-red-400/60"
          style={{ left: pct(start), width: `${midLen}%` }}
          onPointerDown={onPointerDown("mid")}
        >
          <div className="pointer-events-none absolute inset-x-0 -top-0.5 flex justify-center">
            <span className="rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground shadow">
              {fmt(start)} → {fmt(end)}
            </span>
          </div>
        </div>

        {/* start handle */}
        <button
          type="button"
          role="slider"
          aria-label="Clip start"
          aria-valuenow={Math.round(start)}
          className="absolute inset-y-0 z-10 flex w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-l-md bg-gradient-to-b from-red-500 to-red-600 shadow-md outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          style={{ left: pct(start) }}
          onPointerDown={onPointerDown("start")}
          onKeyDown={keyAdjust("start")}
        >
          <Grip />
        </button>

        {/* end handle */}
        <button
          type="button"
          role="slider"
          aria-label="Clip end"
          aria-valuenow={Math.round(end)}
          className={cn(
            "absolute inset-y-0 z-10 flex w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-r-md",
            "bg-gradient-to-b from-orange-500 to-orange-600 shadow-md outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          )}
          style={{ left: pct(end) }}
          onPointerDown={onPointerDown("end")}
          onKeyDown={keyAdjust("end")}
        >
          <Grip />
        </button>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>0:00</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

function Grip() {
  return (
    <div className="flex flex-col items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-[3px] w-2.5 rounded-full bg-white/90" />
      ))}
    </div>
  );
}

function fmt(t: number): string {
  const s = Math.floor(t % 60);
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}
