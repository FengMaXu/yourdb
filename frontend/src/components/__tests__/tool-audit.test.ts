import { describe, expect, it } from 'vitest';
import { extractBasisAudit, formatDisclosureHeadline, type ToolData } from '../tool-audit';

const publish = (items: unknown[]): ToolData => ({
    toolCallId: 'pub-1',
    messageId: 'm1',
    name: 'publish_query_result',
    args: {},
    status: 'done',
    details: { receiptId: 'pub_1', format: 'inline', disclosure: { required: true, unverifiedFields: [], summary: 'model-facing text', items } },
});

describe('disclosure headline for the answer footer', () => {
    it('states what goes beyond the assumption count, in business language, at most two items', () => {
        const audit = extractBasisAudit([publish([
            { kind: 'assumed', paths: ['population.entity', 'measure.formula'] },
            { kind: 'realization_conflict', paths: ['population.source'], detail: 'declares x, but the SQL never reads it.' },
            { kind: 'calendar_coverage', paths: ['population.time'], periods: ['2016-11'] },
            { kind: 'join_fanout_unknown', paths: ['measure.formula'], detail: 'unsupported_shape' },
        ])], false);
        expect(formatDisclosureHeadline(audit, false)).toBe('数据来源：SQL 可能没有按这条口径执行；时间范围：2016-11 没有数据；另有 1 项');
    });

    it('says nothing more when the only disclosure is assumptions', () => {
        const audit = extractBasisAudit([publish([{ kind: 'assumed', paths: ['population.entity'] }])], false);
        expect(formatDisclosureHeadline(audit, false)).toBeUndefined();
    });
});
