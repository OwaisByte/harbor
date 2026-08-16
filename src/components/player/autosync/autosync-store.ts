import { useSyncExternalStore } from "react";
import type { AutoSyncHandle } from "@/views/player/hooks/use-auto-sync";
import { resetMpvSubtitleFpsForTransition } from "@/lib/player/mpv-properties";

let current: AutoSyncHandle | null = null;
const listeners = new Set<() => void>();

export function publishAutoSync(handle: AutoSyncHandle | null): void {
  const resetSubtitleFps = () =>
    resetMpvSubtitleFpsForTransition((error) =>
      console.warn("[auto-sync] subtitle FPS reset failed", error),
    );
  const afterSubtitleFpsReset = (action: () => void) => () => {
    void resetSubtitleFps()
      .then(action)
      .catch(() => {});
  };
  current = handle
    ? {
        ...handle,
        run: afterSubtitleFpsReset(handle.run),
        retry: afterSubtitleFpsReset(handle.retry),
        applyOffer: afterSubtitleFpsReset(handle.applyOffer),
      }
    : null;
  if (
    handle?.status === "analyzing" ||
    handle?.status === "synced" ||
    handle?.status === "best-effort" ||
    handle?.status === "offer"
  ) {
    void resetSubtitleFps().catch(handle.stop);
  }
  listeners.forEach((l) => l());
}

export function useAutoSyncHandle(): AutoSyncHandle | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}
