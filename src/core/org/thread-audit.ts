/**
 * The thread check (experiment threads_audit, 2026-11-25, the user: "by default it should rely on
 * the agent. But we have an extra agent that scans once, maybe Haiku, periodically"). Every
 * AUDIT_EVERY_MS each node that keeps Threads and has open ones is read once, one node at a time:
 * the rules of thread-audit-rules.ts find stale, thin and unasked cards and pick candidate pairs,
 * and ONE fast-model call per node says which pairs are one subject. It only reports: the node
 * hears what is new in one note, each finding with the call that fixes it, and fixes it itself.
 * A repeat or an unasked decision changes what he sees, so that note wakes the node (into its
 * session under the source `thread-audit`, as the re-check sends: a wait it interrupts comes back);
 * stale and thin ones ride its next message (status-riding.ts), carried into the next such note
 * while unread. What it found,
 * told and saw fixed is counted per day (thread-audit-store.ts): the measure of the other parts.
 *
 * Leader only, never on an ephemeral server, with the switch read at every pass (off stops it with
 * no restart), skipped while background AI is off (backgroundAiDisabled) and while the org is off.
 * No model (none set up, a timeout, a test run): the rule findings still go. The model reads only
 * titles, asks and one summary sentence of the node's own tree; the log line holds counts only.
 */
import crypto from 'node:crypto';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { experimentalEnabled } from '../experimental.js';
import { homeWritesStopped } from '../../lib/leader-clocks.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import {
  AUDIT_JUDGE_SYSTEM, MAX_PAIRS, PASS_CALLS, auditNote, judgeInput, pairSig, pickToTell, readJudgement, repeatCandidates, repeatFinding,
  ruleFindings, wakesNode, type AuditFinding, type PairVerdict, type RepeatCandidate,
} from './thread-audit-rules.js';
import { emptyNode, readAudit, recordPass, settleTold, updateAudit, zeroKinds, type KindCounts, type NodeAudit } from './thread-audit-store.js';

/** The send source of the note (org-enabled.ts ORG_OFF_BLOCKED_SOURCES, task-wait-resume.ts). */
export const THREAD_AUDIT_SOURCE = 'thread-audit';
const RIDE_KEY = 'thread-audit';
const HOUR = 3_600_000;
/** How often one node is checked, how often the clock looks, and how many nodes one look checks. */
export const AUDIT_EVERY_MS = 6 * HOUR;
const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
const NODES_PER_TICK = 12;
/** The judge's budget on a direct call (a CLI or a local model gets more: fastCallBudgetMs). */
const JUDGE_DIRECT_MS = 30_000;

/** Test seam: a vitest run never reaches a real model (the call fails, the rule findings still go). */
let override: ((input: string) => Promise<string>) | null = null;
export function setAuditJudgeOverride(fn: ((input: string) => Promise<string>) | null): void { override = fn; }

export async function threadAuditOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    return experimentalEnabled((await getConfig()).experimental, 'threads_audit');
  } catch {
    return false;
  }
}

export interface AuditResult {
  taskId: string;
  ran: boolean;
  why?: 'off' | 'org_off' | 'follower' | 'no_task' | 'no_threads' | 'busy' | 'failed';
  found: KindCounts;
  told: AuditFinding[];
  fixed: KindCounts;
  /** woke: the note started a turn; rode: it waits for the node's next message; failed: nothing told (tried next pass). */
  delivery: 'woke' | 'rode' | 'none' | 'failed';
  pairs: number;
  calls: number;
  callMs: number;
}

const idle = (taskId: string, why: AuditResult['why']): AuditResult =>
  ({ taskId, ran: false, why, found: zeroKinds(), told: [], fixed: zeroKinds(), delivery: 'none', pairs: 0, calls: 0, callMs: 0 });
const sigOf = (c: RepeatCandidate): string => crypto.createHash('sha1').update(pairSig(c)).digest('hex').slice(0, 16);

