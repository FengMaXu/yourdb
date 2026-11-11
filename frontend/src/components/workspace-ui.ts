/**
 * The workspace pages' primitives (settings, channels, skills): cards, fields, inputs, buttons,
 * switches, segmented choices, pills, alerts and tables, on the stone palette with the brand
 * accent. They replace styles/ui.css and styles/workspace.css; combine them with cn(), base first.
 */
export const UI = {
    stack: 'flex flex-col gap-4',
    /** Children rise in one after another. */
    enter: '[&>*]:animate-rise-sm [&>*]:[animation-duration:380ms] [&>:nth-child(2)]:[animation-delay:50ms] [&>:nth-child(3)]:[animation-delay:100ms] [&>:nth-child(4)]:[animation-delay:150ms] [&>:nth-child(n+5)]:[animation-delay:200ms] motion-reduce:[&>*]:animate-none',
    grid2: 'grid grid-cols-2 gap-x-5 gap-y-4 max-[720px]:grid-cols-1',
    lead: 'm-0 max-w-[80ch] text-[0.875rem] leading-[1.65] text-pretty text-muted-foreground',
    caption: 'font-mono text-[0.72rem] font-medium tracking-[0.01em] text-faint',
    card: 'rounded-xl border border-border bg-white p-6 max-[720px]:p-[18px]',
    cardHead: 'flex min-w-0 items-center gap-3 [&>:first-child]:min-w-0 [&>:first-child]:flex-1',
    cardTitle: 'm-0 flex items-center gap-2.5 text-[0.975rem] leading-[1.35] font-[650] text-foreground',
    cardDesc: 'mt-1.5 mb-0 text-[0.85rem] leading-[1.65] text-muted-foreground',
    cardIcon: 'grid size-10 flex-none place-items-center rounded-lg bg-brand-soft text-brand shadow-[inset_0_0_0_1px_rgba(194,65,12,0.08)]',
    subhead: 'mt-0 mb-2.5 text-[0.8rem] font-semibold text-body-strong',
    field: 'flex min-w-0 flex-col gap-2',
    label: 'inline-flex items-center gap-[7px] text-[0.85rem] font-semibold text-foreground [&_svg]:text-faint',
    hint: 'm-0 text-[0.78rem] leading-[1.6] text-muted-foreground',
    input: 'box-border h-10 w-full rounded-lg border border-input bg-white px-3 text-[0.875rem] text-foreground [font-family:inherit] transition-[border-color,box-shadow,background-color] placeholder:text-faint hover:border-border-strong focus:border-brand focus:shadow-[0_0_0_4px_rgba(194,65,12,0.14)] focus:outline-none read-only:cursor-default read-only:bg-paper read-only:text-muted-foreground read-only:focus:border-input read-only:focus:shadow-none motion-reduce:transition-none',
    select: 'cursor-pointer appearance-none bg-[image:var(--select-chevron)] bg-[position:right_12px_center] bg-no-repeat pr-9',
    mono: 'font-mono text-[0.82rem]',
    /** An input with a control beside it; an adornment (data-adorn) sits inside the input's right edge. */
    inputGroup: 'relative flex items-center gap-2 [&>input]:flex-1 has-[[data-adorn]]:[&>input]:pr-[42px]',
    inputAdorn: 'absolute right-1.5 inline-grid size-[30px] cursor-pointer place-items-center rounded-md border-0 bg-transparent text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
    link: 'inline-flex w-fit items-center gap-1 rounded-sm text-[0.8rem] font-medium text-brand no-underline hover:underline hover:underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&_svg]:transition-transform hover:[&_svg]:translate-x-px hover:[&_svg]:-translate-y-px',
    btn: 'inline-flex h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-md border border-input bg-white px-3.5 text-[0.85rem] font-semibold whitespace-nowrap text-foreground [font-family:inherit] shadow-[0_1px_1px_rgba(28,25,23,0.03)] transition-[background-color,border-color,color,transform] enabled:hover:border-border-strong enabled:hover:bg-paper enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none',
    btnPrimary: 'border-foreground bg-foreground text-white shadow-[0_1px_2px_rgba(28,25,23,0.2),inset_0_1px_0_rgba(255,255,255,0.08)] enabled:hover:border-primary-hover enabled:hover:bg-primary-hover',
    btnQuiet: 'border-transparent bg-transparent text-body shadow-none enabled:hover:border-transparent enabled:hover:bg-accent enabled:hover:text-foreground',
    btnDanger: 'text-destructive enabled:hover:border-destructive-border enabled:hover:bg-destructive-soft',
    btnSm: 'h-[30px] px-[11px] text-[0.8rem]',
    actions: 'flex items-center justify-end gap-2 border-t border-border pt-5',
    /** A native role="switch" button: the thumb is its ::after. */
    switch: "relative h-5 w-9 flex-none cursor-pointer rounded-full border-0 bg-border-strong p-0 transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(28,25,23,0.25)] after:transition-[transform,width] after:content-[''] enabled:hover:bg-border-strong aria-checked:bg-brand aria-checked:after:translate-x-4 enabled:active:after:w-5 aria-checked:enabled:active:after:translate-x-3 disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none motion-reduce:after:transition-none",
    /** aria-pressed buttons side by side on a soft track. */
    segmented: 'inline-grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-1 self-start rounded-xl bg-accent p-1 max-[720px]:grid max-[720px]:self-stretch [&_button]:grid [&_button]:min-w-[120px] [&_button]:cursor-pointer [&_button]:gap-0.5 [&_button]:rounded-md [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-3.5 [&_button]:py-2 [&_button]:text-center [&_button]:text-[0.85rem] [&_button]:font-semibold [&_button]:text-body [&_button]:[font-family:inherit] [&_button]:transition-[background-color,box-shadow,color] [&_button:hover]:text-foreground [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-1 [&_button:focus-visible]:outline-brand [&_button[aria-pressed=true]]:bg-white [&_button[aria-pressed=true]]:text-foreground [&_button[aria-pressed=true]]:shadow-[0_1px_2px_rgba(28,25,23,0.08),0_0_0_1px_var(--border)] max-[720px]:[&_button]:min-w-0 motion-reduce:[&_button]:transition-none',
    /** A small rounded label; data-tone ok / warn / error / idle adds a coloured dot. */
    pill: "inline-flex h-[22px] items-center gap-[5px] rounded-full bg-accent px-[9px] text-[0.72rem] leading-none font-[550] whitespace-nowrap text-body data-[tone]:before:size-[5px] data-[tone]:before:rounded-full data-[tone]:before:bg-current data-[tone]:before:content-[''] data-[tone=ok]:bg-success-soft data-[tone=ok]:text-success data-[tone=warn]:bg-warning-soft data-[tone=warn]:text-warning data-[tone=error]:bg-destructive-soft data-[tone=error]:text-destructive data-[tone=idle]:bg-accent data-[tone=idle]:text-muted-foreground",
    /** A notice; data-tone ok / error / warn colours it. */
    alert: 'grid animate-rise-sm gap-1 rounded-lg border border-border bg-paper px-3.5 py-3 text-[0.85rem] leading-[1.6] break-words text-body [animation-duration:260ms] motion-reduce:animate-none [&_strong]:font-[650] data-[tone=ok]:border-success-border data-[tone=ok]:bg-success-soft data-[tone=ok]:text-success data-[tone=error]:border-destructive-border data-[tone=error]:bg-destructive-soft data-[tone=error]:text-destructive data-[tone=warn]:border-warning-border data-[tone=warn]:bg-warning-soft data-[tone=warn]:text-warning',
    alertDetail: 'break-all whitespace-pre-wrap opacity-90',
    table: 'w-full border-collapse text-[0.85rem] [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-[11px] [&_td]:text-body-strong [&_td]:tabular-nums [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:pt-0 [&_th]:pb-2.5 [&_th]:text-left [&_th]:text-[0.75rem] [&_th]:font-semibold [&_th]:text-muted-foreground [&_tr:last-child_td]:border-b-0 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-paper',
    tableAction: 'text-right',
    code: 'rounded-md bg-accent px-2 py-0.5 font-mono text-[0.95em] whitespace-nowrap text-foreground',
    empty: 'm-0 py-0.5 text-[0.85rem] text-muted-foreground',
} as const;
