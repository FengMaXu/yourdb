---
name: dashboard
description: 生成商用级别的 HTML BI 快照看板
allowed-tools:
  - query_database
  - generate_dashboard
  - search_knowledge
  - read_knowledge
---

# 商用级 HTML BI 快照看板

## 目标

生成可以直接交付给业务人员、数据分析师或管理层的独立 HTML **BI 看板**：打开第一屏就能看到头部指标和主要图表，往下翻只是看分解与明细。版面是几行格子（KPI 一行、趋势一行、分解一行、明细在最后），不是一图一屏的长报告。HTML 看板本身就是交付物，下载链接只作为文件获取入口；不要把复杂看板拆成 widget 卡片。

看板是**快照**：每个视图的数据都来自一次已发布的查询结果，生成后不再变化。本 Skill 只描述 `generate_dashboard` 当前实际支持的能力，不要向用户承诺“暂不支持”中列出的功能。

## 当前能力

| 支持 | 暂不支持（不要写进 spec，也不要向用户承诺） |
| --- | --- |
| KPI 卡片、柱形、折线、散点、柱线组合、双 y 轴、堆叠、横向条形、环形饼图、热力图、直方图、箱线图、瀑布图、桑基图、树图、旭日图、面积与堆叠面积、漏斗图、表格；柱形、折线、散点上的重点高亮、参考线与区间标注；结论（`insights`）、KPI 趋势线、表格单元格条形与高低着色 | 页面筛选器、点击下钻、交叉联动 |
| 按行排版：每行 1–4 个格子，可设宽度比例与行高（`compact`、`standard`、`tall`）；图表 tooltip、图例、随窗口缩放；手机上自动单列 | 任意像素尺寸、拖拽排版、导出按钮 |
| 按完整 spec 重新生成并覆盖已有看板 | 读取已有看板后局部修改 |
| 实时数据：视图引用 `{ "kind": "live", "receiptId": ... }`，在应用内打开时可点击刷新 | 定时自动刷新、参数化查询 |

## 推荐流程

1. **理解需求**：明确核心问题（趋势、结构、对比、排名、明细）、受众、时间范围与粒度。用户没有说明但数据可以推断时，先做合理假设，并在最终答复中写明。
2. **先拆解，再下结论**：看板的价值在于回答“为什么”和“先管哪里”，而不是罗列指标。对核心指标做三步拆解再写结论：
   - **构成**：它由哪几部分组成？各部分占多少量、贡献多少结果？（如“延迟订单占 6.7% 的量、贡献 32.6% 的差评”。占比与贡献差距最大的部分就是重点。）
   - **基准**：与什么比？全站均值、目标、上期、同类。没有基准的数字回答不了好坏。
   - **时间**：何时变好或变坏？有没有与事件（大促、政策）同步的峰值？
   拆解中最出人意料、最能指导行动的 2–4 个发现写成 `insights`；不能被数据解释的部分也要说出来（如“三分之二的差评与物流无关”），这本身就是发现。
3. **定版面**：按下文“版面”把结论、KPI、主图、诊断图和明细分配到各行。每个视图只承担一个结论，并在图上用 `highlight` 标出这个结论所在、用 `references` 给出基准。
4. **取数并发布**：每个视图需要的数据按 spec Skill 的流程用 `query_database` 查询，**在查询中聚合到视图需要的粒度**，排名在查询中排好序，再用 `publish_query_result` 或 `export_query` 发布，记下返回的 `receiptId`。多个视图可以共用同一个结果。KPI 要的“最新一期数值 + 同比/环比”最好单独查一行或几行；参考线和表格对比要的基准（全站均值、目标）用窗口函数输出到每一行；结论的数字单独发布一个“发现”结果。
   按 spec Skill 的“报告与看板”一节取数：先用一个报告任务声明各视图共用的统计总体（`population.*`）和各度量定义（`measures.<名字>`），再为每个视图建一个图表查询，只写度量引用、分组、选取和输出。报告任务处理完后，各图表查询的结果查询可以在同一轮里并行发出。
5. **设计 spec**：见下文结构、版面与视图写法。
6. **校验并生成**：`generate_dashboard(operation="validate", spec)`。返回 `[LAYOUT]` 建议时先按建议调整 `layout` 或视图，再校验；通过后 `operation="create"`。
7. **最终答复**：见文末格式。

## 调用方式

```text
generate_dashboard(operation, spec, editPath?)
```

- `operation`：`"validate"` 只校验，成功返回 `dashboard spec valid`；`"create"` 生成新看板，返回 `[DASHBOARD_CREATED] dashboards/<filename>.html`；`"edit"` 用完整 spec 重新生成并覆盖 `editPath`（形如 `dashboards/<name>.html`）。
- `edit` 不读取旧看板，必须提供修改后的**完整** spec。旧版（v3）看板也用这种方式按新 spec 重建。
- 失败时返回 `DASHBOARD_SPEC_INVALID` 和逐条的 `[错误码] 说明 (路径)；建议：…`，按错误修改查询或 spec 后重试，不要绕过校验。
- 成功时还可能返回 `[LAYOUT]`（版面建议，不阻断生成）、`[NOTICE]`（图表的展示处理）、`[CHECK]`（字段声明可疑）。

## Spec 结构

