import { useSyncExternalStore } from "react";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export type CompanionMode = "auto" | "perch" | "working" | "complete" | "paused";
export type CompanionAnimationMode = "inherit" | "independent" | "off";

export interface CompanionPreferences {
  visible: boolean;
  mode: CompanionMode;
  follow: boolean;
  feathers: boolean;
  animation: CompanionAnimationMode;
}

const STORAGE_KEYS = {
  visible: "nibi-companion-visible",
  mode: "nibi-companion-mode",
  follow: "nibi-companion-follow",
  feathers: "nibi-companion-feathers",
  animation: "nibi-companion-animation",
} as const;

const VALID_MODES = new Set<CompanionMode>(["auto", "perch", "working", "complete", "paused"]);
const VALID_ANIMATION_MODES = new Set<CompanionAnimationMode>(["inherit", "independent", "off"]);

const DEFAULT_PREFERENCES: CompanionPreferences = {
  visible: true,
  mode: "auto",
  follow: true,
  feathers: true,
  animation: "inherit",
};

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value !== "false";
}

function loadPreferences(): CompanionPreferences {
  const mode = readSafeLocalStorage(STORAGE_KEYS.mode);
  const animation = readSafeLocalStorage(STORAGE_KEYS.animation);
  return {
    visible: parseBoolean(readSafeLocalStorage(STORAGE_KEYS.visible), DEFAULT_PREFERENCES.visible),
    mode: VALID_MODES.has(mode as CompanionMode) ? (mode as CompanionMode) : "auto",
    follow: parseBoolean(readSafeLocalStorage(STORAGE_KEYS.follow), DEFAULT_PREFERENCES.follow),
    feathers: parseBoolean(
      readSafeLocalStorage(STORAGE_KEYS.feathers),
      DEFAULT_PREFERENCES.feathers,
    ),
    animation: VALID_ANIMATION_MODES.has(animation as CompanionAnimationMode)
      ? (animation as CompanionAnimationMode)
      : "inherit",
  };
}

let cached = loadPreferences();
const listeners = new Set<() => void>();
let storageAttached = false;

function emit(): void {
  cached = loadPreferences();
  for (const listener of listeners) listener();
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith("nibi-companion-")) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageAttached && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageChange);
    storageAttached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageAttached && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageChange);
      storageAttached = false;
    }
  };
}

export function getCompanionPreferences(): CompanionPreferences {
  return cached;
}

export function setCompanionPreference<K extends keyof CompanionPreferences>(
  key: K,
  value: CompanionPreferences[K],
): void {
  const serialized = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  writeSafeLocalStorage(STORAGE_KEYS[key], serialized);
  emit();
}

export function useCompanionPreferences(): CompanionPreferences {
  return useSyncExternalStore(subscribe, getCompanionPreferences, getCompanionPreferences);
}
