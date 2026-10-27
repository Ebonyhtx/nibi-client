import { resolve } from "node:path";
import { git, run } from "./process.mjs";

async function commit(root, ref) {
  try {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]))
      .toString()
      .trim();
  } catch (error) {
    throw new Error(`无法解析基线或提交 ${ref}：${error.message}`, { cause: error });
  }
}
async function isAncestor(root, ancestor, head) {
  const check = await run("git", ["merge-base", "--is-ancestor", ancestor, head], {
    allowFailure: true,
  });
  return check.code === 0;
}

// rebase / force-push 后远端 SHA 不再是 HEAD 的祖先；直接拿它当基线会让 Vitest
// 找不到公共祖先而退化成全量选择。回退到双方 merge-base，永远给官方选择一个
// 真实分叉点（最坏也只是比严格推送范围多选 staging 侧的新增改动，不会全量）。
async function resolvePushBase(root, head, remote) {
  if (await isAncestor(root, remote, head)) {
    return remote;
  }

  return (await git(root, ["merge-base", remote, head])).toString().trim();
}

async function firstPushBase(root, head) {
  // 首次推送没有 remote SHA。上游仓库的集成分支是 origin/staging，NIBI fork 只有 main，
  // 所以按 origin/staging → origin/HEAD → origin/main → origin/master 取第一个存在的
  // 远端集成分支；全部缺失时严格报错，不猜测其他分支（本地 main 可能正是被推送的分支）。
  for (const ref of ["origin/staging", "origin/HEAD", "origin/main", "origin/master"]) {
    const exists = await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      allowFailure: true,
    });
    if (exists.code !== 0) continue;
    const mergeBase = await run("git", ["merge-base", ref, head], {
      cwd: root,
      allowFailure: true,
    });
    if (mergeBase.code === 0) return mergeBase.stdout.toString().trim();
    // 浅克隆会把共同祖先截在 shallow 边界之外，merge-base 直接返回 1；此时不能猜一个基线，
    // 只能要求显式指定，否则会拿错范围去选测试。
    throw new Error(
      `无法计算 ${ref} 与 HEAD 的共同祖先（git merge-base 退出码 ${mergeBase.code}）：` +
        "仓库可能是浅克隆，请先 git fetch --unshallow，或用 NIBI_AFFECTED_TEST_BASE 指定基线",
    );
  }
  throw new Error(
    "首次推送缺少集成基线：origin/staging、origin/HEAD、origin/main、origin/master 均不存在",
  );
}

/** 只解析比较基线；改动文件与关联测试全部由 Vitest 官方选择。 */
export async function resolveScope(root, options = {}, env = process.env) {
  if (options.scope && !["worktree", "push"].includes(options.scope))
    throw new Error(`未知范围：${options.scope}`);
  const explicit = options.base ?? env.NIBI_AFFECTED_TEST_BASE ?? env.NIBI_PRE_PUSH_BASE;
  if (options.files && (options.scope === "push" || explicit))
    throw new Error("--files 不能与 push 或 --base 混用");
  if (options.files)
    return { files: [...new Set(options.files.map((file) => resolve(root, file)))], bases: [true] };
  if (options.scope !== "push") return { bases: [explicit ? await commit(root, explicit) : true] };

  // 脏工作区会让未提交代码掩盖推送版本的失败；先阻止，不自动 stash 或改写 index。
  if ((await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
    throw new Error("Push 工作区不干净：请先提交或自行保存已暂存、未暂存及未跟踪改动");
  const head = await commit(root, "HEAD");
  const entries = (env.NIBI_PRE_PUSH_STDIN ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
  const bases = [];
  if (entries.length) {
    for (const entry of entries) {
      if (entry.length !== 4 || !/^[\da-f]+$/iu.test(entry[1]) || !/^[\da-f]+$/iu.test(entry[3]))
        throw new Error("推送 ref 输入无效");
      if (/^0+$/u.test(entry[1])) continue;
      if ((await commit(root, entry[1])) !== head) throw new Error("推送目标不是当前 HEAD");
      // hook 曾直接使用 remote SHA，导致显式基线变量失效；校验目标后优先使用调用方指定基线。
      bases.push(
        explicit
          ? await commit(root, explicit)
          : /^0+$/u.test(entry[3])
            ? await firstPushBase(root, head)
            : await resolvePushBase(root, head, await commit(root, entry[3])),
      );
    }
    return { bases: [...new Set(bases)], deletedOnly: !bases.length };
  }
  if (explicit) return { bases: [await commit(root, explicit)] };
  const upstream = await run("git", ["rev-parse", "--verify", "@{upstream}^{commit}"], {
    cwd: root,
    allowFailure: true,
  });
  return {
    bases: [
      upstream.code === 0
        ? await resolvePushBase(root, head, upstream.stdout.toString().trim())
        : await firstPushBase(root, head),
    ],
  };
}