```json dashboard-spec
{
  "version": 1,
  "title": "批发、零售、餐饮三大行业经营看板",
  "subtitle": "本年1月至当月累计销售额 · 三大行业 2026-02~07，细分行业为 2026-07 · 单位：亿元 / %",
  "filename": "industry_dashboard",
  "views": [
    {
      "id": "key_findings",
      "type": "insights",
      "title": "本期结论",
      "data": { "kind": "publication", "receiptId": "<receiptId>" },
      "fields": { "value": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" } },
      "items": [
        { "value": { "field": "value" }, "where": { "finding": "retail_yoy" }, "tone": "good", "text": "零售业同比增速 7 月升至 38%，三大行业中最快" },
        { "value": { "field": "value" }, "where": { "finding": "wholesale_share" }, "text": "批发业贡献了三大行业累计销售额的九成，决定整体走势" }
      ]
    },
    {
      "id": "kpi_latest",
      "type": "kpi",
      "title": "2026年1–7月累计销售额",
      "data": { "kind": "publication", "receiptId": "<receiptId>" },
      "fields": {
        "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "累计销售额" },
        "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" }
      },
      "cards": [
        { "label": "批发业", "value": { "field": "sales" }, "delta": { "field": "yoy", "label": "同比" }, "where": { "industry": "批发业" } },
        { "label": "零售业", "value": { "field": "sales" }, "delta": { "field": "yoy", "label": "同比" }, "where": { "industry": "零售业" } },
        { "label": "餐饮业", "value": { "field": "sales" }, "delta": { "field": "yoy", "label": "同比" }, "where": { "industry": "餐饮业" } }
      ]
    },
    {
      "id": "growth_trend",
      "type": "chart",
      "chart": {
        "version": 1,
        "title": "零售业增速 7 月升至 38%，餐饮业逐月回落",
        "subtitle": "累计销售额同比增速（%）",
        "data": { "kind": "publication", "receiptId": "<receiptId>" },
        "fields": {
          "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" },
          "month": { "type": "temporal", "grain": "month", "zone": "floating" }
        },
        "chart": { "mark": "cartesian", "x": { "field": "month" }, "layers": [{ "type": "line", "y": { "field": "yoy" }, "series": { "field": "industry", "order": ["批发业", "零售业", "餐饮业"] } }] }
      }
    },
    {
      "id": "sales_share",
      "type": "chart",
      "chart": {
        "version": 1,
        "title": "批发业占三大行业销售额九成以上",
        "subtitle": "2026年1–7月累计销售额（亿元）",
        "data": { "kind": "publication", "receiptId": "<receiptId>" },
        "fields": { "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "累计销售额" } },
        "chart": { "mark": "pie", "category": { "field": "industry" }, "value": { "field": "sales" } }
      }
    },
    {
      "id": "wholesale_rank",
      "type": "chart",
      "chart": {
        "version": 1,
        "title": "批发：机械设备与电子产品批发占一半，同比 +53.5%",
        "subtitle": "累计销售额（亿元）· 标签为同比增速",
        "data": { "kind": "publication", "receiptId": "<receiptId>" },
        "fields": {
          "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "累计销售额" },
          "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" }
        },
        "chart": { "mark": "cartesian", "orientation": "horizontal", "x": { "field": "sub_industry" }, "layers": [{ "type": "bar", "y": { "field": "sales" }, "label": { "field": "yoy" } }] }
      }
    },
    {
      "id": "retail_rank",
      "type": "chart",
      "chart": {
        "version": 1,
        "title": "零售：无店铺零售领跑，同比 +82.2%",
        "subtitle": "累计销售额（亿元）· 标签为同比增速",
        "data": { "kind": "publication", "receiptId": "<receiptId>" },
        "fields": {
          "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "累计销售额" },
          "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" }
        },
        "chart": { "mark": "cartesian", "orientation": "horizontal", "x": { "field": "sub_industry" }, "layers": [{ "type": "bar", "y": { "field": "sales" }, "label": { "field": "yoy" } }] }
      }
    }
  ],
  "layout": {
    "rows": [
      { "views": ["key_findings"] },
      { "views": ["kpi_latest"] },
      { "views": ["growth_trend", "sales_share"], "widths": [2, 1] },
      { "views": ["wholesale_rank", "retail_rank"] }
    ]
  }
}
```

- 必填：`version: 1`、`title`、至少一个视图。`filename` 省略时按内容生成文件名。
- 每个视图有唯一的 `id`（字母、数字、`_`、`-`）和 `type`：`insights`、`kpi`、`chart`、`table`。
- 数据一律是 `{ "kind": "publication", "receiptId": "<receiptId>" }`，引用已发布的结果。不要把数据行写进 spec，也不要引用工作区里的 CSV。
- `title` 写看板回答的业务问题，用业务名称（“即时配送运营看板”），不要写库名、表名或 schema 名（`delivery_center`）；`subtitle` 写口径、时间范围和单位：每个格子不再重复这些信息。`subtitle` 的各部分用 ` · ` 分隔，页头把每部分显示为一个短标签，所以每部分写短（如 `2017-01–2018-08 · 有效订单 · 单位：% / 天`），不要写成一整句。
- 新看板一律写 `layout`。视图上的旧字段 `width`（`"half"`/`"full"`）只在没有 `layout` 时生效，用于旧看板；不要再写。

## 版面

