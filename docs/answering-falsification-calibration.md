# Answering 主动证伪规则离线校准报告（Phase 4 / T4.4）

> 规则版本：`result-domain-v1`（T4.2）、`data-falsification-v1`（T4.3）
> 生成脚本：[`evaluations/spider2/falsification-calibration.mjs`](../evaluations/spider2/falsification-calibration.mjs)
> 逐题明细：[`evaluations/spider2/falsification-calibration-v1.json`](../evaluations/spider2/falsification-calibration-v1.json)
> 校准日期：2026-11-21

## 1. 方法

按 [ADR-0003](./adr/0003-detect-inform-never-block.md) 的要求，规则先离线回放、再决定披露或阻断。脚本对历史运行的**最终 SQL + 已交付结果行**逐题运行两组规则：`data_falsification` 的数据探针直接在本地 Spider2 SQLite 库上执行（只读）。随后统计每条子规则：

- **错题召回**：在官方评分为错（score=0）的题上触发的比例；
- **正确题误报**：在官方评分为对（score=1）的题上触发的比例。

| 集合 | 来源 | 可用题数（错 / 对） |
| --- | --- | --- |
| 开发集 | `fewshot135-case-evidence.jsonl`（135 道 SQLite 题的一次完整运行，取有最终 SQL 且结果行完整的题） | 129（82 / 47） |
| 独立留出集 | `system0904-gpt55-paired040-default-001`（另一模型、另一轮次的 40 题配对运行，取已评分且有提交的题） | 34（23 / 11） |

错题按 `wrong118-classification-adjudicated.jsonl` 的 `error_layer` 标注归因。

**局限**：两次历史运行都早于字段树 Spec，没有 `measure.formula`。`result_domain` 在回放中改用脚本从最终 SELECT 最后一个输出表达式推断的 op（含乘 100 记为 `percentage`，含除法记为 `ratio`，`COUNT(...)` 记为 `count`）。线上规则读的是封存的 `measure.formula`，推断带来的偏差（如把 `AVG(x/y)` 推成 `ratio`、把百分点差推成 `percentage`）只存在于回放中，因此下面的误报率是**上界**。

## 2. 结果

### 2.1 覆盖（四态 CheckCoverage）

| 集合 | 规则 | finding | clear | not_applicable | unknown |
| --- | --- | --- | --- | --- | --- |
| 开发集 | result_domain | 5 | 35 | 89 | 0 |
| 开发集 | data_falsification | 1 | 20 | 105 | 3 |
| 留出集 | result_domain | 1 | 11 | 21 | 1 |
| 留出集 | data_falsification | 0 | 9 | 25 | 0 |

`data_falsification` 的 3 个 `unknown` 都是未限定表名的列（`insert_date`、`term_start`、`mth`）在多表 FROM 中无法定位来源表，按规则如实记为不可判定，不记为 clear。规则模式出现次数：开发集 LEFT JOIN 18 题、闭区间日期上界 5 题、空结果字面量 1 题；留出集 LEFT JOIN 9 题。

### 2.2 逐子规则

| 子规则 | 开发集错题召回 | 开发集正确题误报 | 留出集错题召回 | 留出集正确题误报 |
| --- | --- | --- | --- | --- |
| `result_domain.count_negative` | 0/82 | 0/47 | 0/23 | 0/11 |
| `result_domain.count_fractional` | 0/82 | 0/47 | 0/23 | 0/11 |
| `result_domain.percentage_as_fraction` | 0/82 | **1/47（2.1%）** | 0/23 | 0/11 |
| `result_domain.ratio_as_percentage` | 3/82（3.7%） | **1/47（2.1%）** | 0/23 | **1/11（9.1%）** |
| `result_domain.measure_all_null` | 0/82 | 0/47 | 0/23 | 0/11 |
| `data_falsification.left_join_degenerated` | 1/82（1.2%） | 0/47 | 0/23 | 0/11 |
| `data_falsification.date_upper_bound_truncated` | 0/82 | 0/47 | 0/23 | 0/11 |
| `data_falsification.literal_not_matched` | 0/82 | 0/47 | 0/23 | 0/11 |

### 2.3 错题触发明细

