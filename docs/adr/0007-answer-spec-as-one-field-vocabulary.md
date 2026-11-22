---
status: accepted
---

# Answer Spec 收敛为一套字段词汇，由一个动作逐字段更新

本 ADR 提议替换 `begin_answer_spec`/`revise_answer_spec` 的模型接口，并部分取代 ADR-0004 第 4 条的证据引用方式、ADR-0005 第 5 条的决策点声明方式。运行时的准入、连续性、探针与兑现规则不变。

## 背景

2026-09-26/27 两个会话中，`begin_answer_spec`/`revise_answer_spec` 共 19 次调用、11 次失败：

| 失败 | 次数 | 例子 |
| --- | --- | --- |
| 槽位引用本次调用的证据 localId，但调用里没带 `evidence` 数组 | 3 | 同一份只含 `spec` 的参数连续重发 3 次，每次都是 `references unknown evidence def-ind51` |
| `affects` 写成决策点名 | 3 | `affects: ["metric", "denominator"]` |
| 证据种类与假设种类不匹配 | 2 | `reviewed_definition` 支持 `data_property` |
| 在同一次调用里处置刚新增的假设 | 1 | `Cannot support unknown hypothesis h-src` |
| 引用未经引文核验的题面证据 | 1 | `request_… has no Runtime-verified quote` |

另有一次结果查询因 `output.columns` 与 SQL 别名不一致而被 CandidateCheck 拒绝，模型改别名后一次通过；它不属于上述耦合，见"考虑过的方案"。

这些失败不是模型粗心，而是接口要求模型在一次调用里编写一张带交叉引用的图：

- **五类实体**：槽位、证据、假设、Choice、决策点，外加 `notProbeable`。
- **三套连接**：本次调用内的 `localId`、假设与 Choice 的 `affects`、槽位依据三选一（推断 / `hypothesisId` / `evidenceIds`）。同一个"槽位 ↔ 假设"关系被正反各写一次。
- **两套名称体系**：7 个槽位名与 8 个决策点名描述同一组决定，却分别出现在 `affects` 和 `decisionPoints[].name` 里。
- **调用级原子性**：任何一处引用失败都会拒绝整次调用，且只报第一个错误；成功的调用平均 4.8 KB 参数。

2026-09-27 已经做了两项不改接口的缓解：名称越界时一次列出所有错误字段及其合法值；support 按 ADR-0006 由运行时判定是否已证实（见 ADR-0006 补充）。它们让错误更容易修正，但不减少概念。

## 决策

1. **一套字段词汇。** Answer Spec 是一组按固定路径命名的字段。8 个决策点并入所属槽位，成为槽位的子字段：

   | 决策点 | 字段路径 |
   | --- | --- |
   | `population` | `filters.population` |
   | `join_multiplicity` | `entity.joinMultiplicity` |
   | `count_grain` | `metric.countGrain` |
   | `denominator` | `metric.denominator` |
   | `time_field` | `time.field` |
   | `window` | `time.window` |
   | `ties` | `ranking.ties` |
   | `output_shape` | `output.shape` |

   另设 `source` 字段，承载同时影响多个槽位的数据来源不确定性（例如"用 fact 表关联维表，还是用 mart 汇总表"）。这是取消 `affects` 后跨槽位不确定项唯一的归属。

2. **每个字段自带状态和依据，不再有独立的假设、Choice 和决策点声明。**

   | 状态 | 写法 | 对应现有记录 |
   | --- | --- | --- |
   | 题面已规定 | `{ "value", "basis": "request", "quote" }` | 已核验的题面证据 |
   | 有引文依据 | `{ "value", "cite": [{ "source", "quote" }] }` | 已核验证据；`source` 为 `knowledge:<id>` 或 `schema:<table.column>` |
   | 观测依据 | `{ "value", "evidenceIds": ["evidence_…"] }` | `query_database` 登记的观测证据 |
   | 假定 | `{ "value", "basis": "assumed", "rationale" }` | 未证实的 Hypothesis |
   | 待定 | `{ "open": ["候选 1", "候选 2"] }` | Choice；运行时为每个候选发放 ID 供探针使用 |
   | 不适用 | `"n/a"` | `not_applicable` |

   决定一个待定字段，就把它改写为某个候选的值并附 `rationale`；探针、比较建议和偏离说明仍按 ADR-0005 执行。

   **普通歧义与重要歧义的区分不变。** 区分依据是探针输出，不是字段结构：待定字段的每个候选仍各自绑定一次探针；全部候选输出相同的字段可声明为等价，不需要理由、建议和披露；输出不同或未知的字段按决定性处理。原来由 `affects` 决定的两条规则改由字段路径推导：路径的第一段就是它影响的槽位（`metric.denominator` 影响 `metric`）；`source` 视为同时影响 `entity`、`metric`、`filters`。因此"决定性 Choice 影响核心槽位时须先有比较建议"（ADR-0005）与"未证实的决定不得确定统计总体"（ADR-0006）的适用范围与现在相同。

3. **引用只剩服务端 ID。** 文本证据在引用处就地附引文，由运行时就地核验；取消模型可写的 `localId`。观测证据仍按 `query_database` 返回的 ID 引用。