/**
 * The model's verdicts on `pairs` (null each where it gave none, all null with no answer), and
 * whether a call was made and how long it took. No call while background AI is off, unless a test set the seam.
 */
async function judgePairs(pairs: readonly RepeatCandidate[], taskId: string): Promise<{ verdicts: Array<{ verdict: PairVerdict; reason: string } | null> | null; called: boolean; ms: number }> {
  if (!override) {
    const [{ ambientTestRun }, { backgroundAiDisabled }] = await Promise.all([import('../test-run.js'), import('../cheap-model.js')]);
    if (ambientTestRun() || backgroundAiDisabled()) return { verdicts: null, called: false, ms: 0 };
  }
  const marker = `<<${crypto.randomBytes(8).toString('hex')}>>`;
  const input = judgeInput(pairs, marker);
  const started = Date.now();
  try {
    const text = override ? await override(input) : (await (await import('../fast-model-call.js')).callFastModel({
      system: AUDIT_JUDGE_SYSTEM, input, source: THREAD_AUDIT_SOURCE, taskId, directMs: JUDGE_DIRECT_MS, maxTokens: 2048,
    })).text;
    return { verdicts: readJudgement(text, pairs.length), called: true, ms: Date.now() - started };
  } catch (err) {
    log.task.debug('thread audit: no answer from the judge, the rule findings still go', { taskId, error: err instanceof Error ? err.message : String(err) });
    return { verdicts: null, called: true, ms: Date.now() - started };
  }
}

/** The waking note as it goes in: a notification (wake-policy.ts NOTICE_WAKES 'threads-audit'), not a trigger. */
export function auditMessage(note: string, n: number): string {
  return buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut: thread check', outcome: 'threads-audit', note: `${n} thing(s) to fix on your threads, no reply needed` }, body: note });
}

/** Tells the node: a note that wakes it, or a line on its next message (`sid`: the session it rides). */
async function tell(task: Task, findings: readonly AuditFinding[]): Promise<{ delivery: AuditResult['delivery']; sid?: string }> {
  const { threadsKeptNow } = await import('./threads-kept.js');
  const wakes = wakesNode(findings);
  const note = auditNote(findings, threadsKeptNow(), !wakes);
  try {
    if (wakes) {
      const { getTask } = await import('../task-manager.js');
      // Read again: a task finished since the pass began is never reopened by a check.
      if ((await getTask(task.id).catch(() => null))?.phase === 'COMPLETE') return { delivery: 'none' };
      // Into the node's session under the check's own source, as the re-check sends (thread-recheck.ts):
      // a wait it interrupts comes back at the turn end (task-wait-resume.ts WORDS_ONLY_SOURCES), and
      // the org's off switch blocks it. A session the user stopped himself is not woken.
      const [{ getSessionsForTask }, { pickDeliverySession }, { personStopped }] = await Promise.all([
        import('../session-tracker.js'), import('../routines/session-target.js'), import('./thread-recheck.js'),
      ]);
      const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => [] as SessionRecord[]));
      if (!target || personStopped(target)) return { delivery: 'none' };
      const { sendMessageToSession } = await import('../session-message-queue.js');
      await sendMessageToSession(target.claudeSessionId, auditMessage(note, findings.length), { source: THREAD_AUDIT_SOURCE, taskId: task.id });
      return { delivery: 'woke' };
    }
    const { leadSession } = await import('./org-store.js');
    const s = await leadSession(task.id);
    if (!s) return { delivery: 'none' };
    const { rideLine } = await import('../sessions/status-riding.js');
    return rideLine(s.claudeSessionId, RIDE_KEY, note) ? { delivery: 'rode', sid: s.claudeSessionId } : { delivery: 'none' };
  } catch (err) {
    log.task.warn('thread audit: the note was not delivered', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return { delivery: 'failed' };
  }
}