| 题 | 子规则 | 归因（error_layer） | 说明 |
| --- | --- | --- | --- |
| local049 | ratio_as_percentage | 口径错 | `avg_new_unicorns_per_year` 全部落在 (1, 100] 且带小数 |
| local212 | ratio_as_percentage | 口径错 | `avg_daily_deliveries` 同上 |
| local194 | ratio_as_percentage | 标准答案有问题 | `avg_revenue_per_actor` 同上 |
| local037 | left_join_degenerated | 标准答案有问题 | `WHERE oc.cat IS NOT NULL` 过滤 LEFT JOIN 右表列，使外连接退化为内连接 |

三道 `ratio_as_percentage` 命中都是“每 X 的平均值”，与量纲错位无关，属于推断 op 的巧合命中，不能算作规则真正发现了错误。

### 2.4 正确题误报明细

| 题 | 集合 | 子规则 | 原因 |
| --- | --- | --- | --- |
| local018 | 开发集 | percentage_as_fraction | 实际是百分点差（`pp_change_2021_vs_2011`），推断 op 误判为 percentage；线上会声明 `pp_difference`，规则不适用 |
| local023 | 开发集 | ratio_as_percentage | 击球率类比值本身就大于 1（`batting_average`），属于规则的真误报 |
| local007 | 留出集 | ratio_as_percentage | `average_career_span_years` 是平均年数，大于 1 是正常值；属于规则的真误报 |

## 3. 结论与决定

1. **没有任何子规则升级为硬阻断。** 升级条件是留出集正确题误报率 ≤ 1%，且有足够的触发样本说明它确实能找到错误。`ratio_as_percentage` 在留出集上误报率达 9.1%（1/11）；其余子规则在留出集上零触发，没有证据支持阻断。全部子规则保持**仅告知与披露**（ADR-0003 第 2 条）。
2. **`ratio_as_percentage` 只保留为披露，并在说明中写明它的已知例外。** 比值大于 1 是常见的正常情况（人均值、击球率），这条子规则只能提示“请确认量纲”，不能当作错误证据。
3. **`left_join_degenerated` 是唯一命中真实 SQL 结构问题的规则**（local037），且零误报。但样本只有 1 次触发，留出集零触发，暂不升级；下一轮带字段树 Spec 的运行积累样本后再复核。
4. **日期上界截断与字面量不匹配在两次运行中都没有触发。** 模式出现过（5 次、1 次），但数据中不存在被截断的当日时刻或大小写差异。规则保持开启，以低成本覆盖这类偶发错误。
5. 回放显示这些规则的召回很低（开发集错题合计约 5%），与 [ADR-0007](./adr/0007-answer-spec-as-one-field-vocabulary.md) 的错题归因一致：错题主要来自口径值错和未声明，而不是可以从结果数值上看出来的量纲或结构错误。主动证伪能补上一小部分 SQL 实现错，不能替代 Link 1 的口径证伪。

## 4. T4.1（差异见证行）的评估状态

差异见证行已实现并接入 Jev 的 `probeEvidence` 和 `[PROBE]` 视图，单测确认 Jev 输入携带具体的差异行而不只是行数（`falsification.test.ts`）。

“Jev 决策准确率不下降（目标提升 ≥ 5 个百分点）”这一项需要两样东西，本次都没有：

- 一份逐字段标注过、且每个候选都有探针输出的待定选择评估集。2026-10-15 的 gold89 字段级标注（50 个字段，Jev 首选正确率 82%）依赖 `C:/data-agent-eval/runs/fieldtree-gold89-jev-20261013` 下的探针 SQL，该目录已不存在；
- 可用的 Jev（TypeSafe）API 凭据。

在补齐这两项之前，T4.1 的准确率对比没有完成，本报告不声称该项通过。

## 5. 复现

```bash
npm run build:runtime
node evaluations/spider2/falsification-calibration.mjs \
  --dev C:/Users/Lenovo/data-agent-eval/fewshot135-case-evidence.jsonl \
  --holdout C:/Users/Lenovo/data-agent-eval/runs-gpt55-system0904/system0904-gpt55-paired040-default-001 \
  --databases C:/data-agent-eval/Spider2/spider2-lite/resource/databases/spider2-localdb \
  --labels evaluations/spider2/wrong118-classification-adjudicated.jsonl \
  --out evaluations/spider2/falsification-calibration-v1.json
```