`layout.rows` 从上到下列出每一行，每行的 `views` 从左到右列出 1–4 个视图 `id`。每个视图恰好出现在一行里。

- `widths`：每个格子的相对宽度，与 `views` 一一对应，如 `[2, 1]` 表示左格占三分之二；省略时等宽。
- `height`：这一行图表的高度。`compact`（矮，适合一行 3–4 个小图）、`standard`（默认）、`tall`（类目多的横向条形、热力图）。KPI 和表格按内容自适应。
- 只有一个 KPI 视图的行显示为一排独立的指标卡；KPI 与图表同行时，卡片竖排在一个格子里。

### 组织方式

按“总览 → 趋势 → 分解”从上到下排；用户要求明细时再在最后加一行表格：

| 行 | 放什么 | 写法 |
| --- | --- | --- |
| 第 1 行 结论 | 2–4 条结论，每条一个数字 + 一句话 | 一个 `insights` 视图独占一行，或与一个带趋势线的 `kpi` 同行（`widths: [2, 1]`） |
| 第 2 行 KPI | 3–6 个头部指标：最新一期数值 + 同比/环比/目标差 | 一个 `kpi` 视图独占一行 |
| 第 2 行 趋势 | 主趋势图 + 一张补充图（构成、当期对比） | `widths: [2, 1]` 或 `[3, 2]`；只有一张趋势图时可独占一行 |
| 第 3 行 分解 | 2–3 张排名、构成或分布图 | 等宽；3 张时用 `compact` 或 `standard` |
| 最后一行 明细（仅在用户要求时） | 可核对的明细或带多个指标的排名 | `table` 独占一行；放汇总或 Top N，长明细用 `export_query` 提供下载 |

- 第一屏（约 1440×900）应能看到结论、KPI 行和趋势行。
- **整行图最多一张**，通常是主趋势图。多张图各占一行会把看板拉成报告，工具会返回 `[LAYOUT]`。
- 一张看板 4–8 个视图、不超过 4 行图表。结论更多时拆成两张看板，不要往下堆。
- 默认不放表格；用户要求明细时，表格放在所有图表之后。

### 格子容量

格子越窄，能承载的类目和系列越少。按格子宽度选图：

| 格子 | 约宽（桌面） | 适合 |
| --- | --- | --- |
| 一行 4 格 | 320px | KPI、环形（≤4 类）、单系列迷你折线；横向条形的类目名只剩约 7 个字，类目名长时不要放这里 |
| 一行 3 格 | 430px | ≤6 类横向条形（类目名截到约 10 个字）、单系列折线、环形（≤5 类） |
| 一行 2 格 | 670px | ≤12 类、≤3 系列的折线或柱形，横向条形 Top 10 |
| 整行 | 1360px | 热力图、长时间序列、4–6 个系列、超过 12 个类目 |

类目标签在格子里放不下时工具会旋转标签并返回 `[LAYOUT]`：改为 `orientation: "horizontal"`，或给这个格子更大的宽度。

## 实时数据

用户希望看板能更新时，把视图的数据写成 `{ "kind": "live", "receiptId": "<receiptId>" }`。生成时与普通发布结果一样读取该结果；在应用内打开看板时，这类视图显示数据版本和“刷新数据”按钮，刷新会用同一版 Answer Spec 重新执行该查询并生成新的发布记录，看板随之更新。

- 刷新不改查询、不改口径，也不接受参数；需要不同口径时重新查询、发布并重建看板。
- 看板文件本身不因刷新改变；离开应用打开时显示生成时的数据。
- 不需要更新的视图继续用 `publication`。

## 字段语义

度量字段必须在 `fields` 中声明语义，工具据此换算与显示单位，不会猜测：

- `type: "quantitative"`，`storage`：存储值的含义（`raw` 原值、`ratio` 0.12 表示 12%、`percent` 12 表示 12%），`additivity`：`additive` 或 `non_additive`（比率、均值、单价都是不可加）。
- 可选 `unit`（如 `"亿元"`）、`label`、`magnitude`（如 `{ "stored": 1, "shown": 100000000 }` 把元显示为亿元）。
- 空值保持为空：折线断开、柱留空、表格单元格留白，不会按 0 画。
- 字段语义由你声明，工具在返回中以 `[SEMANTICS]` 标注“来自模型声明，未经业务定义核实”；看板页面不印这条，由你在答复中转述。
- 工具会用发布时扫描得到的数值范围核对声明，可疑时返回 `[CHECK]`（例如声明为比率却出现 5234）并显示在视图下方。先核对声明：有误就改正 spec，用 `edit` 重建看板。

## 视图写法

### 图表（`chart`）

`chart` 是一个完整的 ChartSpec v1，写法与 `render_chart`、`show_widget` 相同：标题、副标题写在 ChartSpec 里。排名与带第二个指标的类目比较，按上文 Spec 示例写成横向条形加 `label`（柱上标出同比等第二个指标）。

需要同时看绝对量和比率的走势、且类目少而短时，才用柱线组合加右侧数值轴：

```json dashboard-view
{
  "id": "industry_sales_growth",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "三大行业累计销售额与同比增速",
    "subtitle": "销售额为柱形，增速为折线",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "累计销售额" },
      "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" }
    },
    "chart": {
      "mark": "cartesian",
      "x": { "field": "industry" },
      "layers": [
        { "type": "bar", "y": { "field": "sales" } },
        { "type": "line", "y": { "field": "yoy", "axis": "right" } }
      ]
    }
  }
}
```

