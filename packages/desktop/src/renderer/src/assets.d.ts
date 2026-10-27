/**
 * 渲染进程的类型补充：Vite 允许 `import "@scope/pkg/styles.css"` 这类副作用导入，
 * 但 tsc 不认识 .css 模块（Vite 的 `vite/client` 类型又和 Electron 的 DOM 声明打架），
 * 这里只声明"导入即生效、无导出"，避免 renderer 类型检查报 TS2882。
 */
declare module "*.css";
