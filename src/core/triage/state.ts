/**
 * The pending buffer a triage run reads — `~/.open-walnut/triage-state.json`.
 *
 * WHY A FILE AT ALL. Slack's per-conversation cursors live inside the plugin and
 * are not queryable from core, so the items on `plugin:slack:messages-received`
 * ARE the data. Lose them and nobody can ever get them back. So they accumulate
 * here.
 *
 * SLACK ONLY. Mail rows (`pending.mail`, `droppedMail`, a claim's `mail`) were
 * kept here until 2026-11-14, when every mailbox was bound to a mail router that
 * owns each new mail. A file an older build wrote may still hold them: they never
 * reach a batch. Their message ids are kept (`legacyMail`, ids only) through any
 * write until the mail plugin moves them to its router's pending queue at start
 * (takeTriageLegacyMail), so that mail is not lost at the deploy.
 *
 * MACHINE-LOCAL and gitignored, next to cron-state.json and routine-state/ and
 * for the same reason (the 2026-08-04 re-fire storm): this is RUNTIME state. An
 * LWW echo of another box's buffer would deliver that box's Slack lines here, or
 * un-deliver ours.
 *
 * AT-LEAST-ONCE, in three steps, because the run that consumes a batch is a
 * whole session started by a different layer:
 *
 *   claimTriageBatch()  — hand out the batch and REMEMBER what was handed out.
 *                         Nothing is deleted. A second claim while one is open
 *                         returns the SAME batch (a retried run re-delivers).
 *   ackTriageClaim()    — the run's session was asked to start, so the batch
 *                         reached a session: now drop exactly what was claimed.
 *                         A run that has to wait for a free slot first is BOUND to
 *                         the claim (`taskId`) and acknowledges it only when it
 *                         really starts (runs.ts); meanwhile no new batch is built.
 *   releaseTriageClaim()— the delivery failed: forget the claim, keep the items,
 *                         let the next run claim them again.
 *
 * That order is the same choice the Slack inbox documents ("SEND FIRST, then
 * move the cursors"): an item announced twice is an annoyance, an item lost is
 * the feature not working. The run is idempotent by construction anyway — it
 * re-reads real state through ops before it acts.
 *
 * The cap exists because this file is rewritten on every flush: 120 Slack rows
 * keep it a few tens of KB. Over the cap the OLDEST rows go and `droppedSlack`
 * says how many, so "22 new items" is never a lie.
 */

import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import { log } from '../../logging/index.js';

// ── Caps ──

/** Slack rows kept. ~6 busy ticks of 20, which is one 30-minute batch. */
export const PENDING_SLACK_CAP = 120;

/**
 * How long an unacknowledged claim stays open.
 *
 * A claim is released rather than honoured forever: the run that claimed it may
 * have died before its task was created (a crashed server, a refused executor),
 * and holding the batch for a run that will never arrive would stall triage
 * until the caps dropped the items. Generous on purpose — the acknowledgement
 * happens within seconds of the claim on a healthy box (the task is created by
 * the executor), so anything near this bound is a real failure.
 */
export const CLAIM_TTL_MS = 15 * 60_000;

// ── Shapes ──

/** One Slack message, as `plugin:slack:messages-received` reported it. */
export interface TriagePendingSlack {
  conversation: string;
  isDm: boolean;
  isMention: boolean;
  alias: string;
  ts: string;
  permalink: string;
  text: string;
  atMs: number;
}

export interface TriagePending {
  slack: TriagePendingSlack[];
  /** Rows the cap or the emitting plugin dropped. Keeps the counts honest. */
  droppedSlack: number;
}

/** What one run was handed. `atMs` is the claim's id AND the run's start. */
export interface TriageClaim {
  atMs: number;
  slack: number;
  droppedSlack: number;
  /**
   * The run task this batch waits in: a run filed while every host was full is
   * started later, and only its start acknowledges the batch. Keyed by task, so a
   * late start of an older run can never acknowledge a newer claim.
   */
  taskId?: string;
  /** When the claim was bound to `taskId`. */
  boundAtMs?: number;
}

