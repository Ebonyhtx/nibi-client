import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { insertVerifiedDockerSpecRow } from "../scripts/conversation-docker-plan.mjs";

const repoRoot = process.cwd();
const containerScriptPath = resolve(repoRoot, "scripts/test-desktop-e2e-container.sh");

describe("desktop E2E container presets", () => {
  it("keeps the default smoke preset free of stale conversation specs", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const defaultAssignment = script.match(/^DEFAULT_E2E_SPEC="([^"]*)"$/m);

    expect(defaultAssignment).not.toBeNull();
    expect(defaultAssignment?.[1]).not.toContain("./test/e2e/conversation-session/");
  });

  it("admits conversation specs only through the verified preset, never the default smoke", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const verified = script.match(/^CONVERSATION_SESSION_VERIFIED_E2E_SPEC="([^"]*)"$/m);

    expect(verified).not.toBeNull();
    const specs = (verified?.[1] ?? "").split(",").filter(Boolean);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec).toContain("./test/e2e/conversation-session/");
    // 预设为空时的提示要说明正确的准入方式，而不是宣称「从来没有证据」。
    expect(script).toContain("The verified conversation-session preset is empty");
    expect(script).not.toContain("conversation-session-admission)");
    expect(script).not.toContain("conversation-session-needs-docker-fix)");
    expect(script).not.toContain("conversation-session-tool-cross-product)");
  });

  it("retires package commands for stale conversation diagnostic presets", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:e2e:container:conversation"]).toContain(
      "conversation-session-verified",
    );
    expect(packageJson.scripts["test:e2e:container:conversation:admission"]).toBeUndefined();
    expect(packageJson.scripts["test:e2e:container:conversation:needs-docker-fix"]).toBeUndefined();
    expect(
      packageJson.scripts["test:e2e:container:conversation:tool-cross-product"],
    ).toBeUndefined();
    expect(packageJson.scripts["test:e2e:container:conversation:all"]).toBeUndefined();
  });

  it("keeps plugin Docker admission review-gated while exposing the verified preset command", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    const preset = script.match(/^PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC="([^"]*)"$/m)?.[1] ?? "";
    const specs = preset.split(",").filter(Boolean);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).toMatch(/^\.\/test\/e2e\/plugins\/[^/]+\.test\.ts$/);
      expect(spec).not.toContain("manual-review");
    }
    expect(script).toContain("plugins-verified)");
    expect(script).toContain("No plugin-management spec has completed human review");
    expect(packageJson.scripts["test:e2e:container:plugins"]).toContain("plugins-verified");
  });

  it("references only existing conversation spec paths", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const conversationPaths = [
      ...script.matchAll(/\.\/test\/e2e\/conversation-session\/[^,"'\\s]+\.test\.ts/g),
    ].map(([path]) => path);
    const missingPaths = conversationPaths.filter(
      (path) => !existsSync(resolve(repoRoot, "packages/desktop", path)),
    );

    expect(missingPaths).toEqual([]);
  });

  it("writes verified rows into the Docker plan table", () => {
    // Bugfix：仓库只对 *.mjs / *.sh 声明了 `eol=lf`，Markdown 在 `core.autocrlf=true`
    // 的 Windows 检出里是 CRLF。下面断言的表格骨架是跨行片段，`\n` 匹配不到 `\r\n`，
    // 用例在 Windows 上必然失败；这里要断言的是文档结构，与换行字节无关，故归一成 LF。
    const dockerPlan = readFileSync(
      resolve(repoRoot, "docs/testing/conversation-session-docker-automation.md"),
      "utf-8",
    ).replaceAll("\r\n", "\n");

    // 真实文档已经登记过 spec，不能再假设表格为空；插入逻辑用独立空表验证。
    const emptyPlan =
      "| Spec | 迁移状态 |\n| --- | --- |\n<!-- conversation-session-verified-table-end -->";
    const spec = "./test/e2e/conversation-session/example.test.ts";
    const updated = insertVerifiedDockerSpecRow(emptyPlan, spec);
    expect(updated.inserted).toBe(true);
    expect(updated.text).toContain(
      `| \`${spec}\` | verified |\n<!-- conversation-session-verified-table-end -->`,
    );
    expect(dockerPlan).toContain(
      "| `./test/e2e/conversation-session/conversation-session-plugin-marketplace-installed-roundtrip.test.ts` | verified |",
    );
  });
});

