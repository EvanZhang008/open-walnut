/**
 * The one-sentence takeaway a question keeps when the user marks it Done (7.5).
 *
 * The client writes its fallback (first real sentence of the last answer's last
 * paragraph) and `takeawayState: 'pending'` in the Done write; this module then
 * asks the fast model (or the test stub) once for a better sentence. A user
 * edited takeaway is final. Failure keeps the fallback, no retry.
 *
 * Done while that question's answer is still streaming: nothing is computed
 * until the turn's `session:result` (the UI says "Summarizing when the answer
 * finishes"); then the fallback is computed HERE when the client had none to
 * send, from a server copy of the client's preamble table (kept in lockstep by a
 * parity unit test), and the model runs after it.
 *
 * The answer text comes from the `session:result` of a turn that provably
 * belongs to the question (its user uuid is the head or a follow-up anchored to
 * the same passage), held in memory. After a restart the text is gone and the
 * AI step reports `failed` (the fallback stays): the server never re-parses a
 * transcript for this.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { turnUserUuid } from '../../providers/batch-uuid.js';
import { callThreadAi, threadAiAvailable } from './thread-ai-stub.js';
import {
  MAX_THREAD_TAKEAWAY_CHARS, onThreadMetaWritten, threadHeadForMsg, writeThreadMetaAsAi,
  type ThreadMetaWrittenEvent,
} from './thread-meta.js';
import type { SessionRecord, SessionThreadMeta, SessionThreadMetaPatch } from '../types.js';

export const THREAD_TAKEAWAY_REQUIREMENT = 'State the answer this thread reached in one sentence, at most 25 words. No preamble, no "good question". Same language as the question.';

// ── Fallback (server copy of web/src/utils/thread-meta.ts) ──────────────────

/** MUST equal the client's table (tests/core/thread-takeaway.test.ts checks). */
export const TAKEAWAY_PREAMBLE_PATTERNS: readonly RegExp[] = [
  /^(good|great) question/i,
  /^short answer/i,
  /^sure[,.]/i,
  /^I'll /i,
  /^Let me /i,
  /^OK[,.]/i,
];
const FALLBACK_TAKEAWAY_MAX = 160;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

function clipAtWord(line: string, max: number): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const body = space >= Math.floor(max / 3) ? cut.slice(0, space) : cut;
  return `${body.replace(/[\s,;:.]+$/, '')}…`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(sentence: string): number {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  const cjk = (sentence.match(CJK) ?? []).length;
  return Math.max(words, Math.floor(cjk / 2));
}

function sentencesOf(paragraph: string): string[] {
  return (paragraph.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]*/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
}

function lastParagraph(markdown: string): string {
  const noFences = markdown.replace(/```[\s\S]*?(```|$)/g, '\n\n');
  const paras = noFences.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .filter((p) => !p.split('\n').every((l) => /^\s*\|/.test(l)));
  return paras.length ? stripMarkdown(paras[paras.length - 1]) : '';
}

/** First sentence of the last paragraph of the last answer, skipping short and
 *  preamble sentences; the paragraph's first sentence as-is when all are skipped. */
export function fallbackTakeaway(lastAnswerMarkdown: string | undefined): string {
  const para = lastParagraph(lastAnswerMarkdown ?? '');
  if (!para) return '';
  const sentences = sentencesOf(para);
  if (sentences.length === 0) return '';
  const pick = sentences.find((s) => wordCount(s) >= 6 && !TAKEAWAY_PREAMBLE_PATTERNS.some((re) => re.test(s)))
    ?? sentences[0];
  return pick.length > FALLBACK_TAKEAWAY_MAX ? clipAtWord(pick, FALLBACK_TAKEAWAY_MAX - 1) : pick;
}

// ── State: last answers, parked jobs, the turn each session is answering ────

const ANSWER_KEEP = 200;
const QUESTION_AND_ANSWER_CHARS = 2000;
const MAX_CONCURRENT = 2;

