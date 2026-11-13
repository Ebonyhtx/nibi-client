# NIBI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="NIBI" width="128" height="128" />
</div>

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

NIBI is an open-source AI development workspace with a desktop app, browser UI, server, shared UI, and a terminal agent with its runtime. It is built for long, dense development sessions: multiple workspaces, terminals, file previews, tool calls, plugins, and remote development in one place.

This repository contains the public source of the NIBI client. The project is based on [ZCode](https://github.com/zai-org/ZCode) v3.16.2 (Apache License 2.0) and evolves independently. Upstream copyright and third-party notices are kept in [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Open-source scope

Included:

- Electron desktop client and web client
- Local Host, server, RPC, and shared protocols
- Rust Agent CLI, TUI, and runtime
- Shared React UI, plugin host, and built-in plugins
- Development, test, build, and architecture gates

Not included:

- The Computer Use Helper, engine adapter, and runtime semantics live in `packages/nibi-cua`. Native capability comes from MIT-licensed `@trycua/cua-driver`; missing engines fail closed.
- Release signing, real-provider smoke tests, and the internal desktop container E2E pipeline and credentials.
- Operations services, content publishing, and internal runbooks.

When a private component is absent, the public build fails closed and never pretends that the capability is available.

## Requirements

- Node.js **24.22.1**
- pnpm **10.33.2**
- Git

Versions are pinned in [mise.toml](mise.toml). Windows, macOS, and Linux are first-class platforms.

## Quick start

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and builds the base packages.

The internal Node agent runtime (`nibi.cjs`, used by DWF, the plugin host and the remote Source Server) lives in [apps/nibi-cli/](apps/nibi-cli/) as a regular directory; no submodule is required. The user-facing terminal CLI/TUI is the Rust `nibi-rs` under `kernel/`.

Other entry points:

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dependencies only |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets |
| `pnpm build` | Build every workspace package |
| `pnpm dev:web` | Start the web dev server and local backend |
| `pnpm dev:docs` | Start the developer docs site |

To isolate application data, set `NIBI_DATA_BASE_DIR`:

```bash
NIBI_DATA_BASE_DIR="$HOME/.nibi-dev" pnpm dev:desktop
```

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `packages/desktop` | Electron main, host, renderer, and desktop packaging |
| `packages/web` | Web client |
| `packages/server` | HTTP / WebSocket services and remote connections |
| `packages/nibi-server-cli` | Standalone server launcher and process management |
| `packages/ui` | Shared React components, hooks, and Zustand state |
| `packages/services` | Domain services and persistence |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols, RPC framework, agent client SDK |
| `packages/provider`, `packages/provider-node` | Provider primitives and Node implementation |
| `apps/nibi-cli` | Internal Node agent runtime (`nibi.cjs`: DWF, plugin host, remote Source Server) |
| `packages/nibi-cua` | Computer Use implementation (Helper / runtime / engine adapter) |
| `scripts`, `config`, `third-party` | Build tooling, built-in config, third-party notices |

> `apps/nibi-cli` and `packages/nibi-server-cli` have been renamed to NIBI; upstream pristine files are still verified through the local-to-upstream prefix map in `scripts/architecture/upstream-snapshot.json` (snapshot keys remain upstream paths). `packages/nibi-cua` has been migrated into the public repository with the CUA engine upgrade. Package names, CLI commands, and build outputs are NIBI (`nibi-cli`, `@nibi/server-cli`, `@nibi/cua`, `dist/nibi.cjs`, and the remote executor `nibi-server.cjs` / `nibi-server-<target>.tar.gz`).

## Development and verification

```bash
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:unit
pnpm check:public-repo
```

Run `pnpm lint`, `pnpm typecheck`, and the relevant unit tests before opening a pull request. Public CI runs the same gates on Linux, Windows, and macOS and never uses self-hosted runners.

Desktop build:

```bash
pnpm bundle:desktop
pnpm bundle:desktop -- --os win --arch x64
```

Public-source builds are **unsigned**. Signing and notarization for official releases happen inside the private release environment and are not part of this repository.

Terminal CLI distribution (Rust kernel + npm META launcher):

```bash
npm install -g @nibi-studio/cli
nibi --version
nibi doctor --json
```

The META package installs the `@nibi-studio/cli-<platform>` package for the current os/arch.
Linux currently ships glibc (gnu) only; Intel Mac and Windows are not in the npm platform
list. The Node `@nibi/cli` and Node TUI are retired and no longer published; `nibi.cjs` is
only the internal runtime for desktop DWF, the plugin host and the remote Source Server.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NIBI_DATA_BASE_DIR` | Application data base directory; data is written under `.nibi/` |
| `NIBI_SERVER_WORKSPACE` | Workspace path for the web backend |
| `NIBI_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider config file |

Set runtime variables explicitly in the launch environment. The built-in configuration is described in [config/README.md](config/README.md).

## Contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report security issues privately as described in [SECURITY.md](SECURITY.md); do not open a public issue.
- The code of conduct is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Architecture and design documents start at [docs/README.md](docs/README.md).

## License and provenance

Released under the [Apache License 2.0](LICENSE). NIBI is based on ZCode v3.16.2 and evolves independently. Upstream copyright, third-party licenses, and provenance are recorded in [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
