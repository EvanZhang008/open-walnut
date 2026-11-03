/**
 * Name the sections of a long conversation: one short AI title per
 * main-conversation user message, so the transcript outline reads as a table
 * of contents (2026-11-03, the user: "the TOC should be auto generated to make
 * sense for long ones").
 *
 * Two triggers, one job per session at a time:
 *   1. every `session:result`, for a session whose history this server already
 *      holds parsed (someone has it open; an unviewed session is never read for
 *      this, the next open titles it);
 *   2. the client's ask (`POST /api/sessions/:id/turn-titles`), sent when an
 *      open long conversation shows messages with no title yet, which covers a
 *      session that will never have another turn.
 * A job reads the history, takes the newest untitled messages (at most
 * TURN_TITLE_BATCH), asks ONE model call for all of them, writes the titles
 * once (turn-titles-text.ts), and emits the stored list on
 * `session:status-changed` so an open panel adopts it in place. Up to
 * MAX_BATCHES_PER_RUN batches per job, so an old session opened for the first
 * time is named in a few calls, newest first.
 *
 * Same posture as thread-title.ts: Walnut's fast model (or the test stub, the
 * one door callThreadAi), gated by threadAiAvailable, fire-and-forget, never
 * blocks a route, never throws, a global concurrency cap of 2. A message whose
 * title failed twice is not asked again in this process.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { callThreadAi, threadAiAvailable } from './thread-ai-stub.js';
import {
  buildTurnTitlesMessage, mergeTurnTitles, parseTurnTitlesAnswer, sectionCandidates, TURN_TITLE_MIN_MESSAGES,
  TURN_TITLES_REQUIREMENT, untitledBatch, type SectionCandidate, type TurnRowLike,
} from './turn-titles-text.js';
import type { SessionRecord, SessionTurnTitle } from '../types.js';

const MAX_CONCURRENT = 2;
const MAX_BATCHES_PER_RUN = 5;
const MAX_FAILURES_PER_MESSAGE = 2;

type Trigger = 'result' | 'client';

let started = false;
let running = 0;
const queued: Array<{ sessionId: string; trigger: Trigger }> = [];
const inFlight = new Set<string>();
/** A trigger that came while the session's job ran: run once more after it. */
const rerun = new Map<string, Trigger>();
const failures = new Map<string, number>();
let idleWaiters: Array<() => void> = [];

export interface TurnTitlesRequestResult {
  queued: boolean;
  reason?: 'not-started' | 'unavailable' | 'session-not-found';
}

/** Ask for the session's untitled sections to be named (the client's trigger). */
export async function requestTurnTitles(sessionId: string): Promise<TurnTitlesRequestResult> {
  if (!started) return { queued: false, reason: 'not-started' };
  if (!threadAiAvailable(sessionId)) return { queued: false, reason: 'unavailable' };
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  if (!(await getSessionByClaudeId(sessionId))) return { queued: false, reason: 'session-not-found' };
  enqueue(sessionId, 'client');
  return { queued: true };
}

function enqueue(sessionId: string, trigger: Trigger): void {
  if (inFlight.has(sessionId)) {
    // The client's ask wins over a result: it may read history a result would skip.
    if (rerun.get(sessionId) !== 'client') rerun.set(sessionId, trigger);
    return;
  }
  inFlight.add(sessionId);
  queued.push({ sessionId, trigger });
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && queued.length > 0) {
    const job = queued.shift()!;
    running += 1;
    void runJob(job.sessionId, job.trigger).finally(() => {
      running -= 1;
      inFlight.delete(job.sessionId);
      const again = rerun.get(job.sessionId);
      if (again) { rerun.delete(job.sessionId); enqueue(job.sessionId, again); }
      pump();
      if (running === 0 && queued.length === 0) {
        const done = idleWaiters;
        idleWaiters = [];
        done.forEach((resolve) => resolve());
      }
    });
  }
}

/** The session's history rows, or null when this trigger must not read them. */
async function historyRows(record: SessionRecord, trigger: Trigger): Promise<TurnRowLike[] | null> {
  const sessionId = record.claudeSessionId;
  const { engineCaps } = await import('../agents/engine-registry.js');
  const acp = engineCaps(record.engine).historySource === 'acp-journal';
  if (trigger === 'result') {
    // A turn end alone never reads a transcript nobody has open.
    if (acp) return null;
    const { getCachedSessionHistory } = await import('../session-history.js');
    if (!getCachedSessionHistory(sessionId, record.host)) return null;
  }
  const { readProviderSessionHistory } = await import('./session-lifecycle.js');
  const { HISTORY_COLD_TAIL_READ_BYTES } = await import('../session-history.js');
  const { messages } = await readProviderSessionHistory(sessionId, record, record.host, true, {
    maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES,
  });
  return messages;
}

