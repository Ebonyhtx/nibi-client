import childProcess, { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEncodedPowerShellArgs,
  createWindowsPowerShellSecurityArgs,
  escapePowerShellLiteral,
  readWindowsAuthenticodeSignature,
  verifyWindowsAuthenticodeSignature,
} from "../scripts/powershell-command.mjs";

function decodeCommand(args: string[]): string {
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(args).toHaveLength(5);
  return Buffer.from(args[4]!, "base64").toString("utf16le");
}

function extractSignatureOutputPath(command: string): string {
  const encodedPath = command.match(
    /\$nibiSignatureOutput='((?:[^'\u2018\u2019\u201A\u201B]|(['\u2018\u2019\u201A\u201B])\2)*)';/,
  )?.[1];
  expect(encodedPath).toBeDefined();
  return encodedPath!.replace(/(['\u2018\u2019\u201A\u201B])\1/g, "$1");
}

describe("powershell-command", () => {
  it("把动态值编码进脚本且不再依赖普通 -Command 的尾随参数", () => {
    const values = ["C:\\Program Files\\NIBI'Code;测试\\helper.exe", "value with spaces & symbols"];
    const args = createEncodedPowerShellArgs(
      "[Console]::Out.Write($nibiArg0 + '|' + $nibiArg1)",
      values,
    );

    const command = decodeCommand(args);
    expect(command).not.toContain("$args");
    expect(command).not.toContain("[Console]::OutputEncoding");
    for (const [index, value] of values.entries()) {
      expect(command).not.toContain(value);
      expect(command).toContain(`$nibiArg${index}=`);
      expect(command).toContain(Buffer.from(value, "utf8").toString("base64"));
    }
  });

  it("从 PSHOME 显式加载 Windows PowerShell Security 模块", () => {
    const command = decodeCommand(
      createWindowsPowerShellSecurityArgs("[Console]::Out.Write('loaded')"),
    );

    expect(command).toContain(
      "[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security'",
    );
    expect(command).toContain("Import-Module -Name $nibiSecurityModule -Force -ErrorAction Stop");
    expect(command).toContain("Windows PowerShell Security module load failed");
    expect(command).toContain("exit 26");
    expect(command).not.toContain("$env:PSModulePath");
    expect(command).toContain("$ProgressPreference='SilentlyContinue';");
    expect(command.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      command.indexOf("Import-Module"),
    );
  });

  it.each([
    ["a'b", "'a''b'"],
    ["C:\\Program Files\\NIBI'Code\\helper.exe", "'C:\\Program Files\\NIBI''Code\\helper.exe'"],
    ["a‘b", "'a‘‘b'"],
    ["a’b", "'a’’b'"],
    ["a‚b", "'a‚‚b'"],
    ["a‛b", "'a‛‛b'"],
  ])("PowerShell 路径字面量安全转义 %j", (value, expected) => {
    expect(escapePowerShellLiteral(value)).toBe(expected);
  });

  it.each(["a\u0000b", "a\nb", "a\rb"])("拒绝 PowerShell 路径控制符 %j", (value) => {
    expect(() => escapePowerShellLiteral(value)).toThrow("NUL or newline");
  });

  // stdout 不再钉 UTF-8（受限语言模式禁 [Console]::OutputEncoding）：stdout 只承载
  // ASCII（base64/布尔），非 ASCII 走 UTF-8 BOM 文件通道（见 readWindowsAuthenticodeSignature）。
  it.runIf(process.platform === "win32")(
    "Windows PowerShell 能还原带空格和脚本元字符的 ASCII 动态值",
    () => {
      const values = ["C:\\Program Files\\NIBI'Code;spaces\\helper.exe", "value with spaces & symbols"];
      const output = execFileSync(
        "powershell.exe",
        createEncodedPowerShellArgs(
          "[Console]::Out.Write($nibiArg0 + [Environment]::NewLine + $nibiArg1)",
          values,
        ),
        { encoding: "utf8" },
      );

      expect(output.split(/\r?\n/)).toEqual(values);
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 经 UTF-8 BOM 文件还原非 ASCII 动态值",
    async () => {
      const values = ["C:\\Program Files\\NIBI'Code;测试\\helper.exe", "value with spaces & symbols"];
      const dir = await mkdtemp(join(tmpdir(), "nibi-ps-utf8-"));
      try {
        const outputPath = join(dir, "values.json");
        const script = [
          `$nibiSignatureOutput=${escapePowerShellLiteral(outputPath)};`,
          "@($nibiArg0,$nibiArg1)|ConvertTo-Json -Compress|Out-File -LiteralPath $nibiSignatureOutput -Encoding utf8 -NoNewline;",
        ].join("");
        execFileSync("powershell.exe", createEncodedPowerShellArgs(script, values), {
          encoding: "utf8",
        });

        const raw = await readFile(outputPath, "utf8");
        expect(JSON.parse(raw.replace(/^\uFEFF/u, "").trim())).toEqual(values);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 在 PSModulePath 被污染时仍加载系统 Security 模块",
    () => {
      const output = execFileSync(
        "powershell.exe",
        createWindowsPowerShellSecurityArgs(
          [
            "$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $nibiArg0;",
            "[Console]::Out.Write($null -ne $signature)",
          ].join(""),
          [process.execPath],
        ),
        {
          encoding: "utf8",
          env: { ...process.env, PSModulePath: "Z:\\nibi-invalid-psmodulepath" },
        },
      );

      expect(output).toBe("True");
    },
  );
});

// 工程适配器回归：只替换系统进程，仍执行真实临时文件读取与清理。
function mockSignatureQuery(
  result: unknown,
  options: { stderr?: string; error?: Error; output?: string } = {},
) {
  return vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
    const command = decodeCommand(args[1] as string[]);
    const output = extractSignatureOutputPath(command);
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    if (options.error) {
      callback(options.error, "", "");
    } else if (output && options.output !== "missing") {
      void writeFile(output, options.output ?? `\uFEFF${JSON.stringify(result)}`, "utf8").then(
        () => callback(null, "", options.stderr ?? ""),
        (error) => callback(error, "", ""),
      );
    } else {
      callback(null, "", options.stderr ?? "");
    }
    return {} as childProcess.ChildProcess;
  });
}

describe("Windows Authenticode 有效性校验", () => {
  it.runIf(process.platform === "win32")(
    "原生签名查询不会把首次模块加载进度误判为错误",
    async () => {
      const file = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      expect(await verifyWindowsAuthenticodeSignature(file)).toBeNull();
    },
  );

  it.each(["CN=Original Publisher, O=Original, C=US", "CN=换发证书, O=测试公司, C=CN"])(
    "有效签名不受发布者 DN 限制：%s",
    async (subject) => {
      const spy = mockSignatureQuery({ status: 0, subject });
      try {
        expect(
          await verifyWindowsAuthenticodeSignature("C:\\Program Files\\Example';&.exe"),
        ).toBeNull();
        const command = decodeCommand(spy.mock.calls[0]![1] as string[]);
        expect(command).toContain(
          "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $nibiSignaturePath",
        );
        expect(command).toContain("Example'';&.exe");
        expect(command).toContain("exit 27");
        expect(command).not.toMatch(/\[(?:Console|Convert|Text\.|IO\.)/);
        await expect(readFile(extractSignatureOutputPath(command))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("解析 Windows PowerShell 5.1 写出的 UTF-8 BOM JSON", async () => {
    const spy = mockSignatureQuery(undefined, {
      output: '\uFEFF{"status":0,"subject":"CN=测试签名"}',
    });
    try {
      expect(await readWindowsAuthenticodeSignature("C:\\example.exe")).toEqual({
        status: 0,
        subject: "CN=测试签名",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { status: 2, subject: "CN=Unsigned" },
    { status: 1, subject: "CN=Tampered" },
    { status: 0, subject: "" },
    { status: "0", subject: "CN=Malformed" },
  ])("拒绝无效签名或畸形结果：%j", async (result) => {
    const spy = mockSignatureQuery(result);
    try {
      expect(await verifyWindowsAuthenticodeSignature("C:\\example.exe")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { error: new Error("PowerShell unavailable") },
    { error: Object.assign(new Error("PowerShell timed out"), { killed: true }) },
    { stderr: "actual module error" },
    { output: "missing" },
    { output: "not JSON" },
  ])("系统查询、超时或输出失败不放行：%j", async (options) => {
    const spy = mockSignatureQuery({ status: 0, subject: "CN=Example" }, options);
    try {
      await expect(verifyWindowsAuthenticodeSignature("C:\\example.exe")).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(process.platform === "win32")(
    "查询失败时以 exit 27 退出",
    async () => {
      const missing = join(tmpdir(), `nibi-missing-${Date.now()}-'‘’‚‛.exe`);
      await expect(readWindowsAuthenticodeSignature(missing)).rejects.toMatchObject({ code: 27 });
    },
    30_000,
  );

  it.runIf(process.platform === "win32").each(["FullLanguage", "ConstrainedLanguage"])(
    "%s 下真实查询保留安全边界和特殊字符路径",
    async (mode) => {
      const original = childProcess.execFile;
      const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
        const command = decodeCommand(args[1] as string[]);
        const encoded = Buffer.from(
          `$ExecutionContext.SessionState.LanguageMode='${mode}';${command}`,
          "utf16le",
        ).toString("base64");
        return Reflect.apply(original, childProcess, [
          args[0],
          [...(args[1] as string[]).slice(0, -1), encoded],
          { ...(args[2] as object), env: { ...process.env, PSModulePath: "Z:\\invalid-modules" } },
          args[3],
        ]);
      });
      const unicodeTemp = await mkdtemp(join(tmpdir(), "signature-temp-‘’‚‛-"));
      const root = await mkdtemp(join(unicodeTemp, "signature-测试'‘’‚‛-"));
      const originalTemp = process.env.TEMP;
      const originalTmp = process.env.TMP;
      try {
        process.env.TEMP = unicodeTemp;
        process.env.TMP = unicodeTemp;
        const unsigned = join(root, "unsigned'‘’‚‛;&.exe");
        await writeFile(unsigned, "not a signed executable");
        expect(await verifyWindowsAuthenticodeSignature(unsigned)).not.toBeNull();
        const signed = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const signedCopy = join(root, "signed'‘’‚‛;&.exe");
        await copyFile(signed, signedCopy);
        expect(await verifyWindowsAuthenticodeSignature(signedCopy)).toBeNull();
        expect(await verifyWindowsAuthenticodeSignature(signed)).toBeNull();
      } finally {
        spy.mockRestore();
        if (originalTemp === undefined) delete process.env.TEMP;
        else process.env.TEMP = originalTemp;
        if (originalTmp === undefined) delete process.env.TMP;
        else process.env.TMP = originalTmp;
        await rm(unicodeTemp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});