import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  LOCAL_TO_UPSTREAM_PREFIXES,
  toLocalPath,
  toUpstreamPath,
} from "../architecture/upstream-snapshot.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SNAPSHOT = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts/architecture/upstream-snapshot.json"), "utf8"),
);

const EXPECTED_PREFIXES = [
  ["apps/nibi-cli/", "apps/zcode-cli/"],
  ["packages/nibi-server-cli/", "packages/zcode-server-cli/"],
];

test("本地目录映射到上游快照前缀，不是自映射", () => {
  assert.deepEqual(LOCAL_TO_UPSTREAM_PREFIXES, EXPECTED_PREFIXES);
  for (const [local, upstream] of EXPECTED_PREFIXES) {
    assert.notEqual(local, upstream, `${local} 不应映射到自身`);
    assert.ok(local.endsWith("-cli/"));
    assert.ok(
      upstream.startsWith("apps/zcode-cli/") || upstream.startsWith("packages/zcode-server-cli/"),
    );
  }
});

test("快照里确实存在两个上游前缀", () => {
  const keys = new Set([
    ...Object.keys(SNAPSHOT.files),
    ...Object.keys(SNAPSHOT.historicalFiles ?? {}),
  ]);
  for (const [, upstream] of EXPECTED_PREFIXES) {
    const count = [...keys].filter((key) => key.startsWith(upstream)).length;
    assert.ok(count > 0, `快照缺少前缀 ${upstream}`);
  }
  assert.equal(
    [...keys].filter((key) => key.startsWith("apps/nibi-cli/")).length,
    0,
    "快照键必须保留上游历史路径，不能写入本地 nibi 路径",
  );
  assert.equal(
    [...keys].filter((key) => key.startsWith("packages/nibi-server-cli/")).length,
    0,
    "快照键必须保留上游历史路径，不能写入本地 nibi 路径",
  );
});

test("快照键与本地路径 round-trip 一致", () => {
  const keys = new Set([
    ...Object.keys(SNAPSHOT.files),
    ...Object.keys(SNAPSHOT.historicalFiles ?? {}),
  ]);
  let mapped = 0;
  for (const upstream of keys) {
    const local = toLocalPath(upstream);
    if (local === upstream) continue;
    mapped += 1;
    assert.equal(toUpstreamPath(local), upstream, `${local} 未能映射回 ${upstream}`);
  }
  assert.ok(mapped > 0, "没有任何快照键命中映射，round-trip 判据空转");
});

test("已知本地文件能映射到快照键", () => {
  const cases = [
    [
      "apps/nibi-cli/e2e/compact-microcompact/args.mjs",
      "apps/zcode-cli/e2e/compact-microcompact/args.mjs",
    ],
    [
      "packages/nibi-server-cli/scripts/verify-proxy-stdio-docker.mjs",
      "packages/zcode-server-cli/scripts/verify-proxy-stdio-docker.mjs",
    ],
  ];
  for (const [local, upstream] of cases) {
    assert.ok(existsSync(join(REPO_ROOT, local)), `本地样例不存在：${local}`);
    assert.equal(toUpstreamPath(local), upstream);
    assert.equal(toLocalPath(upstream), local);
    assert.ok(SNAPSHOT.files[upstream], `快照里没有 ${upstream}`);
  }
});

test("未命中映射的路径原样返回", () => {
  const paths = ["packages/shared/src/index.ts", "README.md", "apps/nibi-cli-extra/file.ts"];
  for (const path of paths) {
    assert.equal(toUpstreamPath(path), path);
    assert.equal(toLocalPath(path), path);
  }
});