4. **假设种类由字段路径决定。** 例如 `filters.population` 与 `metric.denominator` 为业务语义，`entity.joinMultiplicity` 与 `source` 为物理映射。模型不再声明种类，是否已证实按 ADR-0006（含补充）由运行时判定；ADR-0006 的统计总体规则作用于 `filters.population` 与 `entity`。

5. **一个动作，逐字段生效。** 唯一的写入工具是 `set_answer_spec { taskId?, fields: { <路径>: <字段> } }`。首次调用创建任务；之后按路径更新。每个路径独立校验、独立生效，结果逐路径返回，并附整张状态表：待定、未证实、未声明的字段。模型不再传 `baseRevisionId`，工具读取当前 Revision。

6. **连续性由运行时维持。** 改写一个已处置的字段必须附 `reason`，运行时自动记录为对原记录的取代（ADR-0004 的 supersede），审计链不依赖模型。

7. **输出列比对不变。** `output.shape` 声明 `columns` 时，CandidateCheck（`result_shape`）仍要求结果列数相同、逐位同名。

## 实施与验证

- **第一阶段，适配层。** `set_answer_spec` 把每个路径编译成对现有 `answering.begin`/`answering.revise` 的增量：假定字段生成 Hypothesis，待定字段生成 Choice，决策点由路径自动声明。领域记录、快照格式、探针、披露与发布不变，旧工具保留在开关后。
- **A/B。** 原定在 Spider2 开发集（`phase6-development-35-ids.txt`）上与现有工具对比：spec 工具调用错误率（本 ADR 背景中为 11/19）、到达首个 Ready Revision 的轮次、结果正确率不回退、披露率。2026-10-10 改为按 10 个开发集用例的结果接受，不再跑 35 题，见"接受与实施方式"。
- **第二阶段，领域收敛。** 把领域模型的假设、Choice、决策点三类记录收敛为字段记录。不迁移旧快照，见"接受与实施方式"。

## 考虑过的方案

- **只做名称校验和报错改进（已实施）。** 保留：它是后续任何方案的基线，但五类实体与三套连接仍在。
- **按关注点拆成六个原子工具**（登记证据、声明未决项、处置、声明决策点、改槽位、开始）。否决：数据上正交，时间上耦合——模型必须按"登记 → 声明 → 处置"的顺序调用，前一步返回的 ID 是后一步的输入；概念没有减少，工具却从 2 个增加到 6 个。
- **输出列只按列序与数量比对，或由运行时按声明改名。** 否决。逐位同名是发布内容的列名契约：发布的 CSV 表头就是结果列名。它还能发现列序错位——声明 `[a, b]` 而 SQL 给出 `[b, a]`；只比数量，或按位置改名，都会把错位静默地贴上错误的列名。实际代价是一次可修复的重试。真正的缺陷在报错：obstacle 只写 "Result columns do not match the declared output shape"，不给声明列与实际列，而且这句话排在约 2.7 KB 的尝试记录之后。应改进报错，而不是放宽检查；2026-09-27 已改为在 obstacle 首行同时给出声明列与实际列。
- **把决策点名加入 `affects` 的合法值。** 否决：两套名称体系合并成一个并集，模型仍需知道哪些名字是槽位、哪些是决策点，问题只是从报错变成语义混淆。

## 后果

- 模型需要掌握的概念从五类实体、三套连接收敛为"字段路径 + 字段状态"；交叉引用失败从结构上消失。
- 跨槽位的不确定性只能放在 `source` 字段；若出现 `source` 无法表达的跨槽位不确定项，需要扩展字段表，而不是恢复 `affects`。
- 每个路径独立生效意味着一次调用可能产生多个 Revision；Revision 数量增加，但每个 Revision 都满足 ADR-0004 的连续性不变量。
- ADR-0004 第 4 条"证据引用只能使用 Runtime 发放的 Evidence ID 或同一次调用内的 `localId`"改为"只能使用 Runtime 发放的 ID 或就地引文"；ADR-0005 第 5 条的决策点声明改为由字段状态推导，阻断规则不变。
- 字段路径表是固定、有限的；它和决策点清单一样让遗漏可见，但不保证声明正确。

## 补充（2026-10-05）：对照代码与看板会话的待定设计

本 ADR 仍未实施：代码中没有 `set_answer_spec`，模型接口仍是 `begin_answer_spec`/`revise_answer_spec`。以下事实对照 `develop`（#125 之后）的代码与 2026-10-01/02 三个看板会话的 transcript 核实。

**新的度量。** 三个会话中 `begin_answer_spec`/`revise_answer_spec` 共 58 次调用、19 次失败（按工具返回的错误文本统计，为近似值），失败类别与本 ADR 背景一致：引用未知 Choice、决策点引用已移除的假设、决定统计总体的 Choice 缺少合格证据、用户确认无法核实。