/**
 * The findings of the node's last riding note still unread: its one slot (status-riding.ts) is
 * replaced by the next riding note, so those still found go again in it, never lost (review
 * 2026-11-25). Empty once the node's next message carried it.
 */
async function unreadRide(state: NodeAudit): Promise<Set<string>> {
  if (!state.ride?.keys.length) return new Set();
  const { ridingLine } = await import('../sessions/status-riding.js');
  return ridingLine(state.ride.sid, RIDE_KEY) !== undefined ? new Set(state.ride.keys) : new Set();
}

/**
 * The told repeats a pass can neither find nor call fixed: not judged this pass (past the cap, no
 * answer), or one card's task not read (its tree read failed, or it fell out of the tree): only a
 * card closed on the node, or both cards read open and no longer one subject, is fixed. Pure.
 */
export function standingRepeats(told: NodeAudit['told'], unjudged: ReadonlySet<string>, ownIds: ReadonlySet<string>, ownOpen: ReadonlySet<string>, treeOpen: ReadonlySet<string> | null): Set<string> {
  const out = new Set<string>();
  for (const [key, v] of Object.entries(told)) {
    if (v.kind !== 'repeat') continue;
    if (unjudged.has(key) || !treeOpen) { out.add(key); continue; }
    const ids = key.slice('repeat:'.length).split('+');
    const bothOpen = ids.every((id) => treeOpen.has(id));
    // The node's own card of the pair closed, merged away or gone from its file.
    const nodeSide = v.on ?? ids.filter((id) => ownIds.has(id));
    const ownGone = !nodeSide.length || nodeSide.some((id) => !ownOpen.has(id));
    if (!bothOpen && !ownGone) out.add(key);
  }
  return out;
}

const inFlight = new Set<string>();

/**
 * One pass for one node: its findings, what is new told in one note, its counts recorded. With the
 * switch off, on a follower, or while a pass of the same node runs, it does nothing. Never throws.
 */
