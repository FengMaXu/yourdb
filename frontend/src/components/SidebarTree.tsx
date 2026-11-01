import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type DepthStyle = React.CSSProperties & { '--depth': number };

const depthStyle = (depth: number): DepthStyle => ({ '--depth': depth });

/** A sidebar entry: icon and label on the rail's ground; collapses to an icon tile on the rail. */
export const NAV_ITEM = cn(
    'relative flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-xl border-0 bg-transparent px-2.5 py-2 text-left text-[0.86rem] font-medium whitespace-nowrap text-[var(--text-secondary)]',
    'transition-[background-color,color,transform,box-shadow] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100',
    'pointer-fine:hover:translate-x-0.5 pointer-fine:hover:bg-white/70 pointer-fine:hover:text-[#111827] motion-reduce:pointer-fine:hover:translate-x-0',
    'group-data-[rail=true]/sidebar:h-10 group-data-[rail=true]/sidebar:w-10 group-data-[rail=true]/sidebar:justify-center group-data-[rail=true]/sidebar:gap-0 group-data-[rail=true]/sidebar:p-0 pointer-fine:group-data-[rail=true]/sidebar:hover:translate-x-0',
);
/** The text beside a nav item's icon; hidden on the rail. */
export const NAV_TEXT = 'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-ellipsis group-data-[rail=true]/sidebar:hidden';
/** A nav item whose section is open. */
export const NAV_EXPANDED = 'font-semibold text-[var(--accent-strong)]';

interface SectionHeaderProps {
    icon: React.ReactNode;
    label: string;
    expanded: boolean;
    onToggle: () => void;
    /** Section-level actions, shown on the header while the section is open. */
    actions?: React.ReactNode;
}

