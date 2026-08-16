import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createSubtitleFpsCoordinator,
  validateSubtitleFps,
  type SubtitleFpsChoice,
} from "./subtitle-fps";
import { isTextSubTrack } from "./sub-format";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let subtitleFpsGeneration = 0;
let activeTrackId: string | null = null;
let pendingRequest: { trackId: string } | null = null;
let lifecycleListener: Promise<boolean> | null = null;

type MpvEvent = { event: string; name?: string; data?: unknown };

async function readMpvNumber(name: string): Promise<number | null> {
  if (!isTauri) return null;
  try {
    const value = await invoke<number | string>("mpv_get_property", { name });
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readMpvBoolean(name: string): Promise<boolean | null> {
  if (!isTauri) return null;
  try {
    const value = await invoke<boolean | number | string>("mpv_get_property", { name });
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const normalized = value.trim().toLowerCase();
    if (normalized === "yes" || normalized === "true" || normalized === "1") return true;
    if (normalized === "no" || normalized === "false" || normalized === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export async function readMpvVideoFps(): Promise<number | null> {
  const estimated = await readMpvNumber("estimated-vf-fps");
  if (estimated != null && estimated > 0) return estimated;
  const container = await readMpvNumber("container-fps");
  return container != null && container > 0 ? container : null;
}

export async function readMpvSubtitleFps(): Promise<{
  supported: boolean;
  value: number | null;
}> {
  if ((await readMpvBoolean("idle-active")) !== false) {
    return { supported: false, value: null };
  }
  if (!(await ensureSubtitleFpsLifecycleListener())) {
    return { supported: false, value: null };
  }
  await waitForMpvSubtitleFpsTransitions();
  const raw = await readMpvNumber("sub-fps");
  if (raw == null) return { supported: false, value: null };
  if (raw === 0) return { supported: true, value: null };
  const result = validateSubtitleFps(raw);
  return result.ok ? { supported: true, value: result.value } : { supported: false, value: null };
}

async function writeMpvSubtitleFpsValue(value: number): Promise<void> {
  if (!isTauri) throw new Error("mpv is unavailable outside the desktop player.");
  await invoke("mpv_set_property", { name: "sub-fps", value });
}

const coordinator = createSubtitleFpsCoordinator({ writeFps: writeMpvSubtitleFpsValue });

async function waitForMpvSubtitleFpsTransitions(): Promise<void> {
  while (true) {
    const generation = subtitleFpsGeneration;
    await coordinator.whenSettled();
    if (generation === subtitleFpsGeneration) return;
  }
}

function ensureSubtitleFpsLifecycleListener(): Promise<boolean> {
  if (!isTauri) return Promise.resolve(false);
  if (lifecycleListener) return lifecycleListener;
  lifecycleListener = listen<MpvEvent>("mpv://event", ({ payload }) => {
    if (payload.event === "shutdown") {
      invalidateMpvSubtitleFpsContext();
      activeTrackId = null;
      pendingRequest = null;
      coordinator.markSessionRecreated();
      return;
    }
    if (payload.event === "file-loaded" || payload.event === "end-file") {
      invalidateMpvSubtitleFpsContext();
      pendingRequest = null;
      if (coordinator.isActive()) {
        void resetMpvSubtitleFpsForTransition((error) =>
          console.warn("[subtitles] FPS reset at media boundary failed", error),
        ).catch(() => {});
      }
      return;
    }
    if (payload.event !== "property-change" || payload.name !== "track-list") return;
    const tracks = Array.isArray(payload.data)
      ? (payload.data as Array<Record<string, unknown>>)
      : [];
    const selected = tracks.filter((track) => track.type === "sub" && track.selected === true);
    const current = selected.find((track) => Number(track["main-selection"]) !== 1) ?? selected[0];
    const contextTrackId = pendingRequest?.trackId ?? activeTrackId;
    const stillEligible =
      contextTrackId != null &&
      selected.length === 1 &&
      String(current?.id ?? "") === contextTrackId &&
      isTextSubTrack({
        id: String(current?.id ?? ""),
        label: "",
        kind: "subtitle",
        selected: true,
        codec: String(current?.["codec-desc"] ?? current?.codec ?? ""),
        title: typeof current?.title === "string" ? current.title : undefined,
        externalFilename:
          typeof current?.["external-filename"] === "string"
            ? current["external-filename"]
            : undefined,
      });
    if ((contextTrackId != null || coordinator.isActive()) && !stillEligible) {
      invalidateMpvSubtitleFpsContext();
      pendingRequest = null;
      void resetMpvSubtitleFpsForTransition((error) =>
        console.warn("[subtitles] FPS reset at track boundary failed", error),
      ).catch(() => {});
    }
  })
    .then(() => true)
    .catch((error) => {
      lifecycleListener = null;
      console.warn("[subtitles] could not observe mpv subtitle FPS boundaries", error);
      return false;
    });
  return lifecycleListener;
}

export async function writeMpvSubtitleFps(
  choice: SubtitleFpsChoice,
  generation: number,
  trackId: string,
): Promise<void> {
  if (!(await ensureSubtitleFpsLifecycleListener())) {
    throw new Error("mpv subtitle FPS lifecycle is unavailable.");
  }
  const request = { trackId };
  pendingRequest = request;
  try {
    await coordinator.apply(
      choice,
      () => generation === subtitleFpsGeneration && pendingRequest === request,
    );
    activeTrackId = choice === "default" ? null : trackId;
  } finally {
    if (pendingRequest === request) pendingRequest = null;
  }
}

export async function resetMpvSubtitleFpsForTransition(
  onResetError?: (error: unknown) => void,
): Promise<void> {
  invalidateMpvSubtitleFpsContext();
  pendingRequest = null;
  await coordinator.resetForTransition(onResetError);
  activeTrackId = null;
}

export function invalidateMpvSubtitleFpsContext(): number {
  subtitleFpsGeneration += 1;
  return subtitleFpsGeneration;
}

export function getMpvSubtitleFpsGeneration(): number {
  return subtitleFpsGeneration;
}