长表中一个指标按某个维度拆成多条线或多组柱时，用图层的 `series`：

```json dashboard-view
{
  "id": "industry_trend",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "三大行业同比增速走势",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": { "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" } },
    "chart": {
      "mark": "cartesian",
      "x": { "field": "month" },
      "layers": [{ "type": "line", "y": { "field": "yoy" }, "series": { "field": "industry", "order": ["批发业", "零售业", "餐饮业"] } }]
    }
  }
}
```

环形饼图只用于可加指标的完整构成，值不能为负、不能有空值：

```json dashboard-view
{
  "id": "industry_share",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "三大行业销售额构成",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": { "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive" } },
    "chart": { "mark": "pie", "category": { "field": "industry" }, "value": { "field": "sales" } }
  }
}
```

两个维度交叉比较一个指标时用热力图：每个 (x, y) 单元格一行，缺失的组合留白。颜色有正负含义时用 `scale: "diverging"` 并声明中点 `midpoint`（与数据同单位，如同比的 0），否则用默认的顺序色阶：

```json dashboard-view
{
  "id": "growth_heatmap",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "各行业月度同比增速",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "同比增速" },
      "month": { "type": "temporal", "grain": "month", "zone": "floating" }
    },
    "chart": { "mark": "heatmap", "x": { "field": "month" }, "y": { "field": "industry" }, "color": { "field": "yoy", "scale": "diverging", "midpoint": 0 } }
  }
}
```

分布用直方图或箱线图，分箱与统计量都在查询中算好，工具不分箱、不计算统计量：

```json dashboard-view
{
  "id": "order_amount_hist",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "订单金额分布",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "bin_start": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "additive", "label": "订单金额" },
      "bin_end": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "additive" },
      "orders": { "type": "quantitative", "storage": "raw", "unit": "单", "additivity": "additive", "label": "订单数" }
    },
    "chart": { "mark": "histogram", "start": { "field": "bin_start" }, "end": { "field": "bin_end" }, "value": { "field": "orders" } }
  }
}
```

```json dashboard-view
{
  "id": "price_box",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "各区域单价分布",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "p_min": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "non_additive" },
      "p_q1": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "non_additive" },
      "p_median": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "non_additive", "label": "单价" },
      "p_q3": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "non_additive" },
      "p_max": { "type": "quantitative", "storage": "raw", "unit": "元", "additivity": "non_additive" }
    },
    "chart": { "mark": "boxplot", "category": { "field": "region" }, "min": { "field": "p_min" }, "q1": { "field": "p_q1" }, "median": { "field": "p_median" }, "q3": { "field": "p_q3" }, "max": { "field": "p_max" }, "whisker": "min_max" }
  }
}
```

- 直方图每行一个分箱（左闭右开、互不重叠），区间重叠返回 `BIN_OVERLAP`。
- 箱线图每个类目一行，五个统计量须满足 最小值 ≤ Q1 ≤ 中位数 ≤ Q3 ≤ 最大值，否则返回 `STAT_ORDER_VIOLATION`；`whisker` 必须写明须线含义（`min_max` 或 `iqr_1_5`），会随图说明。

从期初到期末的增减拆解用瀑布图：每一步的起点 `start` 与终点 `end` 都由查询算好（累计在 SQL 中完成），按行顺序衔接；合计行（`total` 列为 true）从 0 开始：

```json dashboard-view
{
  "id": "profit_bridge",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "利润变动拆解",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "run_start": { "type": "quantitative", "storage": "raw", "unit": "万元", "additivity": "non_additive" },
      "run_end": { "type": "quantitative", "storage": "raw", "unit": "万元", "additivity": "non_additive", "label": "利润" }
    },
    "chart": { "mark": "waterfall", "step": { "field": "item" }, "start": { "field": "run_start" }, "end": { "field": "run_end" }, "total": { "field": "is_total" } }
  }
}
```

- 每一步的 `start` 须等于上一步的 `end`，合计行须从 0 开始且等于上一步的 `end`，否则返回 `RANGE_INCONSISTENT`。柱上标注的是查询给出的 `end`。

随时间累积的总量及其构成用面积图：图层 `type: "area"`，加 `stack: "stacked"` 与 `series` 即为堆叠面积，规则与堆叠柱形相同（可加、完整、非负）。

逐级转化用漏斗图：每个阶段一行，按行顺序排列，只显示各阶段自己的数值（转化率需要时在查询中算好，放进表格或 KPI）；值须为非负且不为空，否则返回 `VALUE_OUT_OF_DOMAIN`：

```json dashboard-view
{
  "id": "signup_funnel",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "注册转化漏斗",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": { "users": { "type": "quantitative", "storage": "raw", "unit": "人", "additivity": "additive", "label": "人数" } },
    "chart": { "mark": "funnel", "stage": { "field": "stage" }, "value": { "field": "users" } }
  }
}
```

层级构成也可以用旭日图，数据形态与规则同树图（`"mark": "sunburst"`，`path` 最多 4 层）。

流向（如转化路径）用桑基图，层级构成用树图。两者都属于部分与整体，度量须可加、完整、非负：

