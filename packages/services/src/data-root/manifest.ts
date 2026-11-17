/**
 * 数据根迁移清单：切数据根时要整体搬运哪些目录。
 *
 * `machine` 必须与 `v2` 分开搬运，绝不能把 per-install 凭据密钥并进 v2：
 * 只拷走 `v2/credentials.json`（甚至整个 v2/）的解密端必须失败（fail-closed）。
 * 清单按目录声明而不是单文件，`machine` 下新增密钥文件时无需改迁移逻辑。
 */
import { join } from "node:path";

/** 暂存目录前缀：`<target>/.nibi/.migrating-<stamp>`。 */
export const DATA_ROOT_STAGING_PREFIX = ".migrating-";

/**
 * 相对 `<dataBaseDir>/.nibi` 的迁移条目。
 * 拼上根后分别是 `.nibi/v2`（App 数据）与 `.nibi/machine`（机器级密钥）。
 */
export const DATA_ROOT_MANIFEST = {
  data: ["v2"],
  machine: ["machine"],
} as const;

/** `{base}/.nibi` */
export function getNibiRootDirForBase(baseDir: string): string {
  return join(baseDir, ".nibi");
}

/** `{base}/.nibi/v2` */
export function getAppDataDirForBase(baseDir: string): string {
  return join(getNibiRootDirForBase(baseDir), DATA_ROOT_MANIFEST.data[0]);
}

/** `{base}/.nibi/machine` */
export function getMachineDirForBase(baseDir: string): string {
  return join(getNibiRootDirForBase(baseDir), DATA_ROOT_MANIFEST.machine[0]);
}

/** 迁移暂存目录；stamp 由调用方生成，避免模块级时间读取影响测试与重试。 */
export function getRelocationStagingDir(baseDir: string, stamp: string): string {
  return join(getNibiRootDirForBase(baseDir), `${DATA_ROOT_STAGING_PREFIX}${stamp}`);
}
