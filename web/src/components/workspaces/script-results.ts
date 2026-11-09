/**
 * The last result of each script a session's Scripts menu ran in its terminal,
 * read from the line every run ends with (src/core/workspaces/script-line.ts):
 * `ESC ] 1337 ; walnut-run=<id> BEL` then `[<name> exited with <code>]`. Kept
 * per session in this browser's localStorage, so a reload or a reopened app
 * keeps them (two weeks, then they are dropped): the
 * terminal's scrollback is the record, this only lets the menu say how the last
 * run of each script went.
 *
 * Matched by the run's id, never by the name: a terminal that attaches again
 * replays its earlier output, whose end lines belong to earlier runs. The echo
 * of the typed line holds the sequence as text (`\033]1337;...`), not as an
 * escape, so it never matches either.
 */
import { useSyncExternalStore } from 'react';

export interface ScriptResult {
  /** queued: waiting for the terminal to open; notrun: it never typed it (closed first). */
  state: 'queued' | 'running' | 'passed' | 'failed' | 'stopped' | 'notrun';
  code?: number;
  at: number;
  /** The run this result belongs to (its end line names it). */
  runId: string;
  /** The command that ran: a script of that name with another command (one that replaced it) does not show it. */
  command?: string;
  /** The terminal attachment that is known to run it now (noteTerminalAttached), so a lost end line never blocks. */
  live?: number;
}

type Results = ReadonlyMap<string, ScriptResult>;

const EMPTY: Results = new Map();
const bySession = new Map<string, Results>();
/** The end of the output seen so far, so an end line split over two chunks is still read. */
const tails = new Map<string, string>();
const listeners = new Set<() => void>();

// eslint-disable-next-line no-control-regex
const END = /\x1b\]1337;walnut-run=([A-Za-z0-9-]{1,40})\x07(?:\x1b\[[0-9;]*m)?\[([^\n]*?) exited with (\d{1,3})\]/g;
// eslint-disable-next-line no-control-regex
const START = /\x1b\]1337;walnut-run-start=([A-Za-z0-9-]{1,40})\x07/g;
const TAIL_KEEP = 400;

function emit(): void {
  for (const l of listeners) l();
}

const STORE_PREFIX = 'walnut.scriptResults.';
const STALE_RUNNING_MS = 60 * 60_000;
const KEEP_MS = 14 * 24 * 60 * 60_000;

function store(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function keysOf(s: Storage): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) out.push(k); }
  return out;
}

/** Sessions whose newest result is two weeks old are forgotten (once per page load). */
let pruned = false;
function pruneOld(s: Storage): void {
  if (pruned) return;
  pruned = true;
  try {
    for (const k of keysOf(s)) {
      if (!k.startsWith(STORE_PREFIX)) continue;
      const rows = JSON.parse(s.getItem(k) ?? '[]') as Array<[string, ScriptResult]>;
      const newest = Array.isArray(rows) ? Math.max(0, ...rows.map((r) => Number(r?.[1]?.at) || 0)) : 0;
      if (Date.now() - newest > KEEP_MS) s.removeItem(k);
    }
  } catch { /* unreadable: leave it */ }
}

/** The session's rows as storage holds them now (another tab may have written them). */
function readRaw(sessionId: string): Array<[string, ScriptResult]> {
  try {
    const s = store();
    if (s) pruneOld(s);
    const raw = s ? s.getItem(STORE_PREFIX + sessionId) : null;
    const rows = raw ? JSON.parse(raw) as Array<[string, ScriptResult]> : [];
    // A run still "running" an hour on lost its end line (the terminal closed first): say nothing of it.
    const fresh = (r: ScriptResult) => r.state !== 'running' || Date.now() - r.at < STALE_RUNNING_MS;
    return Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && !!r[1]?.runId && fresh(r[1])) : [];
  } catch { return []; }
}

function stored(sessionId: string): Results {
  const rows = readRaw(sessionId);
  if (!rows.length) return EMPTY;
  // Still waiting for its terminal when the page that asked for it closed: it never ran.
  return new Map(rows.map(([name, r]) => [name, r.state === 'queued' ? { ...r, state: 'notrun' as const } : r]));
}

function persist(sessionId: string, results: Results): void {
  try {
    const s = store();
    if (!s) return;
    if (results.size) s.setItem(STORE_PREFIX + sessionId, JSON.stringify([...results]));
    else s.removeItem(STORE_PREFIX + sessionId);
  } catch { /* storage full or off: this page still has them */ }
}

function current(sessionId: string): Results {
  let r = bySession.get(sessionId);
  if (!r) { r = stored(sessionId); bySession.set(sessionId, r); }
  return r;
}

