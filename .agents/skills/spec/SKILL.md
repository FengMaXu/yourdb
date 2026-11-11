---
name: spec
description: 数据查询的 Answer Spec 流程——按字段树路径设置口径、探针与决定、最终查询、发布
when_to_use: 每个需要从数据库取数、统计、排名或导出的请求，在第一次调用 set_answer_spec 之前加载。口径问答、闲聊和纯结果加工不需要加载。
requires-tools:
  - set_answer_spec
  - query_database
---

# Answer Spec 流程

本 Skill 说明用 `set_answer_spec` 建立和修改 Answer Spec 的方法。语义分析方法（如何拆题、各字段要回答什么问题、各类歧义专题）见知识库 `semantic-guide`；SQL 实现规则见 `sql-rules`。

## 1. 流程总览

1. 按需读取 `semantic-guide`，拆题。
2. 业务定义、表结构、数据取值交给 `subagent` 的 explorer 收集，每个子任务只问一个问题，并行派发。
3. 一次 `set_answer_spec`（不带 `taskId`）按计算顺序写下字段：统计总体 → 度量 → 分组 → 选取 → 输出。题面没说死的字段写成待定。
4. 每个待定字段的每个候选各跑一次探针（§7）。输出全部相同的字段由系统视为等价，不用处理；输出不同的，系统在最后一个探针返回时附上比较建议（`[ADVICE]`），再按 §5「决定与澄清」决定或询问用户。改动其他字段后，此前的探针作废（状态表显示 `stale`），须重跑。
5. 状态表显示“没有待处理的字段”后，执行一次最终查询，得到 Result Candidate。
6. 发布 Candidate，并披露未证实的字段和数据限制。

## 2. 字段树

| 路径 | 内容 | 值 |
| --- | --- | --- |
| `population.entity` | 统计实体与业务键（按名称还是按键、版本是否合并） | 文本，或 `{ name, keyColumns? }` |
| `population.eligibility` | 零值、空值实体是否纳入（例如没有订单的客户算不算） | 一句话 |
| `population.conditions` | 资格条件及其作用阶段（WHERE 还是 HAVING） | 列表，每项为文本或 `{ condition, stage? }` |
| `population.source` | 数据来源 | `{ tables: [...], note? }` |
| `population.time` | 时间范围、端点、参考日、日历与时区 | 文本，或 `{ expression, boundary? }`，`boundary` 取 `inclusive`、`exclusive`、`mixed` |
| `population.timeField` | 用哪个事件的时间字段 | `表.列`（来源只有一张表时可只写列名），或一句话 |
| `population.missing` | 缺期是否补零，相邻观测还是相邻日历期 | 一句话 |
| `population.joinMultiplicity` | 连接后会不会重复计数，要不要去重 | 一句话 |
| `measure.formula` | 逐层的运算表达式（§3） | 表达式 |
| `measure.countGrain` | 按行、按实体还是按事件计数 | 一句话 |
| `measure.denominator` | 分母的总体；分母为 0 怎么处理 | 一句话 |
| `measure.window` | 滚动或累计窗口从哪里开始、多长 | 一句话 |
| `grouping` | 分组键与日历粒度 | 列表，每项为文本或 `{ key, grain? }` |
| `selection` | 排名与取对象；argmax、argmin 即 `n = 1` | `{ n, orderBy }`，`orderBy` 写列和方向 |
| `selection.ties` | 并列政策 | `"strict"`（恰好 n 行）或 `"include_ties"`（保留切点上的全部并列行） |
| `output` | 行粒度、行数、列、每列的单位与精度 | `{ rowMode?, rowCount?, columns?, units?, decimals? }` |

**必须声明的字段**（不适用写 `"n/a"`）：

- 总是：`population.entity`、`population.eligibility`、`population.conditions`、`population.time`、`measure.formula`、`grouping`、`selection`、`output`。
- `measure.formula` 任一层为 `count`、`count_distinct`、`avg`、`median`、`ratio`、`percentage`、`change_rate` 时：`measure.countGrain`。
- 任一层为 `avg`、`ratio`、`percentage`、`change_rate` 时：`measure.denominator`。
- 任一层为 `cumulative`、`rolling` 时：`measure.window`。
- `selection` 不是 `"n/a"` 时：`selection.ties`。
- `population.source` 列出多张表时：`population.joinMultiplicity`。

`population.timeField`、`population.missing` 不强制，题面涉及时再写。例外：按年、季、月或日分组且 `population.time` 写了日期范围时，系统按 `population.timeField`（写成 `表.列`）列出范围内实际有数据的期间（`[CALENDAR_COVERAGE]`）；有期间没有数据，`population.missing` 变为必须声明——写明缺数据的期间以零出现（SQL 须先生成全部期间再连接数据）还是不出现。返回的“未声明”列出还缺的字段；全部声明之前不能执行最终查询。

`output.rowMode` 的取值（不要用其他词）：

