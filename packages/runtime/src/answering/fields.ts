import { asRecord, trimmedText } from "../primitives.js";

/**
 * The Answer Spec field tree (ADR-0007, target model). Every ambiguity of an
 * answer sits on one of these paths, in calculation order: who is counted
 * (population), what is computed (measure), how it is grouped, which objects
 * are kept (selection), and what is delivered (output).
 */
export const FIELD_PATHS = [
  "population.entity",
  "population.eligibility",
  "population.conditions",
  "population.source",
  "population.time",
  "population.timeField",
  "population.missing",
  "population.joinMultiplicity",
  "measure.formula",
  "measure.countGrain",
  "measure.denominator",
  "measure.window",
  "grouping",
  "selection",
  "selection.ties",
  "output",
] as const;

export type FieldPath = typeof FIELD_PATHS[number];

/** A Report Task's named measure definitions (ADR-0009), referenced by its chart queries. */
export type MeasureDefinitionPath = `measures.${string}`;
export type SpecPath = FieldPath | MeasureDefinitionPath;

export const MEASURE_DEFINITION = /^measures\.([A-Za-z0-9_一-鿿-]{1,64})$/;

export function isFieldPath(value: string): value is FieldPath {
  return (FIELD_PATHS as readonly string[]).includes(value);
}

export function isSpecPath(value: string): value is SpecPath {
  return isFieldPath(value) || MEASURE_DEFINITION.test(value);
}

/** The top-level nodes of the tree. */
export const FIELD_SECTIONS = ["population", "measure", "grouping", "selection", "output"] as const;
export type FieldSection = typeof FIELD_SECTIONS[number];


/**
 * Physical fields are facts about this database rather than the user's
 * meaning; they are settled by schema facts and observations, not by quotes.
 */
const PHYSICAL_PATHS = new Set<SpecPath>(["population.source", "population.timeField", "population.joinMultiplicity"]);
export type FieldLayer = "semantic" | "physical";

export function layerOf(path: SpecPath): FieldLayer {
  return PHYSICAL_PATHS.has(path) ? "physical" : "semantic";
}

/** Semantic fields that settle the material population (ADR-0006). */
export const POPULATION_PATHS = new Set<SpecPath>(["population.entity", "population.eligibility", "population.conditions"]);

/** A Report Task owns the population and the named measures; its chart queries inherit them (ADR-0009). */
export function isSharedPath(path: string): boolean {
  return path.startsWith("population.") || MEASURE_DEFINITION.test(path);
}

/** Paths whose open alternatives need advice before a decision when an advisor is configured. */
export function needsAdvice(path: SpecPath): boolean {
  return path !== "selection" && path !== "selection.ties" && path !== "output";
}

export const MEASURE_OPS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "median",
  "min",
  "max",
  "ratio",
  "percentage",
  "difference",
  "change_rate",
  "pp_difference",
  "cumulative",
  "rolling",
  "custom",
] as const;

export type MeasureOp = typeof MEASURE_OPS[number];

const UNARY_OPS = new Set<MeasureOp>(["count", "count_distinct", "sum", "avg", "median", "min", "max", "cumulative", "rolling"]);
const RATIO_OPS = new Set<MeasureOp>(["ratio", "percentage"]);
const CHANGE_OPS = new Set<MeasureOp>(["difference", "change_rate", "pp_difference"]);

export type MeasureOperand = string | MeasureExpression;

/**
 * One layer of a measure: the operation, the grain it is computed per, and
 * what it acts on. Nesting order is aggregation order. `ratio` is a/b and
 * `percentage` is 100·a/b; a change runs from `from` to `to`. `custom` names a
 * calculation outside the enumeration and must describe it.
 */
export interface MeasureExpression {
  readonly op: MeasureOp;
  readonly per?: string;
  readonly of?: MeasureOperand;
  readonly numerator?: MeasureOperand;
  readonly denominator?: MeasureOperand;
  readonly from?: MeasureOperand;
  readonly to?: MeasureOperand;
  readonly description?: string;
}

export interface EntityValue {
  readonly name: string;
  readonly keyColumns?: readonly string[];
}

export interface SourceValue {
  /** Tables or views the answer reads; more than one makes join multiplicity a required field. */
  readonly tables: readonly string[];
  readonly note?: string;
}

