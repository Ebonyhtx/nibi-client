# Contributing to NIBI

Thanks for taking the time to contribute. This repository is the public NIBI
client; it is meant to be buildable, testable, and understandable without any
private service or credential.

## Before you start

- Read [AGENTS.md](AGENTS.md) for repository conventions and validation rules.
- Read [docs/architecture/architecture-governance.md](docs/architecture/architecture-governance.md)
  before changing module boundaries.
- Read [DESIGN.md](DESIGN.md) before changing UI.
- Read [CONTEXT.md](CONTEXT.md) before changing plugin store behavior.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.

## Development setup

Requirements: Node.js 24.14.0, pnpm 10.33.2, and Git. Versions are pinned in
[mise.toml](mise.toml).

```bash
pnpm bootstrap
pnpm dev:desktop
```

Useful commands:

```bash
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:unit
pnpm check:public-repo
```

Run the checks relevant to your change before opening a pull request. If a check
cannot run in your environment, say so in the pull request instead of reporting
it as passing.

## Pull requests

- Keep each pull request focused on one behavior or refactor.
- Describe the background, the design intent, and the behavior before/after.
- For bug fixes, include the trigger, the root-cause evidence, the fix, and the
  regression test.
- Add or update tests when behavior changes. UI interaction changes need a
  rendered or end-to-end check where practical.
- Do not include generated build output, local data directories, logs, or
  screenshots containing personal paths or credentials.
- By submitting a pull request you agree that your contribution is licensed
  under the Apache License 2.0.

## Public repository rules

These rules are enforced by CI and review:

1. **No secrets or credentials.** Never commit tokens, private keys, cookies,
   signing material, or real provider keys. Test fixtures must use obviously
   fake values.
2. **No internal infrastructure.** Do not add private IP addresses, internal
   hostnames, VPN/SSH details, server paths, or operator runbooks. Public
   product endpoints are fine; private deployment details are not.
3. **No private paths.** Do not commit absolute paths such as `D:\...`,
   `/Users/<name>/...`, or machine-specific cache locations.
4. **No native Computer Use implementation.** The public repository keeps the
   `@nibi/cua` contract and fail-closed placeholder only. Native Helper, engine,
   and runtime semantics belong to the private release overlay.
5. **No self-hosted runners in public workflows.** Public CI runs on
   GitHub-hosted runners only. Do not add `runs-on: [self-hosted, ...]`.
6. **Use `pull_request`, never `pull_request_target`.** Fork pull requests must
   not receive repository secrets.
7. **Least privilege.** Workflows declare `permissions: contents: read` unless a
   step genuinely needs more; document why if it does.
8. **Pin actions.** Third-party actions are pinned to a full commit SHA.
9. **Public-facing documentation.** Do not document internal business plans,
   pricing, incidents, customer data, or private service topology.

Run `pnpm check:public-repo` before pushing. It scans tracked text files for the
patterns above and fails with file/line details.

## Code conventions

- Prefer the existing module boundaries and public entry points.
- Do not add a second state owner or a second write path. Make ownership,
  ordering, and idempotency explicit.
- Use the shared UI primitives and semantic tokens.
- Keep comments about constraints, not about the change itself.
- Use asynchronous file and network I/O.
- Do not introduce circular dependencies or cross-domain implementation imports.
- Match the surrounding code's naming and comment density.

## Tests

- Unit tests live next to the package they cover.
- Desktop interaction tests live under `packages/desktop/test/e2e/`.
- Architecture tests live under `scripts/test/`.
- A test that silently skips must say why; do not turn a missing dependency into
  a passing test.

## Review and merge

- A pull request needs a green public CI run and review approval.
- Squash or rebase to keep the history readable.
- Maintainers may ask for a smaller change or a design note before implementation.

## Contact

For non-security questions, open a GitHub issue. For security reports, use the
private channel described in [SECURITY.md](SECURITY.md).
