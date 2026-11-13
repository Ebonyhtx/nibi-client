# MCP Stdio Node Fallback (Electron Node)

## Goal

Many plugin and user MCP servers start with `command: "node"` or `command: "npx"`. On a desktop
machine without Node.js these servers fail with `spawn ENOENT`. The desktop agent already runs on
the Node runtime inside Electron (`docs/runtime-tools/agent-electron-node-runtime.md`). This spec
lets stdio MCP servers use that same runtime, plus a bundled npm, when the machine has no Node.

The user's own Node, npm and npx always win. The fallback only fills a gap.

## Scope

In scope:

- Every stdio MCP server the Node kernel agent starts (plugin servers and user/project config
  servers), through `@nibi/adapters/mcp`.
- Every stdio MCP server the Rust kernel starts, through the environment the Host injects into the
  agent process.
- The commands `node`, `npm` and `npx`, at the top level (`command`) and inside the server's own
  process tree (shebangs such as `#!/usr/bin/env node`, `sh -c "node ..."`, npm bin shims).
- macOS, Linux and Windows desktop packages.

Out of scope:

- Plain Node CLI, SEA binaries and remote hosts. Remote agents keep their existing Node directory
  rule.
- Hooks, the Bash tool and background terminals. They keep the user's PATH unchanged.
- Other runtimes (`uvx`, `python`, `bun`, `deno`).

## Process Chain

```text
Desktop host (Electron utilityProcess)
 ├─ Node kernel: <Electron> nibi.cjs app-server        (ELECTRON_RUN_AS_NODE=1)
 │   └─ MCP stdio spawn (MCP SDK → cross-spawn; resolves PATH + PATHEXT from the child env)
 │       env.PATH = <user PATH> <delimiter> <cliStorageRoot>/node-fallback/v1
 │       env.NIBI_NODE_FALLBACK_EXEC_PATH = <Electron executable>
 │       env.NIBI_NODE_FALLBACK_NPM_ROOT  = <bundled npm package root>
 │
 └─ Rust kernel: nibi-rs app-server
     └─ MCP stdio spawn (entry env snapshot, whitelist projection)
         env.PATH = <user PATH> <delimiter> <appConfigDir>/node-fallback/v1
         env.NIBI_NODE_FALLBACK_EXEC_PATH / NIBI_NODE_FALLBACK_NPM_ROOT  (same values)

"node server.js" ─ user node on PATH? ── yes → user node
                                      └─ no  → shim node → <Electron> server.js
"npx -y pkg"     ─ user npx on PATH?  ── yes → user npx
                                      └─ no  → shim npx  → <Electron> <npm>/bin/npx-cli.js
                                                └─ pkg bin "#!/usr/bin/env node" → PATH → node (same rule)
```

## Activation

- **Node kernel.** Bootstrap creates the fallback provider only when the agent itself runs on
  Electron Node (`process.versions.electron` is defined). Otherwise the MCP adapter gets no
  provider and the env is unchanged. The adapter receives the provider by injection
  (`CreateMcpAdapterOptions.nodeFallback`) and never detects Electron itself.
- **Rust kernel.** The Host appends the shim directory to the agent process PATH only when
  `NIBI_KERNEL` selects Rust. The Rust kernel's MCP child env is the entry snapshot filtered through
  a whitelist; `PATH` and the two fallback variables are in that whitelist, so the kernel needs no
  MCP-specific branch. The Node kernel keeps the upstream semantics (only MCP child envs change).
- The provider prepares the shim directory lazily, on the first stdio connection. The result (or the
  failure) is memoized for the provider's lifetime.
- Waiting for that preparation is part of the connection: it uses the connection's `timeoutMs` and
  its cancel signal. A timeout or a cancel fails the connection through the normal failure path. A
  connection never stays `connecting` because preparation does not finish.
- If preparation fails, the provider logs one `warn` and returns no fallback. Connections continue
  with the unchanged env, so the user sees the normal `spawn ENOENT` failure.

## Shim Directory

Node kernel: `<cliStorageRoot>/node-fallback/v1/`. Rust kernel:
`<appConfigDir>/node-fallback/v1/` (`<dataRoot>/.nibi/v2`). The `v1` segment is the shim layout
version. A change to shim content must bump it, so a running shim file is never rewritten with new
content.

