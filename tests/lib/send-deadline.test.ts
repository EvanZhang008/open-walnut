/**
 * A send's deadline never calls a row it stored undelivered (src/lib/send-deadline.ts).
 *
 * 2026-11-25: the Binary matrix's binary-restart stage went red on the slowest runner. Right
 * after a restart the send's durable enqueue outlasted the 8 s deadline, POST /api/v1/messages
 * answered 503 "delivery timed out — retry", and the row was queued and answered all the same.
 *
 * The class: a timer raced against a send into a session's queue. The ratchets below fail on
 * - a new plain race (withTimeout, Promise.race, withDeadline) whose arguments reach a queue send,
 *   through the store itself or one of the entry points that reach it (QUEUE_SENDS);
 * - a deadline where no caller sends again on a timeout (a notice nobody resends would be lost);
 * - a sendWithin whose send never passes its gate to the store, or negates it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { sendWithin } from '../../src/lib/send-deadline.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => { vi.useRealTimers(); });

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sendWithin', () => {
  it('a send that ends in time is answered by its value', async () => {
    await expect(sendWithin(8_000, async (g) => (g.inTime(), 'queued'))).resolves.toEqual({ status: 'sent', value: 'queued' });
  });

  it('times out a send that had not reached its gate, and shuts the gate so it stores nothing', async () => {
    vi.useFakeTimers();
    let gate: boolean | undefined;
    let stored = false;
    const p = sendWithin(8_000, async (g) => {
      await later(10_000); // slow steps before the store (hints, notes)
      gate = g.inTime();
      if (!gate) throw new Error('send no longer wanted');
      stored = true;
      return 'row';
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toEqual({ status: 'timed_out' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gate).toBe(false);
    expect(stored).toBe(false);
  });

  it('past the deadline, answers the moment the row is stored, not when the rest of the send ends', async () => {
    vi.useFakeTimers();
    let ended = false;
    const p = sendWithin(8_000, async (g) => {
      g.inTime();
      await later(12_000); // the store: lock, read, durable write
      g.stored();
      await later(60_000); // notes, hints, emits after the store
      ended = true;
      return 'row';
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(p).resolves.toEqual({ status: 'stored' });
    expect(ended).toBe(false);
  });

  it('a row stored before the deadline whose send still runs is answered at the deadline', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (g) => { g.inTime(); g.stored(); await later(30_000); return 'row'; });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toEqual({ status: 'stored' });
  });

  it('a store still under way past its bound is unconfirmed, never timed out', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (g) => { g.inTime(); await later(600_000); return 'row'; }, { storeBoundMs: 90_000 });
    await vi.advanceTimersByTimeAsync(8_000 + 90_000);
    await expect(p).resolves.toEqual({ status: 'unconfirmed' });
  });

  it('with no bound, waits for the store however long it takes', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (g) => { g.inTime(); await later(300_000); return 'row'; }, { storeBoundMs: null });
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(p).resolves.toEqual({ status: 'sent', value: 'row' });
  });

  it('a stored mark commits a send that never asked its gate (work that went out on its own)', async () => {
    vi.useFakeTimers();
    const p = sendWithin(8_000, async (g) => { g.stored(); await later(20_000); return 'launched'; });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toEqual({ status: 'stored' });
  });

  it('carries the error of a send that failed before its answer, and reports a later one', async () => {
    vi.useFakeTimers();
    const early = sendWithin(8_000, async (g) => { g.inTime(); await later(9_000); throw new Error('queue not stored'); });
    const seen = expect(early).rejects.toThrow('queue not stored');
    await vi.advanceTimersByTimeAsync(9_000);
    await seen;
    const late: unknown[] = [];
    const p = sendWithin(8_000, async (g) => { g.inTime(); g.stored(); await later(9_000); throw new Error('a hint write failed'); }, { onLateError: (e) => late.push(e) });
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(p).resolves.toEqual({ status: 'stored' });
    expect(String(late[0])).toContain('a hint write failed');
  });
});

describe('a dropped send takes its marks back', () => {
  it('the lead traffic stamps go back to what they were, and a later stamp is kept', async () => {
    const { noteSent, notePeerNote, workerToldLead, latestSenderTo, _resetLeadTrafficForTesting } = await import('../../src/core/org/lead-traffic.js');
    _resetLeadTrafficForTesting();
    noteSent('lead', 'worker', 1_000);
    const unsent = noteSent('worker', 'lead', 2_000);
    expect(workerToldLead('worker', 'lead')).toBe(true);
    unsent();
    expect(workerToldLead('worker', 'lead')).toBe(false);
    const now = Date.now();
    const unhanded = notePeerNote('a', 'b', now);
    unhanded();
    expect(latestSenderTo('b', 60_000, now)).toBeNull();
    notePeerNote('a', 'b', now);
    const stale = notePeerNote('c', 'b', now + 1);
    notePeerNote('d', 'b', now + 2);
    stale(); // a later stamp came since: kept
    expect(latestSenderTo('b', 60_000, now + 2)).toBe('d');
  });
});

// ── Ratchets: the class, enumerated from src/ ──

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

interface Parsed { file: string; source: ts.SourceFile }
let parsedCache: Parsed[] | null = null;
function parsed(): Parsed[] {
  parsedCache ??= sourceFiles(path.join(repoRoot, 'src')).map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return { file: path.relative(repoRoot, file), source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) };
  });
  return parsedCache;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

/** The called name's last part: `f(...)` → f, `a.b(...)` → b, `(await import(x)).f(...)` → f. */
function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}
const fullCallee = (call: ts.CallExpression): string => {
  const e = call.expression;
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : calleeName(call);
};
const lineOf = (p: Parsed, n: ts.Node): string => `${p.file}:${p.source.getLineAndCharacterOfPosition(n.getStart(p.source)).line + 1}`;

