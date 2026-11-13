import { describe, expect, it } from "vitest";
import {
  NIBI_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  NIBI_REMOTE_HTTP_PROXY_ENV_KEY,
  NIBI_REMOTE_NO_PROXY_ENV_KEY,
  NIBI_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  buildNibiToolEnvPassthroughEnv,
  getCapturedNibiCuaBrokerCredentials,
  isCuaDevModeRequested,
  isNibiCuaInternalFeatureEnabled,
  readNibiAgentTelemetryEnv,
  readNibiToolEnvPassthroughEnv,
  resetCapturedNibiCuaBrokerCredentialsForTest,
  sanitizeNibiRuntimeEnv,
  getCapturedNibiAgentTelemetryEnv,
  resetCapturedNibiAgentTelemetryEnvForTest,
} from "../src/runtimeEnv.js";

describe("runtimeEnv", () => {
  it("enables internal CUA by default while honoring explicit false values", () => {
    expect(isNibiCuaInternalFeatureEnabled({})).toBe(true);
    expect(isNibiCuaInternalFeatureEnabled({ NIBI_CUA_PRODUCT_HELPER: "0" })).toBe(false);
    expect(isNibiCuaInternalFeatureEnabled({ NIBI_CUA_PRODUCT_HELPER: "false" })).toBe(false);
    expect(isNibiCuaInternalFeatureEnabled({ NIBI_CUA_PRODUCT_HELPER: "1" })).toBe(true);
    expect(isNibiCuaInternalFeatureEnabled({ NIBI_CUA_PRODUCT_HELPER: " TRUE " })).toBe(true);
    expect(isNibiCuaInternalFeatureEnabled({ NIBI_CUA_PRODUCT_HELPER: "on" })).toBe(true);
  });

  it("parses explicit truthy values for NIBI_CUA_DEV_MODE", () => {
    // isCuaDevModeRequested: only explicit truthy values (case-insensitive, trimmed).
    expect(isCuaDevModeRequested({})).toBe(false);
    expect(isCuaDevModeRequested({ NIBI_CUA_DEV_MODE: "0" })).toBe(false);
    expect(isCuaDevModeRequested({ NIBI_CUA_DEV_MODE: "false" })).toBe(false);
    expect(isCuaDevModeRequested({ NIBI_CUA_DEV_MODE: "1" })).toBe(true);
    expect(isCuaDevModeRequested({ NIBI_CUA_DEV_MODE: " ON " })).toBe(true);
    expect(isCuaDevModeRequested({ NIBI_CUA_DEV_MODE: "true" })).toBe(true);
  });

  it("sanitizes runtime env while sealing user network env for tools", () => {
    const sourceEnv = {
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_ENV: "development",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      PATH: "/usr/bin:/bin",
      npm_config_proxy: "http://npm-proxy.example:8080",
    };

    const sanitized = sanitizeNibiRuntimeEnv(sourceEnv);
    const passthroughEnv = buildNibiToolEnvPassthroughEnv(sourceEnv);
    const captured = readNibiToolEnvPassthroughEnv(passthroughEnv);

    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });
    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      npm_config_proxy: "http://npm-proxy.example:8080",
    });
  });

  it("ignores invalid passthrough JSON and non-network keys", () => {
    const captured = readNibiToolEnvPassthroughEnv({
      [NIBI_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
        HTTP_PROXY: "http://proxy.example:8080",
        NODE_ENV: "production",
        PATH: "/tmp/bin",
      }),
    });

    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
    });
    expect(
      readNibiToolEnvPassthroughEnv({
        [NIBI_TOOL_ENV_PASSTHROUGH_ENV_KEY]: "not-json",
      }),
    ).toEqual({});
  });

  it("strips the CUA broker socket/authority/refresh marker from child env and tool passthrough", () => {
    // Confused-deputy 防护：broker bearer 凭据只该定向注入目标 zcode-cua server，绝不能随全局 env
    // 泄漏给其它 MCP / Bash / tool 子进程，也不能经 tool-env-passthrough 恢复。
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      NIBI_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-me/broker-abc.sock",
      NIBI_CUA_PERMISSION_BROKER_REFRESH_MARKER:
        "/tmp/zcode-cua-me/broker-abc.sock.permission-refresh.json",
    };
    const sanitized = sanitizeNibiRuntimeEnv(sourceEnv);
    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });

    const captured = readNibiToolEnvPassthroughEnv(buildNibiToolEnvPassthroughEnv(sourceEnv));
    expect(captured).not.toHaveProperty("NIBI_CUA_PERMISSION_BROKER_SOCKET");
    expect(captured).not.toHaveProperty("NIBI_CUA_PERMISSION_BROKER_REFRESH_MARKER");
  });

  it("strips desktop-to-remote network handoff values after stdio bootstrap", () => {
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      [NIBI_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
      [NIBI_REMOTE_HTTP_PROXY_ENV_KEY]: "http://172.21.240.1:7890",
      [NIBI_REMOTE_NO_PROXY_ENV_KEY]: "localhost,127.0.0.1",
    };

    expect(sanitizeNibiRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(readNibiToolEnvPassthroughEnv(buildNibiToolEnvPassthroughEnv(sourceEnv))).toEqual({});
  });

  it("captures broker credentials as one atomic pair and clears stale state on partial rotation", () => {
    resetCapturedNibiCuaBrokerCredentialsForTest();
    try {
      sanitizeNibiRuntimeEnv({
        NIBI_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-a.sock",
        NIBI_CUA_PLUGIN_AUTHORITY: "authority-a",
      });
      expect(getCapturedNibiCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-a.sock",
        pluginAuthority: "authority-a",
      });

      sanitizeNibiRuntimeEnv({
        NIBI_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
      });
      expect(getCapturedNibiCuaBrokerCredentials()).toEqual({
        socket: undefined,
        pluginAuthority: undefined,
      });

      sanitizeNibiRuntimeEnv({
        NIBI_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
        NIBI_CUA_PLUGIN_AUTHORITY: "authority-b",
      });
      expect(getCapturedNibiCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-b.sock",
        pluginAuthority: "authority-b",
      });
    } finally {
      resetCapturedNibiCuaBrokerCredentialsForTest();
    }
  });

  it("captures Agent OTLP config privately and never passes auth or identity through to tools", () => {
    resetCapturedNibiAgentTelemetryEnvForTest();
    const sourceEnv = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      PATH: "/usr/bin:/bin",
      NIBI_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    };
    expect(sanitizeNibiRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(getCapturedNibiAgentTelemetryEnv()).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      NIBI_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    });
    const toolEnv = readNibiToolEnvPassthroughEnv(buildNibiToolEnvPassthroughEnv(sourceEnv));
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_METRICS_HEADERS");
    expect(toolEnv).not.toHaveProperty("NIBI_TELEMETRY_USER_SUBJECT_ID");
  });

  it("extracts only the allowlisted Agent telemetry env", () => {
    expect(
      readNibiAgentTelemetryEnv({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: " https://arms.example.com/v1/traces ",
        OTEL_UNKNOWN_SECRET: "must-not-pass",
        PATH: "/bin",
        NIBI_MODEL_TELEMETRY_ENABLED: "1",
        NIBI_TELEMETRY_RUNTIME_DISTRIBUTION: " packaged ",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      NIBI_MODEL_TELEMETRY_ENABLED: "1",
      NIBI_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });
});
