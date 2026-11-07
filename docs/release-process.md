# 发版流程（分支、标签、npm）

## 分支职责

| 分支 | 职责 | 谁动它 |
|---|---|---|
| `dev` | **集成分支**。所有改动先落这里；CI（rust-gates / desktop-package-gates / desktop-e2e-container）在这里跑。日常提交、修复、功能都在 `dev`。 | 每次提交 |
| `main` | **发布分支**。只接受从 `dev` 的快进（`git branch -f main dev` 或 `git push origin dev:main`），只在准备发布时前进。GitHub 的默认分支、对外展示、完整门禁（`client-gates` 四组）跑在这里。 | 发版时 |

规则：**`dev` 可以随便绿着前进，`main` 必须是"已发布/可发布"的状态。** 两者允许暂时不一致；发版时把 `main` 快进到 `dev` 的某个 commit，在那上面打标签。

> 首次公开发布之前，`main` 与 `dev` 保持同一 commit 也行（现状就是这样），但**发布动作一律从 `main` 出发**。

## 发布一个版本

1. 把根 `package.json` 的版本改成新版本（比如 `4.0.2`），提交到 `dev`，等 `dev` 的门禁绿。
2. 快进 `main`：`git branch -f main dev && git push origin main`。
3. 在 `main` 的该 commit 上打标签并推送：
   ```bash
   git tag v4.0.2 <main 的 commit>
   git push origin v4.0.2
   ```
4. 标签推送会触发 `rust-npm-packages` 的 `publish` job，三个平台包（`@nibi-studio/cli-*`）自动带
   provenance 发到 npm。标签必须等于 `package.json` 的版本，否则 job 直接失败（防止 `v4.0.2` 的标签发出
   `4.0.1` 的包）。
5. 桌面安装包/服务端发布沿用各自流程，同样以这次 `main` 的 commit 为准。

## npm 包

- 包名：`@nibi-studio/cli-<platform>`，平台见 `scripts/rust-cli/npm/package.mjs` 的 `TARGETS`
  （`linux-x64-gnu`、`linux-arm64-gnu`、`darwin-arm64`；Intel Mac 不发布）。
- 内容：`bin/nibi-rs` + `build.json` + `package.json`。内核按
  `@nibi-studio/cli-<Platform::package_id()>@<自身版本>` 取包，404 退 `latest`，再用
  `exec-wire::handshake::PROTOCOL` 核对协议。
- 发布方式：**npm trusted publishing（OIDC）**，不需要任何 token/secret；发布身份由 npm 上每个包的
  Trusted Publisher 设置（仓库 `Ebonyhtx/nibi-client` + workflow `rust-npm-packages.yml`）绑定。
- 手动补发：Actions → `rust-npm-packages` → Run workflow → 勾 `publish`（`version` 可覆盖版本，仅用于
  验证配置这类场景）。同一个版本已存在时 job 会跳过而不是失败。
- 已发布版本不可覆盖：要修就发新版本，旧版本只能 `npm deprecate`。

## npm 铁律（踩过的坑，别再踩）

1. **版本号永久占用**：同一个版本不能覆盖。要改就发新版本；已发布的只能 `npm deprecate`，不能删。
2. **发布只从 `main` 的 `v<版本>` 标签走**，标签必须等于根 `package.json` 的版本（workflow 里有守卫）。
3. **provenance 要求 `package.json.repository.url`** 与 OIDC 令牌里的仓库一致（`git+https://github.com/Ebonyhtx/nibi-client.git`），
   缺了会 `422 Error verifying sigstore provenance bundle`。已固定在 `scripts/rust-cli/npm/package.mjs`。
4. **公开仓 workflow 不许出现 `secrets.*`**（`scripts/check-public-repo.mjs` 强制），所以发布只用 OIDC；
   不要为了"图省事"往里加 `NPM_TOKEN`，那会让 `public-repo-policy` 直接红。
5. **Trusted Publisher 一旦创建不可修改**：仓库/工作流文件名写错只能删掉重建；权限只勾 `npm publish`，
   不要勾 `npm dist-tag`（最小权限）。
6. **手动发布要 OTP**：npm 账号开了 2FA 后，`npm publish` 会要一次性密码，只能在交互终端里跑；
   不要试图在脚本/CI 里绕（npm 正在限制能绕过 2FA 的 token）。
7. **`0.0.0-stage` 占位版本**：npm 在带 2FA 的发布流程里会写这条内部记录，删它要 OTP，不影响安装与 `latest`，别当故障。
8. **改了包名前缀要同步四处**：`package.rs` 的 `PACKAGE_PREFIX`、`package.mjs` 的 `name`、
   测试夹具（`@nibi-studio/cli-*` 字符串）、本文档。
9. **Intel Mac 不发**：与 `Platform::published()` 一致；`scripts/rust-cli/npm/package.mjs` 的 `TARGETS` 是唯一清单。

## 为什么不是"从 dev 发"

npm 版本号永久占用、且 provenance 会把产物绑定到具体 commit。若从 `dev` 发，`main`（默认分支、对外展示）
会落后于实际发布的代码，出问题时无法用标签追到一个官方分支上的 commit。所以：**集成分支随便动，发布一定从
`main` 的标签走。**