**待定 1：用户确认在字段状态中没有写法。** 决策 2 的“有引文依据”只列出 `knowledge:<id>` 与 `schema:<table.column>`。现有准入已经支持两种用户确认：`clarification:<id>` 指向本会话某次澄清的回答，省略来源时绑定 Host 提供的当前用户消息（`evidence-admission.ts`、`tools/answering.ts` 的 `confirmationSource`）。澄清回答按会话查找，因此同一会话的后续 Query Task 可以引用。`cite[].source` 应增加 `clarification:<id>` 与 `message`（当前用户消息）两种取值。现有接口有一个陷阱应一并消除：任何非空 `sourceRef` 都被当作澄清 id，2026-10-01 会话中模型写 `sourceRef: "current request"` 被解析为 `clarification:current request` 而失败。

**待定 2：等价由谁判定。** 决策 2 写“可声明为等价”，没有给出写法。现有转换在模型提交 `equivalent` 处置时检查各候选的探针指纹是否全部相同，不同则拒绝（`transition.ts`）。既然判定完全依据 Runtime 已持有的指纹，字段模型中应由 Runtime 在最后一个候选的探针登记后自动把该字段解析为等价，模型不需要也不能声明。

**待定 3：逐路径生效与结果候选的关系。** 结果查询与发布都要求候选所属的 Revision 是当前 Revision（`result-execution.ts`、`publication.ts`）。决策 5 让每个路径独立产生 Revision，因此任何字段写入都会使此前未发布的候选失效。保留这一规则：结果候选只对应一个完整的 Revision；工具返回的状态表应在存在失效候选时明确列出。

**待定 4：一个任务只有一个输出形状，每个 Revision 只能发布一次。** `output.shape` 每个任务只有一个；同一 Revision 已有 Receipt 时，发布另一个候选被拒（`publication.ts`），而 `reviseAnswer` 产生新 Revision 时清除任务的 `publicationId`（`revision.ts`），所以同一任务可以“修订 → 结果查询 → 发布”多次。逐个视图这样做会消耗 Revision 预算（默认 8 次），一个任务能承载的视图数因此有上限。看板会话中模型把多张图塞进一个任务（`metric.kind: "composite"`、`output.columns: ["view", "dimension", "metric_value"]`），随后 4 条结果查询全部未通过 `result_shape` 检查，并行发布的 4 个候选中 3 个被拒。多输出由 ADR-0009 解决，本 ADR 不扩展字段表。

**待定 5：数据质量不进入字段表。** 2026-10-01 会话所用的 olist 各表每行都存了两份（`olist_orders` 每个 `order_id` 恰好 2 行；`olist_order_items` 225,300 行，整行去重后 112,650 行）。模型把“各表先整行去重”写进 `filters`，在每个子查询中使用 `SELECT DISTINCT *`，导致 10 次 60 秒超时并耗尽任务时间预算。整行重复不是业务口径，不应由 Answer Spec 的字段承载，也不应由每条查询各自补偿；它属于数据层缺陷，应在数据源修复。CONTEXT.md 定义的 Schema Profile（含键基数）目前没有实现；实现后它可以把“声明键不唯一”作为结构事实报告给 solver，但修复仍在数据层。

## 第一阶段实施记录（2026-10-05）

第一阶段按“实施与验证”在开关后实现（`specInterface: "fields"`，默认 `legacy`）。与上文决策相比，有三处实现上的取舍：

- **一次调用落一个 Revision。** 决策 5 的“每个路径独立校验、独立生效”保留，但各路径作为同一次调用的有序步骤依次应用到上一步的结果上，被拒的步骤跳过，成功的步骤合并为一个 Revision，只计一次 Revision 预算。若每个路径各产生一个 Revision，写十几个字段就会耗尽预算（默认 8 次），且每次写入都使未发布的候选失效。后果一节“一次调用可能产生多个 Revision”因此不再成立。
- **槽位的“假定”记为推断。** 七个槽位写 `basis: "assumed"` 或直接写值时，记为推断槽位（Inferred Facet），发布时披露，不建 Hypothesis。这样 ADR-0006 统计总体规则的适用范围与旧接口相同；若槽位假定也建业务语义 Hypothesis，`entity`、`filters` 的假定在有澄清工具时会被拒绝，比现在更严。子字段与 `source` 的值都编译为 Hypothesis，`filters.population` 的假定仍受该规则约束。
- **文档引文不要求模型区分文档种类。** `cite` 的 `knowledge:<id>` 按组合根为该文档配置的种类（任务文档或已审核定义）准入。

A/B 由维护者执行（Spider2 运行器的 `--spec-interface legacy|fields`）。

## 补充（2026-10-10）：第二阶段的目标模型

第二阶段把领域记录收敛为字段记录。本节给出收敛的目标：字段树的结构、四个互相独立的维度，以及现有规则在新模型中的位置。

### 为什么不能只把记录一对一搬过来

第一阶段把 8 个决策点挂到"所属"槽位下，但多数决策点描述的是槽位之间的依赖，而不是某一个槽位的细节：

| 子字段 | 挂在 | 实际影响 |
| --- | --- | --- |
| `filters.population` | filters | 也决定 entity；ADR-0006 的统计总体规则同时作用于 `filters.population` 与 `entity`（决策 4） |
| `entity.joinMultiplicity` | entity | 放大的是 metric 的值 |
| `time.field` | time | 也决定 groupBy（按哪个日期分月）与 filters |
| `metric.countGrain` | metric | 实质是实体身份：数行、数订单还是数客户 |
| `metric.denominator` | metric | 分母的总体与 `filters.population` 重叠 |
| `ranking.ties` | ranking | 改变输出行数；`top_n` 的 CandidateCheck 按 `rowCount` 核对 |
| `output.shape` | output | 与 `output` 槽位本身重复：槽位值是 `{rowMode, rowCount, columns}`，子字段又用一句话描述同一件事 |