```json dashboard-view
{
  "id": "funnel_flow",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "访问到付费的流向",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": { "users": { "type": "quantitative", "storage": "raw", "unit": "人", "additivity": "additive", "label": "人数" } },
    "chart": { "mark": "sankey", "source": { "field": "from_stage" }, "target": { "field": "to_stage" }, "value": { "field": "users" } }
  }
}
```

```json dashboard-view
{
  "id": "sales_tree",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "行业销售额构成",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": { "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "销售额" } },
    "chart": { "mark": "treemap", "path": [{ "field": "sector" }, { "field": "industry" }], "value": { "field": "sales" } }
  }
}
```

- 桑基图每条流向（来源、去向）一行；流向成环返回 `FLOW_CYCLE`。节点大小是连线之和。
- 树图只接受叶子行，每行带完整路径（最多 4 层）；上层面积是叶子之和。路径重复返回 `DUPLICATE_KEY`。

图表约束（工具以结构化错误返回，不会自行修复）：

- **同一个 x 值（或 x 加系列值）只能有一行**，否则返回 `DUPLICATE_KEY`。在查询中聚合到图表粒度；散点图允许重复坐标。
- 堆叠、百分比堆叠、饼图要求度量可加、完整、非负，否则返回 `NON_ADDITIVE_PART_OF_WHOLE`、`INCOMPLETE_PART_OF_WHOLE`、`NEGATIVE_IN_PART_OF_WHOLE`。
- 类别太多时用 ChartSpec 的 `selection: { "kind": "top_n", ... }` 显式声明 Top-N，或在查询中筛选；不能与饼图、堆叠同时使用。
- 同一张图不超过 2 个量纲（左右两个 y 轴）；超过时拆成多张图。

### 突出重点、参考线与区间

一张图只讲一个结论时，让读者一眼看到结论所在：用 `highlight` 点名重点，用 `references` 给出比较基准，用 `bands` 标出时间段。三者都写在 cartesian 图的 `chart` 里。

```json dashboard-view
{
  "id": "route_delay",
  "type": "chart",
  "chart": {
    "version": 1,
    "title": "发往 SP 的线路延迟最严重，RJ→SP 量大且延迟率 14.1%",
    "subtitle": "订单量 Top 20 线路中延迟率最高的 5 条 · 虚线为全站延迟率 · 标签为订单量",
    "data": { "kind": "publication", "receiptId": "<receiptId>" },
    "fields": {
      "delay_rate": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "延迟率" },
      "site_delay_rate": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "全站延迟率" },
      "orders": { "type": "quantitative", "storage": "raw", "unit": "单", "additivity": "additive" }
    },
    "chart": {
      "mark": "cartesian",
      "orientation": "horizontal",
      "x": { "field": "route" },
      "layers": [{ "type": "bar", "y": { "field": "delay_rate" }, "label": { "field": "orders" } }],
      "highlight": { "values": ["RJ->SP"], "tone": "bad" },
      "references": [{ "field": "site_delay_rate", "label": "全站" }]
    }
  }
}
```

- `highlight.values`：要突出的 x 类目（散点图写图层 `id` 列的值），最多 5 个。被点名的柱或点用 `tone` 的颜色，其余退为浅灰背景色。`tone`：`focus`（默认，橙红，中性的“看这里”）、`bad`（红，问题、未达标）、`good`（绿，达标、改善）。只用于单系列图；值不在数据中返回 `VALUE_OUT_OF_DOMAIN`。
- `highlight.layer`：图里有两个柱（或散点）图层时，写重点所在图层的下标（从 0 开始），其余柱图层整体退为更浅的背景。典型用法是“占比对照”：同一组类目上并排画“订单占比”和“差评占比”两层，`layer` 指向差评占比、`values` 点名问题类目，读者一眼看出哪些类目的结果占比远超其体量占比。两层同一单位时数值轴只标单位，由图例区分两层。
- `references`：参考线的值**来自数据集里的一列**，这一列每行都是同一个数，例如在查询里用窗口函数或子查询把全站均值、目标值输出到每一行（`AVG(x) OVER ()`）。spec 里不写数字。参考线画在 `axis`（默认 `left`）所在的数值轴上，字段的语义要与该轴的度量一致；各行取值不同或单位不同返回 `INVALID_ENCODING`。
- `bands`：在类目 x 轴上标出一段区间（如大促月份），`from`、`to` 写 x 轴上显示的值（月份写 `2017-11`），`to` 省略时只标一个类目。
- 一张图最多一个重点：同时点名多个类目时，它们应是同一个结论（如“发往 SP 的三条线路”）。

### 结论（`insights`）

看板第一行给出答案。每条结论是**一个数字加一句话**：数字读自已发布结果的一个单元格（与 KPI 卡片一样只读、不聚合），句子由你撰写，说明这个数字意味着什么、该做什么。

```json dashboard-view
{
  "id": "key_findings",
  "type": "insights",
  "title": "本期结论",
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": { "value": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" } },
  "items": [
    { "value": { "field": "value" }, "where": { "finding": "late_share_of_negatives" }, "tone": "bad", "text": "延迟送达只占订单的 6.7%，却贡献了 32.6% 的差评；优先治理延迟 3 天以上的订单" },
    { "value": { "field": "value" }, "where": { "finding": "on_time_share_of_negatives" }, "text": "三分之二的差评来自准时订单：物流只解释一部分，商品与描述需要单独排查" }
  ]
}
```

