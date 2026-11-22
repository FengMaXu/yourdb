import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BusinessContext, PhysicalProfile } from "../answering/public.js";
import { buildPhysicalProfile } from "../answering/public.js";

/**
 * Derived datasets (ADR-0008 decision 4): results a Runtime-run Python job
 * computed from published results. Each is immutable, keeps where it came
 * from, and is readable only by the session and principal that made it.
 * Only the Runtime registers them; no tool accepts rows to register.
 */

export interface DerivedInput {
  readonly receiptId: string;
  readonly contentHash: string;
}

export interface DerivedProvenance {
  readonly inputs: readonly DerivedInput[];
  /** SHA-256 of the script that produced the rows. */
  readonly scriptSha256: string;
  readonly jobId: string;
  readonly createdAt: string;
}

export interface DerivedDatasetRecord {
  readonly derivedId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly columns: readonly string[];
  /** JSON values as the job wrote them. */
  readonly rows: readonly (readonly unknown[])[];
  readonly contentHash: string;
  readonly physicalProfile: PhysicalProfile;
  readonly provenance: DerivedProvenance;
}

export interface DerivedDatasetStore {
  /** Writes once; a second put of the same id fails. */
  put(record: DerivedDatasetRecord): Promise<void>;
  get(derivedId: string): Promise<DerivedDatasetRecord | undefined>;
}

export class InMemoryDerivedDatasetStore implements DerivedDatasetStore {
  private readonly records = new Map<string, string>();
  async put(record: DerivedDatasetRecord): Promise<void> {
    if (this.records.has(record.derivedId)) throw new Error("DERIVED_DATASET_EXISTS");
    this.records.set(record.derivedId, JSON.stringify(record));
  }
  async get(derivedId: string): Promise<DerivedDatasetRecord | undefined> {
    const stored = this.records.get(derivedId);
    return stored ? JSON.parse(stored) as DerivedDatasetRecord : undefined;
  }
}

const DERIVED_ID = /^derived_[0-9a-f-]{36}$/;

/** One JSON file per dataset under the Runtime's data root, outside any workspace. */
export class FileDerivedDatasetStore implements DerivedDatasetStore {
  constructor(private readonly root: string) {}
  async put(record: DerivedDatasetRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // "wx" fails if the file exists, so a record is never overwritten.
    await writeFile(path.join(this.root, `${record.derivedId}.json`), JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  }
  async get(derivedId: string): Promise<DerivedDatasetRecord | undefined> {
    if (!DERIVED_ID.test(derivedId)) return undefined;
    try {
      return JSON.parse(await readFile(path.join(this.root, `${derivedId}.json`), "utf8")) as DerivedDatasetRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export function derivedContentHash(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return createHash("sha256").update(JSON.stringify({ columns, rows })).digest("hex");
}

/** A derived dataset holds at most as many rows as a published result. */
export const MAX_DERIVED_ROWS = 100_000;

export interface RegisterDerived {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly inputs: readonly DerivedInput[];
  readonly script: string;
  readonly jobId: string;
}

export class DerivedDatasets {
  constructor(private readonly store: DerivedDatasetStore) {}

  async register(input: RegisterDerived, context: BusinessContext): Promise<DerivedDatasetRecord> {
    if (input.rows.length > MAX_DERIVED_ROWS) throw new Error(`DERIVED_DATASET_TOO_LARGE: ${input.rows.length} rows; at most ${MAX_DERIVED_ROWS}`);
    if (input.rows.some((row) => row.length !== input.columns.length)) throw new Error("DERIVED_DATASET_INVALID: every row needs one value per column");
    const record: DerivedDatasetRecord = {
      derivedId: `derived_${randomUUID()}`,
      name: input.name,
      sessionId: context.sessionId,
      principalId: context.principal.id,
      columns: [...input.columns],
      rows: input.rows.map((row) => [...row]),
      contentHash: derivedContentHash(input.columns, input.rows),
      physicalProfile: buildPhysicalProfile({ columns: input.columns, rows: input.rows, truncated: false }),
      provenance: {
        inputs: [...input.inputs],
        scriptSha256: createHash("sha256").update(input.script).digest("hex"),
        jobId: input.jobId,
        createdAt: new Date().toISOString(),
      },
    };
    await this.store.put(record);
    return record;
  }

  /** The dataset if this session and principal made it; otherwise not found, without saying whether it exists. */
  async resolve(derivedId: string, context: BusinessContext): Promise<DerivedDatasetRecord> {
    const record = await this.store.get(derivedId);
    if (!record || record.sessionId !== context.sessionId || record.principalId !== context.principal.id) throw new Error("DERIVED_DATASET_NOT_FOUND");
    if (derivedContentHash(record.columns, record.rows) !== record.contentHash) throw new Error("DERIVED_DATASET_INTEGRITY_MISMATCH");
    return record;
  }
}
