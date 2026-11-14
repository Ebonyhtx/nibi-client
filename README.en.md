# NIBI

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="NIBI" width="120" height="120" />

  <p><strong>Bring long, dense development work into one window.</strong></p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="docs/README.md">Documentation</a> ·
    <a href="docs/release-process.md">Release notes</a>
  </p>
</div>

NIBI is an AI workspace for real development work. Conversations, terminals, files, tools, plugins, remote workspaces and mobile control share one context, so you do not have to carry state between windows.

It is built for long-running coding sessions and for developers who move between multiple projects, conversations and machines.

## Why NIBI

- **Go from conversation to work**: read files, run commands, inspect diffs and preview artifacts without copying results into another tool.
- **Long sessions stay together**: tasks, queues, subagents, background work and recovery live in one workspace.
- **The same experience local and remote**: local projects, SSH, WSL, Docker and remote workspaces share session and permission semantics.
- **Continue away from the desk**: scan a QR code to inspect progress, answer questions and handle waiting work from your phone.
- **Extend your own way**: plugins, MCP, skills, hooks and workflows connect to the way you already work.
- **Rust-native core**: the desktop agent runs on a Rust core for more predictable responsiveness and resource use in long sessions.

### The ZCode desktop you know, with a steadier Rust core

NIBI keeps the ZCode open-source desktop workflow, but moves the work that actually runs tasks onto an upstream open-source Rust kernel. The interface and workflow stay familiar; the change happens where you do not see it.

This is not about chasing benchmarks. AI development hurts most when long sessions slow down and tool-heavy work starts to stutter. The Rust kernel gives us more control over startup, memory and background execution, so long tasks are less likely to be dragged down by the runtime.

For you, the difference is simple: long tasks hold up better, interactions stay responsive, and background work is easier to trust. NIBI is an independent product, not an official ZCode release.

## What you can do

| Scenario                 | What NIBI provides                                                   |
| ------------------------ | -------------------------------------------------------------------- |
| Write code and fix bugs  | Locate, change, run and verify in one conversation                   |
| Maintain large codebases | Parallel workspaces, tasks and sessions with their context preserved |
| Run long tasks           | Queues, subagents, background execution, recovery and notifications  |
| Develop remotely         | SSH, WSL, Docker and remote workspaces in one place                  |
| Stay in the loop         | Mobile control for progress, replies and pending actions             |
| Extend workflows         | Plugins, MCP, skills, hooks and automation                           |

## Product principles

- **Local-first**: projects, sessions and configuration stay on your device by default; remote access is explicit.
- **Results must be inspectable**: tool calls, file changes and execution results can be reviewed; “the model says it is done” is not completion.
- **Capabilities have boundaries**: unavailable capabilities are stated clearly; NIBI does not fake success or silently take another path.
- **Recoverable**: long tasks, sessions and subagents have recovery paths instead of forcing a restart from scratch.

## Platforms

- Desktop builds are provided for Windows and Linux.
- macOS supports source builds; package distribution is deferred.
- Public-source builds are unsigned. Official distribution uses the official release channel.

## Build from source

Requirements: Node.js 24.22.1, pnpm 10.33.2, Rust 1.95.0 and Git.

```bash
pnpm bootstrap
pnpm dev:desktop
```

To isolate application data:

```bash
NIBI_DATA_BASE_DIR="$HOME/.nibi-dev" pnpm dev:desktop
```

Other entry points:

| Command         | Purpose                               |
| --------------- | ------------------------------------- |
| `pnpm install`  | Install dependencies only             |
| `pnpm build`    | Build the workspace                   |
| `pnpm dev:web`  | Start the web development environment |
| `pnpm dev:docs` | Start the developer docs site         |

## Documentation

- [Development docs](docs/README.md)
- [Architecture overview](docs/architecture/nibi-code-architecture-overview.md)
- [Rust kernel comparison](docs/rust-kernel-function-parity.md)
- [Release process](docs/release-process.md)

## Contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report security issues privately as described in [SECURITY.md](SECURITY.md); do not open a public issue.
- The code of conduct is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

First-party code is released under the [Apache License 2.0](LICENSE). Upstream provenance, third-party components and redistribution boundaries are described in [LICENSING.md](LICENSING.md), [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). NIBI names and marks are covered by [TRADEMARKS.md](TRADEMARKS.md).
