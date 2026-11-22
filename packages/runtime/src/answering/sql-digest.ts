// A static import so the distribution bundle carries the parser; its types are not re-exported.
import sqlParserModule from "node-sql-parser";
import type { FanoutDialect } from "./fanout-check.js";

/**
 * Query Digest (plan T5.1): a deterministic structural summary of one SQL
 * statement, read from a multi-dialect AST parser. The parser and its AST
 * types stay inside this module; callers see only the digest below. A
 * statement the parser cannot read is `unsupported`, never an error, so a
 * check built on the digest reports `unknown` instead of guessing.
 */

export type DigestJoinType = "inner" | "left" | "right" | "full" | "cross";
export type DigestStage = "on" | "where" | "having" | "qualify";

export interface DigestColumn {
  /** Qualifier as written (alias or table), lower-cased; absent when unqualified. */
  readonly table?: string;
  readonly column: string;
}

export interface DigestAggregate {
  readonly fn: string;
  readonly distinct: boolean;
  readonly columns: readonly DigestColumn[];
  /** An aggregate with OVER (...) is a window, not a grouping layer. */
  readonly windowed: boolean;
}

export interface DigestRelation {
  readonly table: string;
  readonly alias?: string;
  /** How it joins the block; absent for the first FROM item. */
  readonly join?: DigestJoinType;
  /** Columns the ON condition reads. */
  readonly on: readonly DigestColumn[];
}

export interface DigestFilter {
  readonly stage: DigestStage;
  readonly columns: readonly DigestColumn[];
  /** Predicates split on AND at the top of the condition. */
  readonly predicates: readonly DigestPredicate[];
}

export interface DigestPredicate {
  readonly columns: readonly DigestColumn[];
  /** The predicate passes rows whose columns are NULL (IS NULL, COALESCE, OR …). */
  readonly nullTolerant: boolean;
}

export interface DigestBlock {
  readonly id: number;
  readonly kind: "outer" | "cte" | "subquery" | "set_operand";
  readonly name?: string;
  /** Nesting depth: the outer query is 0, a CTE or FROM subquery one more than its parent. */
  readonly depth: number;
  readonly parent?: number;
  readonly relations: readonly DigestRelation[];
  /** CTE or subquery blocks this block reads. */
  readonly reads: readonly number[];
  readonly groupBy: readonly DigestColumn[];
  readonly aggregates: readonly DigestAggregate[];
  readonly windows: number;
  readonly filters: readonly DigestFilter[];
  readonly limit?: number;
  readonly orderBy: boolean;
}

export interface QueryDigest {
  readonly status: "parsed";
  /** The grammar that read the statement. */
  readonly grammar: string;
  readonly tables: readonly string[];
  readonly blocks: readonly DigestBlock[];
}

export type DigestResult = QueryDigest | { readonly status: "unsupported"; readonly reason: string };

type Node = Record<string, unknown>;
type ParserLike = { astify(sql: string, options: { database: string }): unknown };

let parser: ParserLike | undefined;
function sqlParser(): ParserLike {
  if (!parser) {
    const { Parser } = sqlParserModule as unknown as { Parser: new () => ParserLike };
    parser = new Parser();
  }
  return parser;
}

const GRAMMARS: Readonly<Record<FanoutDialect, readonly string[]>> = {
  // The SQLite grammar misses window clauses; its syntax is read by PostgreSQL's, then MySQL's.
  sqlite: ["sqlite", "postgresql", "mysql"],
  postgres: ["postgresql"],
  mysql: ["mysql", "mariadb"],
  bigquery: ["bigquery"],
  snowflake: ["snowflake", "postgresql"],
};

const isNode = (value: unknown): value is Node => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function name(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isNode(value)) {
    if (typeof value.value === "string") return value.value;
    // Function names are a list of parts (schema.fn) in node-sql-parser 5.
    if (Array.isArray(value.name)) return value.name.map(name).filter(Boolean).join(".");
    if (isNode(value.name)) return name(value.name);
    if (isNode(value.expr)) return name(value.expr);
  }
  return undefined;
}

