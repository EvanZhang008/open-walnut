/**
 * A run's outcome and the row of the fire that started it arrive in either order: the fire's
 * row is written once its start returns, and a session that answers at once ends its run
 * first (2026-11-26, tests/e2e/triage-run.test.ts: two rows per run, the fire's row never
 * saying "ended ok"). Either order leaves the same one row per run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { appendFireRow, auditDelivery, mergeFireAttempt, mergeRunOutcome, TRIGGER_FIRE_LOG_MAX } from '../../../src/core/cron/trigger-audit.js';
import type { TriggerAuditEntry } from '../../../src/core/cron/types.js';

const MAX = TRIGGER_FIRE_LOG_MAX;

/** The writers a fireLog may be set from: each folds an outcome that came before its fire's row. */
const FIRE_LOG_WRITERS = new Set(['appendFireRow', 'mergeRunOutcome', 'mergeFireAttempt']);
/** The two that may append on their own: appendFireRow is the fold, mergeRunOutcome keeps an early outcome apart. */
const APPENDERS = new Set(['appendFireRow', 'mergeRunOutcome']);

function walk(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.set(p, fs.readFileSync(p, 'utf8'));
  }
  return out;
}
const SRC = walk(path.resolve(__dirname, '../../../src'));

const callee = (n: ts.Expression): string | undefined => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : undefined);
const isFireLog = (n: ts.Node): boolean => (ts.isPropertyAccessExpression(n) && n.name.text === 'fireLog')
  || (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === 'fireLog');

/**
 * Every write of a `fireLog` (an assignment, `??=`, a property in an object literal, a mutating
 * array call) whose value is not one of FIRE_LOG_WRITERS, and every writer in trigger-audit.ts
 * other than APPENDERS that calls appendAudit itself. Read from the syntax tree, so a write split
 * over lines is read the same.
 */
function fireLogWriteOffenders(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (!text.includes('fireLog') && !text.includes('appendAudit')) continue;
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (n: ts.Node) => `${path.basename(file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n: ts.Node, fn?: string): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && isFireLog(n.left) && !FIRE_LOG_WRITERS.has(callee(n.right) ?? '')) out.push(`${at(n)}: ${n.getText().slice(0, 80)}`);
      if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'fireLog'
        && !FIRE_LOG_WRITERS.has(callee(n.initializer) ?? '')) out.push(`${at(n)}: ${n.getText().slice(0, 80)}`);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && isFireLog(n.expression.expression)
        && ['push', 'unshift', 'splice', 'pop', 'shift', 'sort', 'reverse', 'fill', 'copyWithin'].includes(n.expression.name.text)) out.push(`${at(n)}: ${n.getText().slice(0, 80)}`);
      const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text : fn;
      if (path.basename(file) === 'trigger-audit.ts' && name && FIRE_LOG_WRITERS.has(name) && !APPENDERS.has(name)
        && ts.isCallExpression(n) && callee(n) === 'appendAudit') out.push(`${at(n)}: ${name} appends without appendFireRow`);
      ts.forEachChild(n, (c) => visit(c, name));
    };
    visit(src);
  }
  return out;
}
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

  it('a trigger\'s first delivery attempt folds an outcome that came first (trigger-apply.ts deliver)', () => {
    // deliver() lets go of the lock while the session starts; a run's outcome (recordRunOutcome)
    // can take it first, so the fire's first attempt meets an outcome waiting for it.
    const attempt = (n: number): TriggerAuditEntry => ({ ...fire('t-3', 100, 5), seq: 7, epoch: 'e1', attempts: n });
    const usual = mergeRunOutcome(mergeFireAttempt([], attempt(1), MAX), outcome('t-3', 400), 't-3', MAX);
    const early = mergeFireAttempt(mergeRunOutcome([], outcome('t-3', 400), 't-3', MAX), attempt(1), MAX);
    expect(early).toEqual(usual);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ seq: 7, items: 5, delivery: { summary: 'Triage (task t-3) ended ok' } });
    // A later attempt of the same fire still merges into that one row.
    expect(mergeFireAttempt(early, { ...attempt(2), delivery: early[0]!.delivery }, MAX)).toHaveLength(1);
  });

  it('every write of a fireLog in src goes through a writer that folds an early outcome', () => {
    expect(fireLogWriteOffenders(SRC)).toEqual([]);
  });

  it('the guard reads what a line match misses, and catches a writer that appends on its own', () => {
    const offenders = fireLogWriteOffenders(new Map([
      ['a.ts', 'job.state.fireLog =\n  appendAudit(job.state.fireLog, e, 5);'],
      ['b.ts', 'job.state.fireLog = [e, ...(job.state.fireLog ?? [])];'],
      ['c.ts', 'job.state = { ...job.state, fireLog: appendAudit([], e, 5) };'],
      ['d.ts', 'job.state.fireLog.unshift(e);'],
      ['trigger-audit.ts', 'export function mergeFireAttempt(list, entry, max) { if (x) return appendAudit(list, entry, max); return list; }'],
      ['ok.ts', 'job.state.fireLog = mergeFireAttempt(job.state.fireLog, e, 5);'],
    ]));
    expect(offenders.map((o) => o.split(':')[0])).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'trigger-audit.ts']);
  });
});
