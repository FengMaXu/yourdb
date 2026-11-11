import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { FieldMetaSchema } from "@data-agent/contracts";
import { CHART_RENDERER_VERSIONS, compileChart } from "@data-agent/charts";
import type { BusinessContext } from "../answering/public.js";
import type { ArtifactDirectory } from "../facets/artifact-directory.js";
import { MAX_WIDGET_ROWS, chartDataRef, declaredFields, formatChartErrors, jsonSafeRows, semanticChecks } from "./charts.js";
import { ChartDataResolver, describeSource } from "../facets/chart-data.js";
import { MAX_DERIVED_ROWS, type DerivedDatasets, type DerivedInput } from "../facets/derived-datasets.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { DEFAULT_KNOWLEDGE_RESULTS, formatKnowledgeSearchResults, MAX_KNOWLEDGE_RESULTS, type KnowledgeIndex } from "../knowledge.js";
import { KnowledgeWriter } from "../knowledge-write.js";
import { runPythonJob } from "../python-job.js";
import type { WorkspaceStore } from "../workspace.js";
import { CHART_WIDGET_CONTRACT_VERSION, validateWidgetSpec, widgetLegacyText, type WidgetPayload } from "../widget.js";
import { trustedContext, type DataAgentToolContext } from "./answering.js";
import { defineDataAgentTool, type DataAgentToolDefinition } from "./tool-definition.js";
import type { ClarificationDialogs } from "../facets/clarification-dialogs.js";

function text(content: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: content }], details: details ?? null };
}

const TableFieldsSchema = Type.Record(Type.String(), FieldMetaSchema);

async function chartWidget(options: CoreToolOptions, spec: unknown, widgetId: string, toolCallId: string, business: BusinessContext): Promise<WidgetPayload> {
  if (!options.publishedRows) throw new Error("WIDGET_CHART_UNAVAILABLE: this host cannot read published results for charts");
  const data = await new ChartDataResolver({ publications: options.publishedRows, ...(options.derivedDatasets ? { derived: options.derivedDatasets } : {}) }).resolve(chartDataRef(spec), business);
  if (data.rows.length > MAX_WIDGET_ROWS) {
    throw new Error(`WIDGET_CHART_TOO_MANY_ROWS: the data has ${data.rows.length} rows and chat charts hold at most ${MAX_WIDGET_ROWS}; aggregate in the query, or use render_chart or export_query`);
  }
  // The rows travel with the widget so a replayed session renders without re-reading the result.
  const dataset = { columns: [...data.columns], rows: jsonSafeRows(data.rows) };
  const compiled = compileChart(spec, dataset, { target: "interactive" });
  if (!compiled.ok) throw new Error(formatChartErrors(compiled.errors));
  const disclosure = data.disclosures.join("；");
  const declared = declaredFields(spec);
  const checks = semanticChecks(compiled.spec.fields, data.physicalProfile);
  return {
    widget_id: widgetId,
    kind: "chart",
    title: compiled.spec.title ?? "图表",
    ...(compiled.spec.subtitle ? { subtitle: compiled.spec.subtitle } : {}),
    tool_call_id: toolCallId,
    contractVersion: CHART_WIDGET_CONTRACT_VERSION,
    // For tracing only: the browser always recompiles with its current compiler.
    renderer: CHART_RENDERER_VERSIONS,
    ...(data.source.kind === "publication" ? { receiptId: data.source.receiptId } : { derivedId: data.source.derivedId, derivedFrom: describeSource(data.source) }),
    dataSource: data.source,
    chartSpec: compiled.spec,
    dataset,
    notices: compiled.notices,
    ...(disclosure ? { disclosure } : {}),
    ...(declared.length > 0 ? { declaredFields: declared } : {}),
    ...(checks.length > 0 ? { semanticChecks: checks } : {}),
  };
}