- 结论的数字在查询中算好并发布：常见做法是一个“发现”结果，每行一条（`finding` 列标识、`value` 列取值），用 `where` 选出。不同单位的结论放在不同列，分别在 `fields` 中声明。
- 句子只复述已发布结果中的数字，**不引入新数字**；写清对象、比较对象和含义，最好带一个动作。每句不超过 160 字。
- 大号数字已经显示在句子旁边，句子**不要以同一个数字开头**再念一遍（不写“98.03% 的配送单为已送达…”，写“配送单几乎全部送达，取消与在途合计不到 2%，异常面很窄”）。
- `tone`：`bad` 问题、`good` 改善、`focus` 中性重点，缺省为正文色。颜色只给真正需要读者先看的那一条：一组结论里 `focus` 最多一条，其余缺省；不要每条都着色。
- `tone` 表达**好坏**，不表达排名：三个行业都在正增长时，“增速最低的 +8.7%”不是问题，不写 `bad`（红色会让读者以为在下滑）；只有下滑、未达标、异常才写 `bad`。
- 2–4 条，按重要性排序。好结论来自拆解：先问“这个指标由哪几部分组成、哪部分贡献最大、与基准差多少”，再取数。只是重复 KPI 数值的句子不算结论。

### KPI 卡片（`kpi`）

每张卡片显示结果中**一个单元格**，不做求和或平均。结果只有一行时直接引用字段；有多行时用 `where` 选出唯一的一行。增速、占比等要在查询中算好，放在 `delta` 字段：

```json dashboard-view
{
  "id": "kpi_by_industry",
  "type": "kpi",
  "title": "分行业销售额",
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": {
    "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive", "label": "销售额" },
    "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" }
  },
  "cards": [
    { "label": "批发业", "value": { "field": "sales" }, "delta": { "field": "yoy", "label": "同比", "good": "up" }, "where": { "industry": "批发业" } },
    { "label": "零售业", "value": { "field": "sales" }, "delta": { "field": "yoy", "label": "同比", "good": "up" }, "where": { "industry": "零售业" } }
  ]
}
```

- 卡片最多 8 张，头部 KPI 行放 3–6 张。`label` 缺省时用字段的 `label` 或列名。
- 数值显示为约四位有效数字的大号数字加小号单位（如 4,872 亿元），完整值在悬停提示里。`value` 与 `delta` 都要在 `fields` 中声明语义，未声明的按原值显示。不要为了好看在查询里四舍五入。
- `delta` 有两种，用 `kind` 区分：
  - `"change"`（缺省）：有方向的对比，如同比、环比、与目标的差，显示正负号和升降箭头。**写 `good` 声明哪个方向是改善**：收入、送达率写 `"good": "up"`，成本、延迟率、取消率写 `"good": "down"`；箭头按好坏着绿色或红色。不写 `good` 时箭头为中性灰，不会把上升默认画成红色警告。
  - `"context"`：没有方向的背景数字，如占总体的比例、样本量，显示为“占比 98.0%”，不带正负号、箭头和颜色。**占比、构成不是变化，不要写成 `change`**，否则“已送达占比 98%”会显示成“▲ +98.0%”。
- 每张卡尽量给一个对比：同比、环比或与目标的差。只有快照、没有历史期时，用 `kind: "context"` 给占比，并在最终答复中说明缺少时间对比。
- 匹配不到行返回 `KPI_ROW_NOT_FOUND`；匹配到多行时，这些行在显示的单元格上取值必须相同（如每个月份行都带同一个全期合计），否则返回 `KPI_ROW_AMBIGUOUS`。
- `trend`：在卡片上画一条趋势线，读取该视图结果的**全部行**，按 `x` 排序取 `y`。做法是发布一个按期一行的结果，卡片的数值放在每行都相同的列里：

```json dashboard-view
{
  "id": "kpi_negative_rate",
  "type": "kpi",
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "fields": {
    "period_rate": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive", "label": "差评率" },
    "monthly_rate": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" }
  },
  "cards": [{ "label": "差评率（1–2 星）", "value": { "field": "period_rate" }, "trend": { "x": { "field": "month" }, "y": { "field": "monthly_rate" } } }]
}
```

  每个 `x` 只能有一行（否则 `DUPLICATE_KEY`），`y` 要声明数值语义。有趋势线的卡片与结论同行时，趋势线占满格子宽度。

### 表格（`table`）

**看板默认不放表格。** 只有用户要求明细、清单或可核对的数字时才加 `table`，放在所有图表之后。

表格显示结果的全部行（每个结果最多 5000 行），表头固定、超过一屏时在表内滚动。`columns` 省略时显示全部列；在 `fields` 中声明的数值列右对齐：同一列小数位一致，单位写在表头（百分号留在单元格）。未声明的按原值显示，所以：

