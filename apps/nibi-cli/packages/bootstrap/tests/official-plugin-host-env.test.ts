import { afterEach, describe, expect, it } from "vitest";
import { candidateBaseDirs } from "../src/app/bundled-plugins.js";
import { officialPluginHostPrefixArgs } from "../src/app/official-plugin-runtime.js";

const RESOURCE_DIR_ENV = "NIBI_BUNDLED_AGENT_RESOURCE_DIR";
const BINARY_PATH_ENV = "NIBI_BUNDLED_AGENT_BINARY_PATH";

const original = {
  resourceDir: process.env[RESOURCE_DIR_ENV],
  binaryPath: process.env[BINARY_PATH_ENV],
};

afterEach(() => {
  for (const [name, value] of [
    [RESOURCE_DIR_ENV, original.resourceDir],
    [BINARY_PATH_ENV, original.binaryPath],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Host-provided bundled plugin environment", () => {
  it("prepends the bundled resource dir so a Host entry can find packages/*-plugin", () => {
    process.env[RESOURCE_DIR_ENV] = "/opt/nibi/resources/nibi";
    expect(candidateBaseDirs()[0]).toBe("/opt/nibi/resources/nibi");
  });

  it("uses the bundled nibi.cjs as the plugin host prefix instead of the Host entrypoint", () => {
    process.env[BINARY_PATH_ENV] = "/opt/nibi/resources/nibi/nibi.cjs";
    expect(officialPluginHostPrefixArgs()).toEqual([
      "/opt/nibi/resources/nibi/nibi.cjs",
      "__nibi-plugin-host",
    ]);
  });

  it("keeps the test-process guard when neither override is present", () => {
    delete process.env[RESOURCE_DIR_ENV];
    delete process.env[BINARY_PATH_ENV];
    expect(officialPluginHostPrefixArgs()).toBeUndefined();
  });
});
