export const CODING_PLAN_TEAM_MOCK_BASE_URL_ENV = "NIBI_CODING_PLAN_TEAM_MOCK_BASE_URL";
export const CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV = "NIBI_CODING_PLAN_UPGRADE_MOCK_BASE_URL";

type MutableEnvironment = Record<string, string | undefined>;

const CODING_PLAN_COMMON_ENV_KEYS = [
  "NIBI_BASE_URL",
  "NIBI_ENDPOINT_ORIGIN",
  "NIBI_TEST_BASE_URL",
  "BIGMODEL_API_BASE_URL",
  "NIBI_E2E_CODING_PLAN_MOCK_URL",
] as const;

// 正式 CI 在 launcher 阶段传入未展开的目录 glob；遗漏它会让 worker 缺少预启动的 mock。
const CODING_PLAN_TEAM_SUITE_GLOBS = [
  "test/e2e/**/*.test.ts",
  "test/e2e/conversation-session/*.test.ts",
];
const CODING_PLAN_TEAM_SPEC_MARKERS = [
  "conversation-session-toolsearch",
  "conversation-session-tool-discovery-card.test.ts",
  // 远程导航验收不依赖线上公告；隔离账号控制面，避免营销弹窗遮挡连接交互。
  "conversation-session-rpn-project-navigation.test.ts",
  "conversation-session-ssh-disconnect-experience.test.ts",
  "conversation-session-ssh-remote-cold-reconnect.test.ts",
  "conversation-session-r3-mixed-entries.test.ts",
  "conversation-session-r3-mobile.test.ts",
  // 模拟登录态访问线上账号接口会触发 401 弹窗，遮挡 Logo 的真实 hover 和截图。
  "settings-ui-polish.test.ts",
  "side-pane-tabs-responsive-interactions.test.ts",
  "conversation-session-share-tool-presentation.test.ts",
  // 分享浮窗仅测 Desktop 交互，账号与套餐旁路请求必须留在本地。
  "conversation-session-share-popover.test.ts",
  "conversation-session-start-plan-independent.test.ts",
  // 创建埋点回归复用本地账号控制面，避免初始化/发送访问真实套餐与登录服务。
  "conversation-session-create-telemetry.test.ts",
  "conversation-session-automation-run-title-stable.test.ts",
  "coding-plan-team-usage.test.ts",
  "coding-plan-entitlement-presentation.test.ts",
  "provider-family-responsive.test.ts",
  "provider-builtin-refresh-failure.test.ts",
  // Bugfix：登录后刷新子代理 catalog 的 case 与套餐用量 case 共用 team mock。
  // 抽取 spec 判定时必须保留该入口，否则单跑时 worker 会在业务断言前缺少 mock。
  "subagent-coding-plan-login-catalog-stale.test.ts",
  "conversation-session-model-provider-restart-recovery.test.ts",
  "conversation-session-model-provider-settings-transition.test.ts",
  "conversation-session-model-provider-effective-selection.test.ts",
  "conversation-session-worker-effective-selection.test.ts",
  "conversation-session-model-provider-turbo-recovery.test.ts",
  "conversation-session-model-provider-turbo-switch.test.ts",
  "conversation-session-model-provider-plan-surface.test.ts",
  // Bug 原因：连续切模回放也播种了模拟登录态；未隔离控制面时，线上 401
  // 会触发登录过期弹窗，遮住第二轮的模型菜单，导致与切模无关的失败。
  "conversation-session-active-model-context.test.ts",
] as const;

export function shouldPrepareCodingPlanTeamMock(specs: readonly string[]) {
  return specs.some((spec) => {
    const normalized = spec.replaceAll("\\", "/").replace(/^\.\//u, "");
    return (
      CODING_PLAN_TEAM_SUITE_GLOBS.includes(normalized) ||
      CODING_PLAN_TEAM_SPEC_MARKERS.some((marker) => normalized.includes(marker))
    );
  });
}

export function applyCodingPlanTeamMockEnv(environment: MutableEnvironment, baseUrl: string) {
  environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV] = baseUrl;
  environment.NIBI_ENV = "test";
  for (const key of CODING_PLAN_COMMON_ENV_KEYS) {
    environment[key] = baseUrl;
  }
  environment.NIBI_BIGMODEL_USAGE_QUOTA_URL = `${baseUrl}/api/monitor/usage/quota/limit`;
  environment.BIGMODEL_USAGE_QUOTA_URL = `${baseUrl}/api/monitor/usage/quota/limit`;
}

export function clearCodingPlanTeamMockEnv(environment: MutableEnvironment, baseUrl: string) {
  clearOwnedEnvironmentValues(environment, baseUrl, [
    ...CODING_PLAN_COMMON_ENV_KEYS,
    "NIBI_BIGMODEL_USAGE_QUOTA_URL",
    "BIGMODEL_USAGE_QUOTA_URL",
  ]);
  if (environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV] === baseUrl) {
    delete environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  }
}

export function applyCodingPlanUpgradeMockEnv(environment: MutableEnvironment, baseUrl: string) {
  environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] = baseUrl;
  for (const key of CODING_PLAN_COMMON_ENV_KEYS) {
    environment[key] = baseUrl;
  }
  environment.BIGMODEL_TEST_API_BASE_URL = baseUrl;
  environment.VITE_CODING_PLAN_WEBVIEW_ORIGIN = baseUrl;
  environment.ZAI_BUSINESS_BASE_URL = baseUrl;
}

export function shouldReuseDesktopE2EBuild(environment: MutableEnvironment): boolean {
  // 子 shard 的动态端口晚于父构建；构建决策和源码证据必须共用这个判据。
  return (
    environment.NIBI_E2E_SKIP_BUILD === "1" &&
    !environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim()
  );
}

export function clearCodingPlanUpgradeMockEnv(environment: MutableEnvironment, baseUrl: string) {
  clearOwnedEnvironmentValues(environment, baseUrl, [
    ...CODING_PLAN_COMMON_ENV_KEYS,
    "BIGMODEL_TEST_API_BASE_URL",
    "VITE_CODING_PLAN_WEBVIEW_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
  ]);
  if (environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] === baseUrl) {
    delete environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV];
  }
}

function clearOwnedEnvironmentValues(
  environment: MutableEnvironment,
  baseUrl: string,
  keys: readonly string[],
) {
  const ownedValues = new Set([baseUrl, `${baseUrl}/api/monitor/usage/quota/limit`]);
  for (const key of keys) {
    if (ownedValues.has(environment[key] ?? "")) {
      delete environment[key];
    }
  }
}
