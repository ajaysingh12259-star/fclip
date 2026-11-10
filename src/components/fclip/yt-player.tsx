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
  getVideoData: () => { title?: string; author?: string } | undefined;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
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
  /** Total duration in seconds once the player metadata is loaded (0 before that). */
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  play: () => void;
  pause: () => void;
  /** Title/channel from the player without any server-side fetch. */
  getVideoData: () => { title?: string; author?: string } | null;
}

interface Props {
  videoId: string;
  className?: string;
  onReady?: () => void;
  /** YT error codes: 2/5 invalid, 100 missing, 101/150 embedding disabled. */
  onError?: (code: number) => void;
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

/**
 * Important: the YouTube IFrame API REPLACES the element you pass to it with an
 * <iframe>. If React owns that element it later throws
 * "Failed to execute 'removeChild'…" when it unmounts the subtree (e.g. when the
 * player reports an embed error). So the player target div is created
 * imperatively inside a host React never manages.
 */
export const YtPlayer = forwardRef<YtPlayerHandle, Props>(function YtPlayer(
  { videoId, className, onReady, onError },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({
    getCurrentTime: () => {
      try {
        return playerRef.current?.getCurrentTime() ?? 0;
      } catch {
        return 0;
      }
    },
    getDuration: () => {
      try {
        return playerRef.current?.getDuration() ?? 0;
      } catch {
        return 0;
      }
    },
    seekTo: (seconds: number, allowSeekAhead = true) => {
      try {
        playerRef.current?.seekTo(seconds, allowSeekAhead);
      } catch {
        /* ignore */
      }
    },
    play: () => {
      try {
        playerRef.current?.playVideo();
      } catch {
        /* ignore */
      }
    },
    pause: () => {
      try {
        playerRef.current?.pauseVideo();
      } catch {
        /* ignore */
      }
    },
    getVideoData: () => {
      try {
        return playerRef.current?.getVideoData() ?? null;
      } catch {
        return null;
      }
    },
  }));

  useEffect(() => {
    let alive = true;
    const host = hostRef.current;
    playerRef.current = null;
    setFailed(null);
    loadIframeApi()
      .then((YT) => {
        if (!alive || !host) return;
        const target = document.createElement("div");
        target.style.width = "100%";
        target.style.height = "100%";
        host.appendChild(target);
        playerRef.current = new YT.Player(target, {
          videoId,
          playerVars: {
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (alive) onReadyRef.current?.();
            },
            onError: (e) => {
              if (!alive) return;
              const code = e.data;
              const msg =
                code === 101 || code === 150
                  ? "The uploader disabled embedding for this video, so it cannot be previewed here. The clipper itself may still work — enter the times manually."
                  : code === 100
                  ? "This video does not exist or is private, so it cannot be previewed."
                  : "The YouTube player reported an error for this video.";
              setFailed(msg);
              onErrorRef.current?.(code);
            },
          },
        });
      })
      .catch(() => {
        if (alive)
          setFailed(
            "The YouTube player could not load here (network restriction). You can still type the times manually below."
          );
      });
    return () => {
      alive = false;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (host) host.innerHTML = "";
    };
  }, [videoId]);

  return (
    <div className={className}>
      {failed ? (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
          <span className="max-w-md leading-relaxed">{failed}</span>
          <a
            href={`https://www.youtube.com/watch?v=${videoId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs font-medium text-red-500 underline underline-offset-2"
          >
            Open on YouTube to scrub the times ↗
          </a>
        </div>
      ) : (
        <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black">
          <div ref={hostRef} className="h-full w-full" />
        </div>
      )}
    </div>
  );
});
