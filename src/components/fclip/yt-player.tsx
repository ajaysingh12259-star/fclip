"use client";

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";

/* Minimal typings for the YouTube IFrame API */
interface YTPlayer {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onError?: (e: { data: number }) => void;
      };
    }
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YtPlayerHandle {
  getCurrentTime: () => number;
}

interface Props {
  videoId: string;
  className?: string;
}

function loadIframeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-fclip-yt-api]');
    if (!existing) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.dataset.fclipYtApi = "1";
      document.head.appendChild(s);
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.YT?.Player) {
        clearInterval(timer);
        resolve(window.YT);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error("YouTube player API failed to load"));
      }
    }, 200);
  });
}

export const YtPlayer = forwardRef<YtPlayerHandle, Props>(function YtPlayer({ videoId, className }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => {
      try {
        return playerRef.current?.getCurrentTime() ?? 0;
      } catch {
        return 0;
      }
    },
  }));

  useEffect(() => {
    let alive = true;
    playerRef.current = null;
    loadIframeApi()
      .then((YT) => {
        if (!alive || !innerRef.current) return;
        setFailed(false);
        playerRef.current = new YT.Player(innerRef.current, {
          videoId,
          playerVars: {
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
        });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    };
  }, [videoId]);

  return (
    <div ref={hostRef} className={className}>
      {failed ? (
        <div className="flex h-full w-full items-center justify-center rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
          The YouTube player could not load here (network restriction). You can still type the times manually below.
        </div>
      ) : (
        <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black">
          <div ref={innerRef} className="h-full w-full" />
        </div>
      )}
    </div>
  );
});
