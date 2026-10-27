# NIBI pdf（PDF 插件）

PDF 的生成、手术与印前验收：含**海报/定幅画布**（reportlab 毫米级版面）、HTML/Office → 交付用 PDF（可出 PDF/A）、合并/拆分/抽页/旋转/
加水印/清元数据、印前质量门（字体嵌入、页面尺寸、文字贴边、空白页、扫描件判定）+ 逐页出图。

**状态：已实现并验收**（M3-H 阶段 3 第三件，四件套收齐）。

## 组成

```
skills/pdf/SKILL.md    技能正文（三条路线、印前铁律、HTML 打印模板、判据、常见坑）
agents/visual-judge.md 视觉验收子智能体（按"印出来"的标准：版心、分页、字形、压盖、多页一致性）
tools/                 pdf_build / pdf_ops / pdf_gate / pdf_read / pdf_render / pdf_smoke
templates/report.html   A4 打印模板（**随包发布**，可直接拿来用）
templates/_dev/         仅仓库自测夹具（样例 PDF/PNG、spec 样板），**不随包发布**
```

## 快速上手

```bash
P=plugins/pdf
python $P/tools/env_doctor.py --install
python $P/tools/pdf_build.py  --html $P/templates/report.html --out 样例.pdf [--pdfa]
python $P/tools/pdf_poster.py --spec $P/templates/_dev/spec-poster.json --out 海报样例.pdf  # 样板仅仓库内
python $P/tools/pdf_gate.py   --pdf 样例.pdf --evidence-dir 审查/样例
python $P/tools/pdf_render.py --pdf 样例.pdf --outdir 审查/样例图
python $P/tools/pdf_smoke.py
```

## 与另外三个插件的关键差别

**渲染与读取是自带的**（pypdfium2 + pypdf）：只有"生成 PDF"才需要 LibreOffice，
所以 `pdf_gate` 的渲染层判据**不会被跳过**，没装引擎也能逐页看图。读取与手术（合并/拆分/
加水印/清元数据）同样不依赖引擎。

## 判据（8 条）

静态 7 条：页面尺寸一致、字体全部嵌入、文字贴边/越界、空白页、扫描件判定、交付卫生（元数据+正文）、
结构（加密/页数/体积）；渲染 1 条：逐页出图 + 缺字形 + 近空白页。**无 skip 分支**（不需要引擎）。

## 明确不做

* **学术排版（论文/公式/参考文献）**：用数模插件的自管 TeX 树（XeLaTeX + `TEXMFHOME`），
  本插件不重复造 LaTeX 环境；
* OCR（把扫描件变成可检索 PDF）：需要额外引擎，超出本插件范围，`text-layer` 判据只负责**报**。

## 许可

MIT（见 `LICENSE`）。第三方组件见 `NOTICE`。