此外，"假定"在三处各有一种写法：槽位的推断依据（Inferred Facet）、Hypothesis 的 provisional 结论、决策点的 `assumed` 声明。三者含义相近，规则覆盖面不同。

A/B 重跑（`adr0007-fields-rowmode-dev10-deepseek-flash-20261010`，10 个开发集用例）中各子字段的最终声明：

| 子字段 | 不适用 | 题面已定 | 假定 | 待定 | 引文 / 观测 |
| --- | --- | --- | --- | --- | --- |
| `filters.population` | 0 | 1 | 7 | 2 | 0 |
| `output.shape` | 0 | 5 | 5 | 0 | 0 |
| `metric.countGrain` | 1 | 2 | 6 | 1 | 0 |
| `entity.joinMultiplicity` | 2 | 0 | 7 | 1 | 0 |
| `ranking.ties` | 2 | 0 | 8 | 0 | 0 |
| `time.field` | 5 | 0 | 2 | 3 | 0 |
| `metric.denominator` | 5 | 2 | 1 | 2 | 0 |
| `time.window` | 7 | 1 | 2 | 0 | 0 |

样本小，只看方向：一半的子字段在多数用例中不适用，但每题都要声明；没有一项声明用到引文或观测证据，因此每个发布结果都带着一串"假定"披露；`entity.joinMultiplicity` 是可以查实的数据事实，却有 7 题写成了假定。

### 四个维度

目标模型把现在混在一起的东西拆成四个互相独立的维度；证据保持不变，仍是唯一被引用的对象。

**1. 结构：答案由什么组成。** 字段按计算顺序组织成一棵树，每个歧义落在它实际发生的那一步。决策点不再是独立概念，而是这棵树上的节点。

```
population                统计总体
  population.entity         实体与业务键（含按名称还是按键、版本是否合并）
  population.eligibility    零值、空值实体是否纳入（原 filters.population）
  population.conditions     资格条件及其作用阶段（原 filters）
  population.source         数据来源（原 source）
  population.time           时间范围、端点、参考日、日历与时区（原 time）
  population.timeField      用哪个事件的时间字段（原 time.field）
  population.missing        缺期是否补零，相邻观测还是相邻日历期（新增）
measure                   度量
  measure.formula           可嵌套的运算表达式（原 metric），见下文
  measure.countGrain        计数粒度
  measure.denominator       分母及分母为 0 的处理
  measure.window            滚动或累计窗口（原 time.window）
grouping                  分组键与日历粒度（原 groupBy）
selection                 排名与取对象：orderBy、n（原 ranking）；argmax / argmin 即 n = 1 的排名
  selection.ties            并列政策（原 ranking.ties）
output                    行粒度、行数、列、每列的单位与精度（原 output 与 output.shape 合并）
```

另有一个物理层字段 `population.joinMultiplicity`（原 `entity.joinMultiplicity`），见维度 4，合计 18 个节点。事件顺序与终止（语义指引 S09）、状态与递归（S10）等少见题型不单设节点，用对应节点的待定候选承载。

**`measure.formula` 是逐层的表达式，不是一个类型名。** 每一层写明运算（`op`）、在什么粒度上计算（`per`）、作用于什么（`of`：列或内层表达式）。例如"各国家球员场均得分的平均值"：

```json
{ "op": "avg", "per": "country",
  "of": { "op": "avg", "per": "player",
          "of": { "op": "sum", "per": "match", "of": "runs" } } }
```

先按场次求和，再按球员平均，最后按国家平均；把三层压成一次 `avg(runs) group by country` 是另一个口径。比率写成 `{ "op": "ratio", "numerator": …, "denominator": … }`，分子分母各自是表达式。

嵌套的顺序就是聚合顺序，因此不另设聚合顺序节点。`ratio` 是 a/b 的原值，`percentage` 是 100·a/b，量纲由运算区分；单位与舍入归 `output`，因此不另设单位节点。

`op` 是枚举，取值来自 135 道标准口径实际用到的度量类型：

| 类别 | `op` |
| --- | --- |
| 计数 | `count`、`count_distinct` |
| 求和 | `sum` |
| 集中趋势 | `avg`、`median` |
| 极值 | `min`、`max` |
| 比率 | `ratio`（a/b）、`percentage`（100·a/b） |
| 变化 | `difference`、`change_rate`、`pp_difference`（百分点差） |
| 累计与滚动 | `cumulative`、`rolling`（窗口写在 `measure.window`） |

标注中的 `argmax`、`argmin`、`qualifying_*`、`ranked_detail`、`best_match` 描述的是"选出哪些对象"，归 `selection`；`detail`、`summary`、`player_profile`、`string_aggregation` 描述的是输出明细的形式，归 `output`。二者都不是度量运算。

