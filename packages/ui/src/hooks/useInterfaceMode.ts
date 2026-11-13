import { useNibiStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useNibiStoreWithDefault((state) => state.interfaceMode === "office", false);
}