export interface TriageState {
  version: 1;
  /** Runs whose batch was acknowledged. */
  runs: number;
  /** Start of the last ACKNOWLEDGED run — the `since` the next envelope carries. */
  lastRunAtMs?: number;
  /**
   * First-run floor for `since`. Recorded the first time the action runs, so the
   * first batch says "since the routine existed" instead of reading a whole
   * history from epoch 0, and so a later routine edit cannot move it.
   */
  sinceMs?: number;
  /** The previous run's journal line, carried into the next envelope. */
  lastJournalLine?: string;
  /**
   * The previous run did not rewrite State.md. Set by runs.ts (a WARN, never a
   * retry), consumed by the next envelope's first line, then cleared.
   */
  stateStale?: boolean;
  /** Open batch: handed out, not yet acknowledged. */
  claim?: TriageClaim;
  pending: TriagePending;
  /** Mail an older build buffered here, ids only, until the mail plugin takes it (takeTriageLegacyMail). */
  legacyMail?: TriageLegacyMail[];
}

/** One mail arrival an older build buffered in `pending.mail`: which mails, of which mailbox, buffered when. */
export interface TriageLegacyMail {
  accountId: string;
  messageIds: string[];
  atMs: number;
}

export function emptyTriagePending(): TriagePending {
  return { slack: [], droppedSlack: 0 };
}

export function emptyTriageState(): TriageState {
  return { version: 1, runs: 0, pending: emptyTriagePending() };
}

// ── Persistence ──

/**
 * Where the buffer lives.
 *
 * `home` is a PARAMETER, not just the constant, because one of the two callers is
 * an ACTION MODULE: src/actions/*.ts is compiled as its own tsup entry, so it
 * runs with its own bundled copy of every module it imports — including
 * constants. The registry hands every action `ctx.WALNUT_HOME` from the SERVER's
 * constants, and passing that through is what keeps the two halves pointed at one
 * file (and what lets a test redirect both).
 */
export function triageStatePath(home: string = WALNUT_HOME): string {
  return path.join(home, 'triage-state.json');
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readSlackRow(raw: unknown): TriagePendingSlack | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const conversation = str(r.conversation, 200);
  const ts = str(r.ts, 64);
  if (!conversation && !ts) return null;
  return {
    conversation,
    isDm: r.isDm === true,
    isMention: r.isMention === true,
    alias: str(r.alias, 200),
    ts,
    permalink: str(r.permalink, 400),
    text: str(r.text, 400),
    atMs: num(r.atMs),
  };
}

/** `pending.mail` rows as an older build wrote them, and `legacyMail` as this one keeps them, as ids only. */
function readLegacyMail(raw: unknown): TriageLegacyMail[] {
  if (!Array.isArray(raw)) return [];
  const out: TriageLegacyMail[] = [];
  for (const one of raw) {
    if (!one || typeof one !== 'object') continue;
    const r = one as Record<string, unknown>;
    const accountId = str(r.accountId, 200);
    const ids = Array.isArray(r.messageIds) ? r.messageIds
      : Array.isArray(r.headlines) ? r.headlines.map((h) => (h && typeof h === 'object' ? (h as Record<string, unknown>).messageId : undefined))
        : [];
    const messageIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 1_000))];
    if (accountId && messageIds.length) out.push({ accountId, messageIds, atMs: num(r.atMs) });
  }
  return out;
}

/**
 * Read the buffer, degrading to empty on anything unreadable.
 *
 * Every field is re-validated rather than trusted: this file is rewritten on a
 * timer while a run may be reading it, and a half-written or hand-edited row
 * must cost one tick's items, never the run.
 *
 * Mail rows an older build buffered (`pending.mail`) never join the buffer: the
 * mail router owns mail since 2026-11-14. Their ids are kept as `legacyMail` (the
 * next write moves them there, without the subjects and senders) until the mail
 * plugin takes them; `droppedMail` is only a count, and is dropped.
 */
