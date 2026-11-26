/**
 * A run's outcome and the row of the fire that started it arrive in either order: the fire's
 * row is written once its start returns, and a session that answers at once ends its run
 * first (2026-11-26, tests/e2e/triage-run.test.ts: two rows per run, the fire's row never
 * saying "ended ok"). Either order leaves the same one row per run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { appendFireRow, auditDelivery, mergeRunOutcome, TRIGGER_FIRE_LOG_MAX } from '../../../src/core/cron/trigger-audit.js';
import type { TriggerAuditEntry } from '../../../src/core/cron/types.js';

const MAX = TRIGGER_FIRE_LOG_MAX;
const fire = (taskId: string, atMs: number, items: number): TriggerAuditEntry => ({
  atMs, outcome: 'fired', items, durationMs: 500,
  delivery: auditDelivery({ status: 'ok', retry: false, summary: `Started Claude Code session for task ${taskId} (/tmp/x)`, sessionId: `s-${taskId}` }),
  injected: { chars: 40, preview: `<walnut-message kind="trigger"> ${items} items` },
});
const outcome = (taskId: string, atMs: number): TriggerAuditEntry => ({
  atMs, outcome: 'fired', durationMs: 1200,
  delivery: auditDelivery({ status: 'ok', retry: false, summary: `Triage (task ${taskId}) ended ok` }),
});

describe('a run\'s outcome and its fire row, in either order', () => {
  it('the outcome after the fire merges into its row (the usual order)', () => {
    const list = mergeRunOutcome(appendFireRow([], fire('t-1', 100, 22), MAX), outcome('t-1', 400), 't-1', MAX);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ items: 22, delivery: { summary: 'Triage (task t-1) ended ok' } });
    expect(list[0]!.injected?.preview).toContain('22 items');
  });

  it('the outcome before the fire leaves the same one row', () => {
    const usual = mergeRunOutcome(appendFireRow([], fire('t-1', 100, 22), MAX), outcome('t-1', 400), 't-1', MAX);
    const early = appendFireRow(mergeRunOutcome([], outcome('t-1', 400), 't-1', MAX), fire('t-1', 100, 22), MAX);
    expect(early).toEqual(usual);
    expect(early[0]!.outcomeOf).toBeUndefined();
  });

  it('two runs inside a minute keep their own rows, whichever order each came in', () => {
    let list: TriggerAuditEntry[] = [];
    list = mergeRunOutcome(list, outcome('t-1', 400), 't-1', MAX); // run 1 ended before its fire row
    list = appendFireRow(list, fire('t-1', 100, 22), MAX);
    list = appendFireRow(list, fire('t-2', 500, 24), MAX);         // run 2 in the usual order
    list = mergeRunOutcome(list, outcome('t-2', 900), 't-2', MAX);
    expect(list).toHaveLength(2);
    const of = (id: string) => list.filter((e) => (e.delivery?.summary ?? '').includes(id));
    expect(of('t-1')).toHaveLength(1);
    expect(of('t-2')).toHaveLength(1);
    expect(of('t-1')[0]).toMatchObject({ items: 22, delivery: { summary: 'Triage (task t-1) ended ok' } });
    expect(of('t-2')[0]).toMatchObject({ items: 24, delivery: { summary: 'Triage (task t-2) ended ok' } });
  });

  it('an early outcome waits for its own run\'s fire, never another run\'s', () => {
    const list = appendFireRow(mergeRunOutcome([], outcome('t-1', 400), 't-1', MAX), fire('t-2', 500, 24), MAX);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.outcomeOf === 't-1')).toBeDefined();
    expect(list.find((e) => e.items === 24)?.delivery?.summary).toContain('Started');
  });

  it('every fire row in src/core/cron is written through appendFireRow', () => {
    // A fire row appended another way would leave an early outcome as a second row again.
    const dir = path.resolve(__dirname, '../../../src/core/cron');
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').map((line, i) => ({ line, at: `${f}:${i + 1}` }))
      .filter(({ line }) => /fireLog\s*=\s*appendAudit\(/.test(line)).map(({ at }) => at));
    expect(offenders).toEqual([]);
  });
});
