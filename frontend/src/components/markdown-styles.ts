/**
 * Markdown rendered in the app: the one place its look is defined (D11). Headings, inline and
 * block code, quotes and the rounded, hairline-ruled tables are shared; documents and answers
 * differ only in spacing, table width and links. Joined, not merged: tailwind-merge would
 * misread some of these arbitrary variants as conflicts.
 */
const SHARED = [
    '[&_:is(h1,h2,h3,h4,h5,h6)]:mt-[1.5em] [&_:is(h1,h2,h3,h4,h5,h6)]:mb-[0.75em] [&_:is(h1,h2,h3,h4,h5,h6)]:leading-[1.3] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
    '[&_h1]:border-b [&_h1]:border-[var(--border-light)] [&_h1]:pb-[0.5em] [&_h1]:text-2xl',
    '[&_h2]:border-b [&_h2]:border-[var(--border-light)] [&_h2]:pb-[0.4em] [&_h2]:text-xl',
    '[&_h3]:text-[1.1rem]',
    '[&_code]:rounded-[5px] [&_code]:bg-[var(--bubble-bg)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-[family-name:var(--font-code)] [&_code]:text-[0.84em] [&_code]:font-medium [&_code]:text-[#44403c]',
    '[&_pre]:mb-[1em] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[#1f2937] [&_pre]:p-4 [&_pre]:text-[#f3f4f6]',
    '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-normal [&_pre_code]:text-inherit',
    '[&_blockquote]:mb-[1em] [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--border-medium)] [&_blockquote]:pl-[1em] [&_blockquote]:text-[var(--text-secondary)]',
    '[&_table]:mb-[1em] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-xl [&_table]:border [&_table]:border-[var(--hairline)] [&_table]:tabular-nums',
    '[&_tr:first-child>:first-child]:rounded-tl-[11px] [&_tr:first-child>:last-child]:rounded-tr-[11px] [&_tbody_tr:last-child>:first-child]:rounded-bl-[11px] [&_tbody_tr:last-child>:last-child]:rounded-br-[11px]',
    '[&_:is(td,th)]:border-b [&_:is(td,th)]:border-[var(--hairline)] [&_:is(td,th)]:px-3.5 [&_:is(td,th)]:py-[9px] [&_:is(td,th)]:text-left [&_:is(td,th)]:align-top',
    '[&_:is(td+td,th+th)]:border-l [&_:is(td+td,th+th)]:border-l-[var(--hairline)] [&_tbody_tr:last-child_td]:border-b-0',
    '[&_th]:bg-[#fafaf9] [&_th]:text-[0.85em] [&_th]:font-semibold [&_th]:text-[#57534e]',
    '[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-[#fcfbfa]',
    '[&_a]:text-[var(--accent-strong)] [&_a]:underline-offset-[3px]',
].join(' ');

/** A Markdown document, such as a knowledge file or a note. */
export const MARKDOWN_DOCUMENT = [
    SHARED,
    '[&_p]:mb-[1em] [&_:is(ol,ul)]:mb-[1em] [&_:is(ol,ul)]:pl-[1.5em] [&_li]:mb-[0.25em]',
    '[&_table]:w-full',
    '[&_a]:no-underline [&_a:hover]:underline',
].join(' ');

/** An agent's answer: tighter paragraphs and lists, tables only as wide as their content, links underlined. */
export const MARKDOWN_ANSWER = [
    SHARED,
    'overflow-x-auto wrap-anywhere whitespace-normal [&>:first-child]:mt-0 [&>:last-child]:mb-0',
    '[&_:is(ol,p,ul)]:mt-0 [&_:is(ol,p,ul)]:mb-[0.55em] [&_:is(ol,ul)]:pl-[1.35em]',
    '[&_li]:mt-0 [&_li]:mb-[0.28em] [&_li]:pl-[0.08em] [&_li>p]:mt-0 [&_li>p]:mb-[0.25em] [&_li>p:last-child]:mb-0',
    '[&_table]:w-max [&_table]:max-w-full [&_table]:min-w-[min(560px,100%)]',
    '[&_code]:whitespace-pre-wrap [&_pre_code]:whitespace-pre',
    '[&_a]:underline',
].join(' ');
