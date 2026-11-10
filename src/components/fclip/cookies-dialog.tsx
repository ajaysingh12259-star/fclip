"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { KeyRound, ShieldCheck, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cookiesPresent: boolean;
  onSaved: () => void;
  onCleared: () => void;
}

export function CookiesDialog({ open, onOpenChange, cookiesPresent, onSaved, onCleared }: Props) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? "Could not save cookies.");
      } else {
        setContent("");
        onSaved();
        onOpenChange(false);
      }
    } catch {
      setErr("Network error while saving cookies.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await fetch("/api/cookies", { method: "DELETE" });
      onCleared();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-red-500" aria-hidden />
            Browser cookies (optional)
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-left text-sm leading-relaxed">
              <p>
                YouTube sometimes asks the <em>server</em> to prove it is not a bot (&ldquo;Sign in to
                confirm you&rsquo;re not a bot&rdquo;) — this is common for cloud-hosted IPs and has nothing to
                do with your own browsing. Adding your own browser cookies is the official yt-dlp
                recommended fix, and it also unlocks age-restricted videos you can already watch.
              </p>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>
                  Install a cookies-export extension such as{" "}
                  <strong>&ldquo;Get cookies.txt LOCALLY&rdquo;</strong> (Chrome / Firefox / Edge).
                </li>
                <li>While logged in to YouTube, export cookies for <strong>youtube.com</strong>.</li>
                <li>
                  Open the downloaded <code className="rounded bg-muted px-1">cookies.txt</code> file, copy
                  everything, and paste it below.
                </li>
              </ol>
              <p className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                <span>
                  Your cookies stay on this fclip server only (stored as a local file) — they are never
                  sent to any third party. Deleting them here removes the file.
                </span>
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO1_LIVE\t...\n..."}
          className="min-h-36 font-mono text-xs"
          aria-label="cookies.txt content"
        />
        {err && <p className="text-sm text-red-500">{err}</p>}
        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          {cookiesPresent ? (
            <Button variant="outline" size="sm" onClick={clear} disabled={busy} type="button">
              Remove saved cookies
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">No cookies saved yet</span>
          )}
          <Button
            onClick={save}
            disabled={busy || !content.trim()}
            className="bg-gradient-to-r from-red-500 to-orange-500 text-white hover:opacity-90"
            type="button"
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
            Save cookies
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
