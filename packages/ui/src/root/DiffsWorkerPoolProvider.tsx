import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  WorkerPoolContext,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
} from "@pierre/diffs/react";
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import {
  createDiffsWorkerHighlighterOptions,
  isDiffsWorkerPoolRequested,
  registerDiffsWorkerPoolFactory,
  subscribeDiffsWorkerPoolActivation,
} from "@/lib/diffsHighlighterEngine.js";
import { logger } from "@/logger.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/store/index.js";
import { useNibiStore } from "@/store/StoreProvider.js";

function createDiffsWorker(): Worker {
  return new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), {
    type: "module",
    name: "nibi-diffs-worker",
  });
}

function resolveWorkerPoolSize(): number {
  if (typeof navigator === "undefined") {
    return 2;
  }

  const hardwareConcurrency = navigator.hardwareConcurrency;
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency <= 0) {
    return 2;
  }

  return Math.max(1, Math.min(2, Math.floor(hardwareConcurrency / 2)));
}

function WorkerRenderOptionsSync({
  highlighterOptions,
}: {
  highlighterOptions: WorkerInitializationRenderOptions;
}) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    void workerPool
      .setRenderOptions({
        theme: highlighterOptions.theme,
        lineDiffType: highlighterOptions.lineDiffType,
        maxLineDiffLength: highlighterOptions.maxLineDiffLength,
        tokenizeMaxLineLength: highlighterOptions.tokenizeMaxLineLength,
        useTokenTransformer: highlighterOptions.useTokenTransformer,
      })
      .catch((error: unknown) => {
        logger.warn("[DiffsWorkerPoolProvider] 同步渲染参数失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [highlighterOptions, workerPool]);

  return null;
}

export function DiffsWorkerPoolProvider({ children }: { children: ReactNode }) {
  const codePreviewSettings = useNibiStore(
    (state) => state.codePreviewSettings ?? DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
    () =>
      createDiffsWorkerHighlighterOptions({
        lightTheme: codePreviewSettings.lightTheme,
        darkTheme: codePreviewSettings.darkTheme,
      }),
    [codePreviewSettings.darkTheme, codePreviewSettings.lightTheme],
  );

  const poolSize = useMemo(() => resolveWorkerPoolSize(), []);
  const canUseWorkerPool = typeof window !== "undefined" && typeof Worker !== "undefined";
  const highlighterOptionsRef = useRef(highlighterOptions);
  highlighterOptionsRef.current = highlighterOptions;
  const [activated, setActivated] = useState(() => isDiffsWorkerPoolRequested());
  const poolManagerRef = useRef<WorkerPoolManager | undefined>(undefined);

  if (canUseWorkerPool) {
    registerDiffsWorkerPoolFactory(() =>
      getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: createDiffsWorker,
          poolSize,
        },
        highlighterOptions: highlighterOptionsRef.current,
      }),
    );
  }

  useEffect(() => {
    if (!canUseWorkerPool) {
      return;
    }
    if (isDiffsWorkerPoolRequested()) {
      setActivated(true);
    }
    return subscribeDiffsWorkerPoolActivation(() => setActivated(true));
  }, [canUseWorkerPool]);

  const poolManager = useMemo(() => {
    if (!canUseWorkerPool || !activated) {
      return undefined;
    }
    const singleton = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: createDiffsWorker,
        poolSize,
      },
      highlighterOptions: highlighterOptionsRef.current,
    });
    poolManagerRef.current = singleton;
    return singleton;
  }, [activated, canUseWorkerPool, poolSize]);

  useEffect(() => {
    return () => {
      if (poolManagerRef.current) {
        poolManagerRef.current = undefined;
        terminateWorkerPoolSingleton();
      }
    };
  }, []);

  if (!canUseWorkerPool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContext.Provider value={poolManager}>
      {poolManager ? <WorkerRenderOptionsSync highlighterOptions={highlighterOptions} /> : null}
      {children}
    </WorkerPoolContext.Provider>
  );
}
