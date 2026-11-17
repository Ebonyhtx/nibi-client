#!/usr/bin/env bash
# CI 专用 pnpm install 包装。
#
# pnpm 的 hoisted linker 在“有 patchedDependencies + 同一个包出现在多个 hoist 位置”时
# 存在并发重命名竞态（pnpm/pnpm#12880、#13627）：并行 linker 把 _tmp_* 目录 rename 到
# 已被另一个 racer 占用的路径，输的一方报 ERR_PNPM_ENOENT（典型是嵌套 esbuild），
# 但重装一次通常就好。这里只在命中该错误时清空 node_modules 重试，最多 3 次；
# 其它安装错误立即失败，不掩盖真实问题。
set -euo pipefail

cleanup_node_modules() {
  rm -rf node_modules
  rm -rf apps/nibi-cli/node_modules
  rm -rf apps/nibi-cli/packages/*/node_modules
  rm -rf packages/*/node_modules
  rm -rf kernel/packages/*/node_modules
}

for attempt in 1 2 3; do
  log="$(mktemp)"
  set +e
  pnpm install --frozen-lockfile "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    rm -f "$log"
    exit 0
  fi
  if ! grep -q "ERR_PNPM_ENOENT" "$log"; then
    echo "[pnpm-install-ci] 非 hoisted 重命名竞态，保留原始失败" >&2
    rm -f "$log"
    exit "$status"
  fi
  rm -f "$log"
  if [ "$attempt" -eq 3 ]; then
    exit "$status"
  fi
  echo "[pnpm-install-ci] 命中 ERR_PNPM_ENOENT（pnpm/pnpm#12880），清空 node_modules 后重试 $((attempt + 1))/3" >&2
  cleanup_node_modules
done