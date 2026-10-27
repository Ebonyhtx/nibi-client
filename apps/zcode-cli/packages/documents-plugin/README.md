# NIBI documents（文档插件）

创建与审查 .docx：按规格生成（封面、目录、标题、正文、表格、图片、页脚页码、说明），
读回结构与样式，交付前过质量门并逐页出图验收。

**状态：已实现并验收**（M3-H 阶段 3 第一件；编辑既有 .docx 不在 v1 范围，见下）。

## 组成

```
skills/docx/SKILL.md   技能正文（铁律、工作流、规格格式、命名样式、判据说明、常见坑）
agents/visual-judge.md 视觉验收子智能体（按"阅读距离"看：分页、目录、页眉页脚、图表）
tools/                 构建器、回读、质量门、渲染、体检 + nibi_kit 共享工具包
templates/_dev/        仅仓库自测夹具（spec 样板与插图），**不随包发布**
```

## 快速上手

```bash
P=plugins/documents
python $P/tools/env_doctor.py --install
python $P/tools/env_doctor.py --office-home "C:/Program Files/LibreOffice"   # 可选：真渲染
python $P/tools/docx_build.py  --spec $P/templates/_dev/spec-report.json --out 样例.docx  # 样板仅仓库内
python $P/tools/docx_gate.py   --docx 样例.docx --evidence-dir 审查/样例
python $P/tools/docx_render.py --docx 样例.docx --outdir 审查/样例图
```

## 两个设计取舍

* **目录用静态页码 + 两遍生成 + 引擎对账**，而不是 TOC 域：TOC 域在 LibreOffice 导出时
  不会更新，在 Word 里要用户按 F9 —— 交上去常常是空的或过期页码。静态目录的页码由
  "第一遍占位 → 渲染定位 → 第二遍写真页码"得到，质量门再用最终渲染**逐条对账**。
* **没有引擎时不做视觉验收**：`docx_render` 只给结构与文本转录并明确标注"非视觉验收" ——
  在 Python 里"画"一份 DOCX 排版只会给出误导性的图。

## 判据（9 条，两层）

静态 8 条：字号下限、中文字体（eastAsia 必须是中文字体）、样式一致性（含段内混排与标题跳级）、
图片（纵横比/超版心/有效 DPI/替代文字）、目录、页面与页码、交付卫生、结构卫生；
引擎 1 条：真渲染（缺字形、目录域错误、逐页 PNG）+ 目录页码对账。引擎缺席时是 skip 而非 pass。

## 明确不做（v1）

* **编辑既有 .docx**：python-docx 往返会丢部件（图表/文本框/修订等），v1 只做生成与验收；
  需要改稿时读回结构 → 改规格 → 重新生成（或在 Word 里改）。
* 修订/批注、邮件合并、宏（VBA）：不在范围。

## 许可

MIT（见 `LICENSE`）。第三方组件与"明确不使用"的清单见 `NOTICE`。
