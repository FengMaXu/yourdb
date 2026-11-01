/** Classes shared by the chat's user rows, agent turns and the clarification card. */

/** An agent row: icon then content, up to 85% of the list (92% on a wide window, all of it on a phone). */
export const AGENT_ROW = 'flex max-w-[85%] gap-3 min-[1101px]:max-w-[92%] max-[720px]:max-w-full';

/** A user row: bubble then avatar, pushed to the right, up to 80% of the list. */
export const USER_ROW = 'ml-auto flex max-w-[80%] items-start justify-end gap-3 self-end max-[720px]:max-w-full';

/** The agent's orbit mark beside its content; accent while it works. */
export const agentIcon = (running: boolean) =>
    `mt-1 flex size-8 items-center justify-center self-start bg-transparent transition-colors ${running ? 'text-[var(--accent-color)]' : 'text-[#9ca3af]'}`;

/** The orbit drawn slightly larger than its 32px box. */
export const AGENT_ICON_SVG = 'origin-center scale-[1.18]';

/** The column beside the icon. */
export const MESSAGE_COLUMN = 'min-w-0 flex-1';

/** An agent's answer text; Chinese reads a little looser. */
export const AGENT_BODY = 'mt-0.5 py-1 text-[0.95rem] leading-[1.66] text-[#374151] in-[:lang(zh-CN)]:leading-[1.75]';