export async function auditNode(taskId: string, opts: { now?: number; tasks?: readonly Task[] } = {}): Promise<AuditResult> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return idle(taskId, 'follower');
  if (!(await threadAuditOn())) return idle(taskId, 'off');
  // With the org off no node is told anything (its sends are blocked): no pass, no count.
  if (!(await (await import('./org-enabled.js')).isOrgEnabled())) return idle(taskId, 'org_off');
  if (inFlight.has(taskId)) return idle(taskId, 'busy');
  inFlight.add(taskId);
  try {
    const now = opts.now ?? Date.now();
    const all = opts.tasks ?? await (await import('../task-manager.js')).listTasks();
    const task = all.find((t) => t.id === taskId);
    const { keepsThreads } = await import('./keeps-threads.js');
    if (!task || !keepsThreads(task)) return idle(taskId, 'no_task');
    const { readThreads } = await import('./threads-store.js');
    const mine = (await readThreads(taskId)).threads;
    const own = mine.filter((t) => !t.closed && !t.movedTo);
    if (!own.length) return idle(taskId, 'no_threads');
    const { treeOpenThreads } = await import('./thread-same-subject.js');
    // A tree that could not be read finds no repeat and fixes none (standingRepeats).
    const tree = await treeOpenThreads(taskId, [...new Set(own.flatMap((t) => t.tasks ?? []))]).catch(() => null);
    const rules = ruleFindings(own, taskId, now);
    const candidates = tree ? repeatCandidates(taskId, tree, now) : [];
    const state: NodeAudit = (await readAudit()).nodes[taskId] ?? emptyNode();
    const judged = { ...state.judged };
    // A pair whose cards read as when it was judged keeps its verdict: no second call.
    const fresh = candidates.filter((c) => judged[c.key]?.sig !== sigOf(c));
    const at = new Date(now).toISOString();
    // One list of MAX_PAIRS at a time, at most PASS_CALLS of them; a list with no answer ends it, and what is left waits for the next pass.
    let calls = 0;
    let callMs = 0;
    let asked = 0;
    let read = 0;
    while (calls < PASS_CALLS && asked < fresh.length) {
      // Each further list asks first: a leader switch's stop or the switch turned off ends the pass where it is.
      if (asked > 0 && (homeWritesStopped() || !(await threadAuditOn()))) break;
      const ask = fresh.slice(asked, asked + MAX_PAIRS);
      const answer = await judgePairs(ask, taskId);
      asked += ask.length;
      callMs += answer.ms;
      if (answer.called) calls++;
      if (!answer.verdicts) break;
      read += ask.length;
      ask.forEach((c, i) => { const v = answer.verdicts?.[i]; if (v) judged[c.key] = { verdict: v.verdict, sig: sigOf(c), at, ...(v.reason ? { reason: v.reason } : {}) }; });
    }
    const repeats: AuditFinding[] = [];
    const unjudged = new Set<string>();
    for (const c of candidates) {
      const j = judged[c.key];
      if (j && j.sig === sigOf(c)) { if (j.verdict === 'same') repeats.push(repeatFinding(c, j.reason ?? '')); }
      else unjudged.add(c.key);
    }
    const treeOpen = tree ? new Set(tree.flatMap((b) => b.threads.filter((t) => !t.closed && !t.movedTo).map((t) => t.id))) : null;
    const standing = standingRepeats(state.told, unjudged, new Set(mine.map((t) => t.id)), new Set(own.map((t) => t.id)), treeOpen);
    const found = [...repeats, ...rules];
    let toldBefore = state.told;
    let toTell = pickToTell(found, toldBefore, now);
    // A riding note replaces the last one: what of that one is unread and still found goes in it again.
    const unread = toTell.length && !wakesNode(toTell) ? await unreadRide(state) : new Set<string>();
    if (unread.size) {
      const still = new Set(found.map((f) => f.key));
      toldBefore = Object.fromEntries(Object.entries(state.told).filter(([k]) => !(unread.has(k) && still.has(k))));
      toTell = pickToTell(found, toldBefore, now);
    }
    const sent = toTell.length ? await tell(task, toTell) : { delivery: 'none' as const };
    const delivery = sent.delivery;
    const told = delivery === 'woke' || delivery === 'rode' ? toTell : [];
    const settled = settleTold({ ...state, told: toldBefore, judged }, found, standing, told, now);
    if (delivery === 'rode' && sent.sid) settled.node.ride = { sid: sent.sid, keys: told.map((f) => f.key) };
    else if (state.ride && !(await unreadRide(state)).size) delete settled.node.ride;
    // Told again only because its note was unread: one finding, counted told once.
    const reported = told.filter((f) => !unread.has(f.key));
    await updateAudit((cur) => recordPass(cur, taskId, settled.node, { found, reported, fixed: settled.fixed, calls, callMs }, now));
    const result: AuditResult = { taskId, ran: true, found: countKinds(found), told, fixed: settled.fixed, delivery, pairs: candidates.length, calls, callMs };
    log.task.info('thread audit: pass', { taskId, found: result.found, told: told.length, fixed: settled.fixed, pairs: candidates.length, judged: read, calls, callMs, delivery });
    return result;
  } catch (err) {
    log.task.warn('thread audit: pass failed for a node', { taskId, error: err instanceof Error ? err.message : String(err) });
    return idle(taskId, 'failed');
  } finally {
    inFlight.delete(taskId);
  }
}

function countKinds(list: readonly AuditFinding[]): KindCounts {
  const out = zeroKinds();
  for (const f of list) out[f.kind]++;
  return out;
}

let running = false;
/** When the clock last tried each node, in this process: a node with no open thread, or a pass whose write failed, waits its 6 hours too. */
const triedAt = new Map<string, number>();