const failKey = (sessionId: string, msgId: string) => `${sessionId}:${msgId}`;

function skipSet(sessionId: string, candidates: readonly SectionCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const c of candidates) {
    if ((failures.get(failKey(sessionId, c.msgId)) ?? 0) >= MAX_FAILURES_PER_MESSAGE) out.add(c.msgId);
  }
  return out;
}

/** Store titles write-once, re-reading the record inside its write. */
async function writeTitles(
  sessionId: string, add: Array<{ msgId: string; title: string }>,
): Promise<SessionTurnTitle[] | null> {
  const tracker = await import('../session-tracker.js');
  const updates: { turnTitles?: SessionTurnTitle[] } = {};
  const record = await tracker.updateSessionRecordConditionally(sessionId, updates, (current) => {
    const merged = mergeTurnTitles(current.turnTitles, add, new Date().toISOString());
    if (!merged.changed) return false;
    updates.turnTitles = merged.list;
    return true;
  }, { preserveLastActiveAt: true });
  if (!record || !updates.turnTitles) return null;
  tracker.emitSessionStatusChanged(record, { turnTitles: record.turnTitles ?? [] }, ['*']);
  return record.turnTitles ?? [];
}

async function runJob(sessionId: string, trigger: Trigger): Promise<void> {
  const t0 = Date.now();
  try {
    if (!threadAiAvailable(sessionId)) return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record) return;
    const rows = await historyRows(record, trigger);
    if (!rows) return;
    const candidates = sectionCandidates(rows, record.threadAnchors);
    if (candidates.length < TURN_TITLE_MIN_MESSAGES) return;
    let titles = record.turnTitles;
    for (let round = 0; round < MAX_BATCHES_PER_RUN; round++) {
      const batch = untitledBatch(candidates, titles, skipSet(sessionId, candidates));
      if (batch.length === 0) return;
      log.session.info('turn titles: start', { sessionId, trigger, count: batch.length, round });
      const raw = await callThreadAi({
        kind: 'sections', sessionId, headId: 'sections',
        message: buildTurnTitlesMessage(batch),
        placeholder: '', requirement: TURN_TITLES_REQUIREMENT, question: '',
      });
      const parsed = parseTurnTitlesAnswer(raw, batch.length);
      const add: Array<{ msgId: string; title: string }> = [];
      batch.forEach((c, i) => {
        const title = parsed.get(i);
        if (title) add.push({ msgId: c.msgId, title });
        else failures.set(failKey(sessionId, c.msgId), (failures.get(failKey(sessionId, c.msgId)) ?? 0) + 1);
      });
      const fields = { sessionId, trigger, asked: batch.length, titled: add.length, durationMs: Date.now() - t0 };
      if (add.length === 0) {
        log.session.warn('turn titles: no usable title in the answer', fields);
        return;
      }
      const stored = await writeTitles(sessionId, add);
      log.session.info('turn titles: written', fields);
      if (!stored) return;
      titles = stored;
    }
  } catch (err) {
    log.session.warn('turn titles: job failed', {
      sessionId, trigger, durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function onBusEvent(event: BusEvent): void {
  if (event.name !== EventNames.SESSION_RESULT) return;
  const sessionId = (event.data as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId || !threadAiAvailable(sessionId)) return;
  enqueue(sessionId, 'result');
}

const SUBSCRIBER = 'turn-titles';

/** Start the result trigger and accept client asks. Primary box only. */
export function startTurnTitler(): { stop: () => void } {
  bus.subscribe(SUBSCRIBER, onBusEvent, { global: true, interest: [EventNames.SESSION_RESULT] });
  started = true;
  log.session.info('turn titler started', { maxConcurrent: MAX_CONCURRENT, minMessages: TURN_TITLE_MIN_MESSAGES });
  return { stop: () => { bus.unsubscribe(SUBSCRIBER); started = false; } };
}

/** Test-only: resolves once no job is queued or running. */
export function __turnTitlesIdleForTesting(): Promise<void> {
  if (running === 0 && queued.length === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

/** Test-only: forget every queued job, rerun and failure count. */
export function __resetTurnTitlerForTesting(): void {
  queued.length = 0;
  inFlight.clear();
  rerun.clear();
  failures.clear();
  running = 0;
  idleWaiters = [];
}