export interface TimeValue {
  readonly expression: string;
  readonly boundary?: "inclusive" | "exclusive" | "mixed" | undefined;
}

export interface SelectionValue {
  readonly n: number;
  readonly orderBy: string;
}

export type TiesValue = "strict" | "include_ties";

export const OUTPUT_ROW_MODES = ["scalar", "top_n", "grouped", "full", "detail"] as const;
export type OutputRowMode = typeof OUTPUT_ROW_MODES[number];

export interface OutputValue {
  readonly rowMode?: OutputRowMode;
  readonly rowCount?: number;
  readonly columns?: readonly string[];
  /** Unit of a delivered column, by column name. */
  readonly units?: Readonly<Record<string, string>>;
  /** Decimal places of a delivered column, by column name. */
  readonly decimals?: Readonly<Record<string, number>>;
}

/** One eligibility condition and the stage it applies at (e.g. WHERE on rows, HAVING on groups, after a window). */
export interface ConditionValue {
  readonly condition: string;
  readonly stage?: string;
}

/** One grouping key and, for a time key, its calendar grain. */
export interface GroupingKeyValue {
  readonly key: string;
  readonly grain?: string;
}

/** A Report Task measure definition: the formula and the measure sub-fields a chart query inherits with it. */
export interface MeasureDefinitionValue {
  readonly formula: MeasureExpression;
  readonly countGrain?: string;
  readonly denominator?: string;
  readonly window?: string;
}

export interface FieldValues {
  readonly "population.entity": EntityValue;
  readonly "population.eligibility": string;
  readonly "population.conditions": readonly (string | ConditionValue)[];
  readonly "population.source": SourceValue;
  readonly "population.time": TimeValue;
  readonly "population.timeField": string;
  readonly "population.missing": string;
  readonly "population.joinMultiplicity": string;
  readonly "measure.formula": MeasureExpression;
  readonly "measure.countGrain": string;
  readonly "measure.denominator": string;
  readonly "measure.window": string;
  readonly grouping: readonly (string | GroupingKeyValue)[];
  readonly selection: SelectionValue;
  readonly "selection.ties": TiesValue;
  readonly output: OutputValue;
}

export type FieldValue = FieldValues[FieldPath] | MeasureDefinitionValue;

export class FieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldValueError";
  }
}

function fail(message: string): never {
  throw new FieldValueError(message);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`${label} has unknown keys ${extra.join(", ")}; allowed: ${allowed.join(", ")}`);
}

function textList(value: unknown, label: string): readonly string[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.length === 0 || items.some((item) => !trimmedText(item))) fail(`${label} must be a non-empty list of non-empty strings`);
  return (items as string[]).map((item) => item.trim());
}

/**
 * A list whose items are text or one object naming the item and one optional
 * qualifier. Aliases the model commonly writes for the item are accepted; an
 * object without a qualifier collapses to its text.
 */
function qualifiedList<T>(value: unknown, label: string, item: readonly string[], qualifier: string, build: (name: string, extra?: string) => T): readonly (string | T)[] {
  const items = typeof value === "string" || (asRecord(value) !== undefined) ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) fail(`${label} must be a non-empty list`);
  return items.map((entry, index) => {
    if (typeof entry === "string") return trimmedText(entry) ?? fail(`${label}[${index}] must not be empty`);
    const body = asRecord(entry) ?? fail(`${label}[${index}] must be text or {${item[0]}, ${qualifier}?}`);
    onlyKeys(body, [...item, qualifier], `${label}[${index}]`);
    const name = item.map((key) => trimmedText(body[key])).find(Boolean) ?? fail(`${label}[${index}].${item[0]} is required`);
    const extra = body[qualifier] === undefined ? undefined : trimmedText(body[qualifier]) ?? fail(`${label}[${index}].${qualifier} must not be empty`);
    return extra ? build(name, extra) : name;
  });
}

function sentence(value: unknown, path: string): string {
  return trimmedText(value) ?? fail(`${path} value must be a sentence stating the decision`);
}

function parseEntity(value: unknown): EntityValue {
  if (typeof value === "string") return { name: sentence(value, "population.entity") };
  const body = asRecord(value) ?? fail("population.entity value must be a string or {name, keyColumns?}");
  onlyKeys(body, ["name", "keyColumns"], "population.entity value");
  const name = trimmedText(body.name) ?? fail("population.entity.name is required");
  return { name, ...(body.keyColumns !== undefined ? { keyColumns: textList(body.keyColumns, "population.entity.keyColumns") } : {}) };
}