function columnOf(node: Node): DigestColumn | undefined {
  const column = name(node.column);
  if (!column || column === "*") return undefined;
  const table = name(node.table);
  return { ...(table ? { table: table.toLowerCase() } : {}), column: column.toLowerCase() };
}

function joinType(value: unknown): DigestJoinType | undefined {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!text) return undefined;
  if (text.includes("left")) return "left";
  if (text.includes("right")) return "right";
  if (text.includes("full")) return "full";
  if (text.includes("cross")) return "cross";
  return "inner";
}

/** The SELECT a node holds: itself, or the `ast` of a parenthesized statement. */
function selectOf(value: unknown): Node | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "select") return value;
  if (isNode(value.ast)) return selectOf(value.ast);
  return undefined;
}

class Builder {
  readonly blocks: DigestBlock[] = [];
  readonly tables = new Set<string>();
  private readonly ctes = new Map<string, number>();

  block(select: Node, kind: DigestBlock["kind"], depth: number, parent: number | undefined, blockName?: string): number {
    const id = this.blocks.length;
    // Reserve the id so nested blocks number after their parent.
    this.blocks.push(undefined as unknown as DigestBlock);
    for (const item of Array.isArray(select.with) ? select.with : []) {
      if (!isNode(item)) continue;
      const cteName = name(item.name)?.toLowerCase();
      const stmt = selectOf(item.stmt);
      if (cteName && stmt) this.ctes.set(cteName, this.block(stmt, "cte", depth + 1, id, cteName));
    }
    const relations: DigestRelation[] = [];
    const reads: number[] = [];
    const filters: DigestFilter[] = [];
    const aggregates: DigestAggregate[] = [];
    let windows = 0;
    const scan = (value: unknown) => {
      const found = this.expression(value, depth, id);
      aggregates.push(...found.aggregates);
      windows += found.windows;
      reads.push(...found.reads);
      return found.columns;
    };
    for (const item of Array.isArray(select.from) ? select.from : []) {
      if (!isNode(item)) continue;
      const alias = name(item.as)?.toLowerCase();
      const join = joinType(item.join);
      const sub = selectOf(item.expr);
      if (sub) {
        reads.push(this.block(sub, "subquery", depth + 1, id, alias));
        if (join && item.on) filters.push(this.filter("on", item.on, scan));
        continue;
      }
      const table = name(item.table)?.toLowerCase();
      if (!table) continue;
      const cte = this.ctes.get(table);
      if (cte !== undefined) reads.push(cte);
      else this.tables.add(table);
      const on = item.on ? this.filter("on", item.on, scan) : undefined;
      if (on) filters.push(on);
      relations.push({ table, ...(alias ? { alias } : {}), ...(join ? { join } : {}), on: on?.columns ?? [] });
    }
    for (const column of Array.isArray(select.columns) ? select.columns : []) if (isNode(column)) scan(column.expr);
    if (select.where) filters.push(this.filter("where", select.where, scan));
    const groupBy: DigestColumn[] = [];
    const groupNode = isNode(select.groupby) ? select.groupby.columns : select.groupby;
    const selected = Array.isArray(select.columns) ? select.columns : [];
    for (const item of Array.isArray(groupNode) ? groupNode : []) {
      // GROUP BY 1 names the first output column.
      const position = isNode(item) && item.type === "number" && typeof item.value === "number" ? item.value : undefined;
      const target = position !== undefined && isNode(selected[position - 1]) ? (selected[position - 1] as Node).expr : undefined;
      groupBy.push(...(target !== undefined ? columnRefs(target) : scan(item)));
    }
    if (select.having) filters.push(this.filter("having", select.having, scan));
    if (select.qualify) filters.push(this.filter("qualify", select.qualify, scan));
    const orderBy = Array.isArray(select.orderby) && select.orderby.length > 0;
    for (const item of Array.isArray(select.orderby) ? select.orderby : []) if (isNode(item)) scan(item.expr);
    const limit = this.limit(select);
    this.blocks[id] = {
      id,
      kind,
      ...(blockName ? { name: blockName } : {}),
      depth,
      ...(parent !== undefined ? { parent } : {}),
      relations,
      reads: [...new Set(reads)],
      groupBy,
      aggregates,
      windows,
      filters,
      ...(limit !== undefined ? { limit } : {}),
      orderBy,
    };
    // UNION / INTERSECT / EXCEPT operands are sibling blocks at the same depth.
    const next = selectOf(select._next);
    if (next) this.block(next, "set_operand", depth, parent, blockName);
    return id;
  }

