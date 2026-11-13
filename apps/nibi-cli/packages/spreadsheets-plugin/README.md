# NIBI spreadsheets（表格插件）

创建、编辑、审查 `.xlsx` 工作簿的技能插件。设计目标只有一个：**交付出去的表，用户打开时没有
意外** —— 没有 `###`、没有 `#DIV/0!`、没有缩到看不清的字、没有带着本机用户名与路径的属性。

## 组成

```
skills/xlsx/SKILL.md   技能正文（铁律、工作流、规格格式、中文排版约定、常见坑）
agents/visual-judge.md 视觉验收子智能体（逐页 PNG → 每页一条 JSON 判定）
tools/                 构建器、回读、编辑、质量门、渲染、体检 + nibi_kit 共享工具包
templates/             规格示例
```

## 快速上手

```bash
P=plugins/spreadsheets            # 插件根
python $P/tools/env_doctor.py --install          # 自举依赖（走国内镜像）
python $P/tools/env_doctor.py --layer render     # 看渲染链路（可选装 LibreOffice 后登记）
python $P/tools/xlsx_build.py --spec $P/templates/_dev/spec-quarter.json --out 样例.xlsx  # 样板仅仓库内
python $P/tools/xlsx_gate.py  --xlsx 样例.xlsx --evidence-dir 审查/样例
python $P/tools/xlsx_render.py --xlsx 样例.xlsx --outdir 审查/图
```

## 判据分层（"没验"与"通过"永远分开）

* **静态层**：字号（含印出等效字号）、截断（数字 `###`/文本被裁/合并单元格压字）、公式静态检查、
  数字格式语义、打印就绪、交付卫生、结构卫生；
* **引擎层**（装了 LibreOffice 才有）：公式真重算抓错误值、转 PDF 抓 `###` 与错误 token、
  落逐页 PNG 供人眼/`visual-judge` 验收；
* 引擎缺席时引擎层判据在报告里是 **skip + 原因**，不是 pass；`--require-engine` 可升级为硬失败。

## 许可

MIT（见 `LICENSE`）。第三方组件与"明确不使用"的清单见 `NOTICE`。
