# Nibi Node agent runtime (internal)

This directory is the **internal** TypeScript Node agent runtime (`nibi.cjs`). It is not a
published CLI: the user-facing terminal CLI/TUI is the Rust kernel under `kernel/`, published
as the `@nibi-studio/cli` npm META package plus `@nibi-studio/cli-<platform>` platform packages.

The Node runtime is still built and shipped for:

- DWF / dynamic workflow sidecar execution (`__nibi-dwf-engine`);
- the plugin host (`__nibi-plugin-host`);
- the remote Source Server (`app-server --stdio`);
- desktop development and tests that need the Node agent bundle.

```sh
pnpm install --frozen-lockfile
pnpm --filter @nibi/cli... build
node apps/nibi-cli/packages/cli/dist/nibi.cjs doctor --json
```

`pnpm --filter @nibi/cli build:desktop-agent` is the production build used by desktop staging,
the plugin host and the remote Source Server. The old Node CLI/TUI distribution (SEA binaries,
`build:nibi`, standalone release-it flow and the public `nibi` bin) is retired; do not add new
user-facing commands or packaging here. Use the Rust CLI for anything terminal users run.

The [CLI usage guide (中文)](docs/usage/README.md) and [design specifications](docs/design/v2/)
describe the legacy Node runtime behavior. They remain useful for the internal app-server,
plugin host and DWF paths, but are no longer the contract for the public `nibi` command.

Useful entry points:

- [Quick start and packaging](docs/usage/01-quickstart.md)
- [Model and runtime configuration](docs/usage/03-config.md)
- [Plugin development](docs/usage/10-plugins.md)
- [Hooks and workspace trust](docs/usage/09-hooks.md)
- [Batch tasks and trajectory capture](docs/usage/13-automation.md)
- [Contributor instructions](AGENTS.md)

Run `pnpm --filter @nibi/cli dev` for source development. CLI code validation follows the
contributor instructions; CLI tests are separate from the root unit-test suite.