/** A top-level sidebar entry that opens a tree, with its actions on the same row. */
export const SectionHeader: React.FC<SectionHeaderProps> = ({ icon, label, expanded, onToggle, actions }) => (
    <div className="relative">
        <button
            type="button"
            className={cn(NAV_ITEM, expanded && NAV_EXPANDED, expanded && actions && 'pr-16')}
            title={label}
            aria-label={label}
            aria-expanded={expanded}
            onClick={onToggle}
        >
            {icon}
            <span className={NAV_TEXT}>{label}</span>
        </button>
        {expanded && actions && <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2">{actions}</div>}
    </div>
);

interface TreeActionProps {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
    tone?: 'danger';
    preventBlur?: boolean;
}

/** A small icon button used on section headers and tree rows. */
export const TreeAction: React.FC<TreeActionProps> = ({ label, onClick, children, tone, preventBlur }) => (
    <button
        type="button"
        className={cn(
            'inline-flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#78716c] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-strong)]',
            tone === 'danger' ? 'hover:text-[var(--status-error)]' : 'hover:text-[var(--text-primary)]',
        )}
        title={label}
        aria-label={label}
        onMouseDown={preventBlur ? (event) => event.preventDefault() : undefined}
        onClick={onClick}
    >
        {children}
    </button>
);

interface TreeRowProps {
    depth: number;
    icon: React.ReactNode;
    label: React.ReactNode;
    /** Secondary text after the label, such as a document id. */
    secondary?: React.ReactNode;
    title?: string;
    /** Right-aligned detail such as a count or badge. */
    meta?: React.ReactNode;
    /** Omit for a leaf row; true/false renders the disclosure chevron. */
    expanded?: boolean;
    active?: boolean;
    onSelect?: () => void;
    /** Row actions, revealed on hover or focus. */
    actions?: React.ReactNode;
    /** Replaces the row's main button, e.g. with a rename input. */
    editor?: React.ReactNode;
}

/** A row's content, indented by its --depth: the tree's inset plus one indent per level. */
const ROW_MAIN = 'flex h-full min-w-0 flex-auto items-center gap-1.5 rounded-lg border-0 bg-transparent py-0 pr-2 pl-[calc(var(--tree-inset)+var(--depth)*var(--tree-indent))] text-left text-[0.82rem]';

export const TreeRow: React.FC<TreeRowProps> = ({
    depth,
    icon,
    label,
    secondary,
    title,
    meta,
    expanded,
    active = false,
    onSelect,
    actions,
    editor,
}) => {
    const expandable = expanded !== undefined;
    const chevron = (
        <span className={cn('inline-flex flex-[0_0_14px] text-[var(--thread-muted)] transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} aria-hidden="true">
            {expandable && <ChevronRight className="size-3.5" />}
        </span>
    );
    const iconSpan = <span className={cn('inline-flex flex-none', active ? 'text-[var(--accent-strong)]' : 'text-[#78716c]')} aria-hidden="true">{icon}</span>;

    return (
        // --row-bg is the row's current ground, so the actions' fade matches it.
        <div
            className={cn(
                'group/row relative flex h-[30px] items-center rounded-lg transition-colors',
                active
                    ? 'bg-[var(--row-bg)] [--row-bg:var(--tree-row-active)]'
                    : 'bg-transparent [--row-bg:var(--tree-row-bg)] focus-within:bg-[var(--row-bg)] focus-within:[--row-bg:var(--tree-row-hover)] hover:bg-[var(--row-bg)] hover:[--row-bg:var(--tree-row-hover)]',
            )}
            style={depthStyle(depth)}
        >
            {editor ? (
                <div className={cn(ROW_MAIN, 'text-[var(--text-secondary)]')}>
                    {chevron}
                    {iconSpan}
                    {editor}
                </div>
            ) : (
                <button
                    type="button"
                    className={cn(
                        ROW_MAIN,
                        'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-strong)]',
                        active ? 'font-semibold text-[var(--text-primary)]' : 'font-medium text-[var(--text-secondary)] group-hover/row:text-[var(--text-primary)]',
                    )}
                    title={title}
                    aria-expanded={expandable ? expanded : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={onSelect}
                >
                    {chevron}
                    {iconSpan}
                    <span className="min-w-0 flex-auto truncate">
                        {label}
                        {secondary && <span className="ml-1.5 font-[family-name:var(--font-code)] text-[0.7rem] font-normal text-[var(--thread-muted)]">{secondary}</span>}
                    </span>
                    {meta !== undefined && meta !== null && <span className="max-w-[5em] flex-none truncate font-[family-name:var(--font-code)] text-[0.68rem] text-[var(--thread-muted)]">{meta}</span>}
                </button>
            )}
            {actions && (
                <span
                    className={cn(
                        'absolute top-1/2 right-1 flex -translate-y-1/2 bg-[linear-gradient(90deg,transparent,var(--row-bg)_14px)] pl-3.5 transition-opacity motion-reduce:transition-none',
                        editor ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
                    )}
                >
                    {actions}
                </span>
            )}
        </div>
    );
};

/** Children of a tree row, drawn with a guide line under the parent's chevron. */
export const TreeGroup: React.FC<{ depth: number; children: React.ReactNode }> = ({ depth, children }) => (
    <div
        className="relative before:absolute before:top-0 before:bottom-1 before:left-[calc(var(--tree-inset)+var(--depth)*var(--tree-indent)+7px)] before:w-px before:bg-[var(--tree-guide)]"
        role="group"
        style={depthStyle(depth)}
    >
        {children}
    </div>
);

/** A muted line inside a tree for loading and empty states. */
export const TreeNote: React.FC<{ depth: number; children: React.ReactNode; role?: string }> = ({ depth, children, role }) => (
    <div className="py-1.5 pr-2 pl-[calc(var(--tree-inset)+var(--depth)*var(--tree-indent)+20px)] text-[0.76rem] text-[var(--thread-muted)]" role={role} style={depthStyle(depth)}>
        {children}
    </div>
);

/** The block that holds a section's tree rows. */
export const TREE = 'mt-0.5 mb-2';
