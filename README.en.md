# NIBI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="NIBI" width="120" height="120" />

  <p><strong>An AI development workspace for long, dense coding sessions.</strong></p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="LICENSE">Apache-2.0</a> ·
    <a href="docs/README.md">Documentation</a> ·
    <a href="docs/release-process.md">Release process</a>
  </p>
</div>

> NIBI is an AI development workspace that evolves independently from
> [ZCode](https://github.com/zai-org/ZCode) v3.16.2. The desktop agent kernel is
> Rust (`nibi-rs`); TypeScript / Electron / React provide the UI, Host and platform
> integration; the Node `nibi.cjs` runtime is retained only for DWF, the plugin host
> and the remote Source Server.

## Positioning

NIBI is not a reskinned ZCode distribution, nor a branch that merges upstream as a
whole. It starts from v3.16.2 and evolves independently: capabilities are absorbed
deliberately, while the product boundary, runtime, UI, plugin protocol and release
pipeline are maintained by NIBI.

- **Rust kernel**: the local desktop agent kernel is the standalone Cargo workspace
  under `kernel/` (37 crates). `nibi-rs` carries the CLI, TUI and remote executor.
  A missing kernel binary fails closed instead of silently falling back to Node.
- **One workspace, multiple execution locations**: local workspaces, SSH, WSL,
  Docker and remote Source Servers share the same session, tool and permission
  semantics.
- **Local-first**: configuration, sessions, credentials and plugin data stay under
  the local data root by default. Remote and mobile access is an explicit connection,
  not a default upload of local state.
- **Self-contained public build**: the UI, Host, server, shared protocols, Rust kernel,
  plugin host and CUA implementation live in this repository. Signing, real-provider
  smoke tests and operations tooling do not.

NIBI is not affiliated with or endorsed by the ZCode project or its maintainers.
Upstream names and copyrights belong to their respective owners.

## Capabilities

| Area                 | What it provides                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Workspaces and tasks | Projects, tasks, sessions, queues and subagents in one workbench                                                           |
| Terminal and files   | Built-in terminal, file preview, Git checkpoints, diffs and artifacts                                                      |
| Tools and MCP        | Tool calls, permission modes, MCP, skills, hooks and workflows                                                             |
| Plugins              | Built-in plugins, the official market and a plugin host with explicit contracts                                            |
| Remote development   | SSH / WSL / Docker / Source Server workspaces                                                                              |
| Mobile remote        | Scan-to-connect browser sessions with Relay V2 and share entry points                                                      |
| Computer Use         | Public implementation in `packages/nibi-cua`; MIT `@trycua/cua-driver` provides the native engine and absence fails closed |
| Sharing              | Public conversation projections, read-only share pages and import                                                          |

## Architecture

```text
┌────────────────────────────────────────────────────────────┐
│ Electron / React UI · Web / Mobile Remote                  │
│ Shared UI, protocols, Host services and platform bridges   │
└──────────────────────────┬─────────────────────────────────┘
                           │ RPC / V4 projection
┌──────────────────────────▼─────────────────────────────────┐
│ Rust kernel: nibi-rs                                       │
│ sessions · tools · models · permissions · CLI · TUI        │
└──────────────────────────┬─────────────────────────────────┘
                           │ local / SSH / WSL / Docker
┌──────────────────────────▼─────────────────────────────────┐
│ Workspace, terminal, files, plugins, MCP, CUA              │
└────────────────────────────────────────────────────────────┘

nibi.cjs (Node): internal runtime for DWF, the plugin host and the remote Source Server
```

See the [architecture overview](docs/architecture/nibi-code-architecture-overview.md)
and [architecture governance](docs/architecture/architecture-governance.md) for module
boundaries, message flow and dependency direction.

## Open-source scope

**Included:**

- Electron desktop client, web client and shared React UI
- Local Host, server, RPC and shared protocols
- Rust agent CLI, TUI and runtime (`kernel/`)
- Plugin host, built-in plugins and the Computer Use implementation (`packages/nibi-cua`)
- Development, test, build and architecture gates

**Not included:**

- Release signing, notarization or release credentials
- Real-provider smoke tests and the internal desktop container E2E pipeline
- Operations services, content publishing and internal runbooks

When an optional private component is absent, the public build fails closed. It does
not pretend to succeed or start a native process that is not present.

## Status and platforms

- Current public desktop releases target **Windows and Linux**. macOS source builds
  are supported, but desktop packages are deferred.
- Source Server currently publishes Linux archives; macOS remote archives are deferred
  together with the macOS desktop release.
- Public-source builds are **unsigned**. Signing and notarization are outside this
  repository; any first-run platform warning depends on the actual build.
- Computer Use on macOS requires a signed Helper with TCC permissions; without one the
  capability fails closed.
- The `@nibi-studio/cli` META package is being prepared for its first release. Until
  then, build the terminal CLI from source.

## Requirements

- Node.js **24.22.1**
- pnpm **10.33.2**
- Rust **1.95.0** (pinned by `kernel/rust-toolchain.toml`)
- Git

Versions are pinned in [mise.toml](mise.toml). Windows and Linux are the current
release targets; macOS supports source development and builds.

## Quick start

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime
assets and builds the base packages.

To isolate application data:

```bash
NIBI_DATA_BASE_DIR="$HOME/.nibi-dev" pnpm dev:desktop
```

Other entry points:

| Command                        | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `pnpm install`                 | Install dependencies only                  |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets             |
| `pnpm build`                   | Build every workspace package              |
| `pnpm dev:web`                 | Start the web dev server and local backend |
| `pnpm dev:docs`                | Start the developer docs site              |

## Repository layout

| Directory                                            | Responsibility                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron main, Host, renderer and desktop packaging                        |
| `packages/web`                                       | Web client and mobile remote entry                                         |
| `packages/web-share`                                 | Conversation share landing page                                            |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                           |
| `packages/nibi-server-cli`                           | Standalone server launcher and process management                          |
| `packages/ui`                                        | Shared React components, hooks and state                                   |
| `packages/services`                                  | Domain services and persistence                                            |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols, RPC framework and agent client SDK                       |
| `packages/provider`, `packages/provider-node`        | Provider primitives and Node implementation                                |
| `apps/nibi-cli`                                      | Internal Node runtime (`nibi.cjs`: DWF, plugin host, remote Source Server) |
| `packages/nibi-cua`                                  | Computer Use implementation (Helper / runtime / engine adapter)            |
| `kernel`                                             | Rust kernel: protocols, sessions, tools, models, CLI and TUI               |
| `scripts`, `config`, `third-party`                   | Build tooling, built-in config and third-party notices                     |

`kernel/` is a standalone Cargo workspace and is not part of the pnpm/tsc chain. The
local desktop agent uses only the Rust kernel; `NIBI_AGENT_SERVER_COMMAND` is an
explicit override, not a Node fallback. See
[`docs/rust-kernel-function-parity.md`](docs/rust-kernel-function-parity.md) for the
functional comparison and [`kernel/CHANGELOG-FORK.md`](kernel/CHANGELOG-FORK.md) for
the fork ledger.

## Development and verification

```bash
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:unit
pnpm check:public-repo
```

Run `pnpm lint`, `pnpm typecheck` and the relevant unit tests before opening a pull
request. Public CI runs the same gates on Linux, Windows and macOS, uses only
GitHub-hosted runners and does not receive repository secrets.

Rust kernel checks:

```bash
cd kernel
cargo check --locked --workspace
cargo test --locked --workspace
```

## Desktop builds

```bash
pnpm bundle:desktop
pnpm bundle:desktop -- --os win --arch x64
pnpm bundle:desktop -- --os linux --arch x64
```

Public-source builds are **unsigned**. Signing, notarization and update-inventory
publishing are outside this repository. macOS desktop packages are currently deferred;
the public Windows release uses the NSIS installer. See the
[release process](docs/release-process.md) for the current update policy.

## Terminal CLI

Build the Rust kernel from source:

```bash
cd kernel
cargo build --release -p nibi-kernel-cli --bin nibi-rs
./target/release/nibi-rs --version
```

On macOS / Linux you can also use `cargo install --path kernel/crates/cli`. The npm
META package `@nibi-studio/cli` will provide the global `nibi` entry point after its
first release; do not depend on npm installation before then. The Node `@nibi/cli`
and Node TUI are retired and no longer published.

## Configuration

| Variable                            | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `NIBI_DATA_BASE_DIR`                | Application data base directory; data is written under `.nibi/` |
| `NIBI_SERVER_WORKSPACE`             | Workspace path for the web backend                              |
| `NIBI_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider config file                            |

Set runtime variables explicitly in the launch environment. The built-in
configuration is described in [config/README.md](config/README.md).

## Contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report security issues privately as described in [SECURITY.md](SECURITY.md); do not
  open a public issue.
- The code of conduct is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Architecture and design documents start at [docs/README.md](docs/README.md).

## License and provenance

First-party code is released under the [Apache License 2.0](LICENSE). NIBI is based on
ZCode v3.16.2 and evolves independently; it is not an official ZCode distribution and
does not represent the upstream project.

- Licensing scope and third-party components: [LICENSING.md](LICENSING.md)
- Upstream copyright and provenance: [NOTICE.md](NOTICE.md)
- Third-party dependencies, copied code and native components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- NIBI name and marks: [TRADEMARKS.md](TRADEMARKS.md)
