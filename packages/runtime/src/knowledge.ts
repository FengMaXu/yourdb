import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { boundTextByLines, truncateUtf8 } from "./bounded-read.js";
import { unquoted } from "./primitives.js";

export const DEFAULT_KNOWLEDGE_RESULTS = 5;
export const MAX_KNOWLEDGE_RESULTS = 8;
const MAX_KNOWLEDGE_RESPONSE_BYTES = 16 * 1024;
const MAX_KNOWLEDGE_READ_CONTENT_BYTES = 12 * 1024;
export const MAX_KNOWLEDGE_DOCUMENT_LINES = 500;
const MAX_HEADINGLESS_SECTION_LINES = 100;

/**
 * `method` documents guide how the main Agent reasons and writes SQL; every
 * other document is treated as facts (definitions, schema, data notes). The
 * value only routes access in prompts, never evidence authority.
 */
export type KnowledgeUsage = "method" | "fact";

interface KnowledgeMetadata {
  readonly knowledgeId: string;
  readonly name: string;
  readonly description: string;
  readonly usage?: KnowledgeUsage;
}

export interface KnowledgeDiagnostic {
  readonly code: "missing_metadata" | "builtin_overridden";
  readonly path: string;
  readonly message: string;
}

export interface KnowledgeCatalogEntry extends KnowledgeMetadata {
  readonly path: string;
  readonly lineCount: number;
  readonly revision: number;
  /** Built-in documents ship with the application and are never written by users or the Agent. */
  readonly readOnly: boolean;
  /** False for a frontmatter-only placeholder that has not been filled in yet. */
  readonly hasContent: boolean;
}

export interface KnowledgeLocation {
  readonly root: string;
  readonly readOnly: boolean;
}

interface KnowledgeRootOptions {
  readonly readOnly?: boolean;
}

export interface KnowledgeSection {
  readonly sectionId: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface KnowledgeHit extends KnowledgeMetadata {
  path: string;
  title: string;
  category: string;
  chunkId: string;
  sectionId: string;
  sectionTitle: string;
  startLine: number;
  endLine: number;
  score: number;
  revision: number;
  /** The readable Markdown content of the matching chunk. */
  snippet: string;
}

export interface KnowledgeDocument extends KnowledgeCatalogEntry {
  readonly content: string;
  readonly sections: readonly KnowledgeSection[];
}

export interface KnowledgeReadRequest {
  readonly knowledgeId: string;
  readonly sectionId?: string;
  readonly continuationToken?: string;
}

export type KnowledgeReadResult =
  | {
      readonly mode: "full_document";
      readonly knowledgeId: string;
      readonly name: string;
      readonly content: string;
      readonly lineCount: number;
      readonly truncated: boolean;
      readonly contentRef: string;
      readonly oversizedLine?: KnowledgeOversizedLine;
      readonly message?: string;
    }
  | {
      readonly mode: "section_required";
      readonly knowledgeId: string;
      readonly name: string;
      readonly lineCount: number;
      readonly sections: readonly Pick<KnowledgeSection, "sectionId" | "title" | "startLine" | "endLine">[];
      readonly omittedSectionCount: number;
      readonly message: string;
    }
  | {
      readonly mode: "section";
      readonly knowledgeId: string;
      readonly sectionId: string;
      readonly sectionTitle: string;
      readonly content: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly truncated: boolean;
      readonly contentRef: string;
      readonly continuationToken?: string;
      readonly oversizedLine?: KnowledgeOversizedLine;
    };

interface KnowledgeOversizedLine {
  readonly lineNumber: number;
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly message: string;
}

interface Chunk extends KnowledgeSection {
  readonly tokens: Map<string, number>;
  readonly length: number;
}

interface StoredDocument extends KnowledgeDocument {
  readonly chunks: readonly Chunk[];
  readonly contentStartLine: number;
  readonly root: string;
}

interface ParsedFrontmatter {
  readonly metadata?: KnowledgeMetadata;
  readonly contentLines: readonly string[];
  readonly contentStartLine: number;
}

class MissingKnowledgeMetadataError extends Error {
  constructor(readonly relativePath: string, readonly field?: "knowledgeId" | "name" | "description") {
    super(field ? `KNOWLEDGE_METADATA_REQUIRED:${relativePath}:${field}` : `KNOWLEDGE_METADATA_REQUIRED:${relativePath}`);
    this.name = "MissingKnowledgeMetadataError";
  }
}

function physicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(text)) lines.pop();
  return lines;
}

