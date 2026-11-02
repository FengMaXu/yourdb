import type { Context, Models } from "@earendil-works/pi-ai";
import { failedStream, overrideModels } from "./models-overrides.js";
import { ToolPromptCatalog } from "./tool-prompt-catalog.js";

function appendCatalog(systemPrompt: string | undefined, catalog: string): string {
  return systemPrompt?.trim() ? `${systemPrompt}\n\n${catalog}` : catalog;
}

export interface PromptCatalogOptions {
  /**
   * Additional request-local section rendered before the tool directory, e.g.
   * the Skill catalog. It receives the exact active tool names of the request.
   */
  readonly renderPreamble?: (activeToolNames: readonly string[]) => string;
}

/**
 * Add the request-local Skill and tool directories at the Models seam. The
 * adapter reads only Context.tools from this exact request and leaves every
 * other Models method and stream option untouched.
 */
export function withToolPromptCatalog(source: Models, catalog: ToolPromptCatalog, catalogOptions: PromptCatalogOptions = {}): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    let rendered: string;
    try {
      const activeToolNames = context.tools?.map((tool) => tool.name) ?? [];
      rendered = [catalogOptions.renderPreamble?.(activeToolNames) ?? "", catalog.render(activeToolNames)]
        .filter((section) => section.trim())
        .join("\n\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failedStream(model, message);
    }
    if (!rendered) return source.streamSimple(model, context, options);
    const requestContext: Context = {
      ...context,
      systemPrompt: appendCatalog(context.systemPrompt, rendered),
    };
    return source.streamSimple(model, requestContext, options);
  };

  return overrideModels(source, { streamSimple });
}