/** Last answer text per `<sessionId>:<headId>`, newest last (bounded). */
const answers = new Map<string, string>();
/** Done questions waiting for their streaming answer's result. */
const parked = new Map<string, { sessionId: string; headId: string }>();
/** Per session: the turn uuid whose result was seen last. */
const lastResultUuid = new Map<string, string | undefined>();
/** Per session: that last result's text, kept synchronously so a Done that
 *  races the result's async capture still finds its answer. */
const lastResultText = new Map<string, { uuid: string; text: string }>();
const inFlight = new Set<string>();
const waiting: Array<{ sessionId: string; headId: string }> = [];
let running = 0;
let idleWaiters: Array<() => void> = [];

const keyOf = (sessionId: string, headId: string) => `${sessionId}:${headId}`;

/** Keep what the takeaway reads (the head for the model, the last paragraph for
 *  the fallback) and bound memory on very long answers. */
function boundedAnswer(text: string): string {
  return text.length <= 40_000 ? text : `${text.slice(0, 20_000)}\n\n${text.slice(-20_000)}`;
}

function rememberAnswer(key: string, text: string): void {
  answers.delete(key);
  answers.set(key, boundedAnswer(text));
  while (answers.size > ANSWER_KEEP) answers.delete(answers.keys().next().value as string);
}

/** Is this question's answer streaming right now? (its turn delivered, no result yet) */
function isStreaming(sessionId: string, headId: string, record: SessionRecord): boolean {
  const uuid = turnUserUuid(sessionId);
  if (!uuid || lastResultUuid.get(sessionId) === uuid) return false;
  return threadHeadForMsg(uuid, record.threadAnchors, record.threadMeta) === headId;
}

/** A Done write this module owes work for: an AI takeaway is pending, or the
 *  client had no fallback to send (the answer was still streaming). */
function needsWork(entry: SessionThreadMeta | undefined): entry is SessionThreadMeta {
  if (!entry || entry.status !== 'resolved' || entry.takeawaySource === 'user') return false;
  return entry.takeawayState === 'pending' || !entry.takeaway;
}

function schedule(sessionId: string, headId: string): void {
  const key = keyOf(sessionId, headId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  waiting.push({ sessionId, headId });
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.shift()!;
    running += 1;
    void runTakeaway(job.sessionId, job.headId).finally(() => {
      running -= 1;
      inFlight.delete(keyOf(job.sessionId, job.headId));
      pump();
      if (running === 0 && waiting.length === 0) {
        const done = idleWaiters;
        idleWaiters = [];
        done.forEach((resolve) => resolve());
      }
    });
  }
}

function cleanTakeaway(raw: string | null): string | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (text.length < 2) return null;
  return text.length <= MAX_THREAD_TAKEAWAY_CHARS ? text : clipAtWord(text, MAX_THREAD_TAKEAWAY_CHARS - 1);
}

async function write(sessionId: string, patch: SessionThreadMetaPatch): Promise<void> {
  await writeThreadMetaAsAi(sessionId, [patch]);
}