function update(sessionId: string, change: (next: Map<string, ScriptResult>) => boolean): void {
  const next = new Map(current(sessionId));
  // Another tab's newer result of a script is kept, never written over with this page's older one.
  for (const [name, r] of readRaw(sessionId)) {
    const mine = next.get(name);
    if (!mine || (mine.runId !== r.runId && r.at > mine.at)) next.set(name, r);
  }
  if (!change(next)) return;
  bySession.set(sessionId, next);
  persist(sessionId, next);
  emit();
}

// Another tab wrote a session's results: read them again.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (e) => {
      if (!e.key?.startsWith(STORE_PREFIX)) return;
      bySession.delete(e.key.slice(STORE_PREFIX.length));
      emit();
    });
  } catch { /* no window events */ }
}

/** Each terminal attachment of a session: a new one replays what the shell printed, but a pty that was let go starts empty. */
let attachSeq = Date.now();
const attachOf = new Map<string, number>();

const attachedAt = new Map<string, number>();
/** How long after an attach its replay may still be on its way. */
export const REPLAY_GRACE_MS = 2_500;

/** A terminal of the session attached (its replay follows). */
export function noteTerminalAttached(sessionId: string, now = Date.now()): number {
  const gen = ++attachSeq;
  attachOf.set(sessionId, gen);
  attachedAt.set(sessionId, now);
  tails.delete(sessionId);
  return gen;
}

/** That terminal went away (unmounted): the shell may go on, but nothing here sees its end line now. */
export function noteTerminalDetached(sessionId: string, gen: number): void {
  if (attachOf.get(sessionId) === gen) attachOf.delete(sessionId);
}

/**
 * The run that runs in the session's attached terminal now, if any: typed in this
 * attachment, or its start seen in its replay, and no end line since. A run whose
 * end line was lost (the terminal was closed long enough for its shell to be let
 * go) is not one: nothing is stopped or held for it.
 */
export function busyRun(sessionId: string): [string, ScriptResult] | undefined {
  const gen = attachOf.get(sessionId);
  if (gen === undefined) return undefined;
  return [...current(sessionId)].find(([, r]) => r.state === 'running' && r.live === gen);
}

/**
 * busyRun, once the attached terminal's replay had time to come: a terminal opened a
 * moment ago has not shown yet that a run typed before still goes on in its shell.
 * Waits only then, and only while such a run (running, not this attachment's) exists.
 */
export function settledBusyRun(sessionId: string, graceMs = REPLAY_GRACE_MS): Promise<[string, ScriptResult] | undefined> {
  const now = busyRun(sessionId);
  const since = attachedAt.get(sessionId);
  const gen = attachOf.get(sessionId);
  const left = since === undefined || gen === undefined ? 0 : since + graceMs - Date.now();
  const maybe = () => [...current(sessionId).values()].some((r) => r.state === 'running' && r.live !== attachOf.get(sessionId));
  if (now || left <= 0 || !maybe()) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { listeners.delete(check); clearTimeout(timer); resolve(busyRun(sessionId)); };
    const check = () => { if (busyRun(sessionId) || !maybe()) done(); };
    const timer = setTimeout(done, left);
    listeners.add(check);
  });
}

export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function noteScriptStarted(sessionId: string, name: string, runId: string, now = Date.now()): void {
  update(sessionId, (next) => { next.set(name, { state: 'running', at: now, runId }); return true; });
}

/** The menu asked for this run; it runs once the terminal types it (noteScriptTyped). */
export function noteScriptQueued(sessionId: string, name: string, runId: string, now = Date.now(), command?: string): void {
  update(sessionId, (next) => { next.set(name, { state: 'queued', at: now, runId, ...(command ? { command } : {}) }); return true; });
}

function moveRun(sessionId: string, runId: string, from: ScriptResult['state'], to: ScriptResult['state'], now: number): void {
  update(sessionId, (next) => {
    let changed = false;
    for (const [name, r] of next) if (r.runId === runId && r.state === from) { next.set(name, { ...r, state: to, at: now }); changed = true; }
    return changed;
  });
}

/** The terminal typed the run's line. */
export function noteScriptTyped(sessionId: string, runId: string, now = Date.now()): void {
  const live = attachOf.get(sessionId);
  update(sessionId, (next) => {
    let changed = false;
    for (const [name, r] of next) if (r.runId === runId && r.state === 'queued') { next.set(name, { ...r, state: 'running', at: now, ...(live !== undefined ? { live } : {}) }); changed = true; }
    return changed;
  });
}

