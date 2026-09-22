/**
 * The pending buffer a triage run reads — `~/.open-walnut/triage-state.json`.
 *
 * WHY A FILE AT ALL. Mail can answer "what arrived since T" through its own ops,
 * so the envelope only has to carry `since` plus counts. Slack cannot: its
 * per-conversation cursors live inside the plugin and are not queryable from
 * core, so the items on `plugin:slack:messages-received` ARE the data. Lose them
 * and nobody can ever get them back. So they accumulate here.
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
 *   ackTriageClaim()    — the run's task exists, so the batch reached a session:
 *                         now drop exactly what was claimed.
 *   releaseTriageClaim()— the delivery failed: forget the claim, keep the items,
 *                         let the next run claim them again.
 *
 * That order is the same choice the Slack inbox documents ("SEND FIRST, then
 * move the cursors"): an item announced twice is an annoyance, an item lost is
 * the feature not working. The run is idempotent by construction anyway — it
 * re-reads real state through ops before it acts.
 *
 * Caps exist because this file is rewritten on every flush: 120 Slack rows and
 * 40 mail rows keep it a few tens of KB. Over the cap the OLDEST rows go and
 * `droppedSlack` / `droppedMail` says how many, so "22 new items" is never a lie.
 */

import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import { log } from '../../logging/index.js';

// ── Caps ──

/** Slack rows kept. ~6 busy ticks of 20, which is one 30-minute batch. */
export const PENDING_SLACK_CAP = 120;
/** Mail rows kept. One row per ACCOUNT per tick, so 40 is many accounts × ticks. */
export const PENDING_MAIL_CAP = 40;

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

/** One mail account's tick, as `plugin:mail:messages-received` reported it. */
export interface TriagePendingMail {
  accountId: string;
  count: number;
  headlines: Array<{ from: string; subject: string }>;
  atMs: number;
}

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
  mail: TriagePendingMail[];
  slack: TriagePendingSlack[];
  /** Rows the caps or the emitting plugin dropped. Keeps the counts honest. */
  droppedMail: number;
  droppedSlack: number;
}

/** What one run was handed. `atMs` is the claim's id AND the run's start. */
export interface TriageClaim {
  atMs: number;
  mail: number;
  slack: number;
  droppedMail: number;
  droppedSlack: number;
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
   * mailbox from epoch 0, and so a later routine edit cannot move it.
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
}

