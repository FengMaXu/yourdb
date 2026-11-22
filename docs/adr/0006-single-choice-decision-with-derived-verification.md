---
status: accepted
---

# Choice 只有一种决定动作，是否已证实由运行时判定

本 ADR 修订 ADR-0004 中 Choice 的处置方式（select 与 provisional 两种动作），并补充 ADR-0005。

## 背景

ADR-0004 为 Choice 设计了两种处置：正式选定（select）要求合格证据；临时选择（provisional）不要求合格证据，但须在发布时披露，且不能用于影响统计总体（`entity`、`filters`）的选择。

ADR-0005 之后，决定一个 Choice 的依据是探针输出、比较建议和理由，两种动作都要满足同样的前提。两者只剩一个区别：由 Agent 事先判断证据是否够格。Spider2 运行 `wrong-submitted-34-20260926-deepseek-probes-r1` 中，这个判断错了 34 次：临时选择漏写理由 13 次，拿观测数据正式选定 21 次，每次都被整体拒绝。

此外，"统计总体不能临时选择"在没有澄清工具的环境中无法满足：Agent 既不能问用户，又往往找不到合格证据，只能反复尝试或卡住。

## 决策

1. **一种决定动作。** 模型只提交 `decide`：`choiceId`、`alternativeId`、`rationale`，可选 `evidenceIds` 和 `adviceOverride`。ADR-0005 的前提（探针、建议、偏离说明）不变。
2. **是否已证实由运行时判定。** 所附证据中有能支持该候选的合格证据时，记为已证实（`selected`，附证明）；否则记为未证实（`provisional`），发布时自动披露。证据不够格不再使整次调用失败；引用不存在的证据仍然拒绝。
3. **统计总体的规则按澄清能力区分。** 会话提供澄清工具时，未证实的总体决定仍被拒绝，须取证或询问用户；不提供澄清工具时（评测、无人值守），允许未证实的总体决定，但必须披露。该能力由组合根配置，不由模型声明。
4. **领域记录不变。** `ChoiceResolution` 仍记为 `selected` 或 `provisional`，其含义改为"已证实"与"未证实"。

## 后果

- Agent 不再需要预判证据资格，消除一类整次调用被拒的失败。
- 披露范围不变：未证实的决定都会披露。
- 在没有澄清工具的环境中，统计总体可能按未证实的口径交付；这类交付始终带有披露。
- 领域层保留 select/provisional 处置以兼容旧快照与未开启治理的调用方；模型工具只暴露 `decide`。

## 补充：假设的 support 同样由运行时判定（2026-09-27）

2026-09-26/27 两个会话中，`begin_answer_spec`/`revise_answer_spec` 共 19 次调用、11 次失败，其中 2 次是 support 所附证据种类不合格（`reviewed_definition` 支持 `data_property`、`query_observation` 支持 `physical_mapping`），整次调用被拒。这正是本 ADR 为 Choice 消除的同一类失败。

1. **support 只有一种结果判定方式。** 所附证据中至少一条合格时，记为已证实（`supported`，附证明）；否则记为未证实（Resolution `provisional`，附 `citedEvidenceIds`），视为已处置，发布时自动披露其影响的槽位。新增假设的 `proposedEvidenceIds` 按同一规则判定。
2. **仍然拒绝的情况。** 引用不存在的证据；support 不附任何证据；会话提供澄清工具时，未证实的 `business_semantics` 假设影响统计总体（`entity`/`filters`）。最后一条只针对业务语义假设：澄清只能确定业务含义，物理映射和数据性质假设不是问用户能回答的问题。
3. **refute 不变。** 反驳会让依赖该假设的槽位和决策点失效，仍要求合格证据。
4. **领域记录。** 沿用 Resolution 的 `provisional` 结果，含义与 ChoiceResolution 的 `provisional` 一致（未证实、须披露）；`choiceId` 改为可选，仅旧快照携带。

ADR-0004 的保护不变：无引文的题面句柄仍然不能"证明"任何业务假设，只会使 support 记为未证实并被披露。