**2. 状态：这个点有多确定。** 所有字段共用一个状态机，取代槽位依据、Hypothesis 结论、Choice 结论与决策点声明四套状态：

`不适用 | 题面已定（引文） | 有证据 | 假定（披露） | 待定 → 已决定`

"有证据"与"假定"的区分仍按 ADR-0006 由运行时判定；待定字段的探针、等价与决定规则不变（见规则映射表）。

**3. 必要性：什么时候必须表态。** "必须声明"不再是固定的 8 项清单，而由其他字段的值推出：

| 字段 | 何时必须给出状态 |
| --- | --- |
| `population.entity`、`population.eligibility`、`population.conditions`、`population.time`、`measure.formula`、`grouping`、`selection`、`output` | 总是（可以是"不适用"） |
| `measure.countGrain` | 表达式任一层的 `op` 为 `count`、`count_distinct`、`avg`、`median`、`ratio`、`percentage` 或 `change_rate` |
| `measure.denominator` | 任一层为 `avg`、`ratio`、`percentage` 或 `change_rate` |
| `measure.window` | 任一层为 `cumulative` 或 `rolling` |
| 表达式每个内层的 `per` | 表达式超过一层（最外层按 `grouping` 计算，可省略） |
| `selection.ties` | `selection` 不是"不适用" |
| `population.joinMultiplicity` | 来源涉及多表连接 |

`population.timeField`、`population.missing` 保留为可表达的节点，但不由规则强制（依据见"用历史错题检验"）。

规则检查表达式的任一层，而不只是最外层：比率藏在 argmin 或"满足条件的对象"里时（"投球平均值最低的投手"），最外层看不到它。前提是 `op` 成为枚举；目前 `MetricSpec.kind` 是自由字符串，规则无法据此触发。规则只依赖已有状态的字段；被依赖的字段尚未给出状态时，Revision 本来就不能进入 Ready。

**4. 层：谁来定。**

- **语义层**（用户的意思）：由题面、业务定义或用户澄清确定；模型可以假定，发布时披露。
- **物理层**（在这个数据库里如何实现）：`population.source`、`population.timeField`、`population.joinMultiplicity`。这些是数据事实，由运行时用 Schema Profile（CONTEXT.md；键基数、空值率等）核实后作为观测证据填入，模型不再假定。Schema Profile 尚未实现；实现之前，物理层字段仍可由模型假定并披露。

层由路径决定，取代 Hypothesis 的 `kind`。旧接口中 `kind` 由模型声明，`fields` 接口已由路径推出（`tools/answer-fields.ts` 的 `SUBFIELDS`）。

### 用标准口径检验（2026-10-10）

用 `evaluations/spider2/spec-quality-labels.jsonl` 的 135 道已裁定标准口径检验字段树。标注记录的是每道题的正确口径，不是错因，因此只能检验"能否表达"与"必要性规则准不准"。

**结构。** 标准口径用到 61 种属性（出现 2683 次），每一种都能落到字段树的某个节点。用到的题数：`population.entity`、`measure.formula`、`output` 各 135；单位（现归 `output`）120；`selection` 80；`grouping` 67；`population.time` 58；`population.conditions` 57；两层以上聚合 44；`measure.denominator` 42；`population.source` 与 `population.joinMultiplicity` 各 21；`measure.countGrain` 18。

**必要性规则。** 本补充初稿的规则只看最外层的类型，与标准口径对照的结果是：

| 字段 | 规则触发 | 实际需要 | 漏检 | 多报 |
| --- | --- | --- | --- | --- |
| `selection.ties` | 80 | 79 | 0 | 1 |
| `population.joinMultiplicity` | 21 | 20 | 0 | 1 |
| `measure.window` | 3 | 4 | 1 | 0 |
| `measure.countGrain`（初稿：仅计数） | 33 | 49 | 16 | 0 |
| `measure.denominator`（初稿：最外层为比率或平均） | 49 | 42 | 7 | 14 |
| 聚合顺序（初稿：比率或平均时） | 49 | 44 | 17 | 22 |
| 单位（初稿：比率时） | 49 | 120 | 75 | 4 |

由此做了四处修改：度量改为可嵌套的表达式，聚合顺序由嵌套表达；取消单位节点，量纲由 `op` 区分，单位与精度归 `output`（每题必答）；`measure.countGrain` 的触发扩到平均与比率类，对照结果为漏检 5、多报 27；规则检查任一层的 `op`。`measure.window` 漏检的 local299（逐日累计余额）在标注中记为 `sum`，按新枚举应为 `cumulative`。

**检验不到的部分。**

- `population.eligibility`、`population.timeField`、`population.missing` 在标注格式中没有对应属性，这份数据既不能证明它们有用，也不能证明无用。
- `measure.denominator` 初稿漏检的 7 题中，比率藏在内层（例如 local020"投球平均值最低的投手"）；标注只记录最外层类型，因此"检查任一层"能否消除这些漏检，需要在实施后按新表达式重新标注再测。
- 歧义标注很薄：75 条中 67 条是统一预填的"排名并列"，6 条是标准答案的形状问题，语义歧义只有 2 条（local062、local358）。字段树能否覆盖真实歧义，要靠错题的错因归类检验。

