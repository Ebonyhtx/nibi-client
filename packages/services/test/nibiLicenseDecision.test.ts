import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NIBI_LICENSE_CHECK_INTERVAL_MS,
  NIBI_LICENSE_OFFLINE_GRACE_MS,
  evaluateNibiLicense,
  licenseCoversPlugin,
  type NibiLicenseSnapshot,
} from "../src/license/nibiLicense.js";

/** 真实生成一对 Ed25519 密钥并签发 token——不 mock 验签，验的是同一份代码路径。 */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = "test-kid";
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeys = { [kid]: pem };

  const signToken = (claims: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg: "Ed25519", kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = edSign(null, Buffer.from(`${header}.${payload}`, "utf8"), privateKey);
    return `${header}.${payload}.${signature.toString("base64url")}`;
  };

  return { publicKeys, signToken };
}

const NOW = Date.parse("2026-10-21T00:00:00.000Z");
const DAY = 86_400_000;

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "nibi-license",
    sub: "user-1",
    uid: "user-1",
    plan: "pro",
    plugins: ["*"],
    dev: "dev-1",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor((NOW + 30 * DAY) / 1000),
    jti: "jti-1",
    ...overrides,
  };
}

/** 距离上次成功检查已经过了多久的快照。 */
function snapshotCheckedAgo(ms: number): NibiLicenseSnapshot {
  return {
    deviceId: "dev-1",
    lastCheckAt: new Date(NOW - ms).toISOString(),
    lastRefusal: null,
  };
}

