import { describe, expect, it } from "vitest";
import {
  NIBI_COMPATIBILITY_MANIFEST,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  normalizeRemoteConnectionError,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
} from "@nibi/shared";
import type { SourceServerContract } from "./contract.js";

describe("source-server 公开边界", () => {
  it("实现与契约逐项对齐", () => {
    const contract: SourceServerContract = {
      manifest: NIBI_COMPATIBILITY_MANIFEST,
      compareVersions: compareCompatibilityVersions,
      evaluateCompatibility: evaluateSourceServerCompatibility,
      normalizeFailure: normalizeRemoteConnectionError,
      sanitizeLog: sanitizeRemoteConnectionLog,
      failureLogLevel: remoteConnectionFailureLogLevel,
    };
    expect(contract.manifest.productVersion).toBeTruthy();
  });

  it("同一版本判为互通，不提示升级", () => {
    const result = evaluateSourceServerCompatibility(
      NIBI_COMPATIBILITY_MANIFEST,
      NIBI_COMPATIBILITY_MANIFEST,
    );
    expect(result).toMatchObject({ compatible: true, updateAvailable: false, newerEndpoint: "equal" });
    expect(compareCompatibilityVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareCompatibilityVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("系统错误码归一到稳定 code（ECONNRESET 不能被当成预检失败）", () => {
    expect(normalizeRemoteConnectionError({ code: "ECONNRESET", message: "socket hang up" })).toMatchObject({
      code: "remote-host-unreachable",
    });
    expect(normalizeRemoteConnectionError({ code: "ETIMEDOUT", message: "timeout" })).toMatchObject({
      code: "remote-connection-timeout",
    });
  });

  it("用户可见日志抹掉凭据与 ANSI 控制序列", () => {
    const line = sanitizeRemoteConnectionLog(
      "connect user=root token=abc123 \u001b[31mred\u001b[0m /home/root/.nibi",
      ["abc123"],
    );
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("/home/root");
  });

  it("取消与未安装属正常流程，其余失败记 error", () => {
    expect(remoteConnectionFailureLogLevel("remote-connection-canceled")).toBe("info");
    expect(remoteConnectionFailureLogLevel("source-server-install-required")).toBe("info");
    expect(remoteConnectionFailureLogLevel("remote-install-failed")).toBe("error");
  });
});
