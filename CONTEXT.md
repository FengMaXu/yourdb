# Data Agent Query Assurance

This context defines the language used to assess whether a freely generated database query is consistent with a user's request before its result is delivered.

## Language

**Evidence Authority**:
The precedence order used when semantic evidence conflicts: user clarification, reviewed business definitions, task-supplied business documents, explicit request wording, formal schema constraints, observed data evidence, and finally model inference. Evaluation Gold is never runtime evidence.
_Avoid_: Source priority, truth ranking

**Query Task**:
One database-answering request with its own identity, Answer Spec version chain, candidate queries, review history, and final Publication Status. A chat session may contain multiple Query Tasks.
_Avoid_: Session, tool call

**Report Task**:
A Query Task that holds the fields every chart query of one report or dashboard shares — the population fields and named measure definitions — and never runs a result query or publishes itself (ADR-0009).
_Avoid_: Parent spec, dashboard task

**Chart Query**:
A Query Task bound to one Revision of a Report Task. It inherits the shared fields, declares only its own (measure reference, grouping, selection, output), and delivers only while that Revision is current and handled. A change to an inherited field is a recorded, disclosed deviation.
_Avoid_: Child spec, sub-query

**Query Assurance**:
The process that prepares semantic evidence, detects and informs about candidate anomalies, records interpretation choices, and publishes results under integrity rules.
_Avoid_: SQL validation, export gate

**Answer Spec**:
A versioned interpretation of the requested answer, written as fields on one tree in calculation order: population, measure, grouping, selection and output (ADR-0007). It is evidence-scoped rather than an assertion of absolute correctness.
_Avoid_: Frozen contract, planner answer

**Hard Constraint**:
A requirement supported by authoritative evidence and eligible to block delivery when violated.
_Avoid_: Assumption, guess

**Structural Fact**:
An unambiguous property established by formal schema evidence or the observed result shape, without requiring a business interpretation.
_Avoid_: Business rule, inferred grain

**Answer Spec Field**:
One node of the Answer Spec tree, addressed by path (such as `population.eligibility` or `measure.formula`). A field is not applicable, holds a value with a basis, or is open between alternatives until it is decided. A field changes only with a recorded reason, except when an open field is decided.
_Avoid_: Slot, facet, decision point

**Field Basis**:
What a field value rests on, decided by the Runtime: evidence when cited evidence qualifies for the field's layer, otherwise an assumption that is disclosed at publication. Semantic fields accept request wording, business documents and user confirmation; physical fields accept schema facts, business documents and observations.
_Avoid_: Confidence, source label

**Hypothesis**:
A provisional semantic interpretation with stated evidence and confidence that requires validation before it can become a Hard Constraint. In the Answer Spec it is an assumed field value or one alternative of an open field.
_Avoid_: Rule, fact

**Observation Evidence Handle**:
An opaque, task-scoped identifier returned for a Runtime-registered exploration Query Artifact. It can bind an observed phenomenon to a Claim or Decision, but observed data alone cannot establish the intended business interpretation.
_Avoid_: Candidate ID, proof, business rule

**Assumption Profile**:
A normalized per-alternative inventory of stable assumption identifiers grouped by frozen semantic dimension. Runtime derives the Assumption Vector from profile cardinalities; the profile proves representation consistency, not semantic classification correctness.
_Avoid_: Confidence score, model rationale

**Material Population Decision**:
A material interpretation choice that changes who is counted (`population.entity`, `population.eligibility`, `population.conditions`). While the user can still be asked, it is not settled by an unverified decision, and eligibility is not settled by an assumption.
_Avoid_: Filter warning, row-count anomaly

**Ambiguity**:
An unresolved choice between plausible interpretations for which current evidence does not establish one authoritative answer.
_Avoid_: Error, model uncertainty

**Anomaly Record**:
A task-scoped record of a deterministic observation that may affect interpretation, bound to one Answer Spec slot and one or more candidate artifacts. It reports evidence and status; it does not by itself decide delivery.
_Avoid_: Gate verdict, semantic error

**Interpretation**:
One explicit, auditable way to read an ambiguous Answer Spec slot. Multiple interpretations may remain visible until the delivered candidate records which one it implements.
_Avoid_: Correct answer, reviewer decision

**Schema Profile**:
Runtime-owned, cached structural statistics for a database, such as table row counts, key cardinalities, null rates, and numeric bounds. It is detector evidence, not a model-callable tool and not a business definition.
_Avoid_: Data quality verdict, business rule

