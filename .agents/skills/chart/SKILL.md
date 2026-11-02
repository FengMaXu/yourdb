---
name: chart
description: 交互图表渲染 — 仅当用户明确要求画图或可视化时使用
when_to_use: 仅当用户明确要求“画图”“图表”“可视化”“趋势图”“折线图”“柱状图”“饼图”“保存图表”或“下载图表”时使用。纯数据查询、统计计算或 CSV 导出不要加载此 Skill。
allowed-tools:
  - query_database
  - show_widget
  - render_chart
  - write_file
  - search_knowledge
  - read_knowledge
---

# 交互图表渲染

本 Skill 只处理用户明确要求的图表或可视化，不是所有数据分析任务的默认步骤。先完成用户要求的数据查询，再选择一种输出路径。

## 路径选择

| 用户意图 | 路径 |
|---------|------|
| 明确要求聊天内图表或可视化 | 路径 A：内联 Widget |
| 明确要求保存或下载图像文件 | 路径 B：`render_chart` 输出 SVG 文件 |

不要因为用户使用“分析”“计算”“平均”“报告”或“CSV”这些词就加载本 Skill。

## 路径 A：内联 Widget

1. `query_database` → 按 spec Skill 的流程取数，在查询中把数据聚合到图表需要的粒度
2. `publish_query_result` 或 `export_query` → 发布结果，记下返回的 `receiptId`
3. `show_widget(kind="chart", spec=<ChartSpec>)` → 渲染交互图表
4. 输出简短的图表结论，并写明返回的 `[NOTICE]`、`[DISCLOSURE]`、`[SEMANTICS]`

`show_widget` 的当前合同只有以下 kind：`kpi`、`chart`、`table`、`steps`。参数名是 `spec`，不是 `config`。

`chart` 的 `spec` 是 ChartSpec v1，数据通过 `receiptId` 引用已发布的结果，不要把数据行写进 spec。最小合法示例：

```json chart-spec
{
  "version": 1,
  "title": "月度销售额",
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": { "sales": { "type": "quantitative", "label": "销售额", "storage": "raw", "unit": "元", "additivity": "additive" } },
  "chart": { "mark": "cartesian", "x": { "field": "month" }, "layers": [{ "type": "bar", "y": { "field": "sales" } }] }
}
```

- `chart`：聊天图表最多容纳 5000 行；更大的结果先在查询中聚合，或改用路径 B。类目很多时可以加 `"viewport": { "mode": "scroll", "window": 20 }`，让图表可以滚动查看。
- `kpi`：`spec` 至少包含数值型或字符串型 `value`，也可以使用 `data` 数组。
- `table`、`steps`：`spec` 必须包含 `data` 数组。表格的数值列需要显示为百分比、带单位或换算量级时，在 `spec.fields` 中按列名声明字段语义（与 ChartSpec 的 `fields` 写法相同）；未声明的数值按原样显示。
- 不要把自然语言结论塞进 `data`；结论放在普通回答中。

## 路径 B：保存图表文件

1. `search_knowledge` → 检索业务规则和图表风格
2. `query_database` → 按 spec Skill 的流程取数，在查询中把数据聚合到图表需要的粒度
3. `publish_query_result` 或 `export_query` → 发布结果，记下返回的 `receiptId`
4. `render_chart(spec, fileName)` → 渲染为 `charts/<fileName>.svg`
5. 输出文件链接、图注和简短结论

最小合法示例：

```json chart-spec
{
  "version": 1,
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": { "sales": { "type": "quantitative", "label": "销售额", "storage": "raw", "unit": "元", "additivity": "additive" } },
  "chart": { "mark": "cartesian", "x": { "field": "month" }, "layers": [{ "type": "line", "y": { "field": "sales" } }] }
}
```

- 度量字段必须声明 `type: "quantitative"`、`storage` 与 `additivity`；工具不聚合、不补零，出错时按返回的错误码与建议修改查询或 spec。
- 返回的 `[NOTICE]`、`[DISCLOSURE]`、`[SEMANTICS]` 写进图注。
- 返回 `[CHECK]` 时，先核对对应字段的 `storage`、`additivity` 声明：有误就改正 spec 重新渲染；确认无误才使用该图。
- 不使用 Python 绘图。

## ChartSpec 速查

规格是严格的：每一层只接受下面列出的键，多写一个键就会报 `SCHEMA_INVALID ... must not have additional properties`。

### `fields`：字段语义（按列名声明）

| `type` | 必填 | 可选 | 用于 |
|---|---|---|---|
| `quantitative` | `storage`（`raw` / `ratio` / `percent`）、`additivity`（`additive` / `non_additive`） | `label`、`unit`、`display`、`magnitude` | 度量 |
| `temporal` | `grain`（`year` / `quarter` / `month` / `week` / `day` / `hour` / `minute`）、`zone`（`"floating"` 或时区名） | `label` | 日期时间列 |
| `ordinal` | `order`（类目的先后顺序数组） | `label` | 有固定顺序的类目，如配送天数分档 |
| `nominal` | — | `label` | 普通类目，如支付方式、州 |

