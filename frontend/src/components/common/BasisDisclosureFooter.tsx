import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

export interface BasisDisclosureNotice {
    code: string;
    field?: string;
    message: string;
}

export interface BasisDisclosureCheck {
    code: string;
    field: string;
    message: string;
}

export interface BasisDisclosureFooterProps {
    /** Primary basis content (plain text or rendered markdown from the caller). */
    basis?: React.ReactNode;
    /** Compiler presentation notices (e.g. null handling). */
    notices?: readonly BasisDisclosureNotice[];
    /** Semantic warning checks from ChartSpec compilation. */
    checks?: readonly BasisDisclosureCheck[];
    /** Model assumption disclosure text. */
    disclosure?: string;
    /** Fields whose semantics were declared by the model without business doc verification. */
    declaredFields?: readonly string[];
    /** Optional callback to open the right-hand Basis & Audit drawer (ToolPanel). */
    onOpenAudit?: () => void;
    /** Verified status label, defaults to true when no disclosures/declaredFields are present. */
    verified?: boolean;
    /** Clauses the model assumed; shown in the badge when known. */
    assumedCount?: number;
}

/**
 * Quiet, structured footnote bar for basis statements, semantic verification
 * status, and expandable compiler/assumption disclosures under answers and charts.
 */
const BasisDisclosureFooter: React.FC<BasisDisclosureFooterProps> = ({
    basis,
    notices = [],
    checks = [],
    disclosure,
    declaredFields = [],
    onOpenAudit,
    verified = true,
    assumedCount,
}) => {
    const { language } = useLanguage();
    const isEn = language === 'en';

    const hasAssumptions = declaredFields.length > 0 || (assumedCount ?? 0) > 0;
    // Missing data or a check finding is not an assumption; it still is not "verified".
    const needsAttention = !hasAssumptions && (!verified || Boolean(disclosure));
    const isVerified = verified && !hasAssumptions && !needsAttention;
    // A single disclosure line with nothing else to fold reads inline, beside the badge.
    const inlineDisclosure = !basis && notices.length === 0 && checks.length === 0 && declaredFields.length === 0 ? disclosure : undefined;
    const hasDetails = notices.length > 0 || checks.length > 0 || (Boolean(disclosure) && !inlineDisclosure) || declaredFields.length > 0;

    if (!basis && !hasDetails && !inlineDisclosure && !onOpenAudit) {
        return null;
    }

    return (
        <div
            data-slot="basis-disclosure-footer"
            className="mt-3 rounded-xl border border-border bg-paper/85 px-3.5 py-2.5 text-[12px] leading-[1.6] text-body"
        >
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
                <div className="order-1 flex shrink-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
                        -- BASIS
                    </span>
                    {hasAssumptions || needsAttention ? (
                        <span className="shrink-0 rounded border border-warning-border bg-warning-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-warning">
                            {assumedCount
                                ? (isEn ? `${assumedCount} assumed` : `含 ${assumedCount} 项模型假设`)
                                : hasAssumptions
                                    ? (isEn ? 'Assumed' : '含模型假设')
                                    : (isEn ? 'Check' : '需留意')}
                        </span>
                    ) : isVerified ? (
                        <span className="shrink-0 rounded border border-success-border bg-success-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-success">
                            {isEn ? 'Verified' : '已核实'}
                        </span>
                    ) : null}
                </div>
                {inlineDisclosure && (
                    <div className="order-3 min-w-0 basis-full text-[12.5px] leading-[1.6] break-words text-warning min-[721px]:order-2 min-[721px]:basis-auto min-[721px]:flex-1">
                        {inlineDisclosure}
                    </div>
                )}
                {basis && (
                    <div className="order-3 min-w-0 basis-full text-[12.5px] leading-[1.6] break-words text-body min-[721px]:order-2 min-[721px]:basis-auto min-[721px]:flex-1 [&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-white [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:break-all [&_p]:m-0 [&_p]:inline">
                        {basis}
                    </div>
                )}
                {onOpenAudit && (
                    <button
                        type="button"
                        onClick={onOpenAudit}
                        className="order-2 ml-auto shrink-0 cursor-pointer border-0 bg-transparent p-0 font-mono text-[11.5px] font-medium text-brand hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand min-[721px]:order-3 min-[721px]:ml-0"
                    >
                        {isEn ? 'Basis & SQL ->' : '口径与 SQL 依据 →'}
                    </button>
                )}
            </div>

            {hasDetails && (
                <div className={basis ? 'mt-2 border-t border-border/80 pt-2' : 'mt-1.5'}>
                    <details open className="group/disclosure">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronDown className="size-3.5 transition-transform group-open/disclosure:rotate-0 -rotate-90" aria-hidden="true" />
                            <span>{isEn ? '-- DISCLOSURE · Checks & Assumptions' : '-- DISCLOSURE · 披露与数据校验'}</span>
                        </summary>
                        <div className="mt-1.5 grid gap-1 pl-0.5">
                            {notices.map((notice) => (
                                <div key={`${notice.code}:${notice.field ?? ''}`} className="text-[12px] text-muted-foreground">
                                    {notice.message}
                                </div>
                            ))}
                            {checks.map((check) => (
                                <div key={`check:${check.code}:${check.field}`} className="text-[12px] text-warning">
                                    {check.message}
                                </div>
                            ))}
                            {disclosure && (
                                <div className="text-[12px] text-muted-foreground">
                                    {disclosure}
                                </div>
                            )}
                            {declaredFields.length > 0 && (
                                <div className="text-[12px] text-muted-foreground">
                                    {isEn
                                        ? `Field semantics declared by model without business doc verification: ${declaredFields.join(', ')}`
                                        : `字段语义来自模型声明，未经业务定义核实：${declaredFields.join('、')}`}
                                </div>
                            )}
                        </div>
                    </details>
                </div>
            )}
        </div>
    );
};

export default BasisDisclosureFooter;