**Candidate Profile**:
Runtime-owned statistics limited to columns used by one candidate's Digest for ordering, extrema, averages, distance, or difference expressions. It is disclosed only when relevant to an Anomaly Record or output dependency.
_Avoid_: Full-table exploration, filtering instruction

**Interpretation Enumerator**:
An independent planner that lists materially different readings of one anomalous Answer Spec slot. It may provide exact question-span evidence but has no authority to approve, reject, mutate the Spec, or choose the delivered candidate.
_Avoid_: Reviewer, semantic judge

**Disclosure**:
The publication record of unresolved observations, alternatives, or unavailable review that remain visible when a result is delivered.
_Avoid_: Approval, waiver

**Query Digest**:
A structured account of what a query expresses, including its sources, filters, measures, grouping, ranking, windows, and output lineage, together with explicit coverage and unsupported areas.
_Avoid_: SQL summary, query explanation

**Conversation-Blind Reviewer**:
A reviewer that can see the request, Answer Spec, schema evidence, query, and Query Digest but cannot see the solver's conversation, reasoning, self-description, or self-validation claims.
_Avoid_: Blind translator, question-blind reviewer

**Review Decision**:
An evidence-scoped judgment with one of four outcomes: Approved, Rejected, Needs Clarification, or Abstained.
_Avoid_: Proof, correctness certificate

**Approved**:
A Review Decision meaning that no blocking disagreement was found within the current Answer Spec, schema evidence, Query Digest, Review Coverage, and reviewer capability. It does not mean that semantic correctness has been proven.
_Avoid_: Proven correct, guaranteed correct

**Review Coverage**:
The versioned, structured set of semantic and structural aspects that a Review Decision checked, found inapplicable, could not support, or lacked evidence to assess.
_Avoid_: Confidence

**Calibrated Confidence**:
An empirical estimate derived from Review Calibration for decisions with comparable evidence and coverage. It is distinct from a reviewer's uncalibrated self-reported score.
_Avoid_: Reviewer confidence, model certainty

**Semantic Disagreement**:
A structured difference between the requested semantics and the semantics expressed by a submitted query.
_Avoid_: Validation error, SQL error

**Spec Authority**:
The Runtime role that versions an Answer Spec, applies every state transition to a copy of the current Revision, and admits evidence. A solver drafts the initial Spec and proposes deltas, but never replaces the Revision state or decides evidence authority (ADR-0004).
_Avoid_: Planner, spec editor

**Field Write**:
A solver-submitted write of fields by path. The Runtime checks and applies each path on its own; the applied paths land as one Revision and anything not written carries forward unchanged.
_Avoid_: Spec update, contract rewrite, full proposal

**Field Rewrite**:
The only way a field that already has a state changes, other than deciding an open field: a new state with a recorded reason. Nothing leaves a Revision by omission.
_Avoid_: Deletion, cleanup, supersession

**Evidence Admission**:
The Runtime check that binds text evidence to a trusted source and verifies its quote verbatim before registration. Request wording binds to the task's request, a user confirmation to a later user message supplied by the Host, and documents only to composition-authorized knowledge ids whose authority the composition root configures. Admission proves the text exists, not that it supports a proposition.
_Avoid_: Citation, self-reported source

**Assumed Field**:
A field whose value no qualifying evidence settles. It does not block a result query and is disclosed at publication.
_Avoid_: Inferred facet, guess

**Field Decision**:
The single model-facing way to settle an open field: one of its alternatives plus a rationale and optional evidence. The Runtime records it as verified when the cited evidence qualifies, otherwise as unverified and disclosed. An unverified decision on the material population is accepted only when the session has no clarification path.
_Avoid_: Select vs provisional choice, tentative selection

**Probe**:
One exploration run as an alternative of an open field, computing the final output under that alternative. The Runtime records its Result Fingerprint on the Query Task; an open field is decided only after every alternative has a probe or a declared waiver. A probe counts only while every other field holds the state it ran under; changing another field makes it stale.
_Avoid_: Sample query, alternative preview

**Result Fingerprint**:
Output identity that ignores column names, column order and row order and compares numbers at two decimals. Equal fingerprints mean two queries give the same answer.
_Avoid_: Result hash, content hash

**Equivalent Field**:
An open field whose every alternative produced the same Result Fingerprint. It counts as handled without a decision, advice or disclosure.
_Avoid_: Trivial choice, ignored ambiguity