function tokenize(text: string): string[] {
  const ascii = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) {
    const first = cjk[i];
    const second = cjk[i + 1];
    if (first && second) bigrams.push(first + second);
  }
  if (cjk.length === 1 && cjk[0]) bigrams.push(cjk[0]);
  return [...ascii, ...bigrams];
}

function parseFrontmatter(text: string, relativePath: string, requireMetadata: boolean): ParsedFrontmatter {
  const lines = physicalLines(text);
  const first = lines[0]?.replace(/^\uFEFF/, "").trim();
  if (first !== "---") {
    if (requireMetadata) throw new MissingKnowledgeMetadataError(relativePath);
    return { contentLines: lines, contentStartLine: 1 };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new Error(`KNOWLEDGE_METADATA_INVALID:${relativePath}`);
  const values = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`KNOWLEDGE_METADATA_INVALID:${relativePath}`);
    values.set(match[1]!, unquoted(match[2]!));
  }
  for (const field of ["knowledgeId", "name", "description"] as const) {
    if (!values.has(field)) throw new MissingKnowledgeMetadataError(relativePath, field);
  }
  const knowledgeId = values.get("knowledgeId")!;
  const name = values.get("name")!;
  const description = values.get("description")!;
  if (!knowledgeId || !/^[a-z][a-z0-9-]{1,63}$/.test(knowledgeId)) throw new Error(`KNOWLEDGE_METADATA_INVALID_ID:${relativePath}`);
  if (!name) throw new Error(`KNOWLEDGE_METADATA_NAME_REQUIRED:${relativePath}`);
  if (!description) throw new Error(`KNOWLEDGE_METADATA_DESCRIPTION_REQUIRED:${relativePath}`);
  const usage = values.get("usage");
  if (usage !== undefined && usage !== "method" && usage !== "fact") throw new Error(`KNOWLEDGE_METADATA_INVALID_USAGE:${relativePath}`);
  const contentLines = lines.slice(closing + 1);
  // A blank line after the closing marker is formatting, not document content.
  const body = contentLines[0] === "" ? contentLines.slice(1) : contentLines;
  return {
    metadata: { knowledgeId, name, description, ...(usage ? { usage } : {}) },
    contentLines: body,
    contentStartLine: closing + (contentLines[0] === "" ? 3 : 2),
  };
}

function fallbackMetadata(relativePath: string, contentLines: readonly string[]): KnowledgeMetadata {
  const heading = contentLines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const id = relativePath
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "knowledge";
  return {
    // `path-` marks an id derived from the file path and keeps it apart from ids authors declare.
    knowledgeId: `path-${id}`.slice(0, 64),
    name: heading || path.basename(relativePath, ".md"),
    description: `Knowledge document ${relativePath}`,
  };
}

function sectionSlug(value: string): string {
  const encoded = encodeURIComponent(value.trim().toLowerCase()).replaceAll("%", "_");
  return encoded ? encoded.slice(0, 160) : "section";
}

function uniqueSectionId(knowledgeId: string, value: string, occurrences: Map<string, number>): string {
  const base = sectionSlug(value);
  const occurrence = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, occurrence);
  return `${knowledgeId}#${base}${occurrence > 1 ? `-${occurrence}` : ""}`;
}

function splitHeadinglessChunks(
  lines: readonly string[],
  contentStartLine: number,
  metadata: KnowledgeMetadata,
): Array<Omit<Chunk, "tokens" | "length">> {
  const chunks: Array<Omit<Chunk, "tokens" | "length">> = [];
  const occurrences = new Map<string, number>();
  let paragraphStart = 0;

  const pushParagraph = (endOffset: number) => {
    const paragraph = lines.slice(paragraphStart, endOffset);
    for (let offset = 0; offset < paragraph.length; offset += MAX_HEADINGLESS_SECTION_LINES) {
      const block = paragraph.slice(offset, offset + MAX_HEADINGLESS_SECTION_LINES);
      const text = block.join("\n");
      if (!text.trim()) continue;
      const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
      const part = chunks.length + 1;
      const blockStart = paragraphStart + offset;
      chunks.push({
        sectionId: uniqueSectionId(metadata.knowledgeId, `paragraph-${digest}`, occurrences),
        title: `${metadata.name} (${part})`,
        headingPath: [],
        startLine: contentStartLine + blockStart,
        endLine: contentStartLine + blockStart + block.length - 1,
        text,
      });
    }
  };

  for (let index = 0; index <= lines.length; index += 1) {
    if (index === lines.length || lines[index]?.trim() === "") {
      pushParagraph(index);
      paragraphStart = index + 1;
    }
  }
  return chunks;
}