/** The nodes due a check now, the longest unchecked first: neither recorded nor tried within AUDIT_EVERY_MS. Pure. */
export function dueNodes(ids: readonly string[], last: Readonly<Record<string, Pick<NodeAudit, 'lastPassAt'>>>, tried: ReadonlyMap<string, number>, now: number): string[] {
  const seen = (id: string) => Math.max(Date.parse(last[id]?.lastPassAt ?? '') || 0, tried.get(id) ?? 0);
  return ids.filter((id) => now - seen(id) >= AUDIT_EVERY_MS).sort((a, b) => seen(a) - seen(b));
}

/** One look of the clock: each node due a check (oldest first, at most NODES_PER_TICK), one at a time. Returns the nodes checked. */
export async function runThreadAuditPass(now = Date.now()): Promise<string[]> {
  const done: string[] = [];
  if (running) return done;
  running = true;
  try {
    const [{ isFollower }, { backgroundAiDisabled }, { isOrgEnabled }] = await Promise.all([
      import('../server-role.js'), import('../cheap-model.js'), import('./org-enabled.js'),
    ]);
    if (isFollower() || backgroundAiDisabled() || !(await threadAuditOn()) || !(await isOrgEnabled())) return done;
    const { listTasks } = await import('../task-manager.js');
    const all = await listTasks();
    const { keepsThreads } = await import('./keeps-threads.js');
    const { teamOf } = await import('../sessions/team-stop.js');
    // A team the user stopped in one step (team-stop.ts) is not checked, as the re-check leaves it alone.
    const quieted = new Set(all.filter((t) => t.team_stop).flatMap((root) => teamOf(root, all).map((m) => m.id)));
    const last = (await readAudit()).nodes;
    const nodes = all.filter((t) => keepsThreads(t) && t.phase !== 'COMPLETE' && !t.plugin_only && !quieted.has(t.id)).map((t) => t.id);
    for (const id of dueNodes(nodes, last, triedAt, now)) {
      if (done.length >= NODES_PER_TICK) break;
      // A leader switch's stop: a pass in flight (up to PASS_CALLS model calls a node, each further one asking first) writes no more audit state or notes (lib/leader-clocks.ts).
      if (homeWritesStopped()) break;
      // Read at every node: turning it off stops the pass where it is.
      const r = await auditNode(id, { now, tasks: all });
      if (r.why === 'off' || r.why === 'org_off') break;
      // Tried: not again for AUDIT_EVERY_MS, even when it had no open thread or its counts were not written.
      if (r.why !== 'busy') triedAt.set(id, now);
      if (r.ran) done.push(id);
    }
  } catch (err) {
    log.task.warn('thread audit: the clock\'s pass failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
  return done;
}

/** The clock running now, by the handle that started it. */
let clock: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

function stopClock(): void {
  if (!clock) return;
  clearTimeout(clock.first);
  clearInterval(clock.every);
  clock = null;
}

/**
 * The clock, on the leader; nothing on an ephemeral server (its threads are a copy) or with
 * WALNUT_THREAD_AUDIT=0. A start replaces a clock left running (review 2026-11-25: one left by a
 * server stopped before its start ran made every later start a no-op), and a handle's stop stops
 * only its own clock.
 */
export function startThreadAudit(opts: { ephemeral?: boolean } = {}): { stop: () => void } {
  if (opts.ephemeral || process.env.WALNUT_THREAD_AUDIT === '0') return { stop: () => {} };
  stopClock();
  const tick = () => { void runThreadAuditPass(); };
  const mine = { first: setTimeout(tick, FIRST_TICK_MS), every: setInterval(tick, TICK_MS) };
  mine.first.unref?.();
  mine.every.unref?.();
  clock = mine;
  return { stop: () => { if (clock === mine) stopClock(); } };
}

/** Tests: whether a clock runs. */
export function threadAuditClockRuns(): boolean {
  return clock !== null;
}
