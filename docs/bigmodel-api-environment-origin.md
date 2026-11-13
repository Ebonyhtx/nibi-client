# BigModel API Environment Origin

## Goal

BigModel API traffic should follow the selected product environment without changing
non-API links.

## Rules

- `NIBI_ENV=production` uses `https://bigmodel.cn` for BigModel API requests.
- `NIBI_ENV=test` uses `https://bigmodel.cn` for BigModel API requests.
- `BIGMODEL_API_BASE_URL` may override the selected API origin for local debugging.
- `BIGMODEL_TEST_API_BASE_URL` and `BIGMODEL_PRODUCTION_API_BASE_URL` are scoped
  overrides, following the same pattern as Z.ai test/production endpoint config.
- BigModel 账号 OAuth 已删除；模型接入仍支持 **BigModel API / BigModel Coding Plan
  API Key** 两种预设，二者都走 BigModel API origin，不依赖 OAuth。
- Docs, purchase pages, and model runtime subdomains such as `open.bigmodel.cn`
  are not changed by this environment switch.
- The selected origin is resolved by the shared endpoint resolver in
  `packages/shared/src/nibiEndpoint.ts`; service-side provider code should pass
  runtime `env` into that resolver instead of reading compiled globals.

## Covered Request Types

- Coding Plan subscription APIs under `/api/biz`.
- Coding Plan usage quota APIs under `/api/monitor`.
- BigModel API key exchange APIs that use the root BigModel API host.
