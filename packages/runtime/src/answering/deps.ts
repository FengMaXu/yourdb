import type { SchemaProfile } from "./schema-profile.js";
import type { DataFalsificationOptions } from "./data-falsification.js";
import type { BusinessContext, QueryBudgetPolicy } from "./model.js";
import type { AnsweringStore } from "./answering-store.js";
import type { ResultStore } from "./result-store.js";
import type { EvidenceSource } from "./evidence-admission.js";
import type { FanoutDialect, FanoutSchema } from "./fanout-check.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";

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
  /** Whether an unverified decision may settle the material population (ADR-0006). */
  readonly populationDecisions: "require_evidence" | "allow_disclosed";
  readonly evidenceSource?: EvidenceSource;
  readonly fanout: FanoutAnsweringOptions;
  /** Bounds of the entity identity counts run after a set call. */
  readonly entityIdentity?: EntityIdentityOptions;
  /** Bounds of the data falsification probes after a result query (plan T4.3). */
  readonly dataFalsification?: DataFalsificationOptions;
  /** Session-scoped Schema Profile: every data-check read is memoized here (plan T5.3). */
  readonly schemaProfile: SchemaProfile;
  /** How a Receipt names its published artifact for the transport; an opaque handle by default. */
  readonly formatPublicRef?: (receiptId: string, sessionId: string) => string;
  /** Cached per Answering instance; loaded lazily from the executor. */
  readonly loadFanoutSchema: (context: BusinessContext) => Promise<FanoutSchema | undefined>;
}

export interface EntityIdentityOptions {
  /** Above this many rows the DISTINCT counts are skipped and reported as a limitation. */
  readonly maxRows?: number;
  /** Each counting query is abandoned after this long and reported as a limitation. */
  readonly timeoutMs?: number;
}
