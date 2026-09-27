/**
 * The one door every thread AI call goes through (title, refine, takeaway), plus
 * a deterministic stand-in model for browser tests.
 *
 * Real installs call Walnut's fast model via `titleViaBackendModel`, gated by
 * `backendTitleAvailable()` (test servers never make unprompted model calls).
 * The browser suite still needs to SEE an AI title land, a "looks answered"
 * verdict and an AI takeaway, so a fixture sets WALNUT_THREAD_AI_STUB to a
 * session-id prefix: only those sessions get the stub, every other test session
 * keeps the gate closed, so the `unavailable` path keeps running too.
 *
 * Every call is counted per `<sessionId>:<headId>`, because the design bounds the
 * cost: at most two calls per question (name at send, refine at first answer),
 * plus one takeaway at Done.
 */

import { backendTitleAvailable, titleViaBackendModel } from '../session-title-backend.js';
import { log } from '../../logging/index.js';

export type ThreadAiKind = 'title' | 'refine' | 'takeaway';

export interface ThreadAiRequest {
  kind: ThreadAiKind;
  sessionId: string;
  headId: string;
  /** The full model input (Passage / Question / Answer excerpt lines). */
  message: string;
  /** What the UI shows meanwhile; the model sees it as the placeholder. */
  placeholder: string;
  requirement: string;
  /** Raw parts, for the stub (it answers from these, not from `message`). */
  question: string;
  answer?: string;
}

export type ThreadAiModel = (req: ThreadAiRequest) => Promise<string | null>;

export const THREAD_AI_STUB_ENV = 'WALNUT_THREAD_AI_STUB';
/** How long the stub "thinks": long enough that `Naming…` is observable. */
export const THREAD_AI_STUB_DELAY_MS = 600;

let testModel: ThreadAiModel | null = null;
const callCounts = new Map<string, number>();

/** The stub serves this session (env set, non-empty, and a prefix of the id). */
export function threadAiStubActive(sessionId: string): boolean {
  const prefix = process.env[THREAD_AI_STUB_ENV];
  return !!prefix && sessionId.startsWith(prefix);
}

/** May a thread AI call run for this session at all? */
export function threadAiAvailable(sessionId: string): boolean {
  return threadAiStubActive(sessionId) || backendTitleAvailable();
}

function words(text: string | undefined, n: number): string[] {
  return (text ?? '').split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
    .slice(0, n);
}

function titleCase(list: string[]): string {
  return list.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Deterministic answers the browser specs can assert word for word. */
export function stubThreadAnswer(req: ThreadAiRequest): string | null {
  const title = titleCase(words(req.question, 3)) || 'Stub Question';
  if (req.kind === 'title') return title;
  if (req.kind === 'refine') {
    return `Title: ${title}\nAnswered: ${req.question.includes('stub-answered') ? 'yes' : 'no'}`;
  }
  const lead = words(req.answer, 8).join(' ');
  return lead ? `Stub takeaway: ${lead}.` : null;
}

async function stubModel(req: ThreadAiRequest): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, THREAD_AI_STUB_DELAY_MS));
  return stubThreadAnswer(req);
}

/** Ask the model. Never throws; `null` on any failure (callers keep the fallback). */
export async function callThreadAi(req: ThreadAiRequest): Promise<string | null> {
  const key = `${req.sessionId}:${req.headId}`;
  const count = (callCounts.get(key) ?? 0) + 1;
  callCounts.set(key, count);
  const channel = testModel ? 'test' : threadAiStubActive(req.sessionId) ? 'stub' : 'backend';
  log.session.info('thread ai call', {
    sessionId: req.sessionId, headId: req.headId, kind: req.kind, channel, callsForThread: count,
  });
  try {
    if (testModel) return await testModel(req);
    if (channel === 'stub') return await stubModel(req);
    return await titleViaBackendModel(req.message, req.placeholder, req.requirement);
  } catch (err) {
    log.session.warn('thread ai call threw', {
      sessionId: req.sessionId, headId: req.headId, kind: req.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Calls made per question of one session, keyed by headId. */
export function threadAiCallCounts(sessionId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const prefix = `${sessionId}:`;
  for (const [key, n] of callCounts) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = n;
  return out;
}

/** Test-only: replace the model (null restores the stub/backend routing). */
export function __setThreadAiModelForTesting(fn: ThreadAiModel | null): void {
  testModel = fn;
}

/** Test-only: forget every call count. */
export function __resetThreadAiCallsForTesting(): void {
  callCounts.clear();
}