  private limit(select: Node): number | undefined {
    const limit = isNode(select.limit) ? select.limit : undefined;
    const values = Array.isArray(limit?.value) ? limit.value.filter(isNode) : [];
    // MySQL's LIMIT offset, count caps at the second number.
    const count = values.at(-1);
    if (count && typeof count.value === "number") return count.value;
    const top = isNode(select.top) ? select.top.value : undefined;
    return typeof top === "number" ? top : undefined;
  }

  private filter(stage: DigestStage, condition: unknown, scan: (value: unknown) => DigestColumn[]): DigestFilter {
    const predicates = conjuncts(condition).map((predicate) => ({ columns: scan(predicate), nullTolerant: nullTolerant(predicate) }));
    return { stage, columns: predicates.flatMap((item) => item.columns), predicates };
  }

  /** Columns, aggregates and nested blocks of one expression; nested SELECTs become their own blocks. */
  private expression(value: unknown, depth: number, parent: number): { columns: DigestColumn[]; aggregates: DigestAggregate[]; windows: number; reads: number[] } {
    const out = { columns: [] as DigestColumn[], aggregates: [] as DigestAggregate[], windows: 0, reads: [] as number[] };
    const visit = (node: unknown, inAggregate: boolean) => {
      if (Array.isArray(node)) { for (const item of node) visit(item, inAggregate); return; }
      if (!isNode(node)) return;
      const sub = selectOf(node);
      if (sub && node.type === "select" || (sub && isNode(node.ast))) {
        out.reads.push(this.block(sub!, "subquery", depth + 1, parent));
        return;
      }
      if (node.type === "column_ref") {
        const column = columnOf(node);
        if (column) out.columns.push(column);
        return;
      }
      if (node.type === "aggr_func" || (node.type === "function" && /^(count|sum|avg|min|max|median|total|group_concat|string_agg|array_agg)$/i.test(name(node.name) ?? ""))) {
        const windowed = Boolean(node.over);
        const args = isNode(node.args) ? node.args : {};
        const before = out.columns.length;
        visit(args.expr ?? args.value, true);
        out.aggregates.push({ fn: (name(node.name) ?? "").toLowerCase(), distinct: typeof args.distinct === "string" && /distinct/i.test(args.distinct), columns: out.columns.slice(before), windowed });
        if (windowed) out.windows += 1;
        return;
      }
      if (node.type === "window_func" || (isNode(node.over) && node.type === "function")) {
        out.windows += 1;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "loc" || key === "over" && !inAggregate) continue;
        visit(child, inAggregate);
      }
    };
    visit(value, false);
    return out;
  }
}

/** Column references of an expression, without registering nested blocks. */
function columnRefs(value: unknown): DigestColumn[] {
  const out: DigestColumn[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isNode(node) || selectOf(node)) return;
    if (node.type === "column_ref") { const column = columnOf(node); if (column) out.push(column); return; }
    for (const [key, child] of Object.entries(node)) if (key !== "loc") visit(child);
  };
  visit(value);
  return out;
}

