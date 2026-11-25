/**
 * 浏览器端组件证据 harness 的 node:crypto 替身。
 *
 * @nibi/shared 的进程诊断模块在浏览器里不需要生成错误 ID；这里只避免 Vite
 * 把 node:crypto 外部化成运行时报错，不参与真实产品路径。
 */
export function createHash(): never {
  throw new Error("node:crypto.createHash is not available in the component harness");
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