- 没有 `categorical` 这种 type，普通类目用 `nominal`，也可以不声明类目字段。
- 轴标题来自字段的 `label`；`x`、`y` 本身不接受 `label`。
- 比率、均值、占比是 `non_additive`；金额、件数是 `additive`。

### `chart.mark: "cartesian"`：柱、线、面积、散点

```json chart-spec
{
  "version": 1,
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": {
    "revenue": { "type": "quantitative", "label": "销售额", "storage": "raw", "unit": "BRL", "additivity": "additive" },
    "orders": { "type": "quantitative", "label": "订单量", "storage": "raw", "unit": "单", "additivity": "additive" }
  },
  "chart": {
    "mark": "cartesian",
    "x": { "field": "month" },
    "layers": [
      { "type": "bar", "y": { "field": "revenue" } },
      { "type": "line", "y": { "field": "orders", "axis": "right" } }
    ]
  }
}
```

- `x` 只有 `field`。
- 每层：`type`（`bar` / `line` / `area` / `scatter`）、`y: { field, axis? }`；可选 `series`、`label`、`size`、`id`（都是字段引用 `{ "field": "<列名>" }`，不是文字）、`stack`（`none` / `stacked` / `percent`）、`name`（图例名，文字）。`size`、`id` 只用于 scatter。
- 右轴写在 `y` 里：`"y": { "field": "...", "axis": "right" }`，不是写在层上。
- 横向条形图：`orientation: "horizontal"` 写在 `chart` 上（与 `mark` 同级），`x` 仍然是类目字段、`y` 仍然是度量，只是画成横向。横向图只支持 bar 与 line，且不能有右轴。
- `x` 声明为 `quantitative`（数值 x 轴）时，只能用 line、area、scatter，不能用 bar，也不能堆叠。
- 可选 `highlight`、`references`（参考线，取自查询里每行同值的列）、`bands`。

### `chart.mark: "pie"`：构成

```json chart-spec
{
  "version": 1,
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": { "amount": { "type": "quantitative", "label": "支付金额", "storage": "raw", "unit": "BRL", "additivity": "additive" } },
  "chart": { "mark": "pie", "category": { "field": "payment_type" }, "value": { "field": "amount" } }
}
```

- 只有 `category`、`value`、`donut`，没有 `x` 和 `layers`。
- `value` 用可加的原始量（金额、件数），不要用占比列：占比是 `non_additive`，会被拒绝（`NON_ADDITIVE_PART_OF_WHOLE`）；饼图自己按原始量算占比。

### 其他

- 类目过多：`"selection": { "kind": "top_n", "by": "<度量字段>", "n": 10, "order": "desc" }`，或给 `render_chart` 更大的画布（竖向图加 `width`，横向图加 `height`）；编译器不会自行删减数据。
- 其他 mark（括号内为必填键，除注明外都是 `{ "field": ... }`；数据都要在查询里算好）：
  - `heatmap`（`x`、`y`、`color: { field, scale?, midpoint? }`）
  - `histogram`（`start`、`end`、`value`，每行一个分箱）
  - `boxplot`（`category`、`min`、`q1`、`median`、`q3`、`max`、`whisker`：`"min_max"` 或 `"iqr_1_5"`）
  - `waterfall`（`step`、`start`、`end`，可选 `total`）
  - `sankey`（`source`、`target`、`value`，每行一条流）
  - `treemap`、`sunburst`（`path`：1–4 个字段引用的数组、`value`，每行一个叶子）
  - `funnel`（`stage`、`value`，按行序）

### 常见报错

| 报错 | 原因与改法 |
|---|---|
| `must not have additional properties (/chart/x)` | `x` 里写了 `label` 等多余键；只留 `field`，标题写在 `fields.<列>.label` |
| `must not have additional properties (/chart/layers/N)` | 层上写了 `axis` 或 `orientation`；`axis` 移到 `y` 里，`orientation` 移到 `chart` 上 |
| `must be equal to constant (/fields/<列>/type)` | type 写错（如 `categorical`）；用上表四种之一 |
| `INVALID_ENCODING ... bar 需要类目 x 轴` | `x` 列被声明为 `quantitative`：画柱形就把 `x` 声明为 `nominal`/`ordinal`（或不声明）；要横向条形图则 `x` 放类目、加 `"orientation": "horizontal"`，度量放在 `y` |
| `INVALID_ENCODING ... 横向图只支持 ... bar 与 line` / `横向图不支持右侧数值轴` | 横向图只能用 bar、line，去掉右轴；需要双轴就改回竖向 |
| `NON_ADDITIVE_PART_OF_WHOLE` | 饼图或堆叠用了占比、均值；改用可加的原始量 |
| `CAPACITY_EXCEEDED` | 类目放不下；加 `selection` 取前 N，或加大画布（竖向图 `width`，横向图 `height`），或改成横向图 |

## 图表规范

- 标注清晰、标题简洁；配色由工具统一提供，不要自行指定。
- 图表数据必须来自已发布的查询结果。
- 文件下载链接使用普通 Markdown 链接，不用 Widget 代替文件交付。
