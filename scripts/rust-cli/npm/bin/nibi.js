#!/usr/bin/env node
// `@nibi-studio/cli` 的全局 `nibi` 入口。真正的解析/启动逻辑在同目录的
// `launcher.mjs`，这样测试可以直接 import 纯函数而不触发进程启动。
import { runLauncher } from "./launcher.mjs";

runLauncher();