/** Model-visible summary of a chart widget; the rows stay in the widget, out of the model context. */
function chartWidgetText(widget: WidgetPayload): string {
  const notices = Array.isArray(widget.notices) ? widget.notices as { message?: string }[] : [];
  const declared = Array.isArray(widget.declaredFields) ? widget.declaredFields as string[] : [];
  const checks = Array.isArray(widget.semanticChecks) ? widget.semanticChecks as { message?: string }[] : [];
  const rows = (widget.dataset as { rows?: unknown[] } | undefined)?.rows?.length ?? 0;
  return [
    `[widget:chart] ${widget.title} (${typeof widget.derivedId === "string" ? `derivedId=${widget.derivedId}` : `receiptId=${String(widget.receiptId)}`}, ${rows} 行)`,
    ...(typeof widget.derivedFrom === "string" ? [`[DERIVED] ${widget.derivedFrom}`] : []),
    ...notices.map((notice) => `[NOTICE] ${notice.message ?? ""}`),
    ...checks.map((check) => `[CHECK] ${check.message ?? ""}`),
    ...(typeof widget.disclosure === "string" ? [`[DISCLOSURE] ${widget.disclosure}`] : []),
    ...(declared.length > 0 ? [`[SEMANTICS] 以下字段的语义来自模型声明，未经业务定义核实：${declared.join("、")}`] : []),
  ].join("\n");
}

export interface CoreToolOptions {
  readonly workspace: WorkspaceStore;
  readonly knowledge?: KnowledgeIndex;
  readonly knowledgeRoot?: string;
  readonly pythonExecutable?: string | (() => string | undefined);
  readonly skills?: readonly { readonly name: string; readonly description: string; readonly content: string }[];
  readonly enableWidgets?: boolean;
  readonly clarifications?: Pick<ClarificationDialogs, "ask">;
  /** Receipt-bound rows for chart widgets; without it show_widget cannot draw charts. */
  readonly publishedRows?: Pick<ArtifactDirectory, "resolveRows" | "resolveReceipt">;
  /** Where run_python registers derived datasets and charts read them; without it run_python cannot derive. */
  readonly derivedDatasets?: Pick<DerivedDatasets, "register" | "resolve">;
}

/** Declared outputs are JSON under derived/, so a registration names a file the job itself wrote. */
const DERIVED_OUTPUT_PATH = /^derived\/[A-Za-z0-9_\-\u4e00-\u9fa5]{1,80}\.json$/;

/** Rows of a job output: `{ columns, rows }`, or pandas `to_json(orient="split")` (`{ columns, data }`). */
function derivedTable(text: string, path: string): { columns: string[]; rows: unknown[][] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`DERIVED_OUTPUT_INVALID: ${path} is not JSON`);
  }
  const value = parsed && typeof parsed === "object" ? parsed as { columns?: unknown; rows?: unknown; data?: unknown } : {};
  const rows = Array.isArray(value.rows) ? value.rows : value.data;
  if (!Array.isArray(value.columns) || !value.columns.every((column) => typeof column === "string") || !Array.isArray(rows) || !rows.every(Array.isArray)) {
    throw new Error(`DERIVED_OUTPUT_INVALID: ${path} must hold { "columns": [...], "rows": [[...], ...] } or pandas to_json(orient="split")`);
  }
  if (rows.length > MAX_DERIVED_ROWS) throw new Error(`DERIVED_OUTPUT_TOO_LARGE: ${path} has ${rows.length} rows; at most ${MAX_DERIVED_ROWS}`);
  return { columns: value.columns as string[], rows: rows as unknown[][] };
}

function executableOf(source: CoreToolOptions["pythonExecutable"]): string | undefined {
  return typeof source === "function" ? source() : source;
}


