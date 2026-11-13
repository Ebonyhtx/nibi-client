# 发版流程（分支、标签、npm）

## 分支职责

| 分支 | 职责 | 谁动它 |
|---|---|---|
| `dev` | **集成分支**。所有改动先落这里；CI（rust-gates / desktop-package-gates / desktop-e2e-container）在这里跑。日常提交、修复、功能都在 `dev`。 | 每次提交 |
| `main` | **发布分支**。只接受从 `dev` 的快进（`git branch -f main dev` 或 `git push origin dev:main`），只在准备发布时前进。GitHub 的默认分支、对外展示、完整门禁（`client-gates` 四组）跑在这里。 | 发版时 |

规则：**`dev` 可以随便绿着前进，`main` 必须是"已发布/可发布"的状态。** 两者允许暂时不一致；发版时把 `main` 快进到 `dev` 的某个 commit，在那上面打标签。

> 首次公开发布之前，`main` 与 `dev` 保持同一 commit 也行（现状就是这样），但**发布动作一律从 `main` 出发**。

## 发布一个版本

1. 把根 `package.json` 的版本改成新版本（比如 `4.0.2`），同步 `package-lock.json` 的根 `version` 与
   `packages[""].version`（`desktopProductIdentity` 门禁要求三者一致），提交到 `dev`，等 `dev` 的门禁绿。
2. 快进 `main`：`git branch -f main dev && git push origin main`。
3. 在 `main` 的该 commit 上打标签并推送：
   ```bash
   git tag v4.0.2 <main 的 commit>
   git push origin v4.0.2
   ```
4. 标签推送会触发 `rust-npm-packages`：先发布四个平台包（`@nibi-studio/cli-*`），全部成功后
   `meta` job 再打包并发布入口包 `@nibi-studio/cli`。两层包都自动带 provenance，并共用根
   `package.json` 的版本；标签必须等于该版本，否则 job 直接失败（防止 `v4.0.2` 的标签发出
   `4.0.1` 的包）。META 的 `optionalDependencies` 精确锁定同版本平台包，平台包缺一个就不会发
   META。
5. 桌面安装包/服务端发布沿用各自流程，同样以这次 `main` 的 commit 为准。

## npm 包

### 包结构与入口优先级

npm 上只有两层包，版本始终等于根 `package.json` 的产品版本：

- **平台包**：`@nibi-studio/cli-<platform>`，平台见 `scripts/rust-cli/npm/package.mjs` 的
  `TARGETS`（`linux-x64-gnu`、`linux-arm64-gnu`、`darwin-arm64`、`android-arm64`；Intel Mac 与
  Windows 不发布）。内容：`bin/nibi-rs` + `build.json` + `package.json`。内核按
  `@nibi-studio/cli-<Platform::package_id()>@<自身版本>` 取包，404 退 `latest`，再用
  `exec-wire::handshake::PROTOCOL` 核对协议。这条是 SSH 远端部署的路径；`android-arm64` 只供
  NIBI-GO 直接消费 tarball，不经过内核的 SSH 远端 `Platform`。
- **META 入口包**：`@nibi-studio/cli`，只含 `bin/nibi` 启动器、README/LICENSE 与精确锁版本的
  `optionalDependencies`。它是**唯一**暴露全局 `nibi` bin 的 npm 包（用户安装
  `npm install -g @nibi-studio/cli`）：启动器按 `process.platform`/`process.arch` 解析同版本
  平台包里的 `bin/nibi-rs`，原样转发 argv/stdio/信号，并把 `NIBI_MANAGED_*`、
  `NIBI_MANAGED_PACKAGE=@nibi-studio/cli`、`NIBI_MANAGED_PLATFORM_PACKAGE=<平台包>` 写进
  子进程环境，供 Rust 的 `nibi update` 使用。不支持的平台 fail-closed（退出码 1，错误里
  列出支持的平台），不回退到别的架构或 Node CLI。打包入口是
  `scripts/rust-cli/npm/meta-package.mjs`，启动器模板在同目录 `bin/`。

Node `@nibi/cli` 已退役为内部私有 workspace 包：没有 `bin`、不发布、不再构建 Node CLI/TUI，
只保留 `nibi.cjs`（`--desktop-agent` 构建）供 DWF、插件宿主与远端 Source Server 使用。
不要给任何 Node 包重新加回 `nibi` bin，否则会和 META 包争抢全局入口。

### 版本与发布顺序

- **版本同源**：根 `package.json`、内核 `nibi-rs --version`、平台包 `version`、
  `build.json.version`、META 包 `version` 与它锁定的平台包版本必须逐字相同。CI 的
  `rust-npm-packages` pack job 把同一份版本写进 `NIBI_RELEASE_VERSION`（编译期）与打包参数，
  并在非 Android target 上跑 `nibi-rs --version` 断言；META pack 也读同一个版本。
- **发布顺序**：平台包 → META。`meta` job 的 `needs: publish` 保证所有平台包先发完；发布前还会
  `npm view` 逐个核对四个平台包在该版本存在，缺一个就失败。手动补发时也保持这个顺序。
- 本地 `cargo build --release`（不设 `NIBI_RELEASE_VERSION`）报告的仍是 `0.1.<build-number>`，
  专供本地开发、让执行器缓存与产品版本互不覆盖；**打进安装包的内核必须是产品版本**——
  `prepare-rust-kernel` 在 `NIBI_ENV=production` 下发现不一致会直接 fail 打包。

### 发布方式与操作

- 发布方式：**npm trusted publishing（OIDC）**，不需要任何 token/secret；发布身份由 npm 上每个包的
  Trusted Publisher 设置绑定。
