# @nibi/cua

Computer Use runtime for NIBI Desktop: broker protocol, Helper process, element /
frame ledgers, controller leases and action replay protection. Native capability
comes from `@trycua/cua-driver`; the semantics and safety rules live in this
package (see `IMPLEMENTATION.md` for the layer contract).

The package is **fail-closed by default**: without a broker endpoint every
surface reports unavailable instead of pretending to work. The real runtime is
used when the host injects a broker socket (`createComputerUseRuntime({
brokerSocketPath })`), which is what the desktop app does on Windows and macOS.

The upstream open-source export replaces this directory with an API-compatible
placeholder that declares `nibiCuaPlaceholder: true`; packaging steps skip the
private Helper assets in that case.

License: Apache-2.0.