Files:

| Platform | Files                            | Mode |
| -------- | -------------------------------- | ---- |
| POSIX    | `node`, `npm`, `npx`             | 0755 |
| Windows  | `node.cmd`, `npm.cmd`, `npx.cmd` | -    |

Rules:

- Shim content is static. It contains no machine paths; it reads the two env vars below. So every app
  version, workspace and AppImage mount shares the same files, and concurrent agents write the same
  bytes.
- The provider compares each file with the expected content (and, on POSIX, the exec bits). It writes
  only on a difference, through a unique temp file plus `rename`.
- All three shims are always written. When the bundled npm is missing, `npm`/`npx` shims fail with a
  clear message instead of `ENOENT`.

Each shim:

- Fails with exit code 127 and a one-line stderr message when a required env var is missing.
- Sets `ELECTRON_RUN_AS_NODE=1`, then replaces itself with the Electron executable (`exec` on POSIX;
  the last batch command on Windows, so the exit code passes through).
- `npm`/`npx` shims also set `npm_config_update_notifier=false` when the user has not set it. The
  bundled npm must not ask the user to upgrade a global npm that does not exist.

`ELECTRON_RUN_AS_NODE=1` stays in the env of the MCP server's children on purpose. Node's
`child_process.fork()` and many tools spawn `process.execPath`, which is the Electron executable.
Without the variable those children would start a full Electron app.

## Environment Contract

The Node kernel adds these variables only to stdio MCP child envs. The Host adds them to the Rust
agent process env, which the kernel projects into MCP children. Users do not configure them.

| Variable                        | Value                                                      | Used by            | Missing        |
| ------------------------------- | ---------------------------------------------------------- | ------------------ | -------------- |
| `NIBI_NODE_FALLBACK_EXEC_PATH`  | Absolute path of the agent's `process.execPath` (Electron) | all shims          | shim exits 127 |
| `NIBI_NODE_FALLBACK_NPM_ROOT`   | Absolute path of the bundled npm package root              | `npm`, `npx` shims | shim exits 127 |

`NIBI_NODE_FALLBACK_NPM_ROOT` is omitted when no bundled npm is found.

Merge order for the Node kernel's stdio child env:

1. `buildMcpStdioEnv` (sanitized agent env, network passthrough, remote Node directory rule).
2. The server's own `env` from its config.
3. Node fallback: append the shim directory as the **last** PATH entry and set the two variables.

Step 3 runs after the server `env`, so a server that sets its own `PATH` still gets the fallback at
the end. The entry is not added twice.