### 用历史错题检验（2026-10-10）

118 道历史错题（其中 55 道从未答对）逐题对照卷宗标注三项：最早分叉节点、错误层、可见性。每条标注引用卷宗原文，引文已逐字校验。标注是单遍的，没有双盲；118 题中 101 题没有 Gold SQL。

**能定性的 74 题**：口径错 60、实现错 8、标准答案有问题 6。另 44 题标准细则不足或 SQL 与结果疑似错配，未定性，不计入以下结论。

**结构。** 74 题全部能落到字段树上，没有"树外"。44 题未定性，所以这只说明没有发现缺口，不证明字段树完整。

**三个待定节点。**

| 节点 | 最早分叉 | 次要分叉 | 处理 |
| --- | --- | --- | --- |
| `population.eligibility` | 3（local020、local062 口径错；local131 标准答案有问题） | 1 | 保留，总是必须声明 |
| `population.timeField` | 0 | 0 | 保留节点，移出必要性规则 |
| `population.missing` | 0 | 0 | 保留节点，移出必要性规则 |

按原规则，`timeField` 和 `missing` 在 135 道标准口径中有 58 题须声明，但错题中从未在这两处出错，强制声明只增加负担。题面需要时仍可用它们表达。

**必要性规则。** 60 道口径错中：

- **未声明 24 题**，必要性规则最多只能作用于这部分。17 题落在原规则"总是"的节点上；7 题落在原规则未列出的节点上（`selection` 3、`population.conditions` 2、`population.time` 1、`population.source` 1）。这 7 题中有 5 题卷宗的 Spec 快照与决定记录全空，只能说明记录缺失；有记录支撑的漏检是 local157（`population.time`，漏了题面给的日界）和 local309（`population.source`，物理层，留给 Schema Profile）。据此把 `selection`、`population.conditions`、`population.time` 改为总是必须声明，"不适用"也是一种声明。
- **声明了但值错 36 题**：假定错 23、待定后决定错 7、题面引用错 6。必要性规则对这部分无效，要靠证据核实（Schema Profile、探针）。错题的主因是声明的值错，而不是漏了声明。

**假定错的字段分布（2026-10-25 补充，按标答值复核）。** 23 道假定错（`relabel-v2` 中 `visibility == "假定错"`）的分岔字段，按 Spider2 评分器口径复核：评分器（`condition_cols: []`）只要求标答各列在预测中有数值一致的列，多出的列不扣分；只有标答各列的值都对、错在列或行的形状时，才算 `output`。

  | 分岔字段 | 题数 | 题号 |
  | --- | --- | --- |
  | `measure.formula` | 8 | local003、035、060、062、152、194、300、335 |
  | `measure.countGrain` | 2 | local032、037 |
  | `population.*` | 7 | local040、130、133、263、273、301、355 |
  | `grouping` | 1 | local017 |
  | `output` | 2 | local025（标量交成逐场明细）、local073（缺列、分隔符不同） |
  | 数值错，根因未定 | 3 | local049、064、258 |

  relabel-v2 原把 9 题标为 `output`，其中 6 题的值本身就错（如 local037 笔数 7565 vs 7540、local049 57.67 vs 59.67），多出的列不是失分原因。因此"`output` 每列须有题面或探针依据"的规则不成立：多出的列都是题面提到的词，规则拦不住；少列它看不到。

  主要来源是 `measure`（10 题）。物理层假定只有 2–3 道（local003 金额列映射、local273 来源表、local017 分组列），可由 Schema Profile / Typed Holes 处理；`countGrain` 2 题都是去重粒度，结构化后可由 Spec Realization 核对去重键；local194、local335 的嵌套层次可由多层聚合校验处理。其余是公式或总体的业务读法，只能靠证据核实。复核明细见 `docs/research/slop-answer-spec-comparison.md` 第 5 节。

**归因口径的缺口。** 可见性的五个类别描述的都是声明错误；13 题声明正确，失分来自 SQL 实现或标准答案，没有类别可用。可见性只应对口径错标注。

标注与校验程序见 `evaluations/spider2/adr0007/relabel-v2/`。

### 规则映射

| 现有规则 | 来源 | 在目标模型中 |
| --- | --- | --- |
| 证据准入与权威顺序 | ADR-0004 | 不变；字段引用证据 |
| 改写已处置项须附理由，记录为取代 | ADR-0004、本 ADR 决策 6 | 不变；取代作用于单个字段记录 |
| 一次调用产生一个 Revision，计一次预算 | 本 ADR 第一阶段实施记录 | 不变 |
| 决策点未声明时 Revision 不能 Ready，结果查询与发布被阻断，探索不受影响 | ADR-0005 决策 5 | 必要性规则推出的字段没有状态时同样阻断 |
| 决定前每个候选须有探针或不可探测理由 | ADR-0005 决策 1 | 不变；作用于待定字段的候选 |
| 各候选输出相同即为等价，无需理由、建议与披露 | ADR-0005 决策 1；运行时由探针指纹推出（#146） | 不变 |
| `compare_hypotheses` 只比较一个 Choice 的候选；偏离明显倾向须附理由与证据 | ADR-0005 决策 2、3 | 比较一个待定字段的候选；偏离规则不变 |
| 结果指纹等于未采纳候选的探针指纹、且不等于被采纳候选的指纹时，不能成为结果候选（Choice Realization） | ADR-0005 决策 4 | 不变；作用于每个已决定字段 |
| 已证实 / 未证实由运行时判定，未证实者发布时披露 | ADR-0006 | 不变；对应"有证据"与"假定 / 未证实的决定" |
| 统计总体上的未证实决定，仅在无澄清途径时接受 | ADR-0006 | 作用于 `population.entity`、`population.eligibility`、`population.conditions`（语义层） |
| 槽位假定记为 Inferred Facet，不建 Hypothesis | 本 ADR 第一阶段实施记录 | 不再需要：统计总体规则的范围已由路径确定，所有"假定"共用一种状态 |
| `output.columns` 声明时结果列须逐位同名 | 本 ADR 决策 7 | 不变；归入 `output` |
| 报告任务的共享字段继承与偏离 | ADR-0009 | 不变；路径按下节改名 |