/** The queue's two stores. */
const STORES = ['sendMessageToSession', 'enqueueMessage'];
/**
 * The entry points that reach a store, each through the next: a race around one is a race around a
 * store. Checked below to exist and to call a store or an earlier entry.
 */
const QUEUE_SENDS: Record<string, string> = {
  deliverToSession: 'sessions/session-send-core.ts: every Walnut notice and task message',
  performSessionSend: 'sessions/session-send-core.ts: POST /api/v1/messages and every in-process send',
  deliverLetterToOrigin: 'human-inbox/letter-ops.ts: a letter answer',
  sendToSession: 'routines/executors/session.ts: a routine or trigger fire into its task',
  deliverToMainAgent: 'routines/main-target.ts: a routine into the Main task',
  runMainAgentWithPrompt: 'routines/executors/main-agent.ts: its deps, the Main task delivery',
  runExecutor: 'routines/registry.ts: a routine run or trigger fire',
};
/** The functions between an entry and the next (performSessionSend → performPlainSend → …), for the chain check only. */
const HOPS = new Set(['performPlainSend', 'performPlainSendOnce', 'deliver', 'run']);
const RACES = new Set(['withTimeout', 'Promise.race', 'withDeadline']);

/** Names a parameter typed as a fire's delivery (`(…, at: DeliverAt) => Promise<DeliverResult>`). */
function deliveryParams(p: Parsed): Set<string> {
  const names = new Set<string>();
  walk(p.source, (n) => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && /\bDeliverResult\b/.test(n.type.getText(p.source))) names.add(n.name.text);
  });
  return names;
}

function reachesQueue(node: ts.Node, names: Set<string>, bound: Set<string>): boolean {
  let hit = false;
  walk(node, (n) => {
    if (hit) return;
    if (ts.isCallExpression(n) && names.has(calleeName(n))) hit = true;
    else if (ts.isIdentifier(n) && bound.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) hit = true;
  });
  return hit;
}

