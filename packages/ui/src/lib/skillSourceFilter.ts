import type { NibiProvider } from "@nibi/shared";

type SkillSourceType = "nibi-agent" | "unknown";

export function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.nibi/skills/")) {
    return "nibi-agent";
  }
  if (normalized.includes("/.nibi/cli/plugins/cache/")) {
    return "nibi-agent";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^(?:glm|nibi-agent):/;

function isNibiSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.nibi/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "nibi-agent"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: NibiProvider,
): T[] {
  return skills.filter(isNibiSkill);
}