| `rowMode` | 含义 | `rowCount` |
| --- | --- | --- |
| `scalar` | 只有一行结果 | 1，可省略 |
| `top_n` | 排名后取前 N 行 | N，会核对结果行数 |
| `grouped` | 每个分组一行 | 已知组数时写上，会核对结果行数 |
| `full` | 完整结果集，行数由数据决定 | 省略 |
| `detail` | 逐条明细记录 | 省略 |

写了 `columns` 时，结果列须逐位同名。`units`、`decimals` 按列名写单位和小数位。

## 3. 度量表达式

`measure.formula` 每一层写明运算 `op`、在什么粒度上计算 `per`、作用于什么：

| `op` | 作用于 |
| --- | --- |
| `count`、`count_distinct`、`sum`、`avg`、`median`、`min`、`max`、`cumulative`、`rolling` | `of`：列，或内层表达式 |
| `ratio`（a/b）、`percentage`（100·a/b） | `numerator`、`denominator` |
| `difference`、`change_rate`、`pp_difference`（百分点差） | `from`、`to`（从 from 变到 to） |
| `custom`（以上都不适用，例如回归预测） | `description` 必填，`of` 可选 |

嵌套顺序就是聚合顺序；多于一层时，每个内层都写 `per`。最外层按 `grouping` 计算，`per` 可省略。例如“各区域门店月均销售额的平均值”：

```json
{ "op": "avg", "per": "region",
  "of": { "op": "avg", "per": "store",
          "of": { "op": "sum", "per": "month", "of": "amount" } } }
```

## 4. 字段写法

| 状态 | 写法 | 系统怎么处理 |
| --- | --- | --- |
| 不适用 | `"n/a"` | — |
| 题面已规定 | `{ "value", "basis": "request", "quote" }` | `quote` 必须在原题中逐字出现 |
| 有引文依据 | `{ "value", "cite": [{ "source", "quote" }] }` | 见下表 |
| 观测依据 | `{ "value", "evidenceIds": ["evidence_…"] }` | 引用 `query_database` 探索返回的 evidenceId |
| 假定 | `{ "value", "basis": "assumed", "rationale" }`，或直接写值 | 记为未证实，发布时披露 |
| 待定 | `{ "open": [候选 1, 候选 2] }` | 系统为每个候选发放 `alternativeId` |

引文来源：

| `source` | 含义 | `quote` |
| --- | --- | --- |
| `knowledge:<knowledgeId>` | 系统授权的业务文档 | 必填，文档中逐字出现 |
| `schema:<表.列>` | 表结构事实 | 可选 |
| `clarification:<clarificationId>` | `ask_user_clarification` 的回答 | 必填，回答中逐字出现 |
| `message` | 用户本轮消息 | 必填，消息中逐字出现；原始问题用 `basis: "request"` |

是否已证实由系统按依据判定：语义字段只认原题、业务文档和用户确认；物理字段（`population.source`、`population.timeField`、`population.joinMultiplicity`）只认表结构、业务文档和观测。依据不够格时记为未证实并披露，不会失败。引文能核验只说明原文里有这句话，不说明它支持你的取值：只出现相关词语、对各种读法都说得通的引文，不能用来在候选之间做选择（见 §5）。

## 5. 决定与澄清

这是何时决定、何时询问用户的唯一规则；系统提示词、工具说明和 `semantic-guide` 都以本节为准。

**待定字段**的各候选探针输出不同时，按顺序判断，第一条成立就执行：

1. **有能排除其他候选的依据**：原题、业务文档或用户确认中有短语排除了其他候选（按 `semantic-guide` 的「候选对照」逐词检验）。以该依据决定：`{ "value": <候选原值>, "rationale", "cite" | "basis": "request" | "evidenceIds" }`，`rationale` 写清哪个短语排除了哪些候选。建议无倾向（`[ADVICE] lean=none`）的字段，原题措辞不算这样的依据：比较建议已经读过原题并认为它不能裁决，只有业务文档或用户确认可以。
2. **能询问用户，且字段属于统计总体（`population.entity`、`population.eligibility`、`population.conditions`），或建议无倾向（`[ADVICE] lean=none`）**：先用 `ask_user_clarification` 询问，回答后以 `cite: [{ "source": "clarification:<id>", "quote" }]` 引用回答决定。本任务有多个字段要问时合并成一次询问；问法见 `semantic-guide` 的「歧义澄清模板」。
3. **其余情况**：按比较建议的明显倾向（`[ADVICE] lean=<alternativeId>`）决定，它是默认答案。改选其他候选须附 `"adviceOverride": { "reason", "evidenceIds" }`，证据须能确定该字段本身：语义字段只认原题、业务文档和用户确认，观测不能推翻倾向。建议服务故障（`[ADVICE_UNAVAILABLE]`）时照常决定，发布时会披露该决定未经比较。
4. **不能询问用户**（会话没有澄清工具）：有倾向时按倾向决定，无倾向时按「候选对照」最符合题面的候选决定；发布时会披露该决定未经确认。
5. **询问了但用户没有回答**：会话仍算能询问用户，所以第 2 条的字段依然需要合格依据（Runtime 会拒绝没有依据的决定）：统计总体字段引用能确定它的原题或业务文档，建议无倾向的字段只能引用业务文档；都没有时再次询问。其他字段按第 3 条决定。