function parseSource(value: unknown): SourceValue {
  const body = asRecord(value) ?? fail("population.source value must be {tables: [...], note?}");
  onlyKeys(body, ["tables", "note"], "population.source value");
  const note = trimmedText(body.note);
  return { tables: textList(body.tables, "population.source.tables"), ...(note ? { note } : {}) };
}

function parseTime(value: unknown): TimeValue {
  if (typeof value === "string") return { expression: sentence(value, "population.time") };
  const body = asRecord(value) ?? fail("population.time value must be a string or {expression, boundary?}");
  onlyKeys(body, ["expression", "boundary"], "population.time value");
  const expression = trimmedText(body.expression) ?? fail("population.time.expression is required");
  if (body.boundary !== undefined && !["inclusive", "exclusive", "mixed"].includes(String(body.boundary))) fail("population.time.boundary must be inclusive, exclusive or mixed");
  return { expression, ...(body.boundary !== undefined ? { boundary: body.boundary as TimeValue["boundary"] } : {}) };
}

function parseSelection(value: unknown): SelectionValue {
  const body = asRecord(value) ?? fail("selection value must be {n, orderBy}");
  onlyKeys(body, ["n", "orderBy"], "selection value");
  if (!Number.isSafeInteger(body.n) || Number(body.n) < 1) fail("selection.n must be a positive integer; argmax/argmin is n = 1");
  return { n: Number(body.n), orderBy: orderByText(body.orderBy) ?? fail('selection.orderBy is required: the column and direction, e.g. "revenue desc"') };
}

/** "revenue desc", or the same as {column, direction}. */
function orderByText(value: unknown): string | undefined {
  const written = trimmedText(value);
  if (written) return written;
  const body = asRecord(value);
  if (!body) return undefined;
  onlyKeys(body, ["column", "direction"], "selection.orderBy");
  const column = trimmedText(body.column) ?? fail('selection.orderBy.column is required, e.g. {"column": "revenue", "direction": "desc"}');
  if (body.direction === undefined) return column;
  // A direction that is there but unusable must not quietly become ascending.
  const direction = typeof body.direction === "string" ? body.direction.trim().toLowerCase() : "";
  if (direction !== "asc" && direction !== "desc") fail('selection.orderBy.direction must be "asc" or "desc"');
  return `${column} ${direction}`;
}

function parseTies(value: unknown): TiesValue {
  if (value === "strict" || value === "include_ties") return value;
  return fail(`selection.ties value must be "strict" (exactly n rows) or "include_ties" (keep every row tied at the cut)`);
}

function parseOutput(value: unknown): OutputValue {
  const body = asRecord(value) ?? fail("output value must be {rowMode?, rowCount?, columns?, units?, decimals?}");
  onlyKeys(body, ["rowMode", "rowCount", "columns", "units", "decimals"], "output value");
  const { rowMode, rowCount, columns, units, decimals } = body;
  if (rowMode !== undefined && !(OUTPUT_ROW_MODES as readonly unknown[]).includes(rowMode)) fail(`output.rowMode ${JSON.stringify(rowMode)}: use one of ${OUTPUT_ROW_MODES.join(", ")}`);
  if (rowCount !== undefined && (!Number.isSafeInteger(rowCount) || Number(rowCount) < 0)) fail(`output.rowCount ${JSON.stringify(rowCount)}: use a non-negative integer`);
  if (columns !== undefined && (!Array.isArray(columns) || columns.some((item) => typeof item !== "string"))) fail("output.columns must be an array of column-name strings");
  const unitMap = units === undefined ? undefined : asRecord(units) ?? fail("output.units must map column names to units");
  if (unitMap && Object.values(unitMap).some((item) => !trimmedText(item))) fail("output.units values must be non-empty strings");
  const decimalMap = decimals === undefined ? undefined : asRecord(decimals) ?? fail("output.decimals must map column names to decimal places");
  if (decimalMap && Object.values(decimalMap).some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) fail("output.decimals values must be non-negative integers");
  if ([rowMode, rowCount, columns, units, decimals].every((item) => item === undefined)) fail("output value must set at least one of rowMode, rowCount, columns, units, decimals");
  return {
    ...(rowMode !== undefined ? { rowMode: rowMode as OutputRowMode } : {}),
    ...(rowCount !== undefined ? { rowCount: Number(rowCount) } : {}),
    ...(columns !== undefined ? { columns: [...columns as string[]] } : {}),
    ...(unitMap ? { units: Object.fromEntries(Object.entries(unitMap).map(([key, item]) => [key, String(item).trim()])) } : {}),
    ...(decimalMap ? { decimals: Object.fromEntries(Object.entries(decimalMap).map(([key, item]) => [key, Number(item)])) } : {}),
  };
}

