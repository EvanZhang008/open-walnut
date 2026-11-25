/**
 * A send's deadline never calls a row it stored undelivered (src/core/sessions/send-deadline.ts).
 *
 * 2026-11-25: the Binary matrix's binary-restart stage went red on the slowest runner. Right
 * after a restart the send's durable enqueue outlasted the 8 s deadline, POST /api/v1/messages
 * answered 503 "delivery timed out — retry", and the row was queued and answered all the same.
 *
 * The class: a timer raced against a store into a session's queue. Every such race in src/ goes
 * through sendWithin, whose gate the send passes right before its row is stored; the ratchet
 * below fails on a new plain race (withTimeout / Promise.race) around sendMessageToSession or
 * enqueueMessage, and on a sendWithin whose send never asks its gate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { sendWithin } from '../../../src/core/sessions/send-deadline.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(() => { vi.useRealTimers(); });

describe('sendWithin', () => {
  it('answers with the row when the send passed its gate and stored after the deadline', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (inTime) => {
      expect(inTime()).toBe(true);
      // The store (lock, read, durable write) takes longer than the deadline.
      await new Promise((r) => setTimeout(r, 20_000));
      return { id: 'qm-1' };
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ id: 'qm-1' });
  });

  it('times out a send that had not reached its gate, and shuts the gate so it stores nothing', async () => {
    vi.useFakeTimers();
    let stored = false;
    let gate: boolean | undefined;
    const sent = vi.fn(async (inTime: () => boolean) => {
      // Slow steps before the store (hints, notes): still under the deadline.
      await new Promise((r) => setTimeout(r, 10_000));
      gate = inTime();
      if (!gate) throw new Error('send no longer wanted');
      stored = true;
      return { id: 'qm-2' };
    });
    const p = sendWithin(8_000, sent);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gate).toBe(false);
    expect(stored).toBe(false);
  });

  it('passes the gate more than once (a send asks it on each of its paths)', async () => {
    const r = await sendWithin(1_000, async (inTime) => [inTime(), inTime()]);
    expect(r).toEqual([true, true]);
  });

  it('carries the error of a send that passed its gate', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (inTime) => {
      inTime();
      await new Promise((r) => setTimeout(r, 9_000));
      throw new Error('queue not stored');
    });
    const seen = expect(p).rejects.toThrow('queue not stored');
    await vi.advanceTimersByTimeAsync(9_000);
    await seen;
  });

  it('answers at once when the send ends before the deadline', async () => {
    await expect(sendWithin(8_000, async (inTime) => (inTime(), 'queued'))).resolves.toBe('queued');
  });
});

// ── Ratchet: every timed send into a session's queue goes through sendWithin ──

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const STORES = new Set(['sendMessageToSession', 'enqueueMessage']);
const RACES = new Set(['withTimeout', 'Promise.race']);

/** The called name: `f(...)` → f, `a.b(...)` → a.b, `(await import(x)).f(...)` → f. */
function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : e.name.text;
  return '';
}

/** Does `node` call a store, directly or through a name bound to one (`const p = sendMessageToSession(...)`)? */
function reachesStore(node: ts.Node, storeBound: Set<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(n) && STORES.has(calleeName(n).split('.').pop()!)) hit = true;
    else if (ts.isIdentifier(n) && storeBound.has(n.text)) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

interface Site { file: string; line: number; call: ts.CallExpression; source: ts.SourceFile; storeBound: Set<string> }

/** Every call in src/ whose callee is in `names`, with the file's names bound to a store call. */
function callsTo(names: Set<string>): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (![...names].some((n) => text.includes(n.split('.').pop()!))) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const storeBound = new Set<string>();
    const found: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && reachesStore(n.initializer, new Set())) storeBound.add(n.name.text);
      if (ts.isCallExpression(n) && names.has(calleeName(n))) found.push(n);
      ts.forEachChild(n, visit);
    };
    visit(source);
    for (const call of found) {
      const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
      sites.push({ file: path.relative(repoRoot, file), line, call, source, storeBound });
    }
  }
  return sites;
}

describe('send deadline ratchet', () => {
  it('no plain timer race wraps a store into a session queue', () => {
    const offenders = callsTo(RACES)
      .filter((s) => s.call.arguments.some((a) => reachesStore(a, s.storeBound)))
      .map((s) => `${s.file}:${s.line}`);
    expect(offenders, `A timer raced against sendMessageToSession/enqueueMessage answers "timed out" while the row still lands.
Use sendWithin (src/core/sessions/send-deadline.ts) and pass its gate as the send's stillWanted.`).toEqual([]);
  });

  it('every sendWithin send passes its gate to the store', () => {
    const uses = callsTo(new Set(['sendWithin'])).filter((s) => !s.file.endsWith('send-deadline.ts'));
    // The timed sends of 2026-11-25: deliverToSession's and the letter answer's.
    expect(uses.map((s) => s.file).sort()).toEqual(expect.arrayContaining(['src/core/human-inbox/letter-ops.ts', 'src/core/sessions/session-send-core.ts']));
    const blind = uses.filter((s) => {
      const run = s.call.arguments[1];
      if (!run || !(ts.isArrowFunction(run) || ts.isFunctionExpression(run)) || run.parameters.length === 0) return true;
      const gate = run.parameters[0].name.getText(s.source);
      // The gate is named in the store's options (stillWanted), not merely taken.
      return !new RegExp(`\\bstillWanted\\b[\\s\\S]*\\b${gate}\\b`).test(run.body.getText(s.source));
    }).map((s) => `${s.file}:${s.line}`);
    expect(blind, 'a sendWithin send must pass its gate (inTime) into the store\'s stillWanted').toEqual([]);
  });
});