export function emptyTriagePending(): TriagePending {
  return { mail: [], slack: [], droppedMail: 0, droppedSlack: 0 };
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

function readMailRow(raw: unknown): TriagePendingMail | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const accountId = str(r.accountId, 200);
  if (!accountId) return null;
  const headlines = Array.isArray(r.headlines)
    ? r.headlines.slice(0, 5).map((h) => {
      const row = (h ?? {}) as Record<string, unknown>;
      return { from: str(row.from, 200), subject: str(row.subject, 300) };
    })
    : [];
  return { accountId, count: Math.max(0, Math.floor(num(r.count))), headlines, atMs: num(r.atMs) };
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

/**
 * Read the buffer, degrading to empty on anything unreadable.
 *
 * Every field is re-validated rather than trusted: this file is rewritten on a
 * timer while a run may be reading it, and a half-written or hand-edited row
 * must cost one tick's items, never the run.
 */
export async function loadTriageState(home?: string): Promise<TriageState> {
  const file = triageStatePath(home);
  try {
    const raw = await readJsonFile<Partial<TriageState> | null>(file, null);
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return emptyTriageState();
    const pendingRaw = (raw.pending ?? {}) as Partial<TriagePending>;
    const pending: TriagePending = {
      mail: Array.isArray(pendingRaw.mail)
        ? pendingRaw.mail.map(readMailRow).filter((r): r is TriagePendingMail => r !== null)
        : [],
      slack: Array.isArray(pendingRaw.slack)
        ? pendingRaw.slack.map(readSlackRow).filter((r): r is TriagePendingSlack => r !== null)
        : [],
      droppedMail: Math.max(0, Math.floor(num(pendingRaw.droppedMail))),
      droppedSlack: Math.max(0, Math.floor(num(pendingRaw.droppedSlack))),
    };
    const claimRaw = raw.claim as Partial<TriageClaim> | undefined;
    const claim: TriageClaim | undefined = claimRaw && num(claimRaw.atMs) > 0
      ? {
        atMs: num(claimRaw.atMs),
        mail: Math.max(0, Math.floor(num(claimRaw.mail))),
        slack: Math.max(0, Math.floor(num(claimRaw.slack))),
        droppedMail: Math.max(0, Math.floor(num(claimRaw.droppedMail))),
        droppedSlack: Math.max(0, Math.floor(num(claimRaw.droppedSlack))),
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
 * Persist a collector flush: mail ticks and Slack items in one locked write.
 *
 * When the cap bites while a claim is OPEN, the claim shrinks by however many of
 * ITS rows went. The claim is the oldest prefix and the cap drops the oldest
 * rows, so without this the acknowledgement would slice by a count that no
 * longer matches the rows and would eat items that arrived after the claim.
 */
export async function recordTriageArrivals(input: {
  mail?: readonly TriagePendingMail[];
  slack?: readonly TriagePendingSlack[];
  droppedSlack?: number;
}, home?: string): Promise<TriageState> {
  return await updateTriageState((state) => {
    const p = state.pending;
    if (input.mail?.length) {
      const { list, dropped } = appendCapped(p.mail, input.mail, PENDING_MAIL_CAP);
      p.mail = list;
      p.droppedMail += dropped;
      if (state.claim && dropped > 0) state.claim.mail = Math.max(0, state.claim.mail - dropped);
    }
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
  mail: TriagePendingMail[];
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
 * `sinceMs` is the floor for "what is new": the last acknowledged run's start,
 * or — on the very first run — `nowMs`, recorded so the first batch never asks a
 * session to read a mailbox from the beginning of time.
 */
export async function claimTriageBatch(nowMs: number, home?: string): Promise<TriageClaimResult> {
  let out!: TriageClaimResult;
  await updateTriageState((state) => {
    const open = state.claim;
    const live = !!open && nowMs - open.atMs < CLAIM_TTL_MS;
    if (open && !live) {
      log.cron.warn('triage: a previous batch was never acknowledged — re-claiming its items', {
        claimedAtMs: open.atMs, mail: open.mail, slack: open.slack, ageMs: nowMs - open.atMs,
      });
    }
    if (state.sinceMs === undefined) state.sinceMs = nowMs;
    const claim: TriageClaim = live && open
      ? open
      : {
        atMs: nowMs,
        mail: state.pending.mail.length,
        slack: state.pending.slack.length,
        droppedMail: state.pending.droppedMail,
        droppedSlack: state.pending.droppedSlack,
      };
    state.claim = claim;
    out = {
      claim,
      mail: state.pending.mail.slice(0, claim.mail),
      slack: state.pending.slack.slice(0, claim.slack),
      redelivered: live,
      sinceMs: state.lastRunAtMs ?? state.sinceMs ?? nowMs,
      ...(state.lastJournalLine ? { lastJournalLine: state.lastJournalLine } : {}),
      stateStale: state.stateStale === true,
      runs: state.runs,
    };
  }, home);
  return out;
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
    const claim = s.claim;
    // min(): the caps may have dropped some of the claimed prefix while the run
    // was in flight. Those rows were already delivered, so dropping fewer here
    // is correct — slicing by the claimed COUNT against a shorter list would
    // eat rows that arrived after the claim.
    s.pending.mail = s.pending.mail.slice(Math.min(claim.mail, s.pending.mail.length));
    s.pending.slack = s.pending.slack.slice(Math.min(claim.slack, s.pending.slack.length));
    s.pending.droppedMail = Math.max(0, s.pending.droppedMail - claim.droppedMail);
    s.pending.droppedSlack = Math.max(0, s.pending.droppedSlack - claim.droppedSlack);
    s.claim = undefined;
    s.lastRunAtMs = claim.atMs;
    s.runs += 1;
    // The warning was carried into THIS run's envelope; it has been said.
    s.stateStale = undefined;
    acked = true;
  }, home);
  return { acked, state };
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
