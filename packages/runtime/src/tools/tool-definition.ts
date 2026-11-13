import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

/** Trusted, code-owned prompt metadata for one executable tool. */
export interface ToolPromptMetadata {
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
}

/**
 * A tool and the local prompt contract that travels with it.
 *
 * The executable definition remains the source of the model-visible tool name;
 * metadata deliberately has no second name field.
 */
export interface DataAgentToolDefinition<
  TContext extends object | undefined,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> {
  readonly tool: AgentHarnessTool<TContext, TParameters, TDetails>;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  /** See ToolAvailability.pinned. */
  readonly pinned: boolean;
}

/** How a tool's availability is governed, declared where the tool is defined. */
export interface ToolAvailability {
  /**
   * Stays active when a Skill narrows the tool set. A pinned tool belongs to a
   * protocol the Runtime drives (Answering, clarification, skill loading,
   * delegation): the protocol may require it at any step, so a Skill that hid
   * it would leave the model told to call a tool it does not have.
   */
  readonly pinned?: boolean;
}

function assertPromptMetadata(metadata: ToolPromptMetadata): void {
  if (typeof metadata.promptSnippet !== "string" || !metadata.promptSnippet.trim() || /[\r\n]/u.test(metadata.promptSnippet)) {
    throw new Error("TOOL_PROMPT_SNIPPET_INVALID");
  }
  if (!Array.isArray(metadata.promptGuidelines)) throw new Error("TOOL_PROMPT_GUIDELINES_INVALID");
  for (const guideline of metadata.promptGuidelines) {
    if (typeof guideline !== "string" || !guideline.trim() || /[\r\n]/u.test(guideline)) {
      throw new Error("TOOL_PROMPT_GUIDELINE_INVALID");
    }
  }
}

/**
 * Keep metadata validation and ownership at the tool construction seam.
 * The returned arrays are immutable so callers cannot mutate a catalog after
 * it has been assembled.
 */
export function defineDataAgentTool<
  TContext extends object | undefined,
  TParameters extends TSchema,
  TDetails,
>(
  tool: AgentHarnessTool<TContext, TParameters, TDetails>,
  metadata: ToolPromptMetadata,
  availability: ToolAvailability = {},
): DataAgentToolDefinition<TContext, TParameters, TDetails> {
  assertPromptMetadata(metadata);
  return Object.freeze({
    tool,
    promptSnippet: metadata.promptSnippet.trim(),
    promptGuidelines: Object.freeze(metadata.promptGuidelines.map((guideline) => guideline.trim())),
    pinned: availability.pinned === true,
  });
}

/** A tool result whose content is one text part. */
export function textResult(content: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: content }], details: details ?? null };
}
