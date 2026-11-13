# NIBI presentations（演示插件）

按"投影能不能看清"的标准生成与审查 .pptx：封面、章节页、要点页、双栏对比、指标卡、表格、
图表、图片页、金句、结束页，含演讲备注。

**状态：已实现并验收**（M3-H 阶段 3 第二件）。

## 组成

```
skills/pptx/SKILL.md   技能正文（投影口径的铁律、工作流、规格格式、判据说明、常见坑）
agents/visual-judge.md 视觉验收子智能体（按"投在幕布上"的标准：越界、压盖、卡片半空、跨页一致性）
tools/                 pptx_build / pptx_read / pptx_gate / pptx_render / pptx_smoke / env_doctor
templates/_dev/        仅仓库自测夹具（spec 样板与插图），**不随包发布**
```

## 快速上手

```bash
P=plugins/presentations
python $P/tools/env_doctor.py --install
python $P/tools/pptx_build.py  --spec $P/templates/_dev/spec-deck.json --out 样例.pptx  # 样板仅仓库内
python $P/tools/pptx_gate.py   --pptx 样例.pptx --evidence-dir 审查/样例
python $P/tools/pptx_render.py --pptx 样例.pptx --outdir 审查/样例图
```

## 判据（8 条，两层）

静态 7 条：投影字号下限（12pt 硬 / 16pt 软）、中文字体 `a:ea`、文本溢出与越界、单页信息密度、
图片（纵横比/分辨率/替代文字）、结构卫生、交付卫生；引擎 1 条：真渲染（页数一致、缺字形、逐页 PNG）。

## 许可

MIT（见 `LICENSE`）。第三方组件见 `NOTICE`。