PATH key on Windows: environment names are case-insensitive, so `Path` and `PATH` are the same
variable. Step 3 starts from the variant that was merged last (the server's value when it sets one),
removes every case variant, and writes exactly one key, `PATH`. The uppercase spelling is required:

- The MCP SDK spawns with `{ PATH: process.env.PATH, ...env }`. If the env still held only `Path`,
  the child env would carry both keys.
- With both keys, cross-spawn resolves the command with the last key (`Path`), but Node passes the
  first key in sorted order (`PATH`, without the shim directory) to the child. The top-level command
  starts, and every nested `node` (for example a package bin started by `npx`) fails.

On POSIX only the exact key `PATH` is used. The Host applies the same rule when it builds the Rust
agent env (it returns `Path: undefined` so Node's spawn drops the inherited variant).

## Bundled npm

- Version and registry sha512 are pinned in `packages/desktop/scripts/bundled-npm-assets.mjs`
  (`npm@12.2.0`). Its `engines.node` must accept the Electron Node version.
- npm is **not** a pnpm dependency. The repo uses `node-linker=hoisted`, so an `npm` package would
  link `npm`/`npx` into the root `node_modules/.bin` and shadow every developer's own npm.
- Packaging: `prepare:agent-bundle` downloads the registry tarball, checks its sha512, caches it in
  `node_modules/.cache/nibi-bundled-npm/`, and copies the package into
  `bundled-agents/<platform>/glm/node-runtime/npm` (resources `glm/node-runtime/npm` in the app).
  The top-level `docs/` and `man/` directories are left out (`npm help` is not supported). License
  files of npm and of its bundled dependencies stay in the copied tree.
- Offline fallback: when the registry is unreachable (intranet build machines, TLS failures) the
  staging script copies the npm package shipped with the running Node instead, logs a loud warning
  and writes `glm/npm-stage.json` with `{ source: "local-node", integrityVerified: false }`. A
  local copy has no registry sha512 to check, so it is never claimed as verified; CI that must be
  reproducible sets `NIBI_BUNDLED_NPM_ALLOW_LOCAL=0` semantics through the script option (or fixes
  the network). `NIBI_BUNDLED_NPM_OFFLINE=1` skips the download entirely and uses the local package.
- Runtime lookup: `<dir>/node-runtime/npm` for the entry file directory, then for the bundle
  directory. There is no cwd candidate, so a workspace cannot inject its own npm.
- A candidate is valid only when `bin/npm-cli.js` and `bin/npx-cli.js` exist.
- The desktop dev chain runs `apps/nibi-cli/packages/cli/dist/nibi.cjs`, which has no staged npm
  (and `stageAgentBundle` wipes `glm` on every dev build). There the `node` shim works and the
  `npm`/`npx` shims exit 127 with the missing-variable message.

## Observability

- `info` `mcp.node_fallback.ready` once per provider: `binDir`, `hasNpm`.
- `warn` `mcp.node_fallback.unavailable` once per provider: error message.
- `warn` `mcp.node_fallback.host_unavailable` once per Host env build when the Rust shim directory
  cannot be prepared.
- Bootstrap creates one provider per MCP wiring site (the protocol connection pool, and the
  standalone app adapter). The pool shares it across all session adapters.
- No per-connection logs.

## Known Limits

- **Native addons.** Electron's module ABI differs from Node's. N-API addons work; NAN-style addons
  built for Node fail to load. Users who need them must install Node.js.
- **Node version.** It is the Electron Node version. Servers that need a newer Node must use a
  system Node.
- **Windows `.cmd` resolution.** The Node kernel uses cross-spawn, so `node.cmd`/`npx.cmd` resolve.
  The Rust kernel resolves the command through the child `PATH` × `PATHEXT` before spawning, falls
  back to the Electron executable + bundled npm when the name is `node`/`npm`/`npx` and nothing is
  found, and wraps a resolved `.cmd`/`.bat` in `cmd.exe /d /s /c`. Users' own `node.exe` still wins
  because PATH lookup happens first. See `kernel/crates/env-local/src/mcp/node_fallback.rs`.
- **Starting another Electron app** from inside an MCP server inherits `ELECTRON_RUN_AS_NODE=1` and
  runs that app as plain Node.
- **Third-party notices.** The root `THIRD-PARTY-NOTICES.md` inventory is generated from the pnpm
  lockfile, so it does not list the bundled npm yet. The staged tree carries the license files.

## Tests

- Adapters unit: shim rendering per platform; directory preparation is idempotent, repairs changed
  content and exec bits, and is safe for concurrent calls; env merge appends once, survives a server
  `PATH` override, and is a no-op without a provider. On Windows the merge writes one `PATH` key, and
  both the command lookup and the child env see the shim directory, also when a host `Path` and a
  server `PATH` both exist.
- Adapters unit: a provider that never settles fails the connection at `timeoutMs`, and a cancel
  during preparation fails it too.
- Adapters integration (POSIX): with a PATH that has no `node`, the shims run a script, run
  `npx --version` and `npm --version` from the real npm package, and exit 127 when the env var is
  missing. A real stdio MCP connection with `command: "node"` succeeds through the fallback.
- Bootstrap unit: npm root lookup order, validity check, and no provider outside Electron.
- Services unit: the Rust Host env is a no-op for the Node kernel, appends the shim dir last, writes
  one uppercase Windows `PATH`, and degrades to an empty patch on failure.
- Rust unit: `NIBI_NODE_FALLBACK_*` and `PATH` survive the MCP child env projection.
- Desktop script unit: npm staging verifies the sha512, reuses a valid cache, replaces a corrupt
  cache, copies the package without `docs/`/`man/`, fails when the npm entry files are missing, and
  falls back to the local Node npm with an unverified marker when the registry is unreachable.
