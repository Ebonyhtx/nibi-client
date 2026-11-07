import { expect, it } from "vitest";
import { buildNodeReplHostEnv } from "../src/zcode-agent/nodeReplHostEnv.js";

it("only the Rust kernel gets the hosted node_repl contract", () => {
  expect(buildNodeReplHostEnv({ kernel: "node", execPath: "/opt/nibi/electron" })).toEqual({});
  expect(buildNodeReplHostEnv({ kernel: "rust", execPath: "/opt/nibi/electron" })).toEqual({
    NIBI_HOST_NODE_REPL: "1",
    NIBI_NODE_EXEC_PATH: "/opt/nibi/electron",
  });
});

it("advertises the browser broker only when the Host has an executor", () => {
  expect(
    buildNodeReplHostEnv({
      kernel: "rust",
      execPath: "/opt/nibi/electron",
      browserBroker: true,
    }),
  ).toEqual({
    NIBI_HOST_NODE_REPL: "1",
    NIBI_NODE_EXEC_PATH: "/opt/nibi/electron",
    NIBI_HOST_BROWSER_BROKER: "1",
  });
  expect(
    buildNodeReplHostEnv({ kernel: "node", execPath: "/opt/nibi/electron", browserBroker: true }),
  ).toEqual({});
});