/** The predicates of a condition split on top-level AND. */
function conjuncts(condition: unknown): unknown[] {
  if (isNode(condition) && condition.type === "binary_expr" && typeof condition.operator === "string" && condition.operator.toUpperCase() === "AND") {
    return [...conjuncts(condition.left), ...conjuncts(condition.right)];
  }
  return [condition];
}

/** Whether a predicate can pass a row whose referenced columns are NULL. */
function nullTolerant(predicate: unknown): boolean {
  let tolerant = false;
  const visit = (node: unknown) => {
    if (tolerant) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isNode(node)) return;
    const operator = typeof node.operator === "string" ? node.operator.toUpperCase() : "";
    if (operator === "OR" || operator === "IS" && isNode(node.right) && node.right.type === "null") { tolerant = true; return; }
    if (operator === "IS NOT" && isNode(node.right) && node.right.type === "null") return;
    if (node.type === "function" && /^(coalesce|ifnull|nvl|isnull)$/i.test(name(node.name) ?? "")) { tolerant = true; return; }
    for (const [key, child] of Object.entries(node)) if (key !== "loc") visit(child);
  };
  visit(predicate);
  return tolerant;
}

const cache = new Map<string, DigestResult>();

/** The digest of one SELECT/WITH statement, or `unsupported` with the reason. */
export function digestSql(sql: string, dialect: FanoutDialect = "sqlite"): DigestResult {
  const key = `${dialect}\u0000${sql}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let reason = "no grammar read the statement";
  let result: DigestResult | undefined;
  for (const grammar of GRAMMARS[dialect]) {
    try {
      const parsed = sqlParser().astify(sql.trim().replace(/;+\s*$/, ""), { database: grammar });
      const statements = Array.isArray(parsed) ? parsed : [parsed];
      if (statements.length !== 1) { reason = "more than one statement"; break; }
      const select = selectOf(statements[0]);
      if (!select) { reason = "the statement is not a SELECT"; break; }
      const builder = new Builder();
      builder.block(select, "outer", 0, undefined);
      result = { status: "parsed", grammar, tables: [...builder.tables], blocks: builder.blocks };
      break;
    } catch (error) {
      reason = `the ${grammar} grammar could not read the statement: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
    }
  }
  const out = result ?? { status: "unsupported" as const, reason };
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}

/** Blocks that aggregate rows into groups (a windowed aggregate does not). */
export function aggregatingBlocks(digest: QueryDigest): readonly DigestBlock[] {
  return digest.blocks.filter((block) => block.aggregates.some((item) => !item.windowed));
}

/** Aggregation layers the statement can perform: aggregating blocks plus windowed aggregates. */
export function aggregationCapacity(digest: QueryDigest): number {
  return aggregatingBlocks(digest).length + digest.blocks.reduce((sum, block) => sum + block.aggregates.filter((item) => item.windowed).length, 0);
}

export interface DegeneratedJoin {
  readonly block: number;
  readonly table: string;
  readonly alias: string;
  readonly column: string;
}

/**
 * LEFT JOINs whose right side a WHERE predicate filters in a way NULL rows
 * cannot pass, which makes them inner joins.
 */
export function degeneratedOuterJoins(digest: QueryDigest): readonly DegeneratedJoin[] {
  const out: DegeneratedJoin[] = [];
  for (const block of digest.blocks) {
    for (const relation of block.relations) {
      if (relation.join !== "left") continue;
      const alias = relation.alias ?? relation.table;
      for (const filter of block.filters.filter((item) => item.stage === "where")) {
        const hit = filter.predicates.find((predicate) => !predicate.nullTolerant && predicate.columns.some((column) => column.table === alias));
        const column = hit?.columns.find((item) => item.table === alias);
        if (column) { out.push({ block: block.id, table: relation.table, alias, column: column.column }); break; }
      }
    }
  }
  return out;
}