### 路径对照

实现时按此表改名，不保留旧路径。

| 第一阶段路径 | 目标路径 |
| --- | --- |
| `entity` | `population.entity` |
| `filters` | `population.conditions` |
| `filters.population` | `population.eligibility` |
| `source` | `population.source` |
| `time` | `population.time` |
| `time.field` | `population.timeField` |
| `entity.joinMultiplicity` | `population.joinMultiplicity` |
| `metric`、`metrics.<name>` | `measure.formula`、`measures.<name>` |
| `metric` 的 `unit` | `output` 中对应列的单位 |
| `metric.countGrain`、`metric.denominator` | `measure.countGrain`、`measure.denominator` |
| `time.window` | `measure.window` |
| `groupBy` | `grouping` |
| `ranking`、`ranking.ties` | `selection`、`selection.ties`；度量类型为 argmax / argmin 的，改为 `n = 1` 的 `selection` |
| `output`、`output.shape` | `output` |

### 接受与实施方式（2026-10-10）

**接受。** 按 10 个开发集用例的 A/B（`adr0007-legacy-dev10-deepseek-flash-20261010` 对 `adr0007-fields-rowmode-dev10-deepseek-flash-20261010`）接受本 ADR：spec 工具整次调用报错率 7/24 → 1/40，到达 Ready 6/10 → 8/10，到达首个 Ready 的中位轮次 13.5 → 11，正确率 4/10 → 5/10（local019 由对变错）。正确率只差 1 题，不足以说明变好，只说明没有明显变差。`fields` 接口仍有 25% 的字段路径被拒，第二阶段改路径时一并处理。不再跑 35 题。

**不做兼容。** 所有设计以字段树为准，不为旧模型保留任何通道：

- 删除 `begin_answer_spec`、`revise_answer_spec`、`answer-spec` Skill 与 `specInterface` 开关，`set_answer_spec` 是唯一的写入工具。
- 删除第一阶段的适配层（字段编译为 Hypothesis、Choice、决策点与 Inferred Facet）。领域记录直接是字段记录，不再有 Hypothesis、Choice、决策点三类记录，也不加过渡用的 `path` 属性。
- 旧格式快照不迁移、不投影、不读取。
- JEV 请求、披露、发布回执与评测指标直接使用字段记录，不再生成 hypotheses / choices 形状，也不提供新旧转换。

**实施顺序。**

1. 领域记录收敛为字段记录：字段树 18 个节点、统一状态机、可嵌套的 `measure.formula` 与 `op` 枚举、必要性规则；规则映射表中的规则改为作用于字段。
2. `set_answer_spec` 改用目标路径；删除旧工具、旧 Skill、开关与适配层；更新 `answer-fields` Skill、`.pi/SYSTEM.md` 与语义指引。
3. JEV 适配器、披露、发布与评测脚本改为读取字段记录。
4. Schema Profile 实现后，物理层字段改由运行时核实填入。

第 1–3 步已实施（见下节），第 4 步待 Schema Profile。

### 第二阶段实施记录（2026-10-10）

领域记录、工具、Skill、JEV 适配器与评测脚本已按上文改为字段记录。Answering 的公开用例改为 `set`、`execute`、`publish`、`refresh`、`inspect`。与上文相比，有以下取舍：

