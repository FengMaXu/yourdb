import { describe, expect, it } from 'vitest';
import { extractBasisAudit, formatDisclosureHeadline, formatNotesHeadline, type ToolData } from '../tool-audit';

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

describe('review fixes', () => {
    const query = (candidateId: string, fanout?: string): ToolData => ({
        toolCallId: `q-${candidateId}`,
        messageId: 'm1',
        name: 'query_database',
        args: { kind: 'result', sql: 'SELECT 1' },
        status: 'done',
        details: { artifact: { kind: 'candidate', candidateId }, ...(fanout ? { fanout: { status: fanout } } : {}) },
    });
    const publishOf = (candidateId: string): ToolData => ({ ...publish([]), args: { candidateId } });

    it('keeps the fanout warning of a later query whose candidate was never published', () => {
        const audit = extractBasisAudit([query('A'), publishOf('A'), query('B', 'finding')], false);
        expect(audit.fanoutFinding).toBeDefined();
        expect(extractBasisAudit([query('A', 'finding'), publishOf('A')], false).fanoutFinding).toBeUndefined();
    });

    it('can show every note, and says a repeated note once', () => {
        const note = { kind: 'calendar_coverage', paths: ['population.time'], periods: ['2016-11'] };
        expect(formatNotesHeadline([note, note, { kind: 'join_fanout', paths: ['measure.formula'] }], false, ['x', 'y'], Number.POSITIVE_INFINITY))
            .toBe('时间范围：2016-11 没有数据；度量公式：表连接后可能重复计数；x；y');
    });
});