function splitChunks(
  lines: readonly string[],
  contentStartLine: number,
  metadata: KnowledgeMetadata,
): Array<Omit<Chunk, "tokens" | "length">> {
  if (!lines.some((line) => /^(#{1,6})\s+(.+?)\s*$/.test(line))) {
    return splitHeadinglessChunks(lines, contentStartLine, metadata);
  }

  const chunks: Array<Omit<Chunk, "tokens" | "length">> = [];
  const occurrences = new Map<string, number>();
  let current: string[] = [];
  let start = contentStartLine;
  let title = metadata.name;
  let headingPath: string[] = [];

  const push = (endLine: number) => {
    const text = current.join("\n");
    if (text.trim().length === 0) return;
    const identity = headingPath.length > 0 ? headingPath.join("/") : "preamble";
    chunks.push({
      sectionId: uniqueSectionId(metadata.knowledgeId, identity, occurrences),
      title,
      headingPath: [...headingPath],
      startLine: start,
      endLine,
      text,
    });
  };

  lines.forEach((line, index) => {
    const absoluteLine = contentStartLine + index;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading && current.length > 0) {
      push(absoluteLine - 1);
      current = [];
      start = absoluteLine;
    }
    if (heading) {
      const level = heading[1]!.length;
      const headingTitle = heading[2]!.trim();
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = headingTitle;
      headingPath = headingPath.filter(Boolean);
      title = headingTitle;
    }
    current.push(line);
  });
  if (current.length > 0) push(contentStartLine + lines.length - 1);
  return chunks;
}

interface BoundedKnowledgeContent {
  readonly content: string;
  readonly consumedLines: number;
  readonly nextOffset?: number;
  readonly truncated: boolean;
  readonly oversizedLine?: { readonly offset: number; readonly byteLength: number };
}

function boundedContent(lines: readonly string[], offset: number, maxBytes = MAX_KNOWLEDGE_READ_CONTENT_BYTES): BoundedKnowledgeContent {
  if (lines.length === 0 && offset === 0) return { content: "", consumedLines: 0, truncated: false };
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= lines.length) throw new Error("KNOWLEDGE_CONTINUATION_INVALID");
  const remaining = lines.slice(offset);
  const raw = remaining.join("\n");
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return { content: raw, consumedLines: remaining.length, truncated: false };
  }
  const selected: string[] = [];
  let bytes = 0;
  for (const [index, line] of remaining.entries()) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const candidateBytes = lineBytes + (selected.length ? 1 : 0);
    if (bytes + candidateBytes > maxBytes) {
      if (selected.length === 0) {
        return { content: "", consumedLines: 0, truncated: true, oversizedLine: { offset, byteLength: lineBytes } };
      }
      const nextOffset = offset + index;
      return { content: selected.join("\n"), consumedLines: selected.length, truncated: true, nextOffset };
    }
    selected.push(line);
    bytes += candidateBytes;
  }
  return { content: selected.join("\n"), consumedLines: selected.length, truncated: false };
}

interface KnowledgeContinuation {
  readonly knowledgeId: string;
  readonly revision: number;
  readonly sectionId: string;
  readonly offset: number;
}

function encodeContinuation(value: KnowledgeContinuation): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeContinuation(value: string): KnowledgeContinuation {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const knowledgeId = parsed.knowledgeId;
    const revision = parsed.revision;
    const sectionId = parsed.sectionId;
    const offset = parsed.offset;
    if (typeof knowledgeId !== "string" || typeof sectionId !== "string" || !sectionId || typeof revision !== "number" || typeof offset !== "number" || !Number.isSafeInteger(revision) || !Number.isSafeInteger(offset) || offset < 1) throw new Error();
    return { knowledgeId, revision, sectionId, offset };
  } catch {
    throw new Error("KNOWLEDGE_CONTINUATION_INVALID");
  }
}

interface FormattedKnowledgeHit {
  readonly knowledgeId: string;
  readonly name: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly contentRef: string;
}