- 日期、月份列必须声明 `{ "type": "temporal", "grain": "month", "zone": "floating" }` 这类语义，否则 `2025-12` 会显示成 `2025-12-01`，返回中出现 `[NOTICE] … TEMPORAL_UNDECLARED`。
- 列的 `label` 不要再写单位，表头会自动加上。
- 看板里的表格放汇总或 Top N，一般不超过 20 行；长明细用 `export_query` 提供下载。
- 列可加 `"bar": true`，在单元格里画出按本列最大值缩放的条形；加 `"compare": { "field": "<同一行的基准列>", "above": "bad" }`，高于基准的单元格着色（`bad` 红、`good` 绿）。基准列（如全站均值）在查询中输出到每一行。两者都要求该列在 `fields` 中声明为数值。


```json dashboard-view
{
  "id": "industry_detail",
  "type": "table",
  "title": "重点行业明细",
  "data": { "kind": "publication", "receiptId": "<receiptId>" },
  "columns": [
    { "field": "industry_name", "label": "行业中类" },
    { "field": "month", "label": "月份" },
    { "field": "sales", "label": "销售额" },
    { "field": "yoy", "label": "同比增速", "bar": true, "compare": { "field": "industry_yoy", "above": "good" } }
  ],
  "fields": {
    "month": { "type": "temporal", "grain": "month", "zone": "floating" },
    "sales": { "type": "quantitative", "storage": "raw", "unit": "亿元", "additivity": "additive" },
    "yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" },
    "industry_yoy": { "type": "quantitative", "storage": "ratio", "additivity": "non_additive" }
  }
}
```

## 设计方法与硬约束

1. 先判数据形状，再选视图。至少比较两个能承载同一数据的候选，按业务问题、标签容量、格子宽度和阅读速度选择，不按“哪个图最炫”选择。
2. **视图数由结论数决定。** 每个视图只承担一个独立结论；两个视图表达同一结论时只留更合适的一个，不为凑满版面加图。
3. **标题写结论。** 如“零售业增速 7 月升至 38%”，而不是“零售业增速走势”；数据没有明确结论时写“对象 + 指标”。不写“柱状图”等图型名；单位、口径、筛选范围写进副标题。
4. **一两个数字不画图。** 只有 1–2 个值时放进 KPI 卡或标题；图表留给趋势、排名、构成和分布。
5. **标签横着读。** 类目名长（中文超过 6 个字）或类目超过 6 个时用 `orientation: "horizontal"` 的横向条形，并在查询中按数值降序；不要让标签旋转。
6. **第二个指标优先放标签。** 排名柱上标同比、占比等第二个指标用图层的 `label`；只有需要看比率走势时才用右侧数值轴，同一张图不超过 2 个量纲。
7. **对比要有参照。** 趋势图给出比较对象（多个系列、同比或目标）；KPI 卡给出 delta 或 trend；排名和分布图用 `references` 画出均值或目标线。
8. **一张图一个重点。** 结论落在某个类目或某个点上时用 `highlight` 点名它，其余自动退为背景色；不要所有柱子同色、让读者自己找。时间上的事件（大促、政策）用 `bands` 标出。
9. **类目用读者的语言。** 编码、外文或带排序前缀的值（如 `1_提前送达`、`moveis_escritorio`）不要直接上图：有字典表时在查询中关联出中文名；类目有固定顺序时在 `fields` 中声明 `{ "type": "ordinal", "order": [...] }`，不要在值前加序号。空值在查询中改写为“未分类”等可读名称。
10. 图表不诚实时拒绝：占比类别超过 5 个时改用排序后的条形图或表格；超过 6 个系列时拆图。**最大一类超过 90% 时不画环形**：其余扇区细到读不出，把这个占比写进 KPI 卡或结论，其余类目用条形图比较。
11. 一张看板回答一个业务问题；简约胜于炫技，优先 KPI、折线、横向条形、环形、表格。
12. **同一个数字只出现一次。** 结论、KPI 卡和图表各说不同的事：结论说“意味着什么”，KPI 给头部数值和对比，图表给拆解。KPI 已经给出各状态的单数和占比时，不要再画同一结果的环形图；腾出的格子放回答“为什么”的拆解（按区域、时段、门店的取消率等）。
13. **长尾先截断。** 排名超过 12 个类目时，在查询中取 Top 8 并把其余合并为一行“其他”；不要把 15 根条形摆满一整行。横向条形不要独占整行，与另一张图同行。条形数超过 8 根时这一行用 `height: "tall"`，否则每根条形细到读不出。
14. **累计值不跨期连线。** “本年累计”类指标每年 1 月归零，跨年画成一条折线会在年初出现断崖，读者会误读为暴跌。按年拆成系列（`series` 为年份、x 为月份），或改画当月值；同比增速不受影响，可以连续画。

| 数据形状 | 视图 |
| --- | --- |
| 3–6 个头部指标 | `kpi` |
| 单指标有序时间序列 | `chart`：`line` 图层 |
| 一个指标按一个维度分组的趋势 | `chart`：`line` 图层加 `series` |
| 排名、已排序的类目比较 | `chart`：横向条形（`orientation: "horizontal"`，查询中降序），第二个指标放 `label` |
| 少量短类目的比较 | `chart`：`bar` 图层 |
| 2–3 个可比系列 | `chart`：`bar` 图层加 `series`，或多个 `bar` 图层 |
| 绝对量 + 比率 | `chart`：`bar` 图层 + `line` 图层（`axis: "right"`） |
| 围绕零点的正负值 | `chart`：`bar` 图层 |
| 不超过 5 类的完整构成 | `chart`：`pie` |
| 类目与数值的关系、逐项分布 | `chart`：`scatter` 图层 |
| 两个维度交叉的一个指标（行业 × 月份） | `chart`：`heatmap` |
| 一个数值的分布 | `chart`：`histogram`（分箱由查询给出） |
| 多组数值分布的比较 | `chart`：`boxplot`（统计量由查询给出） |
| 期初到期末的增减拆解 | `chart`：`waterfall`（累计由查询给出） |
| 阶段之间的流向与转化 | `chart`：`sankey` |
| 多层级的完整构成 | `chart`：`treemap` 或 `sunburst` |
| 累积总量随时间的构成 | `chart`：`area` 图层加 `stack` |
| 逐级转化 | `chart`：`funnel` |
| 用户要求的明细、清单 | `table`（默认不加） |

