/** Follow-up sent when a reply was cut by the output limit before any tool call. */
export const LENGTH_CONTINUATION_PROMPT = "上一条回复因输出长度上限被截断，尚未调用任何工具。请直接继续当前任务：精简思考，并调用所需的工具推进。";

/** Bounded per run so a model that keeps exhausting its output cannot loop forever. */
export const MAX_LENGTH_CONTINUATIONS = 2;

interface MessageLike {
  readonly role?: unknown;
  readonly stopReason?: unknown;
  readonly content?: unknown;
}

/**
 * Pi finishes a run when a reply fills the output limit without a tool call
 * (the limit was genuinely reached, so it is neither an error nor an
 * overflow). A reasoning model can spend the whole limit thinking, and the run
 * would end silently mid-task. This decides whether the run should continue.
 */
export function endedByOutputLimit(messages: readonly unknown[]): boolean {
  const last = messages[messages.length - 1] as MessageLike | undefined;
  if (!last || last.role !== "assistant" || last.stopReason !== "length") return false;
  const content = Array.isArray(last.content) ? last.content as readonly { readonly type?: unknown }[] : [];
  return !content.some((item) => item?.type === "toolCall");
}

/** Tracks continuations per run and returns the follow-up to send, if any. */
export class LengthContinuationGuard {
  private readonly counts = new Map<string, number>();

  followUp(runId: string, messages: readonly unknown[]): string | undefined {
    if (!endedByOutputLimit(messages)) {
      this.counts.delete(runId);
      return undefined;
    }
    const used = this.counts.get(runId) ?? 0;
    if (used >= MAX_LENGTH_CONTINUATIONS) {
      this.counts.delete(runId);
      return undefined;
    }
    this.counts.set(runId, used + 1);
    return LENGTH_CONTINUATION_PROMPT;
  }
}
