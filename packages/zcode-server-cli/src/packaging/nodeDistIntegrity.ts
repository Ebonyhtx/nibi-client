/**
 * Node dist 产物的完整性校验（FIX-9 第 3 项）。
 *
 * 与 `apps/zcode-cli/packages/cli/scripts/sea-node-download.mjs` 同一做法：从 dist 源读
 * `SHASUMS256.txt`，按文件名找哈希，下载后比对。取不到清单或清单里没有这一项都失败——
 * 没有哈希就不下载（fail-closed）。
 *
 * 单独成模块而不是留在 stageCli.ts：后者末尾是顶层 `await main()`，import 即执行，
 * 无法在测试里引用（与 nodeDistMirror.ts 同一个理由）。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** 文件的 sha256（小写十六进制）。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * 从 `<distBase>/<nodeVersion>/SHASUMS256.txt` 取产物的 sha256。
 *
 * 清单必须来自实际下载归档的同一个源：镜像源有自己的清单副本，跨源比对会在镜像先行/滞后时
 * 误报；同一源的清单挡的是传输篡改与半截下载。
 */
export async function expectedSha256(
  distBase: string,
  nodeVersion: string,
  artifact: string,
): Promise<string> {
  const url = `${distBase}/${nodeVersion}/SHASUMS256.txt`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  for (const line of (await response.text()).split(/\r?\n/u)) {
    const [hash, name] = line.trim().split(/\s+/u);
    if (hash && name === artifact) return hash;
  }
  throw new Error(`Could not find ${artifact} in Node.js SHASUMS256.txt (${url})`);
}
