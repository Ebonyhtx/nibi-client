// release-it 只负责版本号、提交与标签；发布说明由人按用户口径写进 CHANGELOG.md。
//
// 为什么不再用 conventional-changelog 自动生成：它按 commit 输出 Features/Bug Fixes 和
// 工程术语（模块名、依赖、内部路径），既不符合用户口径，也会把安全修复的细节写进公开页面。
// `after:bump` 会跑发布说明门禁：CHANGELOG 顶部必须已经有本版条目，否则整次发布中止。

export default {
  git: {
    commitMessage: "chore: release v${version}",
    tagName: "v${version}",
    tagAnnotation: "Release v${version}",
    push: true,
  },
  github: {
    release: false,
  },
  gitlab: {
    release: false,
  },
  npm: {
    publish: false,
  },
  hooks: {
    "after:bump": "pnpm run check:release-notes",
  },
};
