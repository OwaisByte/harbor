import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HoverTooltip } from "@/components/hover-tooltip";
import { useAutoSyncHandle } from "@/components/player/autosync/autosync-store";
import { useT } from "@/lib/i18n";
import type { TrackInfo } from "@/lib/player/bridge";
import { readMpvSubtitleFps } from "@/lib/player/mpv-properties";
import { SubtitleFpsIcon } from "./subtitle-fps-icon";
import { SubtitleFpsPanel } from "./subtitle-fps-panel";

type MpvPlaybackEvent = { event: string };

function isMainTauriWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    getCurrentWindow().label === "main"
  );
}

export function SubtitleFpsControl({
  engine,
  track,
  hasSecondary,
}: {
  engine: "html5" | "mpv";
  track: TrackInfo | null;
  hasSecondary: boolean;
}) {
  const tr = useT();
  const autoSync = useAutoSyncHandle();
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (engine !== "mpv" || !isMainTauriWindow()) {
      setSupported(false);
      setOpen(false);
      return;
    }

    let cancelled = false;
    void readMpvSubtitleFps().then((result) => {
      if (!cancelled) setSupported(result.supported);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, track?.id]);

  useEffect(() => {
    if (engine !== "mpv" || !isMainTauriWindow()) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<MpvPlaybackEvent>("mpv://event", ({ payload }) => {
      if (payload.event === "file-loaded") {
        void readMpvSubtitleFps().then((result) => {
          if (!disposed) setSupported(result.supported);
        });
        return;
      }
      if (payload.event === "end-file" || payload.event === "shutdown") {
        setSupported(false);
        setOpen(false);
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) =>
        console.warn("[subtitles] could not observe mpv playback availability", error),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [engine]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeAndRestoreFocus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (engine !== "mpv" || !supported) return null;

  const autoSyncActive =
    autoSync?.status === "analyzing" ||
    autoSync?.status === "synced" ||
    autoSync?.status === "best-effort" ||
    autoSync?.status === "offer";

  return (
    <div ref={wrapRef} className="relative">
      <HoverTooltip label={tr("Subtitle FPS")} side="bottom" align="end">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={tr("Subtitle FPS")}
          aria-expanded={open}
          className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
            open ? "bg-raised text-ink" : "text-ink-muted hover:bg-raised hover:text-ink"
          }`}
        >
          <SubtitleFpsIcon size={18} />
        </button>
      </HoverTooltip>

      {open && (
        <div className="absolute end-0 top-[calc(100%+6px)] z-[60] w-[340px] overflow-hidden rounded-xl border border-edge bg-elevated shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]">
          <SubtitleFpsPanel
            track={track}
            engine={engine}
            hasSecondary={hasSecondary}
            autoSyncActive={autoSyncActive}
            onBack={closeAndRestoreFocus}
          />
        </div>
      )}
    </div>
  );
}
