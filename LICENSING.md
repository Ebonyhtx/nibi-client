# Licensing

This file is a plain-language map of the licenses that apply to this repository.
It does not replace the license texts or the third-party notices.

## First-party code

Code and documentation authored for NIBI are released under the
[Apache License 2.0](LICENSE), unless a file or directory says otherwise.

## Upstream sources

NIBI is an independent project, not an official upstream release and not endorsed
by any upstream project.

- **TypeScript client lineage**: derived from
  [ZCode](https://github.com/zai-org/ZCode) v3.16.2, Apache-2.0.
- **Rust kernel**: vendored from
  [`MBearo/ZCode-rs`](https://github.com/MBearo/ZCode-rs) 0.1.67 (commit
  `6d349ed4`), Apache-2.0. The vendored subtree is `kernel/`; its source and
  upstream-update ledger is [kernel/CHANGELOG-FORK.md](kernel/CHANGELOG-FORK.md).
- **Copied Codex files**: the Rust TUI includes `paste_burst` code copied from
  [`openai/codex`](https://github.com/openai/codex) (commit `c3d3b142d`),
  Apache-2.0. Attribution and license text are kept in
  `kernel/vendor/copied/openai-codex/` and `kernel/vendor/THIRD-PARTY-NOTICES.txt`.

Upstream copyright and provenance are also recorded in [NOTICE.md](NOTICE.md).

## Third-party components

Third-party dependencies, copied source, native binaries, fonts, icons and other
assets remain under their own licenses. The generated inventory is
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Notable examples:

- Computer Use native engine: MIT-licensed `@trycua/cua-driver`
- Computer Use vendor packages: MPL-2.0 `@ubjs/*`
- Electron, React, Node.js and other runtime dependencies: see the generated notices

Nothing in the Apache License 2.0 grants rights to third-party material beyond the
terms attached to that material.

## Contributions

By submitting a contribution, you agree that it is licensed under the Apache
License 2.0, as described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Names and marks

The Apache License 2.0 does not grant permission to use NIBI names or logos. See
[TRADEMARKS.md](TRADEMARKS.md).

## No warranty

The software is provided on an “AS IS” basis, without warranties or conditions of
any kind, as stated in the Apache License 2.0.
