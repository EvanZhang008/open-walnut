/**
 * Lean event frames (src/web/ws/lean-frames.ts + web/src/api/ws-lean.ts, 2026-11-11).
 *
 * A lean socket is sent only what changed since it last heard it, and the client puts
 * the rest back. The one thing that must hold: what a listener reads after the client
 * rebuilds a frame is byte for byte what the whole frame said. A generated stream of
 * background ledgers and task changes (rows added, ended, reordered and dropped; fields
 * growing past the size limit, shrinking under it, vanishing, a workflow script coming
 * and going; rows with no id) is sent through both halves, over JSON as the socket does.
 *
 * The class guard: every event whose payload carries a whole task (event-types.ts) is
 * leaned or listed as exempt with why, so a new task event cannot ride whole by accident.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { leanShaper, newLeanState, wantsLean } from '../../src/web/ws/lean-frames.js';
import { LeanFrameCache } from '../../web/src/api/ws-lean.js';
import { LEAN_FIELD_MIN_BYTES, LEAN_MAX_TASKS, LEAN_SIGNATURE, LEAN_TASK_EVENTS, LEAN_TASK_EXEMPT } from '../../src/lib/ws-lean-protocol.js';

const ROOT = path.resolve(__dirname, '../..');

/** Send one event through the server shaper and the client cache, as the socket would. */
function pipe(state: ReturnType<typeof newLeanState>, cache: LeanFrameCache, name: string, data: unknown) {
  const shaper = leanShaper(name, data);
  const wire = JSON.stringify(shaper ? shaper(state) : data);
  return { wire, rebuilt: cache.rebuild(name, JSON.parse(wire)) };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('lean frames rebuild to the whole payload', () => {
  it('a generated stream of ledgers and task changes reads the same after the client rebuilds it', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const state = newLeanState();
      const cache = new LeanFrameCache();
      const ledgers = new Map<string, Array<Record<string, unknown>>>();
      const tasks = new Map<string, Record<string, unknown>>();
      let nextId = 0;
      for (let step = 0; step < 300; step++) {
        const pick = r();
        if (pick < 0.5) {
          const sid = `s${Math.floor(r() * 3)}`;
          const rows = ledgers.get(sid) ?? [];
          const op = r();
          if (op < 0.3 || rows.length === 0) rows.push({ taskId: `b${nextId++}`, status: 'running', description: 'x'.repeat(Math.floor(r() * 900)) });
          else if (op < 0.6) rows[Math.floor(r() * rows.length)].status = r() < 0.5 ? 'completed' : 'killed';
          else if (op < 0.7) rows.splice(Math.floor(r() * rows.length), 1);
          else if (op < 0.8) rows.reverse();
          else if (op < 0.85) rows.push({ status: 'running' }); // a row with no id: the frame rides whole
          else if (op < 0.9) { const i = rows.findIndex((x) => typeof x.taskId !== 'string'); if (i >= 0) rows.splice(i, 1); }
          ledgers.set(sid, rows);
          const withScript = r() < 0.3;
          const data: Record<string, unknown> = {
            sessionId: sid, taskId: 't1', workflowName: withScript ? 'wf' : undefined, inFlight: rows.length,
            foregroundActive: r() < 0.5, tasks: rows.map((x) => ({ ...x })), phases: [], agents: [],
            ...(withScript ? { scriptSource: r() < 0.5 ? 'script A '.repeat(80) : 'script B' } : {}),
          };
          const { rebuilt } = pipe(state, cache, 'session:background-tasks', data);
          expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(data));
        } else if (pick < 0.95) {
          const id = `t${Math.floor(r() * 6)}`;
          const t = tasks.get(id) ?? { id, title: `task ${id}`, phase: 'TODO' };
          const op = r();
          if (op < 0.25) t.note = 'n'.repeat(Math.floor(r() * 2000));
          else if (op < 0.4) t.agent_memory = r() < 0.2 ? undefined : 'm'.repeat(LEAN_FIELD_MIN_BYTES + Math.floor(r() * 10));
          else if (op < 0.5) delete t.note;
          else if (op < 0.6) t.user_status = { state: 'needs', asks: Array.from({ length: Math.floor(r() * 30) }, (_, i) => ({ i })) };
          else t.phase = r() < 0.5 ? 'IN_PROGRESS' : 'NEED_ACTION';
          tasks.set(id, t);
          const name = LEAN_TASK_EVENTS[Math.floor(r() * LEAN_TASK_EVENTS.length)];
          const data = name === 'task:phase-changed'
            ? { task: { ...t }, oldPhase: 'TODO', newPhase: t.phase, source: 'api' }
            : name === 'task:unblocked' ? { task: { ...t }, unblockedBy: { id: 'other', note: 'z'.repeat(800) } } : { task: { ...t } };
          const { rebuilt } = pipe(state, cache, name, data);
          expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(data));
        } else {
          const id = `t${Math.floor(r() * 6)}`;
          const t = tasks.get(id);
          if (!t) continue;
          tasks.delete(id);
          const data = { id, task: { ...t } };
          const { rebuilt } = pipe(state, cache, 'task:deleted', data);
          expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(data));
        }
      }
    }
  });

  it('an unchanged 206-row ledger and an unchanged note shrink to a few hundred bytes', () => {
    const state = newLeanState();
    const cache = new LeanFrameCache();
    const rows = Array.from({ length: 206 }, (_, i) => ({ taskId: `bg-${i}`, status: i < 194 ? 'completed' : 'running', description: `Running a long command number ${i} `.repeat(15) }));
    const ledger = () => ({ sessionId: 's', taskId: 't', inFlight: 12, foregroundActive: false, tasks: rows.map((x) => ({ ...x })), phases: [], agents: [] });
    const first = pipe(state, cache, 'session:background-tasks', ledger());
    rows[200].status = 'completed';
    const full = JSON.stringify(ledger());
    const second = pipe(state, cache, 'session:background-tasks', ledger());
    expect(JSON.stringify(second.rebuilt)).toBe(full);
    expect(first.wire.length).toBeGreaterThan(100_000);
    expect(second.wire.length).toBeLessThan(1_000);

    const task = { id: 'x', title: 'T', phase: 'TODO', note: 'n'.repeat(18_000), agent_memory: 'm'.repeat(12_000) };
    pipe(state, cache, 'task:updated', { task });
    const next = { task: { ...task, phase: 'IN_PROGRESS' } };
    const lean = pipe(state, cache, 'task:updated', next);
    expect(JSON.stringify(lean.rebuilt)).toBe(JSON.stringify(next));
    expect(lean.wire.length).toBeLessThan(300);
  });

  it('more tasks than the limit: both sides drop the same least recently sent one', () => {
    const state = newLeanState();
    const cache = new LeanFrameCache();
    const note = 'n'.repeat(2_000);
    for (let i = 0; i <= LEAN_MAX_TASKS + 20; i++) pipe(state, cache, 'task:updated', { task: { id: `t${i}`, note } });
    expect(state.task.size).toBe(LEAN_MAX_TASKS);
    expect(state.task.has('t0')).toBe(false);
    // t0 was dropped on both sides: its next frame rides whole and rebuilds.
    const again = { task: { id: 't0', note, phase: 'TODO' } };
    const out = pipe(state, cache, 'task:updated', again);
    expect(out.wire.length).toBeGreaterThan(2_000);
    expect(JSON.stringify(out.rebuilt)).toBe(JSON.stringify(again));
  });

  it('a listener that edits a payload never edits the next frame', () => {
    const state = newLeanState();
    const cache = new LeanFrameCache();
    const ledger = () => ({ sessionId: 's', tasks: [{ taskId: 'a', status: 'running', meta: { n: 1 } }] });
    const first = pipe(state, cache, 'session:background-tasks', ledger()).rebuilt as { tasks: Array<{ meta: { n: number } }> };
    first.tasks[0].meta.n = 99;
    const second = pipe(state, cache, 'session:background-tasks', ledger()).rebuilt;
    expect(JSON.stringify(second)).toBe(JSON.stringify(ledger()));
  });

  it('a frame the cache cannot rebuild asks for a resync instead of guessing', () => {
    const state = newLeanState();
    const sent = new LeanFrameCache();
    const task = { id: 'x', note: 'n'.repeat(2_000) };
    pipe(state, sent, 'task:updated', { task });
    const shaped = leanShaper('task:updated', { task: { ...task, phase: 'TODO' } })!(state);
    // A cache that never saw the first frame (a reconnect the server did not see).
    expect(new LeanFrameCache().rebuild('task:updated', JSON.parse(JSON.stringify(shaped)))).toBeNull();
    expect(new LeanFrameCache().rebuild('task:updated', { task, lean: { v: 99, kind: 'task', omit: [], keep: [] } })).toBeNull();
    // A lean block on an event this page does not lean (a newer server's rules).
    expect(new LeanFrameCache().rebuild('session:new-thing', { sessionId: 's', rows: null, lean: { v: 1 } })).toBeNull();
    // A ledger frame with no rows array rides whole on both sides.
    const s2 = newLeanState(); const c2 = new LeanFrameCache();
    pipe(s2, c2, 'session:background-tasks', { sessionId: 's', tasks: [{ taskId: 'a', status: 'x' }] });
    pipe(s2, c2, 'session:background-tasks', { sessionId: 's' });
    const after = { sessionId: 's', tasks: [{ taskId: 'a', status: 'x' }] };
    expect(JSON.stringify(pipe(s2, c2, 'session:background-tasks', after).rebuilt)).toBe(JSON.stringify(after));
  });

  it('only a socket that asks under exactly these rules gets lean frames, and the server switch turns them off', () => {
    expect(wantsLean(new URL(`http://h/ws?lean=${LEAN_SIGNATURE}`))).toBe(true);
    expect(wantsLean(new URL('http://h/ws'))).toBe(false);
    // A page built with another event list or version asks with another signature.
    expect(wantsLean(new URL('http://h/ws?lean=1'))).toBe(false);
    expect(wantsLean(new URL(`http://h/ws?lean=${LEAN_SIGNATURE}x`))).toBe(false);
    const prev = process.env.WALNUT_WS_LEAN;
    process.env.WALNUT_WS_LEAN = '0';
    try { expect(wantsLean(new URL(`http://h/ws?lean=${LEAN_SIGNATURE}`))).toBe(false); }
    finally { if (prev === undefined) delete process.env.WALNUT_WS_LEAN; else process.env.WALNUT_WS_LEAN = prev; }
  });
});

describe('every event that carries a whole task is leaned or exempt', () => {
  it('lists each such event from event-types.ts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/event-types.ts'), 'utf8');
    // interface name -> body
    const bodies = new Map<string, string>();
    for (const m of src.matchAll(/export interface (\w+)\s*\{([^]*?)\n?\}/g)) bodies.set(m[1], m[2]);
    const map = src.slice(src.indexOf('export interface EventPayloadMap'));
    const withTask: string[] = [];
    for (const m of map.matchAll(/'([\w:-]+)':\s*(\w+);/g)) {
      const body = bodies.get(m[2]);
      if (body && /\btask\??:\s*Task\b/.test(body)) withTask.push(m[1]);
    }
    expect(withTask.length).toBeGreaterThanOrEqual(5);
    const unlisted = withTask.filter((n) => !LEAN_TASK_EVENTS.includes(n) && !(n in LEAN_TASK_EXEMPT));
    expect(unlisted).toEqual([]);
  });
});