describe('send deadline ratchet', () => {
  it('every queue send entry point is real and reaches a store', () => {
    const reach = new Set(STORES);
    const defined = new Map<string, ts.Node[]>();
    for (const p of parsed()) {
      walk(p.source, (n) => {
        let name: string | undefined;
        let body: ts.Node | undefined;
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body) { name = n.name.getText(p.source); body = n.body; }
        else if ((ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertySignature(n)) && ts.isIdentifier(n.name)) {
          const init = 'initializer' in n ? n.initializer : undefined;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) { name = n.name.text; body = init.body; }
        }
        if (name && body && (name in QUEUE_SENDS || HOPS.has(name))) defined.set(name, [...(defined.get(name) ?? []), body]);
      });
    }
    // Each in turn reaches a store or an entry already shown to: the list is a chain, not a guess.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, bodies] of defined) {
        if (reach.has(name)) continue;
        if (bodies.some((b) => reachesQueue(b, reach, new Set()))) { reach.add(name); grew = true; }
      }
    }
    const missing = Object.keys(QUEUE_SENDS).filter((n) => !reach.has(n));
    expect(missing, 'a QUEUE_SENDS entry that is not defined in src/ or reaches no store: update the list').toEqual([]);
  });

  it('no plain timer race reaches a send into a session queue', () => {
    const offenders: string[] = [];
    const names = new Set([...STORES, ...Object.keys(QUEUE_SENDS)]);
    for (const p of parsed()) {
      const local = new Set([...names, ...deliveryParams(p)]);
      // Names bound to a send's promise (`const sent = sendMessageToSession(...)`), raced later.
      const bound = new Set<string>();
      walk(p.source, (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && reachesQueue(n.initializer, local, new Set())) bound.add(n.name.text);
      });
      walk(p.source, (n) => {
        if (ts.isCallExpression(n) && RACES.has(fullCallee(n)) && n.arguments.some((a) => reachesQueue(a, local, bound))) offenders.push(lineOf(p, n));
      });
    }
    expect(offenders, `A timer raced against a send into a session queue answers "timed out" while the row still lands.
Use sendWithin (src/lib/send-deadline.ts) and pass its gate as the send's stillWanted.`).toEqual([]);
  });

  /** Each place that sets a deadline, with the retry that makes a timeout safe for it. */
  const DEADLINES: Record<string, string> = {
    'src/web/routes/messages-v1.ts': 'deadline: true; its client is told "retry" (a task_send op, a script)',
    'src/core/sessions/session-send-core.ts': 'deliverToSession runs sendWithin only for a caller that set deadline, and performPlainSendOnce forwards its caller\'s',
    'src/core/human-inbox/letter-ops.ts': 'a timed-out answer is recorded failed, and a repeat of a failed turn delivers it again (humanReplyAndDeliver)',
    'src/core/cron/trigger-apply.ts': 'a timed-out fire is a retryable error, replayed under the same fire id',
  };

  it('a deadline only where its caller sends again on a timeout', () => {
    const sites: string[] = [];
    for (const p of parsed()) {
      if (p.file === 'src/lib/send-deadline.ts') continue;
      walk(p.source, (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === 'sendWithin') sites.push(p.file);
        if (ts.isPropertyAssignment(n) && n.name.getText(p.source) === 'deadline') {
          const v = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer;
          if (v.kind === ts.SyntaxKind.TrueKeyword) sites.push(p.file);
        }
      });
    }
    const unlisted = [...new Set(sites)].filter((f) => !(f in DEADLINES));
    expect(unlisted, `A send deadline in a file whose caller may not send again: a notice nobody resends is lost when it
passes. Give the send no deadline, or add the file to DEADLINES with the retry that makes a timeout safe.`).toEqual([]);
    expect(Object.keys(DEADLINES).filter((f) => !sites.includes(f)), 'a DEADLINES entry with no deadline left in it').toEqual([]);
  });

  it('no reader takes a send\'s timeout for one that may still arrive', () => {
    // A timeout stored nothing: a letter delivery's reason 'timeout' and a send's code 'delivery_failed'
    // are failures to run again. Only `pending` and 'delivery_unconfirmed' are unsure.
    const misread: string[] = [];
    for (const p of parsed()) {
      walk(p.source, (n) => {
        if (!ts.isBinaryExpression(n) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(n.operatorToken.kind)) return;
        const sides = [n.left, n.right].map((x) => x.getText(p.source));
        if (sides.some((t) => /delivery\??\.reason$/.test(t)) && sides.some((t) => t === "'timeout'")) misread.push(lineOf(p, n));
      });
    }
    expect(misread, 'a letter delivery that timed out stored nothing: read it as failed').toEqual([]);
  });

  it('every sendWithin send passes its gate to the store, never negated', () => {
    const blind: string[] = [];
    for (const p of parsed()) {
      if (p.file === 'src/lib/send-deadline.ts') continue;
      walk(p.source, (n) => {
        if (!ts.isCallExpression(n) || calleeName(n) !== 'sendWithin') return;
        const run = n.arguments[1];
        if (!run || !(ts.isArrowFunction(run) || ts.isFunctionExpression(run)) || run.parameters.length === 0 || !ts.isIdentifier(run.parameters[0].name)) {
          blind.push(`${lineOf(p, n)} (its send takes no gate)`);
          return;
        }
        const gate = run.parameters[0].name.text;
        let passed = false;
        walk(run.body, (m) => {
          if (!ts.isPropertyAccessExpression(m) || !ts.isIdentifier(m.expression) || m.expression.text !== gate || m.name.text !== 'inTime') return;
          // Handed on as the store's stillWanted (or to a helper that composes it): `stillWanted: g.inTime`, `inTime: g.inTime`.
          const parent = m.parent;
          if (ts.isPropertyAssignment(parent) && parent.initializer === m && ['stillWanted', 'inTime'].includes(parent.name.getText(p.source))) passed = true;
          else blind.push(`${lineOf(p, m)} (${gate}.inTime is used other than as the store's stillWanted)`);
        });
        if (!passed) blind.push(`${lineOf(p, n)} (its gate never reaches the store's stillWanted)`);
      });
      // A helper that composes the gate (deliverToSession's send): the gate is the last operand of an && chain, never negated.
      walk(p.source, (m) => {
        if (!ts.isCallExpression(m) || !ts.isPropertyAccessExpression(m.expression) || m.expression.name.text !== 'inTime') return;
        let up: ts.Node = m;
        while (ts.isBinaryExpression(up.parent) && up.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && up.parent.right === up) up = up.parent;
        if (ts.isParenthesizedExpression(up.parent)) up = up.parent;
        const arrow = up.parent;
        const prop = arrow?.parent;
        const ok = arrow && ts.isArrowFunction(arrow) && arrow.body === up && prop && ts.isConditionalExpression(prop) ? ts.isPropertyAssignment(prop.parent) && prop.parent.name.getText(p.source) === 'stillWanted'
          : arrow && ts.isArrowFunction(arrow) && arrow.body === up && prop && ts.isPropertyAssignment(prop) && prop.name.getText(p.source) === 'stillWanted';
        if (!ok) blind.push(`${lineOf(p, m)} (an inTime() call that is not the last check of a stillWanted)`);
      });
    }
    expect(blind, 'a sendWithin send must pass its gate (inTime) into the store\'s stillWanted, as its last check').toEqual([]);
  });
});
