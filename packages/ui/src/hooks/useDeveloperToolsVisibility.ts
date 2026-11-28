import { useEffect, useState } from "react";
import {
  DEVELOPER_TOOLS_PREFERENCE_EVENT,
  DEVELOPER_TOOLS_STORAGE_KEYS,
  readDeveloperToolsEnabled,
} from "@/lib/developerToolsPreference.js";

export function useDeveloperToolsVisibility(): boolean {
  const [enabled, setEnabled] = useState(readDeveloperToolsEnabled);

  useEffect(() => {
    const refresh = () => {
      setEnabled(readDeveloperToolsEnabled());
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        DEVELOPER_TOOLS_STORAGE_KEYS.includes(
          event.key as (typeof DEVELOPER_TOOLS_STORAGE_KEYS)[number],
        )
      ) {
        refresh();
      }
    };
    const handleVisibility = () => {
      if (typeof document === "undefined" || !document.hidden) {
        refresh();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", refresh);
    window.addEventListener(DEVELOPER_TOOLS_PREFERENCE_EVENT, refresh);
    document.addEventListener("visibilitychange", handleVisibility);
    refresh();

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DEVELOPER_TOOLS_PREFERENCE_EVENT, refresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return enabled;
}