/** The run's line was never typed (the terminal closed or never opened, another run took its place). */
export function noteScriptDropped(sessionId: string, runId: string, now = Date.now()): void {
  moveRun(sessionId, runId, 'queued', 'notrun', now);
}

/** Feed terminal output: a run's end line records its result. */
export function noteTerminalOutput(sessionId: string, data: string, now = Date.now()): void {
  const known = current(sessionId);
  // Nothing running and no end line in it: nothing to read (most output).
  if (![...known.values()].some((r) => r.state === 'running') && !data.includes('\x1b]1337;walnut-run=') && !tails.get(sessionId)) return;
  const text = (tails.get(sessionId) ?? '') + data;
  let last = 0;
  const ends: Array<[string, string, number]> = [];
  for (const m of text.matchAll(END)) {
    ends.push([m[1], m[2], Number(m[3])]);
    last = (m.index ?? 0) + m[0].length;
  }
  tails.set(sessionId, text.slice(Math.max(last, text.length - TAIL_KEEP)));
  // A run whose start this attachment shows (its replay) runs in this terminal.
  const gen = attachOf.get(sessionId);
  const started = gen === undefined ? [] : [...text.matchAll(START)].map((m) => m[1]);
  if (started.length && [...known.values()].some((r) => r.state === 'running' && started.includes(r.runId) && r.live !== gen)) {
    update(sessionId, (next) => {
      let changed = false;
      for (const [name, r] of next) if (r.state === 'running' && started.includes(r.runId) && r.live !== gen) { next.set(name, { ...r, live: gen }); changed = true; }
      return changed;
    });
  }
  if (!ends.length) return;
  const stateOf = (code: number): ScriptResult['state'] => (code === 0 ? 'passed' : code === 130 ? 'stopped' : 'failed');
  update(sessionId, (next) => {
    let changed = false;
    for (const [runId, endName, code] of ends) {
      let mine = false;
      for (const [name, r] of next) {
        if (r.runId !== runId) continue;
        mine = true;
        if (r.state !== 'running') continue;
        next.set(name, { runId, code, at: now, state: stateOf(code), ...(r.command ? { command: r.command } : {}) });
        changed = true;
      }
      // A run this browser never saw (another browser, a cleared storage), read from the replayed
      // scrollback: it says how a script without any result here last ended.
      if (!mine && endName && !next.has(endName)) {
        next.set(endName, { runId, code, at: now, state: stateOf(code) });
        changed = true;
      }
    }
    return changed;
  });
}

/** The terminal's shell ended: a run still marked running will print no end line now. */
export function noteTerminalGone(sessionId: string): void {
  tails.delete(sessionId);
  update(sessionId, (next) => {
    let changed = false;
    for (const [name, r] of next) if (r.state === 'running') { next.delete(name); changed = true; }
    return changed;
  });
}

/** Resolves true once this run is no longer running (its end line came, or its terminal went), false after `ms`. */
export function waitForScriptEnd(sessionId: string, runId: string, ms: number): Promise<boolean> {
  const ended = () => ![...current(sessionId).values()].some((r) => r.runId === runId && r.state === 'running');
  if (ended()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => { listeners.delete(check); clearTimeout(timer); resolve(v); };
    const check = () => { if (ended()) done(true); };
    const timer = setTimeout(() => done(false), ms);
    listeners.add(check);
  });
}

export function scriptResultsOf(sessionId: string): Results {
  return current(sessionId);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useScriptResults(sessionId: string): Results {
  return useSyncExternalStore(subscribe, () => scriptResultsOf(sessionId));
}

/** "Running…", "Passed", "Stopped", "Failed (exit 1)", "Not run". */
export function scriptResultText(r: ScriptResult): string {
  switch (r.state) {
    case 'queued': return 'Waiting for the terminal…';
    case 'notrun': return 'Not run';
    case 'running': return 'Running…';
    case 'passed': return 'Passed';
    case 'stopped': return 'Stopped';
    case 'failed': return `Failed (exit ${r.code})`;
  }
}

/** Tests only. */
export function __resetScriptResults(): void {
  try { const s = store(); if (s) for (const k of keysOf(s)) if (k.startsWith(STORE_PREFIX)) s.removeItem(k); } catch { /* none */ }
  pruned = false;
  attachOf.clear();
  attachedAt.clear();
  bySession.clear();
  tails.clear();
}

/** Tests only: forget what this page holds, as a reload does (the browser's storage stays). */
export function __reloadScriptResults(): void {
  bySession.clear();
  tails.clear();
  attachOf.clear();
}
