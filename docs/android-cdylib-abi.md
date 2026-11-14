# Android 平台包 cdylib ABI（NIBI-GO Phase C）

`@nibi-studio/cli-android-arm64` 同时提供：

- `bin/nibi-rs`：开发机对照用的可执行文件（API 26），不用于 App 进程内运行；
- `lib/libnibi.so`：进程内内核 cdylib（aarch64-linux-android，API 24）；
- `lib/libc++_shared.so`：NDK 的 C++ 运行时（NDK 提供时随包携带）；
- `build.json`：`artifacts` 数组逐项给出 `bin` / `cdylib` / `shared-library` 的路径与 sha256。

GO 侧只把 `lib/libnibi.so`（和存在的 `libc++_shared.so`）拷进 `jniLibs`，按 `artifacts` 校验
sha256；校验不过就 fail-closed。

## C ABI

```c
typedef void (*nibi_app_server_output_callback)(
    const uint8_t *data, size_t len, void *user_data);
typedef void (*nibi_app_server_error_callback)(
    const char *message, void *user_data);

uint32_t nibi_app_server_abi_version(void);

void *nibi_app_server_start(
    nibi_app_server_output_callback output,
    void *output_user_data,
    nibi_app_server_error_callback error,
    void *error_user_data);

int32_t nibi_app_server_send(void *handle, const uint8_t *data, size_t len);
int32_t nibi_app_server_stop(void *handle);
void nibi_app_server_destroy(void *handle);
```

- `nibi_app_server_start` 返回 NULL 表示线程/运行时启动失败；异步错误走 `error` 回调。
- `nibi_app_server_send` 送入 Host → kernel 的 UTF-8 JSON 帧；缺 LF 会自动补。返回 `0` 成功、
  `-1` 参数无效、`-2` 内核已停止。
- 输出回调在内核线程上调用，`data` 只在该次回调内有效；一个块里可能包含多行 JSON，按 LF 切帧。
  不要从输出回调里调用 `nibi_app_server_destroy`（会等待同一线程）。
- `nibi_app_server_stop` 取消内核循环；`nibi_app_server_destroy` 等待线程退出并释放句柄，可重复
  传入 NULL。
- 入口语义等价 `nibi-rs app-server --stdio --surface android`：同一套协议帧与内核装配。

## 宿主前置

内核在 `nibi_app_server_start` 时读取一次进程环境与 cwd，因此 GO 必须先设置好：

- `HOME`（Android 上通常指向 App 私有目录）；
- `NIBI_DATA_BASE_DIR` / `NIBI_SESSION_DB_PATH` / `NIBI_STORAGE_DIR` 等存储变量；
- 工作目录（`std::env::current_dir()` 可读）。

一个进程只需一个实例；当前 ABI 不提供多实例隔离。

## 构建

- `nibi-kernel-cli` 同时有 `rlib` 与 `cdylib` 目标，库名 `nibi`。
- 普通平台只打包 `bin/nibi-rs`；Android leg 先用 API 26 编 bin，再 `cargo clean -p nibi-kernel-cli`
  后用 API 24 的 NDK clang 重链 `--lib`，输出 `libnibi.so`。
- 发布 workflow 校验 `.so` 是 shared object、带 Android note、导出
  `nibi_app_server_start`，并在打包器测试里校验 tar 内容与 `build.json.artifacts`。