export function createCoreAgentToolDefinitions(options: CoreToolOptions): readonly DataAgentToolDefinition<DataAgentToolContext>[] {
  const definitions: DataAgentToolDefinition<DataAgentToolContext>[] = [
    defineDataAgentTool({
      name: "list_workspace",
      label: "list_workspace",
      description: "List files in the current session workspace.",
      replay: "safe",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return text((await options.workspace.list()).join("\n") || "(workspace empty)"); },
    }, {
      promptSnippet: "列出当前会话工作区中的文件。",
      promptGuidelines: ["只说明当前工作区，不暗示可以浏览全系统文件。"],
    }),
    defineDataAgentTool({
      name: "read_file",
      label: "read_file",
      description: "Read a workspace file with an optional one-based inclusive line range.",
      replay: "safe",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        const value = input as { path: string; startLine?: number; endLine?: number };
        const read = await options.workspace.readRange(value.path, {
          ...(value.startLine !== undefined ? { startLine: value.startLine } : {}),
          ...(value.endLine !== undefined ? { endLine: value.endLine } : {}),
        });
        return text(read.content, { path: value.path, truncated: read.truncated });
      },
    }, {
      promptSnippet: "读取工作区文件，可选一基包含的行区间。",
      promptGuidelines: ["遵守一基包含边界；披露截断，并按现有读取能力继续读取，不自行假定未返回内容。"],
    }),
    defineDataAgentTool({
      name: "write_file",
      label: "write_file",
      description: "Write a file inside the current session workspace.",
      replay: "never",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        const value = input as { path: string; content: string };
        await options.workspace.write(value.path, value.content);
        return text(`written ${value.path} (${value.content.length} bytes)`);
      },
    }, {
      promptSnippet: "写入当前会话工作区中的文件。",
      promptGuidelines: ["明确这是覆盖式写入且受路径范围约束；不要声称写入会自动发布或改变查询发布授权。"],
    }),
  ];

  if (options.knowledge) {
    const knowledge = options.knowledge;
    definitions.push(
      defineDataAgentTool({
        name: "search_knowledge",
        label: "search_knowledge",
        description: "Search the selected Markdown knowledge sources and return bounded relevant content. Search results include source, section, location, score, and content reference; use read_knowledge only when more context is needed.",
        replay: "safe",
        parameters: Type.Object({
          query: Type.String({ minLength: 1 }),
          knowledgeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_KNOWLEDGE_RESULTS })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, input) {
          const value = input as { query: string; knowledgeIds?: string[]; maxResults?: number };
          const allowed = value.knowledgeIds ? new Set(value.knowledgeIds) : undefined;
          const requestedResults = value.maxResults ?? DEFAULT_KNOWLEDGE_RESULTS;
          const hits = knowledge.search(
            value.query,
            Math.min(requestedResults, MAX_KNOWLEDGE_RESULTS),
            (_relativePath, knowledgeId) => !allowed || allowed.has(knowledgeId),
          );
          const formatted = formatKnowledgeSearchResults(hits, requestedResults);
          return text(JSON.stringify(formatted), formatted);
        },
      }, {
        promptSnippet: "检索相关知识章节及有界正文。",
        promptGuidelines: ["先搜索并按需选择来源；搜索结果已经足够时不要为了形式流程重复读取相同 contentRef。"],
      }),
      defineDataAgentTool({
        name: "read_knowledge",
        label: "read_knowledge",
        description: "Read a knowledge document or one named section. Short documents may be returned in full; large documents require a sectionId. Do not calculate line ranges.",
        replay: "safe",
        parameters: Type.Object({
          knowledgeId: Type.String({ minLength: 1 }),
          sectionId: Type.Optional(Type.String({ minLength: 1 })),
          continuationToken: Type.Optional(Type.String({ minLength: 1 })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, input) {
          const value = input as { knowledgeId: string; sectionId?: string; continuationToken?: string };
          const read = knowledge.read(value);
          return text(JSON.stringify(read), read);
        },
      }, {
        promptSnippet: "读取短知识文档或指定章节。",
        promptGuidelines: ["遵守 500 行边界，按 knowledgeId/sectionId 和 continuationToken 读取；不要自行计算行号分页。"],
      }),
    );
    if (options.knowledgeRoot) {
      const knowledge = options.knowledge;
      const writer = new KnowledgeWriter(options.knowledgeRoot, undefined, knowledge ? { isBuiltin: (relativePath) => knowledge.isBuiltinPath(relativePath) } : {});
      definitions.push(defineDataAgentTool({
        name: "update_knowledge",
        label: "update_knowledge",
        description: "Append learning or write a knowledge draft through the scoped knowledge capability.",
        replay: "never",
        parameters: Type.Object({ operation: Type.Union([Type.Literal("append_learning"), Type.Literal("write_draft"), Type.Literal("update_schema")]), path: Type.String({ minLength: 1 }), content: Type.String() }, { additionalProperties: false }),
        async execute(_toolCallId, input) {
          const value = input as { operation: "append_learning" | "write_draft" | "update_schema"; path: string; content: string };
          const written = await writer.write(value.operation, value.path, value.content);
          return text(`${written.operation} -> ${written.path} (${written.bytesWritten} bytes)`);
        },
      }, {
        promptSnippet: "追加学习记录或写入受限知识内容。",
        promptGuidelines: ["仅在复杂查询完成或用户纠错后记录可复用经验；不要把草稿、学习记录或 schema 更新冒充为已审核业务定义。"],
      }));
    }
  }

  if (options.pythonExecutable) {
    definitions.push(defineDataAgentTool({
      name: "run_python",
      label: "run_python",
      description: "Execute Python analysis confined to the current session workspace.",
      replay: "never",
      parameters: Type.Object({
        code: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        /** Compute chartable data from published results: inputs are materialized, outputs registered as derived datasets. */
        derive: Type.Optional(Type.Object({
          inputs: Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 }),
          outputs: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), path: Type.String() }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input, _onUpdate, toolContext, invocation, context) {
        const executable = executableOf(options.pythonExecutable);
        if (!executable) throw new Error("PYTHON_RUNTIME_NOT_AVAILABLE");
        const value = input as { code: string; description?: string; derive?: { inputs: string[]; outputs: { name: string; path: string }[] } };
        const derive = value.derive;
        const inputs: DerivedInput[] = [];
        let business: BusinessContext | undefined;
        if (derive) {
          if (!options.derivedDatasets || !options.publishedRows) throw new Error("DERIVED_DATASET_UNAVAILABLE: this host does not keep derived datasets");
          const bad = derive.outputs.find((output) => !DERIVED_OUTPUT_PATH.test(output.path));
          if (bad) throw new Error(`DERIVED_OUTPUT_INVALID: ${bad.path} must be derived/<name>.json`);
          business = trustedContext(toolContext, invocation, context);
          // Inputs are read through their Receipts before the job runs, so an unreadable one stops it early.
          for (const receiptId of [...new Set(derive.inputs)]) {
            const published = await options.publishedRows.resolveRows(receiptId, business);
            await options.workspace.write(`inputs/${receiptId}.json`, JSON.stringify({ columns: published.columns, rows: jsonSafeRows(published.rows) }));
            inputs.push({ receiptId, contentHash: published.receipt.contentHash });
          }
          // Outputs are written here by the job; the folder exists so scripts need not create it.
          await mkdir(path.join(options.workspace.root, "derived"), { recursive: true });
        }
        const job = await runPythonJob(value.code, { workspace: options.workspace.root, executable, timeoutMs: 120_000, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        const output = job.stdout || job.stderr || "(no output)";
        if (!derive || job.status !== "success") return text(output, { status: job.status, jobId: job.jobId, artifacts: job.artifacts, sessionId: toolContext?.sessionId });
        const derived = [];
        for (const declared of derive.outputs) {
          const table = derivedTable(await options.workspace.read(declared.path), declared.path);
          const record = await options.derivedDatasets!.register({ name: declared.name, columns: table.columns, rows: table.rows, inputs, script: value.code, jobId: job.jobId }, business!);
          derived.push({ name: declared.name, derivedId: record.derivedId, rows: record.rows.length });
        }
        const lines = derived.map((item) => `[DERIVED] ${item.name} derivedId=${item.derivedId}（${item.rows} 行，派生自 ${inputs.map((item) => item.receiptId).join("、") || "无输入"}）`);
        return text([output, ...lines].join("\n"), { status: job.status, jobId: job.jobId, artifacts: job.artifacts, sessionId: toolContext?.sessionId, derived });
      },
    }, {
      promptSnippet: "在配置的 Python 环境中执行当前工作区分析。",
      promptGuidelines: ["只能读写当前工作区，访问其他路径、启动子进程都会被拒绝；数据库数据请用 query_database 获取。运行时不提供绘图库（如 matplotlib），需要图表时用 render_chart、show_widget 或 generate_dashboard；要把计算结果画成图，用 derive 声明输入的 receiptId（脚本从 inputs/<receiptId>.json 读取 {columns, rows}）与输出 derived/<name>.json（写入 {columns, rows} 或 pandas to_json(orient=\"split\")），返回的 derivedId 作为图表的 { kind: \"derived\", derivedId }；披露实际工作区、超时和失败语义，不承诺这是安全沙箱。"],
    }));
  }

  if (options.clarifications) {
    definitions.push(defineDataAgentTool({
      name: "ask_user_clarification",
      label: "ask_user_clarification",
      description: "Ask the user one structured clarification and wait for the Session-owned answer.",
      replay: "never",
      parameters: Type.Object({ question: Type.String({ minLength: 1 }), options: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
      async execute(_toolCallId, input, _onUpdate, toolContext) {
        const value = input as { question: string; options?: string[] };
        const request = options.clarifications!.ask(toolContext?.sessionId ?? "", value.question, value.options ?? []);
        const answer = await request.promise;
        if (!answer) return text("[CLARIFICATION_UNANSWERED] 用户未回答（超时或已取消）。按 spec Skill 的「决定与澄清」第 5 条处理：统计总体字段仍需引用能确定它的原题或业务文档，建议无倾向的字段只能引用业务文档，都没有时再次询问；其他字段按比较建议的倾向决定。", { clarificationId: request.clarificationId });
        return text(`${answer}\n[CLARIFICATION_ANSWERED] clarificationId=${request.clarificationId}：在 set_answer_spec 中以 cite: [{source: "clarification:${request.clarificationId}", quote: <回答原文的逐字摘录>}] 引用这条回答。`, { clarificationId: request.clarificationId });
      },
    }, {
      promptSnippet: "请求并等待一个结构化的用户澄清。",
      promptGuidelines: ["按 spec Skill 的「决定与澄清」使用：待定字段没有能排除其他候选的依据，且属于统计总体字段或比较建议无倾向时询问；同一任务要问的字段合并成一次询问，选项用候选的业务含义。比较建议和模型推断不能冒充用户确认。"],
    }, { pinned: true }));
  }

  definitions.push(defineDataAgentTool({
    name: "load_skill",
    label: "load_skill",
    description: "Load a discovered skill without starting a nested Agent operation.",
    replay: "safe",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      const name = (input as { name: string }).name;
      const skill = options.skills?.find((item) => item.name === name);
      if (!skill) throw new Error(`SKILL_NOT_FOUND: ${name}`);
      return text(skill.content, { nativeSkill: name });
    },
  }, {
    promptSnippet: "加载已经发现的技能。",
    promptGuidelines: ["只加载现存技能；技能 allowlist 只筛选已有能力，不授予新的工具或权限。"],
  }, { pinned: true }));

  if (options.enableWidgets !== false) {
    definitions.push(defineDataAgentTool({
      name: "show_widget",
      label: "show_widget",
      description: "Render a structured widget for the Presentation layer.",
      replay: "never",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("kpi"), Type.Literal("chart"), Type.Literal("table"), Type.Literal("steps")]), spec: Type.Unknown() }, { additionalProperties: false }),
      async execute(toolCallId, input, _onUpdate, toolContext, invocation, context) {
        const value = input as { kind: WidgetPayload["kind"]; spec: unknown };
        const widgetId = `widget-${toolCallId}`;
        const lifecycle = (widget: WidgetPayload) => ({ widgetEvent: "widget", widgetId, toolCallId, toolName: "show_widget", widget });
        if (value.kind === "chart") {
          const widget = await chartWidget(options, value.spec, widgetId, toolCallId, trustedContext(toolContext, invocation, context));
          return text(chartWidgetText(widget), lifecycle(widget));
        }
        const validation = validateWidgetSpec(value.kind, value.spec);
        if (!validation.ok) throw new Error(`WIDGET_SPEC_INVALID: ${validation.error}`);
        const fields = validation.spec.fields;
        if (value.kind === "table" && fields !== undefined && !Value.Check(TableFieldsSchema, fields)) {
          throw new Error("WIDGET_SPEC_INVALID: table fields must map column names to ChartSpec field semantics (type, storage, additivity, ...)");
        }
        const widget: WidgetPayload = { ...validation.spec, widget_id: widgetId, kind: value.kind, title: typeof validation.spec.title === "string" && validation.spec.title.trim() ? validation.spec.title : `${value.kind} widget`, tool_call_id: toolCallId, contractVersion: CHART_WIDGET_CONTRACT_VERSION };
        return text(widgetLegacyText(widget), lifecycle(widget));
      },
    }, {
      promptSnippet: "输出结构化展示部件。",
      promptGuidelines: [
        "只在获得可视化授权且 kind 受现有实现支持时使用；不能绕过查询结果的发布授权。",
        "kind=\"chart\" 的 spec 是 ChartSpec v1，spec.data 为 { kind: \"publication\", receiptId }，引用已发布的结果；不要把数据行写进 spec。",
        "chart 返回 [CHECK] 时，说明字段声明与数据不符的可能：核对 storage、additivity，有误就改正后重新调用。",
        "kind=\"table\" 的数值列需要百分比、单位或量级换算时，在 spec.fields 中按列名声明字段语义；未声明的数值按原样显示，不会被猜测为百分比。",
      ],
    }));
  }

  return definitions;
}
