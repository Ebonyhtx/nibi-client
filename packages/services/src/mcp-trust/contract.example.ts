import type { WorkspaceMcpTrustHost } from "./contract.js";

/** 一次完整的审核：读取当前声明，信任第一条未信任的声明。 */
export async function exampleWorkspaceMcpTrust(host: WorkspaceMcpTrustHost, workspacePath: string) {
  const storePath = await host.resolveStorePath();
  const records = await host.inspect({ records: [], workspacePath, storePath });
  const first = Object.entries(records.reviews)[0];
  if (!first) return;
  // 真实调用必须来自用户对当前行的显式审核动作。
  await host.decide({
    records: [],
    workspacePath,
    serverName: first[0],
    declarationDigest: first[1].declarationDigest,
    trusted: true,
    storePath,
  });
}