const EXPRESSION_KEYS = ["op", "per", "of", "numerator", "denominator", "from", "to", "description"] as const;

function parseOperand(value: unknown, label: string): MeasureOperand {
  if (typeof value === "string") return trimmedText(value) ?? fail(`${label} must not be empty`);
  return parseExpression(value, label);
}

function parseExpression(value: unknown, label: string): MeasureExpression {
  const body = asRecord(value) ?? fail(`${label} must be {op, per?, of | numerator+denominator | from+to}`);
  onlyKeys(body, EXPRESSION_KEYS, label);
  const op = body.op;
  if (!(MEASURE_OPS as readonly unknown[]).includes(op)) fail(`${label}.op ${JSON.stringify(op)}: use one of ${MEASURE_OPS.join(", ")}`);
  const measureOp = op as MeasureOp;
  const per = body.per === undefined ? undefined : trimmedText(body.per) ?? fail(`${label}.per must not be empty`);
  const description = body.description === undefined ? undefined : trimmedText(body.description) ?? fail(`${label}.description must not be empty`);
  const present = (key: string) => body[key] !== undefined;
  const only = (keys: readonly string[]) => {
    const misplaced = ["of", "numerator", "denominator", "from", "to"].filter((key) => present(key) && !keys.includes(key));
    if (misplaced.length > 0) fail(`${label}: op ${measureOp} does not take ${misplaced.join(", ")}`);
  };
  const base = { op: measureOp, ...(per ? { per } : {}), ...(description ? { description } : {}) };
  if (UNARY_OPS.has(measureOp)) {
    only(["of"]);
    if (!present("of")) fail(`${label}: op ${measureOp} needs "of" (a column or an inner expression)`);
    return { ...base, of: parseOperand(body.of, `${label}.of`) };
  }
  if (RATIO_OPS.has(measureOp)) {
    only(["numerator", "denominator"]);
    if (!present("numerator") || !present("denominator")) fail(`${label}: op ${measureOp} needs "numerator" and "denominator"`);
    return { ...base, numerator: parseOperand(body.numerator, `${label}.numerator`), denominator: parseOperand(body.denominator, `${label}.denominator`) };
  }
  if (CHANGE_OPS.has(measureOp)) {
    only(["from", "to"]);
    if (!present("from") || !present("to")) fail(`${label}: op ${measureOp} needs "from" and "to"`);
    return { ...base, from: parseOperand(body.from, `${label}.from`), to: parseOperand(body.to, `${label}.to`) };
  }
  if (!description) fail(`${label}: op custom needs a description of the calculation`);
  return { ...base, ...(present("of") ? { of: parseOperand(body.of, `${label}.of`) } : {}) };
}

function nested(expression: MeasureExpression): readonly MeasureExpression[] {
  return [expression.of, expression.numerator, expression.denominator, expression.from, expression.to]
    .filter((item): item is MeasureExpression => typeof item === "object" && item !== null);
}

/** Every layer of an expression, outermost first. */
export function layersOf(expression: MeasureExpression): readonly MeasureExpression[] {
  return [expression, ...nested(expression).flatMap(layersOf)];
}

/**
 * A formula of more than one layer states the grain of every inner layer:
 * flattening layers is another measure. The outermost layer is computed per
 * the output grouping, so its "per" may be left out.
 */
