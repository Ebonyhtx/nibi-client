import { formatJson } from "@nibi/core";
import type { GlobalOptions, RunContext } from "@nibi/shared-types";
import type { NibiDeviceAuthorization } from "@nibi/adapters";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

/**
 * `nibi login`：登录 NIBI 账号（Device Authorization Grant）。
 *
 * 分家后的 CLI 只认 NIBI 账号中心：会员身份、付费插件授权、插件市场购买都靠它。
 * 上游的 `zai|bigmodel` Coding Plan 入口属于另一家生态的套餐，SF 后端也从未在我们的
 * API 上存在过（`/oauth/cli/init`），留着只会让用户拿着一个必然 404 的登录命令。
 */
export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    if (args.length > 0) {
      throw new Error("Usage: nibi login [--no-browser]");
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const login = deps.loginNibiAccount ?? (await loadBootstrapModule()).loginNibiAccount;
    const result = await login({
      env,
      noBrowser,
      onDeviceCode: (data) => {
        writeDeviceCode(ctx, options, data, noBrowser);
      },
      onBrowserOpen: (browser) => {
        if (!options.json && !browser.opened) {
          ctx.stderr.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
        }
      },
    });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          account: {
            user_id: result.user.id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatarUrl ? { avatar: result.user.avatarUrl } : {}),
          },
          apiBaseUrl: result.apiBaseUrl,
          credentialsPath: result.credentialsPath,
          licenseExpiresAt: result.licenseExpiresAt ?? null,
          membership: result.membership
            ? {
                expiresAt: result.membership.expiresAt ?? null,
                plan: result.membership.plan ?? null,
                status: result.membership.status,
              }
            : null,
          status: "signed_in",
          warnings: result.warnings,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Signed in to NIBI${formatUserLabel(result.user)}.`,
        formatMembership(result.membership, result.licenseExpiresAt ?? null),
        `Credentials: ${result.credentialsPath}`,
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutNibiAccount ?? (await loadBootstrapModule()).logoutNibiAccount;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          clearedKeys: result.clearedKeys,
          credentialsPath: result.credentialsPath,
          status: "signed_out",
        }),
      );
      return 0;
    }

    ctx.stdout.write(`Signed out of NIBI. Credentials: ${result.credentialsPath}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function writeDeviceCode(
  ctx: RunContext,
  options: GlobalOptions,
  data: NibiDeviceAuthorization,
  noBrowser: boolean,
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  const url = data.verificationUriComplete ?? data.verificationUri;
  if (noBrowser) {
    target.write(
      [
        "To sign in to NIBI, open this URL in a browser and enter the code:",
        url,
        `Code: ${data.userCode}`,
        "",
      ].join("\n"),
    );
    return;
  }
  target.write(
    [
      "Opening the browser for NIBI sign-in. If it does not open, use this URL:",
      url,
      `Code: ${data.userCode}`,
      "",
    ].join("\n"),
  );
}

function formatMembership(
  membership:
    | { status: "active" | "expired" | "none" | "unknown"; plan?: string | null; expiresAt?: string | null }
    | null,
  licenseExpiresAt: string | null,
): string {
  if (!membership) {
    return "Membership: unknown (will retry on the next login or desktop launch)";
  }
  if (membership.status !== "active") {
    return membership.status === "expired"
      ? "Membership: expired (member-only plugins stay locked)"
      : "Membership: none (member-only plugins stay locked)";
  }
  const plan = membership.plan ?? "member";
  const expiresAt = membership.expiresAt ?? licenseExpiresAt;
  return `Membership: ${plan}${expiresAt ? ` (active until ${formatDate(expiresAt)})` : ""}`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

function formatUserLabel(user: { email?: string; name?: string; id: string }): string {
  const label = user.name || user.email || user.id;
  if (!label) return "";
  return user.name && user.email ? ` as ${label} <${user.email}>` : ` as ${label}`;
}
