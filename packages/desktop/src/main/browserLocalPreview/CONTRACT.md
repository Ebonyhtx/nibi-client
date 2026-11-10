# browser-local-preview

内置浏览器把 `file:` HTML 当作预览输入：主进程用 HTML 所在目录作为授权根，生成
`nibi-html://<hmac>/<encodedRoot>/<basename>`；页面内的同目录资源请求逐个验签并重新
`realpath`，只有仍位于签名根内的普通文件才交给 Electron 的 file loader。

不变量：

- 签名密钥只在主进程内存中生成，不落盘；跨进程/重启后旧 URL 失效，恢复时必须重新解析。
- `file:` 只作为输入；`loadURL` 永远拿到 `nibi-html:` 或普通 http(s)。
- 分区 session 先注册 `file` 的空错误 handler，再注册 `nibi-html`；任何安装/校验失败都
  fail closed，不能退回不受限的 file loader。
- 路径段不以 `.` 开头、不含 `\0`/`\`/`/`/`:` 才允许读取，目录按 404 处理。
