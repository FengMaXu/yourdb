import {
  contentHash,
  clone,
  type BusinessContext,
  type PrivateResultRef,
  type PublicationReceipt,
} from "./model.js";
import { makeInternalId } from "./internal-ids.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferType } from "./support.js";

export interface ResultStream {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly columnTypes?: readonly string[];
  readonly truncated: boolean;
}

export interface PrivateResultObject {
  readonly resultRef: PrivateResultRef;
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly contentHash: string;
}

export interface ResultStore {
  createPrivate(input: ResultStream, context: BusinessContext): Promise<PrivateResultObject>;
  openPrivate(ref: PrivateResultRef, context: BusinessContext): Promise<PrivateResultObject | undefined>;
  openAuthorized(ref: PrivateResultRef, receipt: PublicationReceipt, context: BusinessContext): Promise<PrivateResultObject>;
  discard(ref: PrivateResultRef, context: BusinessContext): Promise<void>;
  /** Remove only private objects not referenced by durable Candidate records. */
  reconcile(referenced: readonly PrivateResultRef[], context: BusinessContext): Promise<readonly PrivateResultRef[]>;
  encodeCsv(ref: PrivateResultRef, context: BusinessContext): Promise<{ readonly content: string; readonly contentHash: string }>;
}


function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return { __type: "bigint", value: value.toString() };
  if (value === undefined) return { __type: "undefined" };
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function csvField(value: unknown): string {
  // CSV has no NULL token. Keep NULL as an unquoted empty field and encode an
  // actual empty string as `""`, so the two values remain distinguishable.
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : typeof value === "bigint" ? value.toString() : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(stableValue(value)) : String(value);
  return raw === "" ? "\"\"" : /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function assertContext(context: BusinessContext): void {
  if (!context?.principal?.id || !context.sessionId || !context.operationId || !context.invocationId) throw new Error("ANSWERING_CONTEXT_INVALID");
  if (context.signal?.aborted) throw new Error("ANSWERING_OPERATION_ABORTED");
}

function encodeWire(value: unknown): unknown {
  if (typeof value === "bigint") return { __type: "bigint", value: value.toString() };
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (value === undefined) return { __type: "undefined" };
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]));
  return value;
}

function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__type === "bigint" && typeof record.value === "string") return BigInt(record.value);
    if (record.__type === "date" && typeof record.value === "string") return new Date(record.value);
    if (record.__type === "undefined") return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeWire(item)]));
  }
  return value;
}

function encodeStored(value: unknown): string {
  return JSON.stringify(encodeWire(value));
}

function decodeStored(value: string): unknown {
  return decodeWire(JSON.parse(value) as unknown);
}

function resultForStream(input: ResultStream, resultRef: PrivateResultRef): PrivateResultObject {
  const columns = [...input.columns];
  const rows = input.rows.map((row) => [...row]);
  if (rows.some((row) => row.length !== columns.length)) throw new Error("RESULT_ROW_WIDTH_MISMATCH");
  const columnTypes = [...(input.columnTypes ?? columns.map((_, index) => inferType(rows[0]?.[index])))];
  if (columnTypes.length !== columns.length) throw new Error("RESULT_COLUMN_TYPE_WIDTH_MISMATCH");
  return {
    resultRef,
    columns,
    columnTypes,
    rows,
    rowCount: rows.length,
    truncated: input.truncated,
    contentHash: contentHash({ columns, columnTypes, rows: rows.map((row) => row.map(stableValue)), truncated: input.truncated }),
  };
}

function validateStoredResult(value: unknown, expectedRef: PrivateResultRef): PrivateResultObject {
  if (!value || typeof value !== "object") throw new Error("RESULT_INTEGRITY_MISMATCH");
  const stored = value as Partial<PrivateResultObject>;
  if (stored.resultRef !== expectedRef || !Array.isArray(stored.columns) || !Array.isArray(stored.rows) || !Array.isArray(stored.columnTypes) || typeof stored.truncated !== "boolean") {
    throw new Error("RESULT_INTEGRITY_MISMATCH");
  }
  const rebuilt = resultForStream({ columns: stored.columns, rows: stored.rows, columnTypes: stored.columnTypes, truncated: stored.truncated }, expectedRef);
  if (rebuilt.contentHash !== stored.contentHash || rebuilt.rowCount !== stored.rowCount) throw new Error("RESULT_INTEGRITY_MISMATCH");
  return rebuilt;
}

/** Immutable private result objects; it never executes SQL and has no policy authority. */
export class InMemoryResultStore implements ResultStore {
  private readonly objects = new Map<PrivateResultRef, PrivateResultObject>();

  async createPrivate(input: ResultStream, context: BusinessContext): Promise<PrivateResultObject> {
    assertContext(context);
    const result = resultForStream(input, makeInternalId("result") as unknown as PrivateResultRef);
    this.objects.set(result.resultRef, clone(result));
    return clone(result);
  }

