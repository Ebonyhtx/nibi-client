import { createHash } from "node:crypto";
import { basename, posix, resolve } from "node:path";

import { joinPathLikeRoot } from "./directory.js";

interface ProjectMemoryRootInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\");
}

export function resolveProjectMemoryRoot(input: ProjectMemoryRootInput): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  // 工作区可能是 POSIX 形状（远程/WSL/测试注入）：按宿主 resolve 会把 /workspace
  // 拼到当前盘符上，根与预期路径（以及按字符串索引的端口）随之错位。
  const normalizedWorkspacePath = isPosixAbsolutePath(input.workspacePath)
    ? posix.normalize(input.workspacePath)
    : resolve(input.workspacePath);
  const keySource =
    workspaceIdentity ||
    (process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = workspaceIdentity
    ? "project"
    : sanitizeProjectSlug(basename(normalizedWorkspacePath) || "project");

  return joinPathLikeRoot(input.cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
