/**
 * 数据根迁移清单：切数据根时要整体搬运哪些目录。
 *
 * `machine` 必须与 `v2` 分开搬运，绝不能把 per-install 凭据密钥并进 v2：
 * 只拷走 `v2/credentials.json`（甚至整个 v2/）的解密端必须失败（fail-closed）。
 * 清单按目录声明而不是单文件，`machine` 下新增密钥文件时无需改迁移逻辑。
 *
 * `data` 中的条目逐个迁移：`v2`（App 数据）与 `workspace`（非项目对话工作区）。
 * 两者过滤规则不同，具体见 relocate.ts：v2 排除 bootstrap 指针与瞬时文件，
 * workspace 只跳过符号链接。
 */
import { join } from "node:path";

/** 暂存目录前缀：`<target>/.nibi/.migrating-<stamp>`。 */
export const DATA_ROOT_STAGING_PREFIX = ".migrating-";

/** App 数据目录名；凭据与数据根清单的“主目录”语义都指向它。 */
export const DATA_ROOT_APP_DATA_DIR_NAME = "v2";
/** 非项目对话共享工作区目录名；整体迁移，不参与凭据验证。 */
export const DATA_ROOT_WORKSPACE_DIR_NAME = "workspace";
/** 机器级密钥目录名。 */
export const DATA_ROOT_MACHINE_DIR_NAME = "machine";

/**
 * 相对 `<dataBaseDir>/.nibi` 的迁移条目。
 * `data` 按顺序逐项处理：`.nibi/v2`（App 数据）与 `.nibi/workspace`（对话工作区）；
 * `machine` 是 `.nibi/machine`（机器级密钥），先于 data 发布。
 */
export const DATA_ROOT_MANIFEST = {
  data: [DATA_ROOT_APP_DATA_DIR_NAME, DATA_ROOT_WORKSPACE_DIR_NAME],
  machine: [DATA_ROOT_MACHINE_DIR_NAME],
} as const;

/** `{base}/.nibi` */
export function getNibiRootDirForBase(baseDir: string): string {
  return join(baseDir, ".nibi");
}

/** `{base}/.nibi/<entry>`，entry 来自 DATA_ROOT_MANIFEST。 */
export function getManifestEntryDirForBase(baseDir: string, entry: string): string {
  return join(getNibiRootDirForBase(baseDir), entry);
}

/** `{base}/.nibi/v2` */
export function getAppDataDirForBase(baseDir: string): string {
  return getManifestEntryDirForBase(baseDir, DATA_ROOT_APP_DATA_DIR_NAME);
}

/** `{base}/.nibi/machine` */
export function getMachineDirForBase(baseDir: string): string {
  return getManifestEntryDirForBase(baseDir, DATA_ROOT_MACHINE_DIR_NAME);
}

/** 迁移暂存目录；stamp 由调用方生成，避免模块级时间读取影响测试与重试。 */
export function getRelocationStagingDir(baseDir: string, stamp: string): string {
  return join(getNibiRootDirForBase(baseDir), `${DATA_ROOT_STAGING_PREFIX}${stamp}`);
}