  async openPrivate(ref: PrivateResultRef, context: BusinessContext): Promise<PrivateResultObject | undefined> {
    assertContext(context);
    const result = this.objects.get(ref);
    return result ? clone(result) : undefined;
  }

  async openAuthorized(ref: PrivateResultRef, receipt: PublicationReceipt, context: BusinessContext): Promise<PrivateResultObject> {
    if (receipt.principalId !== context.principal.id || receipt.sessionId !== context.sessionId) throw new Error("RESULT_REF_NOT_AUTHORIZED");
    const result = await this.openPrivate(ref, context);
    if (!result || result.contentHash !== receipt.contentHash || result.resultRef !== receipt.resultRef) throw new Error("RESULT_REF_NOT_AUTHORIZED");
    return result;
  }

  async discard(ref: PrivateResultRef, context: BusinessContext): Promise<void> {
    assertContext(context);
    this.objects.delete(ref);
  }

  async reconcile(referenced: readonly PrivateResultRef[], context: BusinessContext): Promise<readonly PrivateResultRef[]> {
    assertContext(context);
    const keep = new Set(referenced);
    const removed: PrivateResultRef[] = [];
    for (const ref of [...this.objects.keys()]) {
      if (keep.has(ref)) continue;
      this.objects.delete(ref);
      removed.push(ref);
    }
    return removed;
  }

  async encodeCsv(ref: PrivateResultRef, context: BusinessContext): Promise<{ readonly content: string; readonly contentHash: string }> {
    const result = await this.openPrivate(ref, context);
    if (!result) throw new Error("RESULT_NOT_FOUND");
    const content = `${result.columns.map(csvField).join(",")}\n${result.rows.map((row) => row.map(csvField).join(",")).join("\n")}${result.rows.length ? "\n" : ""}`;
    return { content, contentHash: contentHash(content) };
  }
}

/**
 * Durable private ResultStore for a Session Host. Objects are immutable JSON
 * files outside the Pi Session; the Session stores only opaque ResultRef and
 * content hash. A missing/corrupt object is never repaired by re-running SQL.
 */
export class FileResultStore implements ResultStore {
  constructor(private readonly root: string) {}

  private file(ref: PrivateResultRef): string {
    const value = String(ref);
    if (!/^result_[A-Za-z0-9-]+$/.test(value)) throw new Error("RESULT_REF_INVALID");
    return path.join(path.resolve(this.root), `${value}.json`);
  }

  async createPrivate(input: ResultStream, context: BusinessContext): Promise<PrivateResultObject> {
    assertContext(context);
    const result = resultForStream(input, makeInternalId("result") as unknown as PrivateResultRef);
    await mkdir(path.resolve(this.root), { recursive: true });
    await writeFile(this.file(result.resultRef), encodeStored(result), { encoding: "utf8", flag: "wx" });
    return clone(result);
  }

  async openPrivate(ref: PrivateResultRef, context: BusinessContext): Promise<PrivateResultObject | undefined> {
    assertContext(context);
    try {
      const parsed = decodeStored(await readFile(this.file(ref), "utf8"));
      return clone(validateStoredResult(parsed, ref));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async openAuthorized(ref: PrivateResultRef, receipt: PublicationReceipt, context: BusinessContext): Promise<PrivateResultObject> {
    if (receipt.principalId !== context.principal.id || receipt.sessionId !== context.sessionId) throw new Error("RESULT_REF_NOT_AUTHORIZED");
    const result = await this.openPrivate(ref, context);
    if (!result || result.resultRef !== receipt.resultRef || result.contentHash !== receipt.contentHash) throw new Error("RESULT_REF_NOT_AUTHORIZED");
    return result;
  }

  async discard(ref: PrivateResultRef, context: BusinessContext): Promise<void> {
    assertContext(context);
    await rm(this.file(ref), { force: true });
  }

  async reconcile(referenced: readonly PrivateResultRef[], context: BusinessContext): Promise<readonly PrivateResultRef[]> {
    assertContext(context);
    await mkdir(path.resolve(this.root), { recursive: true });
    const keep = new Set(referenced.map(String));
    const removed: PrivateResultRef[] = [];
    for (const name of await readdir(path.resolve(this.root))) {
      if (!/^result_[A-Za-z0-9-]+\.json$/.test(name)) continue;
      const ref = name.slice(0, -5) as PrivateResultRef;
      if (keep.has(String(ref))) continue;
      await rm(path.join(path.resolve(this.root), name), { force: true });
      removed.push(ref);
    }
    return removed;
  }

  async encodeCsv(ref: PrivateResultRef, context: BusinessContext): Promise<{ readonly content: string; readonly contentHash: string }> {
    const result = await this.openPrivate(ref, context);
    if (!result) throw new Error("RESULT_NOT_FOUND");
    const content = `${result.columns.map(csvField).join(",")}\n${result.rows.map((row) => row.map(csvField).join(",")).join("\n")}${result.rows.length ? "\n" : ""}`;
    return { content, contentHash: contentHash(content) };
  }
}
