// 登录返回的用户资料归一化。
//
// 上游把 userinfo 放在不同形状里（{id,username,displayName} / {user_id,name,email,avatar}），
// 两个 provider 都要用；放在中性模块，避免 NIBI provider 依赖上游 provider。
import type { UserInfo } from "@nibi/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeBackendAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length >= 16) {
    return `data:image/png;base64,${trimmed}`;
  }

  return trimmed;
}

export function toUserInfo(user: unknown): UserInfo | null {
  if (!isRecord(user)) {
    return null;
  }

  if (
    typeof user.id === "string" &&
    typeof user.username === "string" &&
    typeof user.displayName === "string"
  ) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      ...(typeof user.avatarUrl === "string" ? { avatarUrl: user.avatarUrl } : {}),
    };
  }

  const id = typeof user.user_id === "string" ? user.user_id : "unknown";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const username = name || email || id;
  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(normalizeBackendAvatarUrl(user.avatar)
      ? { avatarUrl: normalizeBackendAvatarUrl(user.avatar) }
      : {}),
  };
}