describe("evaluateNibiLicense 判定表", () => {
  const { publicKeys, signToken } = makeSigner();

  it("没有 token → not_activated", () => {
    const d = evaluateNibiLicense({ token: null, snapshot: null, now: NOW, publicKeys });
    expect(d.status).toBe("not_activated");
    expect(d.allowed).toBe(false);
  });

  it("验签失败（篡改 payload）→ denied", () => {
    const token = signToken(baseClaims());
    const [h, , s] = token.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify(baseClaims({ exp: 9e9 }))).toString("base64url")}.${s}`;
    const d = evaluateNibiLicense({ token: tampered, snapshot: null, now: NOW, publicKeys });
    expect(d.status).toBe("denied");
    expect(d.allowed).toBe(false);
  });

  it("签发方不是 nibi-license → denied（防止拿别家 token 冒充）", () => {
    const token = signToken(baseClaims({ iss: "someone-else" }));
    const d = evaluateNibiLicense({ token, snapshot: null, now: NOW, publicKeys });
    expect(d.status).toBe("denied");
  });

  it("未知 kid → denied", () => {
    const { signToken: otherSign } = makeSigner();
    const token = otherSign(baseClaims());
    const d = evaluateNibiLicense({ token, snapshot: null, now: NOW, publicKeys });
    expect(d.status).toBe("denied");
  });

  it("服务端明确拒绝过（设备/凭证问题）→ denied（不等宽限）", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: { ...snapshotCheckedAgo(1000), lastRefusal: "device_mismatch" },
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("denied");
    expect(d.allowed).toBe(false);
  });

  it("服务端说会员已过期 → expired，不报“状态异常”", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: { ...snapshotCheckedAgo(1000), lastRefusal: "membership_expired" },
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("expired");
    expect(d.allowed).toBe(false);
  });

  it("服务端说账号未开通 → not_activated", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: { ...snapshotCheckedAgo(1000), lastRefusal: "no_membership" },
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("not_activated");
    expect(d.allowed).toBe(false);
  });

  it("exp 已过时优先判定 expired，即使服务端留了其它拒绝", () => {
    const token = signToken(baseClaims({ exp: Math.floor((NOW - 1000) / 1000) }));
    const d = evaluateNibiLicense({
      token,
      snapshot: { ...snapshotCheckedAgo(1000), lastRefusal: "device_mismatch" },
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("expired");
  });

  it("exp 已过 → expired（会员到期是硬边界，与联网无关）", () => {
    const token = signToken(baseClaims({ exp: Math.floor((NOW - 1000) / 1000) }));
    const d = evaluateNibiLicense({ token, snapshot: null, now: NOW, publicKeys });
    expect(d.status).toBe("expired");
    expect(d.allowed).toBe(false);
  });

  it("检查新鲜（72h 内）→ active", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(NIBI_LICENSE_CHECK_INTERVAL_MS - DAY),
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("active");
    expect(d.allowed).toBe(true);
  });

  it("检查过期但仍在大 7 天宽限内 → grace（照用）", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(NIBI_LICENSE_CHECK_INTERVAL_MS + DAY),
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("grace");
    expect(d.allowed).toBe(true);
  });

  it("宽限也过完（72h + 7 天）→ expired，哪怕 exp 还没到", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(
        NIBI_LICENSE_CHECK_INTERVAL_MS + NIBI_LICENSE_OFFLINE_GRACE_MS + DAY,
      ),
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("expired");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("联网");
  });

  it("从未在线检查过（lastCheckAt 为 null）时，不会误判成 active", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: { deviceId: "dev-1", lastCheckAt: null, lastRefusal: null },
      now: NOW,
      publicKeys,
    });
    // nextCheckFrom = 0 + 72h；NOW 远大于它 → 已超过宽限 → expired
    expect(d.status).toBe("expired");
  });

  it("快照时间恰好等于检查时刻 → 该查了，进入 grace 而不是仍算 active", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(NIBI_LICENSE_CHECK_INTERVAL_MS),
      now: NOW,
      publicKeys,
    });
    expect(d.status).toBe("grace");
  });

  it("license 缺 dev claim → denied（设备绑定 fail-closed）", () => {
    const token = signToken(baseClaims({ dev: undefined }));
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(1000),
      now: NOW,
      publicKeys,
      deviceId: "dev-1",
    });
    expect(d.status).toBe("denied");
    expect(d.allowed).toBe(false);
  });

  it("dev 与本机 deviceId 不一致 → denied（复制凭据到别的机器失效）", () => {
    const token = signToken(baseClaims({ dev: "other-machine" }));
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(1000),
      now: NOW,
      publicKeys,
      deviceId: "dev-1",
    });
    expect(d.status).toBe("denied");
    expect(d.allowed).toBe(false);
  });

  it("uid/sub 与当前账号不一致 → denied（换账号后旧 license 不能沿用）", () => {
    const token = signToken(baseClaims());
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(1000),
      now: NOW,
      publicKeys,
      deviceId: "dev-1",
      accountIdentity: "user-2",
    });
    expect(d.status).toBe("denied");
    expect(d.allowed).toBe(false);
  });

  it("uid 或 sub 命中当前账号即可（与签发口径一致）", () => {
    const token = signToken(baseClaims({ sub: "zitadel-sub-9", uid: "user-1" }));
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(1000),
      now: NOW,
      publicKeys,
      deviceId: "dev-1",
      accountIdentity: "user-1",
    });
    expect(d.status).toBe("active");
  });

  it("nextCheckAt 反映真实的下次应查时刻（快照时间 + 72h）", () => {
    const token = signToken(baseClaims());
    const checkedAt = NOW - DAY;
    const d = evaluateNibiLicense({
      token,
      snapshot: snapshotCheckedAgo(DAY),
      now: NOW,
      publicKeys,
    });
    expect(d.nextCheckAt).toBe(new Date(checkedAt + NIBI_LICENSE_CHECK_INTERVAL_MS).toISOString());
    expect(d.nextCheckInMs).toBe(NIBI_LICENSE_CHECK_INTERVAL_MS - DAY);
  });
});

describe("licenseCoversPlugin", () => {
  const { publicKeys, signToken } = makeSigner();

  const claimsFor = (plugins: string[]) => {
    const token = signToken(baseClaims({ plugins }));
    const d = evaluateNibiLicense({ token, snapshot: null, now: NOW, publicKeys });
    return d.claims;
  };

  it("通配符覆盖任意插件", () => {
    expect(licenseCoversPlugin(claimsFor(["*"]), "math-modeling")).toBe(true);
  });

  it("精确列出才覆盖", () => {
    expect(licenseCoversPlugin(claimsFor(["math-modeling"]), "math-modeling")).toBe(true);
    expect(licenseCoversPlugin(claimsFor(["math-modeling"]), "documents")).toBe(false);
  });

  it("没有 claims 时不覆盖（fail-close）", () => {
    expect(licenseCoversPlugin(null, "math-modeling")).toBe(false);
  });
});
