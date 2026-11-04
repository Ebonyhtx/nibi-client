import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createBuildTimeConfigDefines, resolveBuildTimeConfig } from "../build-time-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时三项能力都关闭", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
  });
});

test("私有默认配置启用三项能力", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    NIBI_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
    NIBI_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    NIBI_AUTO_UPDATE: "1",
  });
  assert.deepEqual(await resolveBuildTimeConfig({}, { defaultsPath }), {
    armsRumEndpoint: "https://rum.example.com/x",
    telemetryReportEndpoint: "https://report.example.com/event",
    autoUpdateEnabled: true,
  });
});

test("环境变量优先于私有默认配置，显式空字符串关闭单项能力", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    NIBI_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    NIBI_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    NIBI_AUTO_UPDATE: "true",
  });
  const config = await resolveBuildTimeConfig(
    {
      NIBI_ARMS_RUM_ENDPOINT: "",
      NIBI_TELEMETRY_REPORT_ENDPOINT: "https://other.example.com/event",
      NIBI_AUTO_UPDATE: "0",
    },
    { defaultsPath },
  );
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "https://other.example.com/event",
    autoUpdateEnabled: false,
  });
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig({}, { defaultsPath }), /必须是 JSON 对象/);
});

test("上报端点硬拒绝上游域名与明文非回环地址", async () => {
  const missing = { defaultsPath: join(dir, "missing.json") };
  await assert.rejects(
    resolveBuildTimeConfig(
      { NIBI_ARMS_RUM_ENDPOINT: "https://upstream.zcode.invalid/api/v1/event/report" },
      missing,
    ),
    /上游域名/,
  );
  await assert.rejects(
    resolveBuildTimeConfig(
      { NIBI_TELEMETRY_REPORT_ENDPOINT: "https://cdn.zcode-upstream.invalid/event" },
      missing,
    ),
    /上游域名/,
  );
  await assert.rejects(
    resolveBuildTimeConfig({ NIBI_ARMS_RUM_ENDPOINT: "http://rum.example.com/x" }, missing),
    /https/,
  );
  assert.equal(
    (
      await resolveBuildTimeConfig(
        { NIBI_ARMS_RUM_ENDPOINT: "http://127.0.0.1:9/api/v1/event/report" },
        missing,
      )
    ).armsRumEndpoint,
    "http://127.0.0.1:9/api/v1/event/report",
  );
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
    }),
    {
      __NIBI_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __NIBI_TELEMETRY_REPORT_ENDPOINT__: '""',
      __NIBI_AUTO_UPDATE_ENABLED__: "true",
    },
  );
});