- **一次性登记**：运营者在 npmjs.com 给每个包配置 Trusted Publisher——组织/用户 `Ebonyhtx`、
  仓库 `nibi-client`、workflow `rust-npm-packages.yml`、权限只勾 `npm publish`。平台包与 META 包
  `@nibi-studio/cli` 各要一份；新包首次发布前必须先登记（若 npm 要求包已存在才能配置，由运营者
  在交互终端用 OTP 手工首发一次，**不要**把 token 写进 CI 或仓库）。
- 手动补发：Actions → `rust-npm-packages` → Run workflow → 勾 `publish`（`version` 可覆盖版本，仅用于
  验证配置这类场景）。同一个版本已存在时 job 会跳过而不是失败；META 仍会在平台包核对通过后才跑。
- 已发布版本不可覆盖：要修就发新版本，旧版本只能 `npm deprecate`。
- **`4.0.1` 不可用**：`linux-x64-gnu` / `linux-arm64-gnu` / `darwin-arm64` 是 2026-11 手工验证
  时发的，包内二进制仍报告 `0.1.x`（当时还没有 `NIBI_RELEASE_VERSION` 注入），与包版本不一致；
  `android-arm64` 在 4.0.2 之前从未发布。第一个版本同源的发布从 `4.0.2` 起；META 包在新版本
  首次发布前从未上线，不要拿 4.0.1 做 META 的首次发布。

## Source Server 远端产物

远端工作区的 `nibi-server-<target>.tar.gz`（`linux-x64` / `linux-arm64` / `darwin-x64` /
`darwin-arm64`）与 `source-server-release.json` 由同一条 staging 链产出，**不是 Rust 构建**：

1. 触发 `source-server-release` workflow（`workflow_dispatch`，ubuntu-latest）。它跑
   `NIBI_ENV=production pnpm prepare:remote-assets`，把四个包与 descriptor 放进
   `packages/desktop/mock-cdn/releases/<版本>/`，校验版本、sha256、size 与执行位后上传 artifact。
   - 不要在 Windows 本机跑：staging 里 `spawn("pnpm")` 在 Windows 会 ENOENT，Windows 的 tar
     也保不住 POSIX 执行位（远端解压后直接跑 `bin/nibi`）。
   - 不要用 `prepare:remote-assets:linux` 发正式版：descriptor 只会登记两个 Linux target。
2. 下载 artifact，把 5 个文件放到服务器 `/srv/nibi-site/content/releases/electron/<版本>/`。
3. 服务器上 `python3 tools/publish-content.py --only releases --dry-run`，确认只新增这 5 个对象后
   去掉 `--dry-run`；**不要加 `--prune`**。发布后的公网地址是
   `https://dl.nibistudio.cn/releases/electron/<版本>/…`。

descriptor 的 `version` 必须等于产品版本（根 `package.json`）：客户端
`sourceServerReleaseResolver` 不匹配会直接拒绝，`content-publish.py verify` 的 URL 前缀也按同一版本。

## npm 铁律（踩过的坑，别再踩）

1. **版本号永久占用**：同一个版本不能覆盖。要改就发新版本；已发布的只能 `npm deprecate`，不能删。
2. **发布只从 `main` 的 `v<版本>` 标签走**，标签必须等于根 `package.json` 的版本（workflow 里有守卫）。
3. **provenance 要求 `package.json.repository.url`** 与 OIDC 令牌里的仓库一致（`git+https://github.com/Ebonyhtx/nibi-client.git`），
   缺了会 `422 Error verifying sigstore provenance bundle`。平台包与 META 包都已固定在
   `scripts/rust-cli/npm/package.mjs` / `meta-package.mjs`（共享 `REPOSITORY_URL`）。
4. **公开仓 workflow 不许出现 `secrets.*`**（`scripts/check-public-repo.mjs` 强制），所以发布只用 OIDC；
   不要为了"图省事"往里加 `NPM_TOKEN`，那会让 `public-repo-policy` 直接红。
5. **Trusted Publisher 一旦创建不可修改**：仓库/工作流文件名写错只能删掉重建；权限只勾 `npm publish`，
   不要勾 `npm dist-tag`（最小权限）。
6. **手动发布要 OTP**：npm 账号开了 2FA 后，`npm publish` 会要一次性密码，只能在交互终端里跑；
   不要试图在脚本/CI 里绕（npm 正在限制能绕过 2FA 的 token）。
7. **`0.0.0-stage` 占位版本**：npm 在带 2FA 的发布流程里会写这条内部记录，删它要 OTP，不影响安装与 `latest`，别当故障。
8. **改了包名/平台清单要同步五处**：`package.rs` 的 `PACKAGE_PREFIX`、`package.mjs` 的
   `TARGETS`/`name`、META 启动器的 `PLATFORM_PACKAGES`、平台包与 META 的测试夹具、
   本文档。
9. **Intel Mac 不发**：`scripts/rust-cli/npm/package.mjs` 的 `TARGETS` 是 npm 平台包的唯一清单；
   `Platform::published()` 只管 SSH 远端（linux/darwin），android 只出现在 TARGETS 与 CI matrix 里。
10. **META 始终最后发**：平台包先于 `@nibi-studio/cli`；不要为了"先让用户能装"把 META job 提前，
    也不要在平台包缺失时用 `--ignore-optional` 绕过。
11. **全局 `nibi` 只属于 META 包**：Node `@nibi/cli` 不再有 `bin`；SEA、`build:nibi`、
    release-it 的 Node CLI 发布链均已删除，不要恢复。

## 为什么不是"从 dev 发"

npm 版本号永久占用、且 provenance 会把产物绑定到具体 commit。若从 `dev` 发，`main`（默认分支、对外展示）
会落后于实际发布的代码，出问题时无法用标签追到一个官方分支上的 commit。所以：**集成分支随便动，发布一定从
`main` 的标签走。**