- **可写的路径。** 18 个节点中，`population` 与 `measure` 是分组，不单独写值；其余 16 个节点加上报告任务的 `measures.<name>` 可写。`population.conditions` 的值是列表，每项为文本或 `{ condition, stage? }`，`stage` 写作用阶段；`grouping` 的每项为文本或 `{ key, grain? }`；`selection` 为 `{ n, orderBy }`；`selection.ties` 取 `strict` 或 `include_ties`，使严格 Top N 的行数检查能读到它。
- **`population.source` 写成 `{ tables, note? }`。** 必要性规则"来源涉及多表连接"由此判定：列出两张以上的表时要求 `population.joinMultiplicity`。
- **`op` 枚举加 `custom`。** 回归预测、分箱打分等枚举外的运算写 `custom` 并附 `description`，不触发任何必要性规则。差值类运算（`difference`、`change_rate`、`pp_difference`）的两端写作 `from`、`to`。
- **统计总体规则的范围。** 会话有澄清途径时，`population.entity`、`population.eligibility`、`population.conditions` 不能由未证实的决定确定；假定只对 `population.eligibility` 拒绝。这与旧接口只拒绝 `filters.population` 假定的严格程度相同，没有把实体和条件的假定一并收紧。
- **一种"假定"。** 直接写值、`{value}`、`{value, basis:"assumed", rationale}` 都记为假定，发布时披露。`{value, rationale}` 在字段待定时是决定，否则是附理由的值；决定也可以附 `basis:"request"` 或 `cite`，由运行时判定是否已证实。
- **等价只由运行时推出。** 待定字段的各候选探针输出相同时视为已处理，模型没有"声明等价"的写法。
- **报告任务。** 共享字段是全部 `population.*` 与 `measures.<name>`。`measure.window` 不再是共享字段，随度量定义一起继承。报告任务有度量定义时，图表查询写自己的 `measure.formula` 记为偏离；图表查询继承的待定字段只通过报告任务阻断。
- **SpecFeedback 按五段评估。** JEV 评估从 7 个槽位改为 `population`、`measure`、`grouping`、`selection`、`output` 五段，规则版本为 `spec-alignment-v2`、`spec-feedback-v2`。
- **快照。** 持久化快照带 `version: 2`，其他版本不读取，按空状态处理。
- **错误码。** 结果复现未采纳候选的探针输出时报 `DECISION_NOT_REALIZED`（原 `CHOICE_NOT_REALIZED`）。

### 未决

- 没有路径的 `data_property` 假设（例如"每行存了两份"）：本 ADR 补充 2026-10-05 待定 5 已决定数据质量不进字段表；收敛后它们以物理层观测或检测器结论的形式存在，模型不能再假定。Schema Profile 实现之前，这类事实的承载位置待定。
- 字段树是否覆盖评测外的产品场景（看板多视图由 ADR-0009 的报告任务承载，不在本树内）。

## 修订（2026-10-12）：数据缺期时 `population.missing` 必须声明

上文把 `population.missing` 移出必要性规则，依据是 118 道历史错题从未在此处出错，而按“有时间就必填”会让 135 题中 58 题多声明一个字段。之后 61 道评分错题的复核确认 local064 正是在这里出错：`population.time` 为 2020 全年、按月分组，交易只覆盖 1–4 月，`population.missing` 未声明，SQL 的月份取自交易，5–12 月消失。

改为由数据触发，而不是由字段触发：分组键或公式某层的 `per` 有年、季、月或日粒度，`population.time` 写有日期范围，`population.timeField` 指明列（`表.列`，或来源只有一张表时的列名），且该列以 ISO 日期存储时，Revision 提交后运行时列出范围内实际有数据的期间。有期间没有数据时，`population.missing` 加入必须声明的字段，并随结果披露缺失的期间；读不懂的时间表达式（含季度或周的措辞、非 ISO 存储等）记为不可判定，不触发。

回放 2026-10-10 字段树运行的最终 Spec：有日历粒度的 31 题中 2 题触发——local064（错题，未声明，规则会要求声明）和 local197（正确题，已声明，只多一条披露）；19 题不可判定。对已声明的题不增加负担。

## 修订（2026-10-15）：封存前补读日历覆盖

日历覆盖在 `set_answer_spec` 的 Revision 提交之后、另一事务中写入。同一轮并行发出的结果查询若先到达该 Revision，封存时还没有覆盖结果，`population.missing` 不会成为必须声明的字段。现在结果查询在封存前检查该 Revision 是否已有实体身份与日历覆盖读数，没有就先读取并记录（同目标沿用父 Revision 的读数，不重复查询），再判断必须声明的字段。`set` 仍在提交后读取，让模型在写字段时就看到缺期。

## 修订（2026-11-21）：Schema Profile 落地；countGrain 与 eligibility 结构化

第 4 步的 Schema Profile 由 Runtime 持有（`answering/schema-profile.ts`），每个 Answering 实例（一个会话）一份：数据检查的每次读取按 SQL 记忆，同一会话内不同 Query Task 不再重复扫表；每张来源表只采集一次表行数、主键/唯一键实际基数、时间列格式与 min/max、低基数文本列取值。超过 200,000 行的表只读行数，并如实记为 limitation。这些读取不计入任务预算，也不是模型工具。来源表有多个同类候选列（多个日期列、多个金额列），而模型直接假定其中一列、没有建 `open` 时，结果附带 `physical_candidates` 提醒，只披露不阻断。

`measure.countGrain` 与 `population.eligibility` 直接改为结构化值，不保留自由文本写法：

- `measure.countGrain`：`{ grain: "row" | "entity" | "event", keyColumns?: string[], note?: string }`；
- `population.eligibility`：`{ zeroActivity: "include" | "exclude" | "n/a", nullKey: "include" | "exclude" | "n/a", note?: string }`。

一句话的旧写法被 `parseFieldValue` 拒绝，报错中给出精确结构。`ANSWERING_SNAPSHOT_VERSION` 升到 3，Pi Session 的记录按版本放在各自的命名空间（`data-agent.answering.v3.*`），旧版本记录不会被读入。
