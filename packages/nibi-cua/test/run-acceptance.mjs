import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

const RUNS = {
  typed: ["typed", "test/nativeAcceptance.test.mjs"],
  native: ["1", "test/nativeAcceptance.test.mjs"],
  p4b: ["1", "test/nativeAcceptanceP4b.test.mjs"],
  wiring: ["1", "test/wiringAcceptance.test.mjs"],
};

function run(envValue, file) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
    env: { ...process.env, NIBI_CUA_NATIVE_ACCEPTANCE: envValue },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const mode = process.argv[2] ?? "typed";
if (mode === "all") {
  run("typed", "test/nativeAcceptance.test.mjs");
  run("1", "test/nativeAcceptanceP4b.test.mjs");
  run("1", "test/wiringAcceptance.test.mjs");
} else if (RUNS[mode]) {
  run(...RUNS[mode]);
} else {
  console.error(`Unknown acceptance mode: ${mode}`);
  process.exit(1);
}
