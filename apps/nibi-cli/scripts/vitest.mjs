#!/usr/bin/env node
// 包内 `vitest` 的 .bin shim 在 hoisted linker 下指向不存在的 `../vitest`（pnpm 只把包提升到
// 工作区根）。这里统一从工作区解析真正的 vitest 入口，让各包的 test 脚本不再依赖 shim。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("vitest/package.json");
await import(pathToFileURL(join(dirname(packageJsonPath), "vitest.mjs")).href);