## 配色

工具按系列顺序使用本项目八色商用色板，与聊天图表和报告图表一致：

`#2F6FDB` 蓝、`#F28A30` 橙、`#22A38A` 青绿、`#7B61D1` 紫、`#E8B53A` 琥珀、`#E05A6F` 玫红、`#4FB3E8` 天蓝、`#8A94A6` 石板灰。

页面与坐标轴用一组冷灰中性色；`highlight` 之外的柱子退为实心浅冷灰 `#D6DCE4`，重点用 `tone` 的颜色（`focus` `#F2622E`、`bad` `#D9483B`、`good` `#1E9E6A`），读者第一眼落在重点上。

工具已经替你处理的样式，不要在 spec 里重复或绕开：单条折线自动加浅色渐变面积，点多于 12 个时隐藏圆点（悬停显示）；横向条形带浅灰底槽，窄格子会截短类目名、放宽数值刻度；KPI 卡与趋势线用主色蓝。

一张看板只用这一套色板。单系列图不需要图例，也不要为单系列逐柱换色；颜色只用来区分有意义的系列或标出一个重点，标重点用 `highlight`（见“突出重点、参考线与区间”），不要手写颜色。需要按维度值固定颜色时，在图层的 `series.colors` 中指定（如 `{ "批发业": "#2F6FDB" }`），只从上面的色板取色。同一个维度值在不同图中要保持同一颜色：在每张图中写相同的映射，或让系列顺序保持一致。语义映射：达标/盈利用 `#1E9E6A`，未达标/亏损用 `#D9483B`，中性基准用 `#8A94A6`。

## 验收

生成前：

- 每个视图的数据都已发布，`receiptId` 来自发布工具的返回。
- 每个 `view.id` 唯一；引用的列都在对应结果中。
- 图表数据已在查询中聚合到图表粒度；KPI 引用的是查询算好的单元格。
- `validate` 返回 `dashboard spec valid`，且没有 `[LAYOUT]` 建议；确有理由保留某条建议时，在最终答复中说明。常见建议与改法：
  - `REPEATED_MEASURE`：两个视图显示同一结果的同一度量，删掉其一，换成拆解图。
  - `PIE_DOMINATED`：环形图最大一类超过 90%，改为 KPI 卡或条形图。
  - `RAW_CODE_LABELS`：类目是系统编码（`DELIVERED`、`STORE_DIRECT_PAYMENT`），在查询中关联字典表或用 `CASE` 改写为中文。
  - `WIDE_HORIZONTAL_BAR`、`LONG_TAIL`：横向条形独占整行、类目超过 12 个，与另一张图同行，并在查询中取 Top N 加“其他”。
- 版面：第一行是结论（或结论加带趋势线的 KPI），然后是 KPI 行，整行图不超过一张；没有用户要求时不放表格，有表格时放在最后。
- 每张结论句子里的数字都能在已发布结果中找到。

生成后：

- `create` 返回了 HTML 路径。
- 标题、单位、图例、颜色一致。

## 错误处理

- `DASHBOARD_SPEC_INVALID`：按错误列表修改 spec 或查询，不要绕过校验。
- `LAYOUT_UNKNOWN_VIEW`、`LAYOUT_DUPLICATE_VIEW`、`LAYOUT_VIEW_NOT_PLACED`、`LAYOUT_WIDTHS_MISMATCH`：`layout.rows` 必须让每个视图恰好出现一次，`widths` 与 `views` 一一对应。
- `CHART_DATA_UNSUPPORTED`：视图的数据不是已发布结果。先发布，再引用 `receiptId`。
- `DASHBOARD_TOO_MANY_ROWS`：结果超过 5000 行。在查询中聚合，明细用 `export_query` 提供下载。
- 用户要求筛选、下钻、实时刷新等暂不支持的能力时，明确说明限制，给出可落地的替代方案（例如按切片拆成多张图、附上明细表），不要伪造交互。

## 最终答复格式

1. 看板 HTML 链接。
2. 数据来源和口径摘要，包括所做的假设；把返回中有关数据的 `[NOTICE]`、`[DISCLOSURE]`、`[SEMANTICS]` 如实转述。看板页面只给读者看数据，`[DISCLOSURE]` 与 `[SEMANTICS]` 不印在页面上，你的答复是它们到达用户的唯一途径。标签旋转、截断和 `TEMPORAL_UNDECLARED` 是给你调整 spec 的提示，不显示在页面上；能改就改 spec 重建，不必转述。
3. 核心发现 2 到 4 条。
4. 已执行的校验。
