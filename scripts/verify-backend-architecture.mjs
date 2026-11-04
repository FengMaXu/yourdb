#!/usr/bin/env node
/**
 * §16 architecture gate. This is deliberately a small static dependency
 * verifier, not a claim that imports alone prove runtime correctness.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoots = [
  "packages/runtime/src",
  "packages/contracts/src",
  "packages/charts/src",
  "packages/channel-feishu/src",
  "packages/channel-weixin/src",
  "packages/electron-host/src",
  "packages/database/src",
  "packages/mcp-plugins/src",
  "packages/mcp-mysql/src",
  "packages/mcp-pg/src",
  "packages/mcp-sqlite/src",
  "apps/server/src",
  "frontend/src",
].map((relative) => path.join(root, relative));
const failures = [];
const productionFiles = [];

function walk(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(?:ts|tsx)$/.test(file) && !/(?:\.test\.tsx?|\.d\.ts)$/.test(file)) productionFiles.push(file);
  }
}
for (const sourceRoot of sourceRoots) walk(sourceRoot);
for (const launcher of ["scripts/start-web-host.mjs"]) {
  const file = path.join(root, launcher);
  if (existsSync(file)) productionFiles.push(file);
}

function moduleSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".mjs") || file.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const modules = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) modules.push(statement.moduleSpecifier.text);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) modules.push(statement.moduleSpecifier.text);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) modules.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { text, modules };
}

function fail(message) { failures.push(message); }
function relative(file) { return path.relative(root, file).replaceAll(path.sep, "/"); }
function hasAny(value, patterns) { return patterns.some((pattern) => value.includes(pattern)); }

for (const file of productionFiles) {
  const rel = relative(file);
  const { text, modules } = moduleSpecifiers(file);
  const isAnswering = rel.startsWith("packages/runtime/src/answering/");
  const isCapabilities = /packages\/runtime\/src\/(?:workspace|knowledge|python|dashboard|skills|bounded-read|clarification|widget|auth|metadata)\.ts$/.test(rel);
  const isAgent = rel.startsWith("packages/runtime/src/agent/");
  const isTools = rel.startsWith("packages/runtime/src/tools/");
  const isDelegation = rel.startsWith("packages/runtime/src/delegation/");
  const isFacets = rel.startsWith("packages/runtime/src/facets/");
  const isContracts = rel.startsWith("packages/contracts/src/");
  // The chart compiler runs in browsers and Node alike (ADR-0008 decision 5).
  const isCharts = rel.startsWith("packages/charts/src/");
  // The dashboard renderer is a pure function of spec and datasets; the tool resolves data (ADR-0008 step 4).
  const isDashboardRenderer = rel === "packages/runtime/src/dashboard.ts";
  const isPresentation = rel.startsWith("frontend/src/");
  // The channel boundary reaches the Runtime only through the versioned protocol (ADR-0011 decisions 1 and 6).
  const isChannels = rel.startsWith("packages/runtime/src/channels/");
  // A platform adapter knows its platform and the channel contracts, nothing of the Runtime.
  const isPlatformChannel = rel.startsWith("packages/channel-");
  const isElectronOrServer = rel.startsWith("packages/electron-host/src/") || rel.startsWith("apps/server/src/") || rel === "scripts/start-web-host.mjs";

  for (const specifier of modules) {
    const normalized = specifier.replaceAll("\\", "/");
    if (isCapabilities && hasAny(normalized, ["/agent/", "/answering/", "/application/", "/tools/"])) fail(`${rel}: capability imports forbidden ${specifier}`);
    if (isAnswering && hasAny(normalized, ["pi-agent", "electron", "fastify", "http", "/tools/", "/application/"])) fail(`${rel}: Answering imports forbidden seam ${specifier}`);
    if ((isAgent || isTools) && hasAny(normalized, ["/answering/answering-store", "/answering/result-store"])) fail(`${rel}: Agent/Tool imports concrete Answering store ${specifier}`);
    if (isDelegation && hasAny(normalized, ["pi-coding-agent", "pi-tui", "pi-subagents", "/application/", "/answering/"])) fail(`${rel}: Delegation core imports forbidden host/business dependency ${specifier}`);
    if (isFacets && hasAny(normalized, ["/answering/answering-store", "/answering/result-store"])) fail(`${rel}: Facet imports concrete Answering store ${specifier}`);
    if (isContracts && hasAny(normalized, ["pi-agent", "chord", "better-sqlite", "sqlite"])) fail(`${rel}: contracts imports infrastructure ${specifier}`);
    if (isCharts && !normalized.startsWith(".") && normalized !== "@data-agent/contracts") fail(`${rel}: isomorphic chart compiler imports ${specifier}`);
    if (isDashboardRenderer && normalized !== "@data-agent/charts" && normalized !== "@data-agent/contracts") fail(`${rel}: pure dashboard renderer imports ${specifier}`);
    if (isElectronOrServer && hasAny(normalized, ["@earendil-works/pi-agent-core", "AgentHarness", "AgentEvent"])) fail(`${rel}: transport Host imports Pi internals ${specifier}`);
    if (isElectronOrServer && hasAny(normalized, ["@data-agent/runtime/protocol", "packages/runtime/dist/protocol", "packages/runtime/src/protocol"])) fail(`${rel}: transport Host imports Runtime protocol internals ${specifier}`);
    if (isChannels && !(normalized === "@data-agent/contracts" || normalized.startsWith("node:") || normalized.startsWith("./") || normalized === "../application/protocol-host.js" || normalized === "../metadata.js")) fail(`${rel}: channel boundary imports ${specifier}`);
    if (isPlatformChannel && !(normalized === "@data-agent/contracts" || normalized.startsWith("@larksuiteoapi/") || normalized.startsWith("node:") || normalized.startsWith("./"))) fail(`${rel}: platform channel imports ${specifier}`);
    // Only Deliverables leave through channels; no model tool, Answering or agent code may send messages itself.
    if ((isTools || isAnswering || isAgent || isFacets || isDelegation) && normalized.includes("/channels/")) fail(`${rel}: imports the channel boundary ${specifier}`);
    if (isPresentation && hasAny(normalized, ["@earendil-works/pi-agent-core", "@data-agent/runtime", "better-sqlite", "mysql", "sqlExecutor", "credentials"])) fail(`${rel}: Presentation imports backend authority ${specifier}`);
  }

  if (rel.startsWith("packages/runtime/src/") && /\b(?:AgentSession|ExtensionRunner)\b/.test(text)) fail(`${rel}: Runtime production reintroduces a forbidden coding-agent host`);
  if (isAnswering && /\bas any\b/.test(text)) fail(`${rel}: Answering production contains as any`);
  if (isElectronOrServer && /(?:@data-agent\/runtime\/protocol|packages\/runtime\/dist\/protocol|packages\/runtime\/src\/protocol)/.test(text.replaceAll("\\", "/"))) {
    fail(`${rel}: transport Host references Runtime protocol internals`);
  }
}

const subagentTool = path.join(root, "packages/runtime/src/tools/subagent.ts");
if (existsSync(subagentTool) && !/replay:\s*["']never["']/.test(readFileSync(subagentTool, "utf8"))) {
  fail("subagent tool must use replay: never until cross-Session automatic recovery is implemented");
}

const runtimePackage = path.join(root, "packages/runtime/package.json");
if (existsSync(runtimePackage)) {
  const manifest = JSON.parse(readFileSync(runtimePackage, "utf8"));
  if (manifest.exports?.["./protocol"]) fail("runtime package exposes forbidden ./protocol production subpath");
}

const publicIndex = path.join(root, "packages/runtime/src/index.ts");
if (existsSync(publicIndex)) {
  const text = readFileSync(publicIndex, "utf8");
  for (const forbidden of ["DataAgentRuntime", "MetadataStore", "WorkspaceStore", "AgentHarness", "AnsweringStore", "PublicationRegistry", "QueryAssurance", "ApplicationAgentAdapter", "ApplicationSessionStore", "ApplicationSessionHandle", "ApplicationResources", "DataAgentSessionApplication"]) {
    if (new RegExp(`\\b${forbidden}\\b`).test(text)) fail(`runtime public index mentions forbidden symbol ${forbidden}`);
  }
  if (!text.includes("createDataAgentApplication") || !text.includes("DataAgentApplication")) fail("runtime public index does not expose Application Host");
}

const answeringService = path.join(root, "packages/runtime/src/answering/service.ts");
if (existsSync(answeringService)) {
  const source = ts.createSourceFile(answeringService, readFileSync(answeringService, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "Answering");
  const methods = declaration && ts.isInterfaceDeclaration(declaration)
    ? declaration.members.flatMap((member) => ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name) ? [member.name.text] : [])
    : [];
  const expected = ["set", "execute", "publish", "refresh", "inspect"];
  if (methods.join(",") !== expected.join(",")) fail(`Answering public interface must contain only ${expected.join(", ")}; found ${methods.join(", ") || "none"}`);
}

for (const file of productionFiles) {
  const rel = relative(file);
  if (rel.startsWith("packages/runtime/src/") && readFileSync(file, "utf8").includes(".watchSession(")) fail(`${rel}: production depends on unsupported watchSession`);
}

const oldSymbols = [
  "createDataAgentHarness",
  "createAgentHarnessResolver",
  "QueryAssurance",
  "JsonFileQueryAssuranceStateStore",
  "FastPathCheckpoint",
  "TaskUsageLedger",
  "answer-spec-legacy-v1",
  "evidence-plan-v2",
  "activeRun",
  "execute_query_export_batch",
];
for (const file of productionFiles) {
  const text = readFileSync(file, "utf8");
  for (const symbol of oldSymbols) if (text.includes(symbol)) fail(`${relative(file)}: legacy production symbol ${symbol}`);
}

const bundle = path.join(root, "frontend/electron-host/main.cjs");
if (existsSync(bundle)) {
  const text = readFileSync(bundle, "utf8");
  if (!text.includes("DataAgentApplication")) fail("generated Electron bundle does not contain DataAgentApplication");
  for (const symbol of oldSymbols) if (text.includes(symbol)) fail(`generated Electron bundle contains legacy symbol ${symbol}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `ARCHITECTURE_FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`backend architecture static gate OK (${productionFiles.length} production files)`);
}