export async function loadTriageState(home?: string): Promise<TriageState> {
  const file = triageStatePath(home);
  try {
    const raw = await readJsonFile<Partial<TriageState> | null>(file, null);
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return emptyTriageState();
    const pendingRaw = (raw.pending ?? {}) as Partial<TriagePending>;
    const pending: TriagePending = {
      slack: Array.isArray(pendingRaw.slack)
        ? pendingRaw.slack.map(readSlackRow).filter((r): r is TriagePendingSlack => r !== null)
        : [],
      droppedSlack: Math.max(0, Math.floor(num(pendingRaw.droppedSlack))),
    };
    const legacyMail = [
      ...readLegacyMail((raw as { legacyMail?: unknown }).legacyMail),
      ...readLegacyMail((pendingRaw as { mail?: unknown }).mail),
    ];
    const claimRaw = raw.claim as Partial<TriageClaim> | undefined;
    const claim: TriageClaim | undefined = claimRaw && num(claimRaw.atMs) > 0
      ? {
        atMs: num(claimRaw.atMs),
        slack: Math.max(0, Math.floor(num(claimRaw.slack))),
        droppedSlack: Math.max(0, Math.floor(num(claimRaw.droppedSlack))),
        ...(typeof claimRaw.taskId === 'string' && claimRaw.taskId ? { taskId: claimRaw.taskId.slice(0, 200) } : {}),
        ...(num(claimRaw.boundAtMs) > 0 ? { boundAtMs: num(claimRaw.boundAtMs) } : {}),
      }
      : undefined;
    return {
      version: 1,
      runs: Math.max(0, Math.floor(num(raw.runs))),
      ...(num(raw.lastRunAtMs) > 0 ? { lastRunAtMs: num(raw.lastRunAtMs) } : {}),
      ...(num(raw.sinceMs) > 0 ? { sinceMs: num(raw.sinceMs) } : {}),
      ...(typeof raw.lastJournalLine === 'string' && raw.lastJournalLine
        ? { lastJournalLine: raw.lastJournalLine.slice(0, 1_000) }
        : {}),
      ...(raw.stateStale === true ? { stateStale: true as const } : {}),
      ...(claim ? { claim } : {}),
      pending,
      ...(legacyMail.length ? { legacyMail } : {}),
    };
  } catch (err) {
    log.cron.warn('triage: state file unreadable — starting from an empty buffer', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyTriageState();
  }
}

/**
 * Locked read-modify-write on the buffer.
 *
 * The lock is the SAME cross-process lock every other Walnut store takes, which
 * matters here because the two writers are independent: the collector's trailing
 * flush and the batch action's claim can land in the same millisecond, and a
 * blind write from either would erase the other's.
 */
export async function updateTriageState(
  mutate: (state: TriageState) => void | Promise<void>,
  home?: string,
): Promise<TriageState> {
  const file = triageStatePath(home);
  return await withFileLock(file, async () => {
    const state = await loadTriageState(home);
    await mutate(state);
    await writeJsonFile(file, state);
    return state;
  });
}

/**
 * Hands the mail an older build buffered here to `adopt` (the mail plugin's pending queue), then
 * removes it from the file, under the file's lock: a failed `adopt` keeps it for the next try, and a
 * crash in between hands it over again (the queue keeps one entry per mail). Answers how many mails
 * moved; a file with none is not written.
 */
export async function takeTriageLegacyMail(
  adopt: (rows: readonly TriageLegacyMail[]) => Promise<void>,
  home?: string,
): Promise<number> {
  if (!(await loadTriageState(home)).legacyMail?.length) return 0;
  let moved = 0;
  await updateTriageState(async (state) => {
    const rows = state.legacyMail ?? [];
    if (!rows.length) return;
    await adopt(rows);
    moved = rows.reduce((n, row) => n + row.messageIds.length, 0);
    delete state.legacyMail;
  }, home);
  if (moved) log.cron.info('triage: mail an older build buffered went to the mail router', { mails: moved });
  return moved;
}

// ── Appending (pure halves, so the caps are gradable without a disk) ──

/**
 * Append rows and enforce the cap by dropping the OLDEST.
 *
 * Oldest-first because the newest items are the ones a human still cares about
 * and the ones a run can still act on; and because the claim (a prefix of this
 * list) is the oldest end, so a cap that bites during a run drops rows that were
 * already delivered before it touches rows that were not.
 */
export function appendCapped<T>(
  list: T[],
  rows: readonly T[],
  cap: number,
): { list: T[]; dropped: number } {
  const next = [...list, ...rows];
  if (next.length <= cap) return { list: next, dropped: 0 };
  const dropped = next.length - cap;
  return { list: next.slice(dropped), dropped };
}

/**
 * Persist a collector flush: Slack items in one locked write.
 *
 * When the cap bites while a claim is OPEN, the claim shrinks by however many of
 * ITS rows went. The claim is the oldest prefix and the cap drops the oldest
 * rows, so without this the acknowledgement would slice by a count that no
 * longer matches the rows and would eat items that arrived after the claim.
 */
export async function recordTriageArrivals(input: {
  slack?: readonly TriagePendingSlack[];
  droppedSlack?: number;
}, home?: string): Promise<TriageState> {
  return await updateTriageState((state) => {
    const p = state.pending;
    const extraDropped = Math.max(0, Math.floor(input.droppedSlack ?? 0));
    if (input.slack?.length || extraDropped) {
      const { list, dropped } = appendCapped(p.slack, input.slack ?? [], PENDING_SLACK_CAP);
      p.slack = list;
      p.droppedSlack += dropped + extraDropped;
      if (state.claim && dropped > 0) state.claim.slack = Math.max(0, state.claim.slack - dropped);
    }
  }, home);
}

// ── The three-step handover ──

export interface TriageClaimResult {
  claim: TriageClaim;
  /** The rows this run owns — the claimed PREFIX of the buffer. */
  slack: TriagePendingSlack[];
  /** True when an earlier run claimed this batch and never acknowledged it. */
  redelivered: boolean;
  /** Everything else the envelope needs, read under the same lock. */
  sinceMs: number;
  lastJournalLine?: string;
  stateStale: boolean;
  runs: number;
}

/**
 * Hand this run the batch it owns, WITHOUT deleting anything.
 *
 * Three cases, in order:
 *  - an open claim younger than CLAIM_TTL_MS → the same batch again (the run it
 *    was handed to never reached a session);
 *  - an open claim older than that → released, and a fresh claim covers
 *    everything now buffered (including the stale claim's rows, which were never
 *    delivered anywhere that mattered);
 *  - no claim → a fresh claim over the whole buffer.
 *
 * A claim still bound to a waiting run (`taskId`) never reaches here: the batch
 * action skips the fire while that run waits, and releases the claim first when it
 * no longer does. One that does anyway is replaced by a fresh claim with no
 * binding, so the old run's late start cannot acknowledge it.
 *
 * `sinceMs` is the floor for "what is new": the last acknowledged run's start,
 * or — on the very first run — `nowMs`, recorded so the first batch never asks a
 * session to read an inbox from the beginning of time.
 */
export async function claimTriageBatch(nowMs: number, home?: string): Promise<TriageClaimResult> {
  let out!: TriageClaimResult;
  await updateTriageState((state) => {
    const open = state.claim;
    const bound = !!open?.taskId;
    const live = !!open && !bound && nowMs - open.atMs < CLAIM_TTL_MS;
    if (open && !live && !bound) {
      log.cron.warn('triage: a previous batch was never acknowledged — re-claiming its items', {
        claimedAtMs: open.atMs, slack: open.slack, ageMs: nowMs - open.atMs,
      });
    }
    if (state.sinceMs === undefined) state.sinceMs = nowMs;
    const claim: TriageClaim = live && open
      ? open
      : {
        atMs: nowMs,
        slack: state.pending.slack.length,
        droppedSlack: state.pending.droppedSlack,
      };
    state.claim = claim;
    out = {
      claim,
      slack: state.pending.slack.slice(0, claim.slack),
      redelivered: live || bound,
      sinceMs: state.lastRunAtMs ?? state.sinceMs ?? nowMs,
      ...(state.lastJournalLine ? { lastJournalLine: state.lastJournalLine } : {}),
      stateStale: state.stateStale === true,
      runs: state.runs,
    };
  }, home);
  return out;
}

/** Drop exactly what the open claim covered. Runs under the state lock. */
function dropClaimed(s: TriageState): void {
  const claim = s.claim!;
  // min(): the caps may have dropped some of the claimed prefix while the run
  // was in flight. Those rows were already delivered, so dropping fewer here
  // is correct — slicing by the claimed COUNT against a shorter list would
  // eat rows that arrived after the claim.
  s.pending.slack = s.pending.slack.slice(Math.min(claim.slack, s.pending.slack.length));
  s.pending.droppedSlack = Math.max(0, s.pending.droppedSlack - claim.droppedSlack);
  s.claim = undefined;
  s.lastRunAtMs = claim.atMs;
  s.runs += 1;
  // The warning was carried into THIS run's envelope; it has been said.
  s.stateStale = undefined;
}

/**
 * The batch reached a session: drop exactly what was claimed.
 *
 * Idempotent and claim-keyed. A second acknowledgement (two `task:created`
 * events for one run, an old event replayed) finds no matching claim and does
 * nothing, so it can never eat the NEXT run's items.
 */
export async function ackTriageClaim(
  claimAtMs: number,
  home?: string,
): Promise<{ acked: boolean; state: TriageState }> {
  let acked = false;
  const state = await updateTriageState((s) => {
    if (!s.claim || s.claim.atMs !== claimAtMs) return;
    dropClaimed(s);
    acked = true;
  }, home);
  return { acked, state };
}

/**
 * The run task `taskId` started its session: acknowledge the claim it carries.
 *
 * Only a claim bound to this task, or (`bindIfUnbound`, a run started at once) one
 * nobody holds yet. A claim bound to another run is never touched, so a late start
 * of an older run cannot acknowledge the batch a newer run holds.
 */
export async function ackTriageClaimForTask(
  taskId: string,
  opts: { bindIfUnbound?: boolean } = {},
  home?: string,
): Promise<{ acked: boolean; claim?: TriageClaim }> {
  let acked: TriageClaim | undefined;
  await updateTriageState((s) => {
    const claim = s.claim;
    if (!claim) return;
    if (claim.taskId ? claim.taskId !== taskId : !opts.bindIfUnbound) return;
    acked = { ...claim };
    dropClaimed(s);
  }, home);
  return acked ? { acked: true, claim: acked } : { acked: false };
}

/**
 * A run was filed but waits to start (every host full): the open claim now waits
 * in it. Binds only a claim nobody holds; returns it, or undefined.
 */
export async function bindTriageClaim(taskId: string, nowMs: number, home?: string): Promise<TriageClaim | undefined> {
  let bound: TriageClaim | undefined;
  await updateTriageState((s) => {
    if (!s.claim || s.claim.taskId) return;
    s.claim.taskId = taskId;
    s.claim.boundAtMs = nowMs;
    bound = { ...s.claim };
  }, home);
  return bound;
}

/** How long a just-bound claim counts as held before its task shows the wait (the queue write follows the create). */
export const CLAIM_BIND_GRACE_MS = 2 * 60_000;

/** The task fields `triageRunHold` reads (no import of the whole Task type into the action bundle). */
export interface TriageRunTaskView {
  phase?: string;
  start_queue?: unknown;
  routine_start?: { state?: string } | null;
}

/**
 * What the run a claim is bound to did with it, read off the task:
 *  - `waiting`: it waits for a slot (`start_queue`), or its start was dispatched and is not
 *    confirmed yet (`routine_start` starting: a spawn that fails is retried with the same batch);
 *  - `delivered`: its session came up (`routine_start` started), the batch reached it;
 *  - `gone`: deleted, complete, cancelled or failed, so the batch never reached a session.
 * A claim bound a moment ago reads `waiting` until its task shows the wait (the queue write
 * follows the create).
 */
export function triageRunHold(
  task: TriageRunTaskView | null | undefined,
  claim: Pick<TriageClaim, 'boundAtMs'>,
  nowMs: number,
): 'waiting' | 'delivered' | 'gone' {
  if (!task) return 'gone';
  if (task.start_queue && task.phase !== 'COMPLETE') return 'waiting';
  const state = task.routine_start?.state;
  if (state === 'started') return 'delivered';
  if (task.phase === 'COMPLETE' || state === 'failed') return 'gone';
  if (state === 'starting') return 'waiting';
  return claim.boundAtMs && nowMs - claim.boundAtMs < CLAIM_BIND_GRACE_MS ? 'waiting' : 'gone';
}

/** The run `taskId` will not deliver its batch: forget the claim, keep the items. */
export async function releaseTriageClaimHeldBy(taskId: string, home?: string): Promise<boolean> {
  let released = false;
  await updateTriageState((s) => {
    if (!s.claim || s.claim.taskId !== taskId) return;
    s.claim = undefined;
    released = true;
  }, home);
  return released;
}

/**
 * The delivery failed: forget the claim and keep every item, so the next run
 * offers the same batch. Never advances `lastRunAtMs` — `since` must not move
 * past items nobody read.
 */
export async function releaseTriageClaim(claimAtMs: number, home?: string): Promise<boolean> {
  let released = false;
  await updateTriageState((s) => {
    if (!s.claim || s.claim.atMs !== claimAtMs) return;
    s.claim = undefined;
    released = true;
  }, home);
  return released;
}

/** Record the line runs.ts wrote to the journal, for the next envelope. */
export async function recordTriageJournalLine(line: string, home?: string): Promise<void> {
  await updateTriageState((s) => { s.lastJournalLine = line.slice(0, 1_000); }, home);
}

/** Remember that a run did not rewrite State.md (the next envelope says so). */
export async function markTriageStateStale(home?: string): Promise<void> {
  await updateTriageState((s) => { s.stateStale = true; }, home);
}
