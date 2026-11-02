---
name: report
description: 生成标准化数据分析报告的工作流 Skill
when_to_use: 当用户要求生成正式的数据分析报告、或者明确提到"报告"、"report"时使用
allowed-tools:
  - query_database
  - publish_query_result
  - export_query
  - render_chart
  - run_python
  - write_file
  - read_file
  - search_knowledge
  - read_knowledge
---

# 数据分析报告生成 Skill

## 目标

根据用户需求生成一份结构化的数据分析报告（Markdown），其中的图表由 `render_chart` 从已发布的查询结果渲染。

## 执行流程

### 第一步：理解需求

- 确认分析主题与数据范围。
- 用户没有明确指定时，询问时间范围、维度和指标。

### 第二步：取数并发布

- 每张图或每个数据表对应一个查询，按 spec Skill 的流程完成 Answer Spec 与结果查询，并按其“报告与看板”一节：一个报告任务声明共用的统计总体和度量定义，每张图或表一个图表查询。
- **在查询中把数据聚合到图表需要的粒度**：每个类目（或类目加系列）一行；比率、均值等指标在 SQL 中算好，不依赖画图时相加。
- 用 `publish_query_result` 或 `export_query` 发布结果，记下返回的 `receiptId`。图表只能引用已发布的结果。

### 第三步：统计分析（可选）

- 需要回归、检验等统计计算时，用 `run_python` 读取导出的 CSV。
- 能在 SQL 中算出的量，优先在查询中算好并发布。只能用 Python 算的量（回归拟合值、检验统计量等），用 `run_python` 的 `derive` 登记为派生数据集后再画图：
  - `derive.inputs` 列出要读的 `receiptId`，脚本从 `inputs/<receiptId>.json`（`{"columns": [...], "rows": [[...]]}`）读取；
  - `derive.outputs` 声明输出 `derived/<name>.json`，脚本写入 `{"columns": [...], "rows": [[...]]}`（或 pandas `to_json(orient="split")`）；
  - 返回的 `[DERIVED] ... derivedId=...` 用作图表数据 `{ "kind": "derived", "derivedId": "<derivedId>" }`，并把 `[DERIVED]` 一并写进图注。

### 第四步：出图

- 用 `render_chart(spec, fileName)` 渲染图表，SVG 写入 `charts/<fileName>.svg`。
- `spec.data` 引用第二步的 `receiptId`；度量字段在 `spec.fields` 中声明数值语义。
- 返回 `CHART_SPEC_INVALID` 时，按错误码与建议修改查询或 spec，不要绕过。
- 返回的 `[NOTICE]`、`[DISCLOSURE]`、`[SEMANTICS]` 都要写进该图的图注。
- 返回 `[CHECK]` 时，先核对对应字段的 `storage`、`additivity` 声明：有误就改正 spec 重新渲染；确认无误才使用该图。

### 第五步：撰写报告

用 `write_file` 把 Markdown 报告写到 `reports/<名字>.md`（不要写在工作区根目录），结构为：摘要 → 数据概览 → 关键发现 → 图表 → 建议。报告在 `reports/` 下，`render_chart` 的图在工作区根目录的 `charts/` 下，所以报告里引用图表写 `../charts/<fileName>.svg`；回复里给报告链接写 `[报告标题](reports/<名字>.md)`，不要加前导 `/`。

## ChartSpec 速查

柱线组合、双轴：

```json chart-spec
{
  "version": 1,
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": {
    "sales": { "type": "quantitative", "label": "累计销售额", "storage": "raw", "unit": "元", "magnitude": { "stored": 1, "shown": 100000000 }, "additivity": "additive" },
    "growth": { "type": "quantitative", "label": "同比增速", "storage": "ratio", "additivity": "non_additive" }
  },
  "chart": {
    "mark": "cartesian",
    "x": { "field": "industry" },
    "layers": [
      { "type": "bar", "y": { "field": "sales" } },
      { "type": "line", "y": { "field": "growth", "axis": "right" } }
    ]
  }
}
```

构成（饼图只用于可加指标的完整构成，类别不超过 5 个）：

```json chart-spec
{
  "version": 1,
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": { "sales": { "type": "quantitative", "label": "销售额", "storage": "raw", "unit": "亿元", "additivity": "additive" } },
  "chart": { "mark": "pie", "category": { "field": "industry" }, "value": { "field": "sales" } }
}
```

要点：

- `chart.mark` 为 `cartesian` 或 `pie`。`cartesian` 的每层 `type` 为 `bar`、`line` 或 `scatter`；`y.axis: "right"` 放到右轴；`series: { "field": ... }` 按字段拆系列；`orientation: "horizontal"` 画横向条形图（只用于 bar、line）。
- 度量字段必须声明 `type: "quantitative"`、`storage`（`raw` / `ratio` / `percent`）与 `additivity`（`additive` / `non_additive`）。`storage: "ratio"` 的 0.12 显示为 12%；`magnitude` 把元换算为万元或亿元。
- 堆叠（`stack`）与饼图要求可加、完整、非负的度量。
- 类目过多时，用 `"selection": { "kind": "top_n", "by": "<度量字段>", "n": 10, "order": "desc" }` 只显示前 N 项，或在查询中缩小范围；编译器不会自行删减数据。

## 报告模板

```markdown
# [主题] 数据分析报告

## 摘要
用一段话概括核心发现。

## 数据概览
| 指标 | 数值 |
|------|------|
| ... | ... |

## 关键发现
1. ...
2. ...

## 图表

![图表标题](../charts/<fileName>.svg)

*图注：数据口径与时间范围；render_chart 返回的提示、披露与字段语义来源。*

## 建议
基于数据给出 2-3 条可操作的业务建议。
```

## 约束

- 所有数据必须来自已发布的查询结果，不得编造。
- 不使用 matplotlib 或其他 Python 绘图库画图。
- 需要随报告附数据文件时，使用 `export_query` 返回的下载链接。
- 配色、字体和图例由图表工具统一提供，不要自行指定颜色；业务文档里的配色建议不适用于工具生成的图表。