不要把待定字段改写成假定来绕开这一流程，Runtime 会拒绝。会话能询问用户时，Runtime 也会拒绝第 2 条中没有合格依据的决定。

**没有候选、只是缺少依据的取值**：直接写成假定，发布时披露。例外：会话能询问用户时，`population.eligibility` 不能只靠假定，须引用依据或询问。

## 6. 修改

- **只写要变的路径。** 未写的路径保持不变。每个路径独立校验、独立生效，失败的路径不影响其他路径；按返回的 `✗` 原因只重发失败的路径。
- **无法单独执行的候选**：写 `{ "notProbeable": { "<alternativeId>": "理由" } }` 代替探针。
- **改写已设置的字段**须附 `"reason"`，系统记录改写理由。
- **`[SPEC_FEEDBACK]` 题面要求**：Spec 必须声明的字段齐全后，系统逐条核对原题的要求片段，列出被判为与字段矛盾或缺失的原文和无定义的输出列。逐条对照对应字段：改写字段（附 reason）、打开候选，或在该片段确实不适用时保留。它是决策模型的建议，不是证据。
- **实体身份计数**：写了 `population.entity` 和 `population.source` 后，返回中的 `[ENTITY_IDENTITY]` 给出每张来源表的行数、去重行数和 `keyColumns` 去重数。计数的键不唯一时，按键去重计数，或在 `population.entity` / `measure.countGrain` 写明每行为何是独立实体。完全重复行只是数据质量事实，不是去重的理由：除非题面或业务文档说明重复行是同一实体，否则按表中原有行计数。这些计数会随结果披露。
- 写入任何字段都会产生新的 Revision，上一版未发布的结果候选随之失效；先把字段写完，再执行最终查询。

## 7. 探索、探针与最终查询

```text
query_database(kind="exploration", taskId, sql, limit?)
query_database(kind="exploration", taskId, sql, probe={ path, alternativeId })
query_database(kind="result", taskId, revisionId, sql)
```

- 待定字段每个候选的 `alternativeId` 见 `set_answer_spec` 返回的状态表。
- 探针 SQL 按该候选的口径计算**最终输出**，不是中间量。`[PROBE] output=...` 相同表示两个候选给出同一个答案。探针不占探索次数。
- 探索只验证可能改变答案的未决点，每次解决一个问题；探索产物不能发布。
- 最终查询绑定状态表所在的当前 `revisionId`，成功后生成不可变的 Result Candidate；被拒时按下面的原因修正后重新执行（结果查询有次数预算）。SQL 与已封存字段明显不符（最外层行数上限与 `selection.n` 不同、`include_ties` 却用行数上限截断、`percentage` 或 `pp_difference` 未乘 100）时，SQL 不执行并以 `SPEC_NOT_REALIZED` 拒绝：改 SQL 实现字段，字段本身写错才附 reason 改写字段；可能不符的情况随结果披露。CandidateCheck 拒绝时修正 SQL；结果与未采纳候选的探针输出相同时以 `DECISION_NOT_REALIZED` 拒绝，改 SQL 实现已采纳的候选。
- `[IMPLEMENTATION_OBSTACLE]` 按 `kind` 判断：技术失败在预算内修 SQL；业务判断、映射不足、预算耗尽或执行结果未知时回到取证、澄清或说明限制。

## 8. 报告与看板

一份报告或看板有多张图时，共用的口径只声明一次：

1. **报告任务**：`set_answer_spec({ report: true, fields })`，只写共享字段——`population.*`——和各度量定义 `measures.<名字>`，值为 `{ formula, countGrain?, denominator?, window? }`。报告任务本身不执行结果查询、不发布。
2. **图表查询**：每张图 `set_answer_spec({ parentTaskId, fields })`，`population.*` 自动继承，只写 `measure.formula: { "ref": "<名字>" }`、`grouping`、`selection`、`selection.ties`、`output`（度量定义写了分母、计数粒度或窗口的，对应字段一并继承）。
3. 报告任务处理完后，各图表查询的结果查询互不依赖，可以在同一轮里并行发出，再分别发布。
4. **偏离**：图表查询改 `population.*`，或报告任务有度量定义时用自己的 `measure.formula`，须附 `reason`，记为偏离，发布时披露。
5. **报告任务修改后**，绑定旧版本的图表查询不能再执行结果查询或发布（`PARENT_REVISION_STALE`）：先 `set_answer_spec({ taskId, fields: {}, rebind: true })` 重新继承，偏离过的字段保留。报告任务还有未处理的共享字段时，所有图表查询的结果查询都被阻断（`PARENT_UNRESOLVED`）。

## 9. 发布

- 行数 ≤ 10：`publish_query_result(candidateId, format="inline")`
- 行数 > 10：`export_query(candidateId, format="csv")`

发布不会重跑 SQL。回复中说明结果对应的口径，并转述 `[DISCLOSURE]` 中未证实的口径和检查限制。转述用业务语言（例如“‘四上’企业以表内标识为准，未经业务文档确认”），不要列出 `population.entity` 之类的字段路径。