interface FormattedKnowledgeSearchResults {
  readonly hits: readonly FormattedKnowledgeHit[];
  readonly omittedHitCount: number;
}

function formattedKnowledgeHit(hit: KnowledgeHit, maxContentBytes: number): FormattedKnowledgeHit {
  const bounded = truncateUtf8(hit.snippet, maxContentBytes);
  return {
    knowledgeId: hit.knowledgeId,
    name: hit.name,
    sectionId: hit.sectionId,
    sectionTitle: hit.sectionTitle,
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
    score: hit.score,
    content: bounded.content,
    truncated: bounded.truncated,
    contentRef: knowledgeContentRef(hit.knowledgeId, hit.revision, hit.sectionId, bounded.content),
  };
}

function fitKnowledgeHit(hit: KnowledgeHit, accepted: readonly FormattedKnowledgeHit[], totalHitCount: number): FormattedKnowledgeHit | undefined {
  let low = 0;
  let high = Buffer.byteLength(hit.snippet, "utf8");
  let best: FormattedKnowledgeHit | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = formattedKnowledgeHit(hit, middle);
    const payload = { hits: [...accepted, candidate], omittedHitCount: Math.max(0, totalHitCount - accepted.length - 1) };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_KNOWLEDGE_RESPONSE_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function formatKnowledgeSearchResults(hits: readonly KnowledgeHit[], maxResults = DEFAULT_KNOWLEDGE_RESULTS): FormattedKnowledgeSearchResults {
  const selected = hits.slice(0, Math.max(0, Math.min(maxResults, MAX_KNOWLEDGE_RESULTS)));
  const values: FormattedKnowledgeHit[] = [];
  for (const hit of selected) {
    const fitted = fitKnowledgeHit(hit, values, hits.length);
    if (!fitted) break;
    values.push(fitted);
  }
  return { hits: values, omittedHitCount: Math.max(0, hits.length - values.length) };
}

function knowledgeContentRef(knowledgeId: string, revision: number, sectionId: string, content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
  return `knowledge:${knowledgeId}@${revision}#${sectionId}:${digest}`;
}

export function renderKnowledgeCatalog(entries: readonly KnowledgeCatalogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["<knowledge_catalog>"];
  for (const entry of entries) {
    lines.push(`- id: ${entry.knowledgeId}`, `  name: ${entry.name}`, `  description: ${entry.description}`);
  }
  lines.push("</knowledge_catalog>");
  return lines.join("\n");
}

export class KnowledgeIndex {
  private readonly docs = new Map<string, StoredDocument>();
  private readonly docsById = new Map<string, string>();
  private readonly diagnosticsByPath = new Map<string, KnowledgeDiagnostic>();
  /** Loaded roots in load order, keyed by their real path. */
  private readonly roots = new Map<string, { readonly readOnly: boolean }>();
  /** Every Markdown path found under each read-only root, including ones a user copy overrides. */
  private readonly builtinPathsByRoot = new Map<string, ReadonlySet<string>>();
  private readonly requireMetadata: boolean;

  constructor(options: { readonly requireMetadata?: boolean } = {}) {
    this.requireMetadata = options.requireMetadata === true;
  }

  private averageLength = () => {
    const all = [...this.docs.values()].flatMap((document) => document.chunks);
    return all.length === 0 ? 0 : all.reduce((sum, chunk) => sum + chunk.length, 0) / all.length;
  };

  diagnostics(): readonly KnowledgeDiagnostic[] {
    return [...this.diagnosticsByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private removeDocument(relativePath: string): void {
    const previous = this.docs.get(relativePath);
    if (previous) this.docsById.delete(previous.knowledgeId);
    this.docs.delete(relativePath);
  }

  /**
   * Load every Markdown document under `root`. Loading the same root again
   * rescans it: changed files are re-indexed and deleted files leave the index.
   * A read-only root holds built-in documents; a document at the same path or
   * with the same knowledgeId in a writable root overrides it.
   */
  async loadDirectory(root: string, options: KnowledgeRootOptions = {}): Promise<number> {
    if (!existsSync(root)) return 0;
    const resolvedRoot = await realpath(root);
    const readOnly = options.readOnly === true;
    this.roots.set(resolvedRoot, { readOnly });
    const seen = new Set<string>();
    const loaded = await this.loadTree(resolvedRoot, resolvedRoot, seen);
    for (const [relative, document] of [...this.docs]) {
      if (document.root === resolvedRoot && !seen.has(relative)) this.removeDocument(relative);
    }
    for (const relative of [...this.diagnosticsByPath.keys()]) {
      if (!this.docs.has(relative) && !seen.has(relative) && !this.isBuiltinPath(relative)) this.diagnosticsByPath.delete(relative);
    }
    if (readOnly) this.builtinPathsByRoot.set(resolvedRoot, seen);
    return loaded;
  }

  /** Rescan every loaded root, registering `writableRoot` first when it is new. Writable roots go first so a deleted override restores its built-in document. */
  async reload(writableRoot?: string): Promise<void> {
    if (writableRoot && existsSync(writableRoot) && !this.roots.has(await realpath(writableRoot))) await this.loadDirectory(writableRoot);
    const ordered = [...this.roots].sort(([, a], [, b]) => Number(a.readOnly) - Number(b.readOnly));
    for (const [root, state] of ordered) await this.loadDirectory(root, state);
  }

  private async loadTree(directory: string, root: string, seen: Set<string>): Promise<number> {
    let loaded = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) loaded += await this.loadTree(full, root, seen);
      else if (entry.name.endsWith(".md")) {
        seen.add(path.relative(root, full).split(path.sep).join("/"));
        if (await this.loadFile(root, full)) loaded += 1;
      }
    }
    return loaded;
  }

  /** True when a read-only root ships this path, whether or not a user copy overrides it. */
  isBuiltinPath(relativePath: string): boolean {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    return [...this.builtinPathsByRoot.values()].some((paths) => paths.has(normalized));
  }

  /** Where an indexed document lives on disk. */
  locate(relativePath: string): KnowledgeLocation | undefined {
    const document = this.docs.get(relativePath.replaceAll("\\", "/"));
    return document ? { root: document.root, readOnly: document.readOnly } : undefined;
  }

  /** Record that the user document at `relative` replaces a built-in one, removing the built-in document when it is still indexed. */
  private overrideBuiltin(relative: string, builtin?: StoredDocument): void {
    if (builtin) this.removeDocument(builtin.path);
    this.diagnosticsByPath.set(relative, {
      code: "builtin_overridden",
      path: relative,
      message: `KNOWLEDGE_BUILTIN_OVERRIDDEN:${relative} replaces a built-in document and no longer receives application updates`,
    });
  }

  async loadFile(root: string, filePath: string): Promise<boolean> {
    const resolvedRoot = await realpath(root);
    const resolvedFile = await realpath(filePath);
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("KNOWLEDGE_SYMLINK_ESCAPE");
    const relative = path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../")) throw new Error("KNOWLEDGE_PATH_ESCAPE");
    const readOnly = this.roots.get(resolvedRoot)?.readOnly === true;
    const samePath = this.docs.get(relative);
    if (samePath && samePath.root !== resolvedRoot) {
      // An earlier built-in root or a user override already owns this path.
      if (readOnly) {
        if (!samePath.readOnly) this.overrideBuiltin(relative);
        return false;
      }
      if (!samePath.readOnly) throw new Error(`KNOWLEDGE_PATH_DUPLICATE:${relative}`);
    }
    const text = await readFile(resolvedFile, "utf8");
    let parsed: ParsedFrontmatter;
    try {
      parsed = parseFrontmatter(text, relative, this.requireMetadata);
    } catch (error) {
      if (!(error instanceof MissingKnowledgeMetadataError)) throw error;
      if (this.docs.get(relative)?.root === resolvedRoot) this.removeDocument(relative);
      this.diagnosticsByPath.set(relative, { code: "missing_metadata", path: relative, message: error.message });
      return false;
    }
    this.diagnosticsByPath.delete(relative);
    const metadata = parsed.metadata ?? fallbackMetadata(relative, parsed.contentLines);
    const existingPath = this.docsById.get(metadata.knowledgeId);
    const sameId = existingPath && existingPath !== relative ? this.docs.get(existingPath) : undefined;
    if (sameId) {
      if (readOnly && !sameId.readOnly) {
        this.overrideBuiltin(sameId.path);
        return false;
      }
      if (readOnly === sameId.readOnly) throw new Error(`KNOWLEDGE_ID_DUPLICATE:${metadata.knowledgeId}`);
      this.overrideBuiltin(relative, sameId);
    }
    if (samePath && samePath.root !== resolvedRoot) this.overrideBuiltin(relative, samePath);
    this.removeDocument(relative);
    const revision = this.hash(text);
    const rawChunks = splitChunks(parsed.contentLines, parsed.contentStartLine, metadata);
    const chunks = rawChunks.map((chunk) => {
      const tokens = tokenize(chunk.text);
      const tokenMap = new Map<string, number>();
      for (const token of tokens) tokenMap.set(token, (tokenMap.get(token) ?? 0) + 1);
      return { ...chunk, tokens: tokenMap, length: tokens.length };
    });
    const document: StoredDocument = {
      ...metadata,
      path: relative,
      lineCount: physicalLines(text).length,
      revision,
      content: parsed.contentLines.join("\n"),
      sections: chunks,
      chunks,
      contentStartLine: parsed.contentStartLine,
      root: resolvedRoot,
      readOnly,
      hasContent: parsed.contentLines.some((line) => line.trim().length > 0),
    };
    this.docs.set(relative, document);
    this.docsById.set(metadata.knowledgeId, relative);
    return true;
  }

  catalog(pathFilter?: (relativePath: string, knowledgeId: string) => boolean): KnowledgeCatalogEntry[] {
    return [...this.docs.values()]
      .filter((document) => pathFilter?.(document.path, document.knowledgeId) ?? true)
      .map(({ chunks: _chunks, content: _content, contentStartLine: _contentStartLine, root: _root, ...entry }) => entry)
      .sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId));
  }

  getDocument(knowledgeId: string): KnowledgeDocument {
    const pathName = this.docsById.get(knowledgeId);
    const document = pathName ? this.docs.get(pathName) : undefined;
    if (!document) throw new Error(`KNOWLEDGE_NOT_FOUND:${knowledgeId}`);
    const { chunks: _chunks, contentStartLine: _contentStartLine, root: _root, ...publicDocument } = document;
    return publicDocument;
  }

  private getStoredDocument(knowledgeId: string): StoredDocument {
    const pathName = this.docsById.get(knowledgeId);
    const document = pathName ? this.docs.get(pathName) : undefined;
    if (!document) throw new Error(`KNOWLEDGE_NOT_FOUND:${knowledgeId}`);
    return document;
  }

  private getSection(knowledgeId: string, sectionId: string): KnowledgeSection {
    const section = this.getStoredDocument(knowledgeId).chunks.find((chunk) => chunk.sectionId === sectionId);
    if (!section) throw new Error(`KNOWLEDGE_SECTION_NOT_FOUND:${knowledgeId}:${sectionId}`);
    return section;
  }

  async isCurrent(knowledgeId: string): Promise<boolean> {
    const document = this.getStoredDocument(knowledgeId);
    try {
      const current = await readFile(path.resolve(document.root, document.path), "utf8");
      return this.hash(current) === document.revision;
    } catch {
      return false;
    }
  }

  read(request: KnowledgeReadRequest): KnowledgeReadResult {
    const document = this.getStoredDocument(request.knowledgeId);
    const continuation = request.continuationToken ? decodeContinuation(request.continuationToken) : undefined;
    if (continuation && (continuation.knowledgeId !== document.knowledgeId || continuation.revision !== document.revision)) throw new Error("KNOWLEDGE_CONTINUATION_STALE");
    if (continuation && request.sectionId && continuation.sectionId !== request.sectionId) throw new Error("KNOWLEDGE_CONTINUATION_SECTION_MISMATCH");
    const sectionId = request.sectionId ?? continuation?.sectionId;
    if (!sectionId && document.lineCount >= MAX_KNOWLEDGE_DOCUMENT_LINES) {
      const allSections = document.sections.map(({ sectionId: id, title, startLine, endLine }) => ({ sectionId: id, title, startLine, endLine }));
      const sections: typeof allSections = [];
      for (const section of allSections) {
        const candidate = [...sections, section];
        const payload = {
          mode: "section_required",
          knowledgeId: document.knowledgeId,
          name: document.name,
          lineCount: document.lineCount,
          sections: candidate,
          omittedSectionCount: allSections.length - candidate.length,
          message: `Knowledge document ${document.knowledgeId} has ${document.lineCount} lines; use search_knowledge or a sectionId instead of requesting the full document.`,
        };
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_KNOWLEDGE_RESPONSE_BYTES) break;
        sections.push(section);
      }
      return {
        mode: "section_required",
        knowledgeId: document.knowledgeId,
        name: document.name,
        lineCount: document.lineCount,
        sections,
        omittedSectionCount: allSections.length - sections.length,
        message: `Knowledge document ${document.knowledgeId} has ${document.lineCount} lines; use search_knowledge or a sectionId instead of requesting the full document.`,
      };
    }
    if (sectionId) {
      const section = this.getSection(document.knowledgeId, sectionId);
      const offset = continuation?.offset ?? 0;
      const lines = physicalLines(section.text);
      const bounded = boundedContent(lines, offset);
      const startLine = section.startLine + offset;
      const endLine = bounded.consumedLines > 0 ? startLine + bounded.consumedLines - 1 : startLine;
      return {
        mode: "section",
        knowledgeId: document.knowledgeId,
        sectionId: section.sectionId,
        sectionTitle: section.title,
        content: bounded.content,
        startLine,
        endLine,
        truncated: bounded.truncated,
        contentRef: knowledgeContentRef(document.knowledgeId, document.revision, section.sectionId, bounded.content),
        ...(bounded.nextOffset !== undefined ? { continuationToken: encodeContinuation({ knowledgeId: document.knowledgeId, revision: document.revision, sectionId: section.sectionId, offset: bounded.nextOffset }) } : {}),
        ...(bounded.oversizedLine ? {
          oversizedLine: {
            lineNumber: section.startLine + bounded.oversizedLine.offset,
            byteLength: bounded.oversizedLine.byteLength,
            maxBytes: MAX_KNOWLEDGE_READ_CONTENT_BYTES,
            message: "The next complete line exceeds the Host response budget; no partial line was returned.",
          },
        } : {}),
      };
    }
    const lines = physicalLines(document.content);
    const bounded = boundedContent(lines, 0);
    return {
      mode: "full_document",
      knowledgeId: document.knowledgeId,
      name: document.name,
      content: bounded.content,
      lineCount: document.lineCount,
      truncated: bounded.truncated,
      contentRef: knowledgeContentRef(document.knowledgeId, document.revision, "document", bounded.content),
      ...(bounded.truncated ? { message: "The document exceeded the Host response budget; use search_knowledge or read a specific section for more context." } : {}),
      ...(bounded.oversizedLine ? {
        oversizedLine: {
          lineNumber: document.contentStartLine + bounded.oversizedLine.offset,
          byteLength: bounded.oversizedLine.byteLength,
          maxBytes: MAX_KNOWLEDGE_READ_CONTENT_BYTES,
          message: "The next complete line exceeds the Host response budget; no partial line was returned.",
        },
      } : {}),
    };
  }

  private hash(text: string): number {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  search(query: string, limit = MAX_KNOWLEDGE_RESULTS, pathFilter?: (relativePath: string, knowledgeId: string) => boolean): KnowledgeHit[] {
    const queryTokens = tokenize(query);
    const all = [...this.docs.entries()]
      .filter(([relative, document]) => pathFilter?.(relative, document.knowledgeId) ?? true)
      .flatMap(([relative, document]) => document.chunks.map((chunk) => ({ relative, document, chunk })));
    if (all.length === 0) return [];
    const N = all.length;
    const average = this.averageLength() || 1;
    const k1 = 1.5;
    const b = 0.75;
    const df = new Map<string, number>();
    for (const token of new Set(queryTokens)) {
      let count = 0;
      for (const { chunk } of all) if (chunk.tokens.has(token)) count += 1;
      df.set(token, count);
    }
    const scored: KnowledgeHit[] = [];
    for (const { relative, document, chunk } of all) {
      let score = 0;
      for (const token of queryTokens) {
        const frequency = chunk.tokens.get(token) ?? 0;
        if (frequency === 0) continue;
        const idf = Math.log(1 + (N - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
        score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (chunk.length / average)));
      }
      if (score > 0) {
        const category = relative.includes("/") ? (relative.split("/")[0] ?? "doc") : "doc";
        scored.push({
          knowledgeId: document.knowledgeId,
          name: document.name,
          description: document.description,
          path: relative,
          title: chunk.title,
          category,
          chunkId: chunk.sectionId,
          sectionId: chunk.sectionId,
          sectionTitle: chunk.title,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score,
          revision: document.revision,
          snippet: boundTextByLines(chunk.text).content,
        });
      }
    }
    return scored.sort((a, z) => z.score - a.score).slice(0, Math.max(0, limit));
  }
}