**Field Advice**:
The Runtime's record, on the Query Task, of the comparison advisor's latest advice per open field. The Runtime asks for it once every alternative's output is known under the current other fields and the outputs differ; it applies only to the alternatives and probe outputs it compared. A decision that departs from the advice's clear lean must carry an override reason and evidence that qualifies for the field (observations never outweigh a lean on a semantic field); the advice itself is never evidence. When the advisor fails, the outage is recorded and asked again after a minute; the field may then be decided without advice, and the publication discloses it. When the advisor answers but favours no alternative, the request does not settle the field: while the user can be asked, the decision must cite the user's answer or a business document (request wording is not enough, the advisor already read it); without a clarification path the decision is recorded as undecided and disclosed. An open field that needs advice cannot be replaced by an assumption, only decided, settled by qualifying evidence, or reopened.
_Avoid_: Advice cache, recommendation store

**Decision Realization**:
The requirement that a result does not reproduce the probe output of an alternative the Revision did not adopt. A result that does is rejected as DECISION_NOT_REALIZED.
_Avoid_: Choice consistency check

**Spec Realization**:
The check that the final SQL implements the sealed fields, read from the fields and the SQL text only. A conflict no correct implementation can have (a row cap that differs from `selection.n`, a cap that drops ties the Spec keeps, a percentage or percentage-point difference never multiplied by 100) rejects the SQL before it runs as SPEC_NOT_REALIZED; a likely conflict is disclosed with the result. It judges implementation, never whether the meaning is right.
_Avoid_: SQL review, query digest

**Entity Identity Check**:
The Runtime's count of rows, distinct rows and distinct declared keys of each source in `population.source`, taken when a Revision with a settled entity and source commits. It reports a counted key that is not unique and exact duplicate rows; whether a duplicate is one entity or a separate one stays a Spec decision. Exact duplicate rows are a data-quality fact (ADR-0007 待定 5): rows are counted as stored unless the request or a business document says a repeated row is the same entity. Findings are shown with the Revision and disclosed with the result, never blocking.
_Avoid_: Deduplication rule, data quality verdict

**Calendar Coverage**:
The Runtime's list of the periods the time field actually has inside `population.time`, at the answer's year, quarter, month or day grain, read when a Revision commits. Periods without data make `population.missing` a required field and are disclosed with the result; how an absent period counts stays a Spec decision.
_Avoid_: Gap filling, zero-fill rule

**Necessity Rule**:
The rule that says which fields must have a state before a result query: eight always, and the measure sub-fields, `selection.ties` and `population.joinMultiplicity` when the formula, selection or source call for them, and `population.missing` when Calendar Coverage finds periods without data (ADR-0007). Not applicable is a state.
_Avoid_: Checklist item, decision point

**Business Definition Proposal**:
A candidate cross-task business rule produced from user correction or task evidence that requires business review before becoming authoritative.
_Avoid_: Saved learning, global rule

**Internal Evidence**:
Query data and metadata available to the solver for analysis but not yet authorized for user-visible delivery.
_Avoid_: Preview result, draft answer

**Validated Query Artifact**:
An immutable identity for a successfully previewed query and its Internal Evidence, used to ensure that review and delivery refer to the same query.
_Avoid_: Last SQL, validated SQL string

**Export Candidate**:
A private, unpublished query result held for review and promoted unchanged only when Delivery Policy permits publication.
_Avoid_: Temporary export, draft CSV

**Schema Evidence Fingerprint**:
The stable identity of the schema slice and reviewed structural evidence used to compile and review one query.
_Avoid_: Schema version, database version

**Review Token**:
A review result bound to one Validated Query Artifact, one Answer Spec version, and one Schema Evidence Fingerprint. It cannot authorize a different query or interpretation.
_Avoid_: Approval flag, validation boolean

**Review Outcome**:
The envelope that distinguishes whether review was available from the Review Decision produced when it was available.
_Avoid_: Review Decision, verdict

**Review Unavailable**:
A Review Outcome meaning that required review evidence could not be produced because the review capability failed or lacked coverage. It is distinct from Approved, Rejected, and Abstained.
_Avoid_: Approved with warning, reviewer rejection

**Semantic Diff**:
A structured statement of one requested-versus-observed semantic difference with references to the supporting Answer Spec and Query Digest evidence. It describes the mismatch without supplying replacement query logic.
_Avoid_: Reviewer explanation, suggested fix

**Invariant Probe**:
A conditional query property check whose applicability and blocking authority depend on explicitly satisfied evidence requirements.
_Avoid_: Sanity check, universal invariant

**Publication Authorization**:
A user's one-time permission to publish one exact Export Candidate with disclosed Semantic Diffs. It does not authorize later query or specification changes.
_Avoid_: Review override, permanent exception