// 用假的 docker 记录参数，验证容器脚本透传给容器的上游供应商配置；取最后一次 docker run（前面一次是驱动预取）。
function runContainerScriptWithFakeDocker(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "nibi-e2e-container-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "docker.log");
    // 只记录 run：容器脚本的后台采样会并发调用 docker inspect/stats，长的 run 参数行分多次写入时
    // 会与之交错（曾出现 "-e E2inspect ..."）；两次 docker run 本身串行，只记 run 就没有并发写。
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env bash\nif [ "$1" = run ]; then printf '%s\\n' "$*" >> "${logPath}"; fi\n`,
      {
        mode: 0o755,
      },
    );
    const result = spawnSync("bash", [containerScriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SKIP_IMAGE_BUILD: "1",
        E2E_ARTIFACT_DIR: join(dir, "artifacts"),
        PERF_SAMPLE_INTERVAL_SECONDS: "1",
        ...env,
      },
    });
    const runArgs = existsSync(logPath)
      ? (readFileSync(logPath, "utf8")
          .split("\n")
          .findLast((line) => line.startsWith("run ")) ?? "")
      : "";
    return { status: result.status, stderr: result.stderr, runArgs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("desktop E2E verified spec source", () => {
  // `--print-spec` 必须在任何 Docker 检查之前退出：这里把 docker 换成必然失败的桩，
  // 一旦脚本仍去探测 daemon，status 就会变成 1。
  function printSpec(preset: string) {
    const dir = mkdtempSync(join(tmpdir(), "nibi-e2e-print-spec-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "docker"), "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });
      const result = spawnSync("bash", [containerScriptPath, "--print-spec", preset], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      return {
        status: result.status,
        stdout: (result.stdout ?? "").trim(),
        stderr: result.stderr ?? "",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function assignment(name: string) {
    return (
      readFileSync(containerScriptPath, "utf-8").match(
        new RegExp(`^${name}="([^"]*)"$`, "m"),
      )?.[1] ?? ""
    );
  }

  it("prints the plugins-verified preset without touching Docker", () => {
    const result = printSpec("plugins-verified");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Docker daemon is not reachable");
    expect(result.stdout).toBe(assignment("PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC"));
    expect(result.stdout.split(",").filter(Boolean).length).toBeGreaterThan(0);
  });

  it("prints the conversation-session-verified preset without touching Docker", () => {
    const result = printSpec("conversation-session-verified");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(assignment("CONVERSATION_SESSION_VERIFIED_E2E_SPEC"));
  });

  it("keeps the default preset and rejects unknown preset names", () => {
    expect(printSpec("default").stdout).toBe(assignment("DEFAULT_E2E_SPEC"));
    expect(printSpec("no-such-preset").status).not.toBe(0);
  });
});

describe("desktop E2E native CI selection", () => {
  const workflowPath = resolve(repoRoot, ".github/workflows/desktop-e2e-native.yml");

  it("selects the same verified presets on macOS and Windows", () => {
    const workflow = readFileSync(workflowPath, "utf-8");

    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("windows-latest");
    // 预设的唯一事实源是容器脚本；workflow 不得自带第二份 spec 路径。
    expect(workflow).toContain("--print-spec plugins-verified");
    expect(workflow).toContain("--print-spec conversation-session-verified");
    expect(workflow).not.toContain("./test/e2e/");
    expect(workflow).toContain("E2E_PROVIDER_HTTP_MODE: replay");
  });

  it("stays manually dispatched so macOS billing is an explicit decision", () => {
    const workflow = readFileSync(workflowPath, "utf-8");

    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}push:/m);
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
  });

  it("pins every action to a full commit SHA", () => {
    const workflow = readFileSync(workflowPath, "utf-8");
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    for (const spec of uses) expect(spec).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe.skipIf(process.platform === "win32")("desktop E2E container upstream provider env", () => {
  it("ci 预设把默认 smoke 与已验证的会话 spec 合成一份清单", () => {
    const result = runContainerScriptWithFakeDocker({ E2E_SPEC_PRESET: "ci" });

    expect(result.status).toBe(0);
    expect(result.runArgs).toContain("NIBI_E2E_SPEC=./test/e2e/container-boot.test.ts");
    expect(result.runArgs).toContain(
      "conversation-session-ask-user-question-keyboard-default-focus.test.ts",
    );
  });

  it("capture 模式把上游地址、模型与 preset 透传给容器", () => {
    const result = runContainerScriptWithFakeDocker({
      E2E_NETWORK_MODE: "capture",
      E2E_PROVIDER_API_KEY: "test-key",
      E2E_PROVIDER_BASE_URL: "https://upstream.example/v1",
      E2E_PROVIDER_MODEL: "model-a",
      E2E_PROVIDER_SECONDARY_MODEL: "model-b",
      E2E_PROVIDER_PRESET: "env",
    });

    expect(result.status).toBe(0);
    expect(result.runArgs).toContain("E2E_PROVIDER_HTTP_MODE=capture");
    expect(result.runArgs).toContain("E2E_PROVIDER_BASE_URL=https://upstream.example/v1");
    expect(result.runArgs).toContain("E2E_PROVIDER_MODEL=model-a");
    expect(result.runArgs).toContain("E2E_PROVIDER_SECONDARY_MODEL=model-b");
    expect(result.runArgs).toContain("E2E_PROVIDER_PRESET=env");
  });

  it("capture 模式缺少上游地址时在启动容器前失败", () => {
    const result = runContainerScriptWithFakeDocker({
      E2E_NETWORK_MODE: "capture",
      E2E_PROVIDER_API_KEY: "test-key",
      E2E_PROVIDER_BASE_URL: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires E2E_PROVIDER_BASE_URL");
    expect(result.runArgs).toBe("");
  });
});
