// @pierre/diffs 在这个 worker 里用 WebAssembly 实例化高亮器：部署页面的 CSP 必须
// 允许 'wasm-unsafe-eval'（部署配置需覆盖 /remote/v4 路径），
// 否则真实浏览器报 CompileError，而 Vite 构建与单测都不会暴露。
// 文件名带内容哈希，改这里即换新 URL，避免旧的 immutable 缓存继续带着旧 CSP。
import "@pierre/diffs/worker/worker.js";

// 版本哨兵：只写注释不会改变产物哈希；这个赋值是保留的副作用，改值即可换 worker URL。
// 1 → 页面 CSP 首次放行 wasm（2026-10-25）。运行时可读它确认加载的是哪一版 worker。
(globalThis as { __nibiDiffsWorkerRevision?: number }).__nibiDiffsWorkerRevision = 1;
