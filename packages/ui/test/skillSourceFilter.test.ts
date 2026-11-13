import { describe, expect, it } from "vitest";
import { filterSkillsForProvider, resolveSkillSourceType } from "@/lib/skillSourceFilter.js";

const demoSkills = [
  {
    id: "skill-claude",
    path: "/tmp/workspace/.claude/skills/claude-only/SKILL.md",
  },
  {
    id: "skill-agents",
    path: "/tmp/workspace/.agents/skills/agents-only/SKILL.md",
  },
  {
    id: "skill-glm-deprecated",
    path: "/tmp/workspace/.nibi/cli/skills/glm-only/SKILL.md",
  },
  {
    id: "skill-glm-by-path",
    path: "/tmp/workspace/.nibi/skills/glm-only/SKILL.md",
  },
  {
    id: "nibi-agent:workspace:nibi-common:abc123",
    path: "/tmp/workspace/.nibi/skills/common/SKILL.md",
  },
  {
    id: "claude:workspace:nibi-common:abc123",
    path: "/tmp/workspace/.nibi/skills/common-from-legacy-list/SKILL.md",
  },
  {
    id: "nibi-agent:user:mirrored:abc123",
    path: "/tmp/workspace/.agents/skills/mirrored/SKILL.md",
  },
  {
    id: "skill-plugin-by-scope",
    path: "/tmp/home/.nibi/cli/plugins/cache/nibi-official/document-skills/0.1.0/skills/pdf/SKILL.md",
    scope: "plugin",
  },
  {
    id: "skill-plugin-by-path",
    path: "/tmp/home/.nibi/cli/plugins/cache/nibi-official/document-skills/0.1.0/skills/docx/SKILL.md",
  },
];

describe("skillSourceFilter", () => {
  it("把 .zcode/skills 和官方 plugin cache 识别为 Nibi Agent 技能来源", () => {
    expect(resolveSkillSourceType("/tmp/workspace/.nibi/skills/my-skill/SKILL.md")).toBe("nibi-agent");
    expect(
      resolveSkillSourceType(
        "/tmp/home/.nibi/cli/plugins/cache/nibi-official/document-skills/0.1.0/skills/pdf/SKILL.md",
      ),
    ).toBe("nibi-agent");
    expect(resolveSkillSourceType("/tmp/workspace/.nibi/cli/skills/my-skill/SKILL.md")).toBe(
      "unknown",
    );
    expect(resolveSkillSourceType("/tmp/workspace/.agents/skills/my-skill/SKILL.md")).toBe(
      "unknown",
    );
  });

  it("过滤混合来源时保留 Nibi Agent 技能", () => {
    const expectedIds = [
      "skill-glm-by-path",
      "nibi-agent:workspace:nibi-common:abc123",
      "claude:workspace:nibi-common:abc123",
      "nibi-agent:user:mirrored:abc123",
      "skill-plugin-by-scope",
      "skill-plugin-by-path",
    ];

    expect(filterSkillsForProvider(demoSkills, "nibi-agent").map((skill) => skill.id)).toEqual(
      expectedIds,
    );
  });
});
