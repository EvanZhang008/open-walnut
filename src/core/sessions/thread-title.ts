/**
 * Name each conversation question (spec 7.4) and judge "looks answered" (7.6).
 *
 * Two triggers, at most two model calls per question:
 *   1. NAME AT SEND: a meta write carrying `titleState: 'pending'` queues a call
 *      with the passage and the question. No answer needed, so `Naming…` lasts
 *      seconds instead of a whole answer plus a naming budget.
 *   2. REFINE ONCE at the question's first `session:result`, and only when the
 *      turn provably answered this question (the turn's user uuid is the head
 *      id; the queue sends one uuid row per turn). It may improve the title and
 *      returns the answered verdict, stored as `suggested`, never `resolved`.
 * Plus a sweep on every result: a `pending` entry older than 30s (trigger 1 lost
 * to a restart or a race) is queued again, at most two per record.
 *
 * Same channel and posture as side-thread-title.ts: Walnut's fast model (or the
 * test stub), fire-and-forget, never blocks a route, never throws. In-flight
 * dedupe per `<sessionId>:<headId>` (a result is emitted several times within
 * milliseconds) and a global concurrency cap of 2. Every write goes through
 * writeThreadMetaAsAi, which re-reads the record and drops a title the user
 * renamed meanwhile.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { turnUserUuid } from '../../providers/batch-uuid.js';
import { callThreadAi, threadAiStubActive, type ThreadAiKind } from './thread-ai-stub.js';
import {
  MAX_THREAD_TITLE_CHARS, onThreadMetaWritten, writeThreadMetaAsAi, type ThreadMetaWrittenEvent,
} from './thread-meta.js';
import type { SessionThreadMeta, SessionThreadMetaPatch } from '../types.js';

export const THREAD_TITLE_REQUIREMENT = 'Name this follow-up question for a navigation tree. 2 to 6 words, a noun phrase naming what the question is about, not the whole conversation. Same language as the question.';
/** The refine call returns the title AND the verdict. One line, because the
 *  backend channel keeps only the first line of an answer (cleanTitleAnswer). */
export const THREAD_REFINE_REQUIREMENT = `${THREAD_TITLE_REQUIREMENT} Then judge from the answer excerpt whether the answer resolves the question. Reply on ONE line in exactly this form: Title: <2 to 6 words> | Answered: yes (or no)`;

const MAX_CONCURRENT = 2;
export const THREAD_TITLE_SWEEP_AGE_MS = 30_000;
const SWEEP_MAX = 2;
const PASSAGE_CHARS = 600;
const ANSWER_EXCERPT_CHARS = 1200;
const PLACEHOLDER_CHARS = 48;

type TitleJobKind = Extract<ThreadAiKind, 'title' | 'refine'>;
interface TitleJob { sessionId: string; headId: string; kind: TitleJobKind; answer?: string }

const inFlight = new Set<string>();
const waiting: TitleJob[] = [];
const deferredRefine = new Map<string, TitleJob>();
const refineClaimed = new Set<string>();
let running = 0;
let idleWaiters: Array<() => void> = [];

const keyOf = (sessionId: string, headId: string) => `${sessionId}:${headId}`;

/** A title the UI can show: label echo and wrappers off, whitespace collapsed,
 *  cut at a word boundary to the stored cap. `null` when nothing usable is left. */
