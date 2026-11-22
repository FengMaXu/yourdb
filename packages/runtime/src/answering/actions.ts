/**
 * Next steps a domain message points the caller to, without naming a tool or
 * route. The domain writes a marker; the transport layer (model tools, HTTP)
 * renders it in its own vocabulary, so Answering never depends on tool names.
 */
export type AnsweringAction =
  /** Run an exploration query; with a path, as the probe of one of its alternatives. */
  | { readonly kind: "explore"; readonly probePath?: string }
  /** Ask the user and cite the answer. */
  | { readonly kind: "clarify" }
  /** Rebind a chart query to its Report Task's current Revision. */
  | { readonly kind: "rebind"; readonly taskId: string };

const OPEN = "⟦action:";
const CLOSE = "⟧";

export function actionRef(action: AnsweringAction): string {
  return `${OPEN}${JSON.stringify(action)}${CLOSE}`;
}

/** Replaces every action marker in a domain message with the caller's rendering. */
export function renderActions(text: string, render: (action: AnsweringAction) => string): string {
  if (!text.includes(OPEN)) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(OPEN, index);
    if (start < 0) { out += text.slice(index); break; }
    const end = text.indexOf(CLOSE, start);
    if (end < 0) { out += text.slice(index); break; }
    out += text.slice(index, start);
    try {
      out += render(JSON.parse(text.slice(start + OPEN.length, end)) as AnsweringAction);
    } catch {
      out += text.slice(start, end + 1);
    }
    index = end + CLOSE.length;
  }
  return out;
}