**Automatic Semantic Repair**:
One solver attempt to revise a rejected candidate using only returned Semantic Diffs. It creates a new Validated Query Artifact and requires a new review.
_Avoid_: Retry loop, reviewer fix

**Publication Receipt**:
The evidence that one exact query result was published under a specific Review Outcome, Delivery Policy, and Publication Authorization when required.
_Avoid_: Export result, task-complete flag

**Publication Status**:
The delivery record distinguishing approved publication from publication with disclosed disagreement. Runner-level non-publication labels separately identify no export call, export failure, provider failure, and integrity blocking.
_Avoid_: Task complete, export success

**Assurance Audit Record**:
The non-sensitive provenance of a candidate's specification, query identity, review versions, coverage, differences, repair attempt, publication outcome, latency, and cost.
_Avoid_: Trace, conversation log

**Review Off**:
A declared mode in which Query Assurance review is unavailable and no Review Decision is produced. It must not be represented as Shadow Review or Approved.
_Avoid_: Disabled warning, implicit fallback

**Shadow Review**:
A review mode that records Review Decisions without affecting delivery.
_Avoid_: Optional validation, dry run

**Enforced Review**:
A review mode in which Delivery Policy acts on the Review Decision before results can be published. It is enabled only after Review Calibration meets the pre-registered enforcement thresholds.
_Avoid_: Hard validation, production review

**Review Calibration**:
The measured error-detection, false-rejection, stability, latency, and cost profile used to decide whether a review capability may gain blocking authority.
_Avoid_: Benchmark score, prompt tuning

**Assurance Circuit Breaker**:
The control that removes blocking authority and returns Enforced Review to Shadow Review when calibration assumptions, availability, latency, cost, or observed precision degrade.
_Avoid_: Reviewer retry, automatic approval

**Delivery Policy**:
The environment-specific rule applied after a Review Decision. The default is deliver with disclosure; product integrations may explicitly choose fail closed or ask the user for a dirty-data choice. Spider2 may submit with disagreement but must not label the submission Approved.
_Avoid_: Reviewer verdict, retry policy

**ChartSpec**:
The versioned, serializable description of one chart shared by chat widgets, dashboards and reports: mark, field encodings, ordering, titles, and any declared data selection. It contains no data transformation or aggregation and reads its data through a Dataset Reference; the compiled rendering option is never persisted (ADR-0008).
_Avoid_: Chart config, ECharts option, view spec

**Dataset Reference**:
An opaque reference to immutable chart data, either a Publication Receipt or a registered derived dataset, that Runtime resolves and checks for delivery eligibility before compilation. Model-supplied rows and overwritable file paths are not Dataset References.
_Avoid_: Data path, inline rows

**Physical Profile**:
The per-column observed facts, such as physical kind, null count and numeric range, that Runtime attaches to a Publication Receipt at publication by scanning every stored row. It states facts only and never decides scale, unit or additivity.
_Avoid_: Column types, field semantics

**Dataset Annotation**:
An append-only statement of one column's field semantics, such as storage and display scale, unit, additivity and temporal grain, keyed by Dataset Reference and carrying its basis. Annotations resolve by Evidence Authority; conflicting annotations of equal authority are reported, not chosen.
_Avoid_: Metadata override, field config

**Presentation Notice**:
A record of how a chart presents its data: a layout adjustment, a viewport, or a declared data selection. It is delivered with the chart and recomputed on refresh, export or resize. It is distinct from Disclosure, which records unresolved observations about the published result; both are shown together at delivery.
_Avoid_: Disclosure, chart warning

**Channel**:
An adapter for one external platform or trigger source (an IM, a scheduler, an MCP Events server) that turns its inbound events into Submissions and renders Deliverables back. It speaks only the versioned protocol and never reaches Answering, tools or the agent harness (ADR-0011).
_Avoid_: Gateway, bot, integration

**Submission**:
The single inbound shape a Channel hands the Runtime: a deduplicated request id, a Conversation Address, a verified actor and a body: an input, a clarification answer, a new-conversation request or an access decision (ADR-0011 decision 2).
_Avoid_: Message, webhook payload

**Conversation Address**:
Where a conversation lives on a Channel (tenant, chat, optional thread) and who can see it there (direct or group). One Address holds one Session per speaking user; Sessions keep a single owner.
_Avoid_: Chat id, channel session

**Deliverable**:
What may leave the system through a Channel: a Question, a Publication delivery (by Receipt), a Dashboard delivery, an Access Request or a Notice (ADR-0011 decision 3). Deliverables are persisted before delivery and keyed for idempotency; run progress is not a Deliverable and may be dropped.
_Avoid_: Outbound message, notification