export function cleanThreadTitle(raw: string | null | undefined): string | null {
  const line = (raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const text = line
    .replace(/^[#>*`_\s]+|[*`_\s]+$/g, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[\s.;:,|]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2) return null;
  if (text.length <= MAX_THREAD_TITLE_CHARS) return text;
  const cut = text.slice(0, MAX_THREAD_TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

/**
 * Read `Title: X | Answered: yes` (or the two-line form, or a cleaned
 * `X Answered: yes`). No verdict found = a parse failure: keep the title,
 * answered is `false`.
 */
export function parseRefineAnswer(raw: string | null | undefined): { title: string | null; answered: boolean } {
  if (!raw) return { title: null, answered: false };
  const text = raw.replace(/\s+/g, ' ').trim();
  const m = /\banswered\s*:\s*(yes|no)\b/i.exec(text);
  const head = (m ? text.slice(0, m.index) : text).replace(/[\s|;,]+$/, '');
  return { title: cleanThreadTitle(head), answered: m?.[1].toLowerCase() === 'yes' };
}

/** What the model sees as the current label: the client's fallback rule. */
export function placeholderTitle(passage: string, question: string): string {
  const firstLine = (t: string) => t.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const line = firstLine(passage) || firstLine(question);
  if (!line) return 'Untitled question';
  if (line.length <= PLACEHOLDER_CHARS) return line;
  const cut = line.slice(0, PLACEHOLDER_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space >= PLACEHOLDER_CHARS / 3 ? cut.slice(0, space) : cut).trim()}…`;
}

// ── Queue: in-flight dedupe, concurrency 2 ──────────────────────────────────

function enqueue(job: TitleJob): void {
  const key = keyOf(job.sessionId, job.headId);
  if (inFlight.has(key)) {
    // The first answer landed while the name-at-send call is still running:
    // run the refine right after it instead of losing it.
    if (job.kind === 'refine' && !deferredRefine.has(key)) deferredRefine.set(key, job);
    return;
  }
  inFlight.add(key);
  waiting.push(job);
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.shift()!;
    const key = keyOf(job.sessionId, job.headId);
    running += 1;
    void runJob(job).finally(() => {
      running -= 1;
      inFlight.delete(key);
      const next = deferredRefine.get(key);
      if (next) { deferredRefine.delete(key); enqueue(next); }
      pump();
      if (running === 0 && waiting.length === 0) {
        const done = idleWaiters;
        idleWaiters = [];
        done.forEach((resolve) => resolve());
      }
    });
  }
}

function buildMessage(passage: string, question: string, answer?: string): string {
  return [
    `Passage: ${passage.slice(0, PASSAGE_CHARS)}`,
    `Question: ${question}`,
    ...(answer ? [`Answer excerpt: ${answer.slice(0, ANSWER_EXCERPT_CHARS)}`] : []),
  ].join('\n');
}

function patchFor(job: TitleJob, entry: SessionThreadMeta, raw: string | null): SessionThreadMetaPatch {
  if (job.kind === 'title') {
    const title = cleanThreadTitle(raw);
    return title
      ? { headId: job.headId, title, titleSource: 'ai', titleState: 'done' }
      : { headId: job.headId, titleState: 'failed' };
  }
  const { title, answered } = parseRefineAnswer(raw);
  const patch: SessionThreadMetaPatch = { headId: job.headId, refinedAt: new Date().toISOString() };
  if (title) Object.assign(patch, { title, titleSource: 'ai', titleState: 'done' });
  else if (entry.titleState === 'pending') patch.titleState = 'failed';
  // Only ever a suggestion; the merge's AI guard also refuses it on a question
  // that is no longer open or that the user said Not yet to.
  if (answered) patch.status = 'suggested';
  return patch;
}

async function runJob(job: TitleJob): Promise<void> {
  const { sessionId, headId, kind } = job;
  const started = Date.now();
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const entry = record?.threadMeta?.find((e) => e.headId === headId);
    if (!record || !entry || entry.titleSource === 'user') return;
    if (kind === 'title' && entry.titleState !== 'pending') return;
    if (kind === 'refine' && entry.refinedAt) return;
    const passage = record.threadAnchors?.find((a) => a.msgId === headId)?.quote?.exact ?? '';
    const question = entry.question ?? '';
    log.session.info('thread title: start', { sessionId, headId, kind, withAnswer: !!job.answer });
    const raw = await callThreadAi({
      kind, sessionId, headId, question, answer: job.answer,
      message: buildMessage(passage, question, job.answer),
      placeholder: placeholderTitle(passage, question),
      requirement: kind === 'refine' ? THREAD_REFINE_REQUIREMENT : THREAD_TITLE_REQUIREMENT,
    });
    const patch = patchFor(job, entry, raw);
    await writeThreadMetaAsAi(sessionId, [patch]);
    const fields = {
      sessionId, headId, kind, durationMs: Date.now() - started,
      titled: typeof patch.title === 'string', suggested: patch.status === 'suggested',
    };
    if (raw === null) log.session.warn('thread title: failure', fields);
    else log.session.info('thread title: success', fields);
  } catch (err) {
    log.session.warn('thread title: failure', {
      sessionId, headId, kind, durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Triggers ────────────────────────────────────────────────────────────────

/** Trigger 1: a write left an entry `pending` (the client's send, a lazy fill). */
function onMetaWritten(event: ThreadMetaWrittenEvent): void {
  const ids = new Set([...event.touched, ...event.listed]);
  for (const headId of ids) {
    const entry = event.record.threadMeta?.find((e) => e.headId === headId);
    if (entry?.titleState !== 'pending' || entry.titleSource === 'user') continue;
    // Test hook (stub sessions only): a question containing `stub-drop-name`
    // loses its name-at-send call, so a browser spec can watch the sweep recover it.
    if (threadAiStubActive(event.sessionId) && entry.question?.includes('stub-drop-name')) {
      log.session.info('thread title: stub dropped the name-at-send call', { sessionId: event.sessionId, headId });
      continue;
    }
    enqueue({ sessionId: event.sessionId, headId, kind: 'title' });
  }
}

interface ResultData {
  sessionId?: string; result?: string; isError?: boolean; interrupted?: boolean;
  teamActive?: boolean; backgroundActive?: boolean; userUuid?: string;
}

/** Trigger 2 (refine once) and the 30s sweep, on every `session:result`. */
export async function handleThreadTitleResult(data: ResultData, turnUuid: string | undefined): Promise<void> {
  const sessionId = data.sessionId;
  if (!sessionId) return;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  const meta = record?.threadMeta;
  if (!meta?.length) return;
  const finalAnswer = !data.isError && !data.interrupted && !data.teamActive && !data.backgroundActive;
  const head = turnUuid ? meta.find((e) => e.headId === turnUuid) : undefined;
  if (finalAnswer && head && !head.refinedAt && head.titleSource !== 'user') {
    const key = keyOf(sessionId, head.headId);
    if (!refineClaimed.has(key)) {
      refineClaimed.add(key);
      enqueue({ sessionId, headId: head.headId, kind: 'refine', answer: data.result ?? '' });
    }
  }
  const now = Date.now();
  meta
    .filter((e) => e.titleState === 'pending' && e.titleSource !== 'user'
      && now - Date.parse(e.updatedAt) > THREAD_TITLE_SWEEP_AGE_MS)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, SWEEP_MAX)
    .forEach((e) => {
      log.session.info('thread title: sweep requeues a lost name', { sessionId, headId: e.headId });
      enqueue({ sessionId, headId: e.headId, kind: 'title' });
    });
}

function onBusEvent(event: BusEvent): void {
  if (event.name !== EventNames.SESSION_RESULT) return;
  const data = (event.data ?? {}) as ResultData;
  if (!data.sessionId) return;
  // Read the turn's uuid NOW, synchronously: the next batch is delivered right
  // after this result and would overwrite it.
  const turnUuid = data.userUuid ?? turnUserUuid(data.sessionId);
  void handleThreadTitleResult(data, turnUuid).catch((err) => {
    log.session.warn('thread title: result handler failed', {
      sessionId: data.sessionId, error: err instanceof Error ? err.message : String(err),
    });
  });
}

const SUBSCRIBER = 'thread-title';

/** Start both triggers. Primary box only (the replica proxies sessions). */
export function startThreadTitler(): { stop: () => void } {
  bus.subscribe(SUBSCRIBER, onBusEvent, { global: true, interest: [EventNames.SESSION_RESULT] });
  const off = onThreadMetaWritten(onMetaWritten);
  log.session.info('thread titler started', { maxConcurrent: MAX_CONCURRENT });
  return { stop: () => { bus.unsubscribe(SUBSCRIBER); off(); } };
}

/** Test-only: resolves once no title job is queued or running. */
export function __threadTitlesIdleForTesting(): Promise<void> {
  if (running === 0 && waiting.length === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

/** Test-only: forget every claim, deferral and queued job. */
export function __resetThreadTitlerForTesting(): void {
  inFlight.clear();
  waiting.length = 0;
  deferredRefine.clear();
  refineClaimed.clear();
  running = 0;
  idleWaiters = [];
}

/** Test-only: the current concurrency, to assert the cap. */
export function __threadTitleRunningForTesting(): number {
  return running;
}