async function runTakeaway(sessionId: string, headId: string): Promise<void> {
  const key = keyOf(sessionId, headId);
  const started = Date.now();
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const entry = record?.threadMeta?.find((e) => e.headId === headId);
    if (!record || !needsWork(entry)) return;
    if (isStreaming(sessionId, headId, record)) {
      parked.set(key, { sessionId, headId });
      log.session.info('thread takeaway: waits for the streaming answer', { sessionId, headId });
      return;
    }
    const last = lastResultText.get(sessionId);
    const answer = answers.get(key)
      ?? (last && threadHeadForMsg(last.uuid, record.threadAnchors, record.threadMeta) === headId ? last.text : undefined);
    if (!answer) {
      if (entry.takeawayState === 'pending') await write(sessionId, { headId, takeawayState: 'failed' });
      log.session.warn('thread takeaway: failure', { sessionId, headId, reason: 'no-answer-text', durationMs: Date.now() - started });
      return;
    }
    const fallback = entry.takeaway ? '' : fallbackTakeaway(answer);
    if (fallback) await write(sessionId, { headId, takeaway: fallback, takeawaySource: 'fallback' });
    if (entry.takeawayState !== 'pending' || !threadAiAvailable(sessionId)) return;
    log.session.info('thread takeaway: start', { sessionId, headId });
    const question = entry.question ?? '';
    const raw = await callThreadAi({
      kind: 'takeaway', sessionId, headId, question, answer,
      message: `Question: ${question}\nAnswer: ${answer.slice(0, QUESTION_AND_ANSWER_CHARS)}`,
      placeholder: entry.takeaway || fallback || question.slice(0, 80),
      requirement: THREAD_TAKEAWAY_REQUIREMENT,
    });
    const takeaway = cleanTakeaway(raw);
    await write(sessionId, takeaway
      ? { headId, takeaway, takeawaySource: 'ai', takeawayState: 'done' }
      : { headId, takeawayState: 'failed' });
    const fields = { sessionId, headId, durationMs: Date.now() - started };
    if (takeaway) log.session.info('thread takeaway: success', fields);
    else log.session.warn('thread takeaway: failure', { ...fields, reason: 'model-returned-nothing' });
  } catch (err) {
    log.session.warn('thread takeaway: failure', {
      sessionId, headId, durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Triggers ────────────────────────────────────────────────────────────────

function onMetaWritten(event: ThreadMetaWrittenEvent): void {
  if (event.writer !== 'client') return;
  for (const headId of event.touched) {
    const entry = event.record.threadMeta?.find((e) => e.headId === headId);
    if (needsWork(entry)) schedule(event.sessionId, headId);
  }
}

interface ResultData {
  sessionId?: string; result?: string; isError?: boolean;
  teamActive?: boolean; backgroundActive?: boolean; userUuid?: string;
}

/** Keep the answer of a turn that belongs to a question; release parked Dones. */
export async function handleThreadTakeawayResult(data: ResultData, turnUuid: string | undefined): Promise<void> {
  const sessionId = data.sessionId;
  if (!sessionId) return;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.threadMeta?.length) return;
  const headId = turnUuid ? threadHeadForMsg(turnUuid, record.threadAnchors, record.threadMeta) : undefined;
  if (headId && !data.isError && data.result) rememberAnswer(keyOf(sessionId, headId), data.result);
  for (const [key, job] of parked) {
    if (job.sessionId !== sessionId) continue;
    parked.delete(key);
    schedule(job.sessionId, job.headId);
  }
}

function onBusEvent(event: BusEvent): void {
  if (event.name !== EventNames.SESSION_RESULT) return;
  const data = (event.data ?? {}) as ResultData;
  if (!data.sessionId || data.teamActive || data.backgroundActive) return;
  // Synchronous: the next delivery right after this result replaces the uuid.
  const turnUuid = data.userUuid ?? turnUserUuid(data.sessionId);
  lastResultUuid.set(data.sessionId, turnUuid);
  if (turnUuid && !data.isError && data.result) lastResultText.set(data.sessionId, { uuid: turnUuid, text: boundedAnswer(data.result) });
  else lastResultText.delete(data.sessionId);
  void handleThreadTakeawayResult(data, turnUuid).catch((err) => {
    log.session.warn('thread takeaway: result handler failed', {
      sessionId: data.sessionId, error: err instanceof Error ? err.message : String(err),
    });
  });
}

const SUBSCRIBER = 'thread-takeaway';

export function startThreadTakeaways(): { stop: () => void } {
  bus.subscribe(SUBSCRIBER, onBusEvent, { global: true, interest: [EventNames.SESSION_RESULT] });
  const off = onThreadMetaWritten(onMetaWritten);
  return { stop: () => { bus.unsubscribe(SUBSCRIBER); off(); } };
}

/** Test-only: resolves once no takeaway job is queued or running. */
export function __threadTakeawaysIdleForTesting(): Promise<void> {
  if (running === 0 && waiting.length === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

export function __resetThreadTakeawaysForTesting(): void {
  answers.clear(); parked.clear(); lastResultUuid.clear(); lastResultText.clear(); inFlight.clear();
  waiting.length = 0; running = 0; idleWaiters = [];
}