function parseFormula(value: unknown, label: string): MeasureExpression {
  // {ref} is a form of the field, like {value} or {open}: as a formula it would read as one with an unknown key.
  if (asRecord(value)?.ref !== undefined) {
    fail(`${label}: a formula cannot be a ref. Only a chart query (parentTaskId) references a Report Task measure, and it writes the ref as the field itself, "measure.formula": {"ref": "<measure name>"}, never inside "value" or "open"; a measure definition states its own formula`);
  }
  const expression = parseExpression(value, label);
  const inner = layersOf(expression).slice(1);
  if (inner.some((layer) => !layer.per)) {
    fail(`${label} has ${inner.length + 1} layers; give every inner layer "per" (the grain it is computed on), e.g. avg per country of avg per player of sum per match`);
  }
  return expression;
}

function parseMeasureDefinition(value: unknown, path: string): MeasureDefinitionValue {
  const body = asRecord(value) ?? fail(`${path} value must be {formula, countGrain?, denominator?, window?}`);
  onlyKeys(body, ["formula", "countGrain", "denominator", "window"], `${path} value`);
  const optional = (key: "countGrain" | "denominator" | "window") => body[key] === undefined ? {} : { [key]: trimmedText(body[key]) ?? fail(`${path}.${key} must be a sentence`) };
  return { formula: parseFormula(body.formula, `${path}.formula`), ...optional("countGrain"), ...optional("denominator"), ...optional("window") };
}

/** Parses an untrusted field value into its canonical form, naming the part to fix. */
export function parseFieldValue(path: SpecPath, value: unknown): FieldValue {
  if (MEASURE_DEFINITION.test(path)) return parseMeasureDefinition(value, path);
  switch (path as FieldPath) {
    case "population.entity": return parseEntity(value);
    case "population.conditions": return qualifiedList(value, "population.conditions value", ["condition", "expression"], "stage", (condition, stage): ConditionValue => ({ condition, ...(stage ? { stage } : {}) }));
    case "population.source": return parseSource(value);
    case "population.time": return parseTime(value);
    case "measure.formula": return parseFormula(value, "measure.formula");
    case "grouping": return qualifiedList(value, "grouping value", ["key", "field", "expression"], "grain", (key, grain): GroupingKeyValue => ({ key, ...(grain ? { grain } : {}) }));
    case "selection": return parseSelection(value);
    case "selection.ties": return parseTies(value);
    case "output": return parseOutput(value);
    default: return sentence(value, path);
  }
}

/** Stable text for comparing and displaying values. */
export function valueKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Paths that must have a state whatever the other fields say (ADR-0007 necessity). */
export const ALWAYS_REQUIRED: readonly FieldPath[] = [
  "population.entity",
  "population.eligibility",
  "population.conditions",
  "population.time",
  "measure.formula",
  "grouping",
  "selection",
  "output",
];

const COUNT_GRAIN_OPS = new Set<MeasureOp>(["count", "count_distinct", "avg", "median", "ratio", "percentage", "change_rate"]);
const DENOMINATOR_OPS = new Set<MeasureOp>(["avg", "ratio", "percentage", "change_rate"]);
const WINDOW_OPS = new Set<MeasureOp>(["cumulative", "rolling"]);

/**
 * What the rules read from the fields that already have a state. A field
 * with several open alternatives contributes every alternative, so a rule
 * fires when any reading could need it.
 */
export interface NecessityInputs {
  readonly formulas: readonly MeasureExpression[];
  readonly sources: readonly SourceValue[];
  /** selection has a state other than not applicable. */
  readonly selection: boolean;
}

/** Fields required by the other fields' values (ADR-0007 necessity, revised against the wrong-answer check). */
export function requiredPaths(inputs: NecessityInputs): readonly FieldPath[] {
  const ops = new Set(inputs.formulas.flatMap(layersOf).map((layer) => layer.op));
  const any = (set: ReadonlySet<MeasureOp>) => [...ops].some((op) => set.has(op));
  return [
    ...ALWAYS_REQUIRED,
    ...(any(COUNT_GRAIN_OPS) ? ["measure.countGrain" as const] : []),
    ...(any(DENOMINATOR_OPS) ? ["measure.denominator" as const] : []),
    ...(any(WINDOW_OPS) ? ["measure.window" as const] : []),
    ...(inputs.selection ? ["selection.ties" as const] : []),
    ...(inputs.sources.some((source) => source.tables.length > 1) ? ["population.joinMultiplicity" as const] : []),
  ];
}

/** Report Tasks answer only for the shared population (ADR-0009). */
export const REPORT_REQUIRED: readonly FieldPath[] = ["population.entity", "population.eligibility", "population.conditions", "population.time"];
