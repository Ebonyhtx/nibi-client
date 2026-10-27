# @nibi/cua

Public Computer Use contract for the NIBI client.

This package contains the integration surface that the open-source client
compiles against:

- broker method names, request/response envelopes, error codes, and socket naming
- frame, display, and access-request metadata contracts
- fail-closed runtime and Helper launcher stubs

The native Helper, the engine adapter, and the runtime safety semantics are
**not** part of this repository. In the open-source build every Computer Use
entry point reports `Computer Use is not available in this build.` and never
starts a Helper process. Official NIBI builds replace this package with the
full implementation.

The placeholder is detected through `zcodeCuaPlaceholder: true` in
`package.json`; desktop development and packaging steps use that flag to skip
Helper assets. See
[`docs/desktop/computer-use-producer-detection.md`](../../docs/desktop/computer-use-producer-detection.md).

License: Apache-2.0.
