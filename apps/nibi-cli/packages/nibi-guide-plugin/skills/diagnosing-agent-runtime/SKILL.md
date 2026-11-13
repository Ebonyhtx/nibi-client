---
name: diagnosing-agent-runtime
description: Diagnose NIBI's agent runtime when Browser Use or Computer Use reports a missing runtime bridge, node_repl tools do not appear, a bundled official plugin is missing from the cache, or the Host cannot start a plugin MCP server. 用于诊断 node_repl 运行时缺失、Browser Use/Computer Use 不可用、内置插件未落到缓存或插件 MCP 宿主启动失败。
---

# Diagnosing the agent runtime

Use this skill for problems that sit below ordinary plugin configuration: the NIBI Host, the bundled `node-repl-host`, the official plugin cache, and the Rust kernel. Finish with one concrete next action, not a list of guesses.

## 1. Know which layer owns the failure

NIBI has four layers. Name the failing layer before changing anything.

| Layer | What lives there | Typical symptom |
| --- | --- | --- |
| Kernel | Rust kernel only for desktop local; missing `nibi-rs` fails closed | tools or sessions fail before any plugin loads |
| Host | Desktop main process, plugin seeding, MCP process launch | plugin cache is empty or a server never starts |
| Plugin content | `browser-use`, `computer-use`, `visualize`, office plugins | skill or panel is missing, but sessions still work |
| Runtime host | bundled `node-repl-host` plugin | `Browser runtime bridge is unavailable` or `Computer Use runtime bridge is unavailable` |

`node_repl` is not a general shell or filesystem tool. It is the execution surface that Browser Use and Computer Use ride on.

## 2. Check the cheap facts first

1. Confirm the feature is enabled: **Settings → Plugin Management** must show `browser-use` or `computer-use` enabled. Disabling the content plugin also removes the reason to start `node-repl-host`.
2. Confirm the config file agrees: `~/.nibi/cli/config.json` → `plugins.enabledPlugins["browser-use@nibi-official"]` or `["computer-use@nibi-official"]`.
3. Confirm the cache exists: `~/.nibi/cli/plugins/cache/nibi-official/<plugin>/<version>/`. The version must match the bundled definition, not an older directory left by a previous install.
4. Confirm the seed completed: the cache directory contains `.nibi-plugin-seed.json` and the files it names. A missing marker means the Host never finished seeding.
5. Look at `~/.nibi/cli/log/` for the startup window. Search for `plugin`, `seed`, `mcp`, `node_repl`, `browser broker`, or `cua`.

## 3. Match the exact runtime error

- `Browser runtime bridge is unavailable. Use Browser from a NIBI desktop or shared-host session.` — the `node-repl-host` MCP server is running, but the browser bridge was not injected. Check that the session is a normal desktop/shared-host session and that `browser-use` is enabled. A content-only plugin install without the bundled runtime host cannot provide it.
- `Computer Use runtime bridge is unavailable. Use Computer Use from a NIBI desktop or shared-host session.` — same shape for CUA. Check that the private CUA helper is present for this platform; the open-source build intentionally ships a fail-closed placeholder.
- `node_repl` tools are absent from the tool list — neither `browser-use` nor `computer-use` is enabled, or the Host did not seed `node-repl-host`. Confirm both the enabled plugin and the cache directory.
- A bundled plugin is absent or a panel never opens — compare the required files under the cache version directory with the plugin's `.nibi-plugin/plugin.json`. If the cache is partial, the seed was interrupted.

## 4. Repair without deleting user data

- Restart NIBI after enabling or disabling a plugin. Plugins are not hot-reloaded.
- For a partial official cache, quit NIBI, remove only the affected version directory under `~/.nibi/cli/plugins/cache/nibi-official/<plugin>/<version>/`, then start NIBI again. Do not delete `~/.nibi/v2` or the whole plugin storage root.
- If the Rust kernel itself is the suspect, compare against a remote shared-host session (which still runs the Node `nibi.cjs` kernel); desktop local has no `NIBI_KERNEL=node` fallback. Treat a difference as a kernel-parity bug, not a plugin fix.
- If a plugin MCP server fails to start, run its cached entry directly from the cache directory to see the real stderr. Do not edit the cached copy permanently; fix the source or re-seed instead.

## 5. Report

State the failing layer, the exact error text, the cache path checked, and the one action taken. If the problem is a missing private CUA helper or a kernel parity gap, say so plainly instead of prescribing unrelated plugin changes.
