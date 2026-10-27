// 校验一份内置 Provider 配置是否满足运行时 Release schema——与构建期同一解码器
// （decodeZCodeBuiltinRelease → parseZCodeBuiltinProviderConfigRules），避免"自研检查
// 全绿、客户端却整体拒收"（实测：logo.key 被剥掉时只有这里报得出来）。
//
// 用法：node NIBI-Client/scripts/validate-builtin-release.mjs <nibi-builtin.json>
// 退出码：0=通过；1=校验失败（stderr 打印 zod issues）；2=用法错误。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const file = process.argv[2];
if (!file) {
  console.error("用法: node scripts/validate-builtin-release.mjs <file>");
  process.exit(2);
}
const repositoryRoot = resolve(import.meta.dirname, "..");
try {
  const content = JSON.parse(await readFile(file, "utf8"));
  const { decodeZCodeBuiltinRelease } = await tsImport(
    pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/nibi-builtin-release.ts")).href,
    import.meta.url,
  );
  decodeZCodeBuiltinRelease(content);
  console.log("OK");
} catch (error) {
  const cause = error?.cause;
  console.error(String(cause?.message ?? error?.message ?? error));
  if (Array.isArray(cause?.issues)) {
    console.error(JSON.stringify(cause.issues.slice(0, 10), null, 2));
  }
  process.exit(1);
}
