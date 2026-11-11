import type { BusinessContext, QueryBudgetPolicy } from "./model.js";
import type { AnsweringStore } from "./answering-store.js";
import type { ResultStore } from "./result-store.js";
import type { EvidenceSource } from "./evidence-admission.js";
import type { FanoutDialect, FanoutSchema } from "./fanout-check.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import type { FieldAdviceOptions } from "./advice-execution.js";

export interface FanoutAnsweringOptions {
  readonly enabled?: boolean;
  readonly dialect?: FanoutDialect;
  readonly schema?: FanoutSchema;
  readonly maxTargets?: number;
  readonly maxInputRows?: number;
}

export type SemanticQualificationMode = "required" | "bypassed";

/**
 * Resolved collaborators shared by the Answering use-case modules. Only the
 * InMemoryAnswering facade constructs it; each module keeps its own
 * transaction boundaries and never exposes these capabilities to callers.
 */
export interface AnsweringDeps {
  readonly store: AnsweringStore;
  readonly resultStore: ResultStore;
  readonly sqlExecutor: AnsweringSqlExecutor;
  readonly budgetPolicy: QueryBudgetPolicy;
  readonly maxResultRows: number;
  readonly semanticQualificationMode: SemanticQualificationMode;
  /** Probe tracking for open fields and the decide-after-probe rule (ADR-0005). */
  readonly fieldProbes: boolean;
  /** The advisor the Runtime asks about an open field whose probe outputs differ (ADR-0005). */
  readonly fieldAdvice?: FieldAdviceOptions;
  /** An advisor is configured and probes are tracked, so decisive open fields need advice before a decision. */
  readonly adviceRequired: boolean;
  /** Whether an unverified decision may settle the material population (ADR-0006). */
  readonly populationDecisions: "require_evidence" | "allow_disclosed";
  readonly evidenceSource?: EvidenceSource;
  readonly fanout: FanoutAnsweringOptions;
  /** Cached per Answering instance; loaded lazily from the executor. */
  readonly loadFanoutSchema: (context: BusinessContext) => Promise<FanoutSchema | undefined>;
}
