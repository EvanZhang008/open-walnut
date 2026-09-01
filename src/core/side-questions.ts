/**
 * Side-question ("/btw") persistence.
 *
 * The native Claude Code side_question (see ClaudeCodeSession.askSideQuestion)
 * is fire-and-forget: the CLI returns the answer in a control_response and never
 * persists it. Walnut stores each Q&A here so the session-panel drawer can show a
 * traceable history and let the user promote one into a task.
 *
 * Storage: ~/.open-walnut/side-questions/{sessionId}.json — one small array per
 * session, read-modify-written under a per-process lock (mirrors conversations.ts).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

export interface SideQuestion {
  id: string;
  sessionId: string;
  question: string;
  /**
   * LEGACY one-shot `/btw` answer. Absent on side-thread entries: a thread's
   * answer lives in its own session transcript, not here.
   */
  answer?: string;
  createdAt: string;
  /**
   * SIDE THREAD: the hidden fork session backing this question. Its presence is
   * what makes an entry a thread rather than a legacy Q&A.
   */
  threadSessionId?: string;
  /** Display label for a thread (defaults to the question at the UI layer). */
  title?: string;
  /** Set once promoted into a task, so the UI can show "✓ task created". */
  promotedTaskId?: string;
}

/** Split a stored list into the two shapes the drawer renders. */
export function isSideThreadEntry(entry: SideQuestion): boolean {
  return typeof entry.threadSessionId === 'string' && entry.threadSessionId.length > 0;
}

const DIR = path.join(WALNUT_HOME, 'side-questions');

/** In-process serialization per session file (read-modify-write safety). Each call
 *  chains onto the prior one for the same session so concurrent writes don't clobber. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (locks.get(sessionId) ?? Promise.resolve()).catch(() => {});
  const run = prev.then(fn);
  const tail = run.catch(() => {}).finally(() => {
    // Tail-identity check, NOT unconditional delete — see the race timeline in
    // chat-history.ts withWriteLock (same pattern).
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  locks.set(sessionId, tail);
  return run;
}

function fileFor(sessionId: string): string {
  // sessionId is a CLI UUID — safe as a filename, but guard against traversal.
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(DIR, `${safe}.json`);
}

export async function listSideQuestions(sessionId: string): Promise<SideQuestion[]> {
  return readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
}

export async function addSideQuestion(
  sessionId: string,
  question: string,
  answer: string,
): Promise<SideQuestion> {
  return withLock(sessionId, async () => {
    const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
    const entry: SideQuestion = {
      id: `bsq-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      sessionId,
      question,
      answer,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    await writeJsonFile(fileFor(sessionId), list);
    log.web.info('side question persisted', { sessionId, id: entry.id });
    return entry;
  });
}

/**
 * Record a side THREAD. The caller owns the id (it is also the lane component
 * and the route path segment), so one id addresses the record, the store row and
 * the HTTP resource.
 */
export async function addSideThread(
  sessionId: string,
  input: { id: string; question: string; threadSessionId: string; title?: string },
): Promise<SideQuestion> {
  return withLock(sessionId, async () => {
    const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
    const entry: SideQuestion = {
      id: input.id,
      sessionId,
      question: input.question,
      threadSessionId: input.threadSessionId,
      ...(input.title ? { title: input.title } : {}),
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    await writeJsonFile(fileFor(sessionId), list);
    log.web.info('side thread persisted', {
      sessionId, id: entry.id, threadSessionId: input.threadSessionId,
    });
    return entry;
  });
}

/** Drop a thread entry (the session record is retired separately). */
export async function removeSideThread(sessionId: string, id: string): Promise<boolean> {
  return deleteSideQuestion(sessionId, id);
}

/** Stamp a thread entry with the task it was promoted into. False = the entry
 *  is gone (retired concurrently) and nothing was written — the caller decides
 *  whether that voids the promote. */
export async function markThreadPromoted(
  sessionId: string,
  id: string,
  taskId: string,
): Promise<boolean> {
  return markPromoted(sessionId, id, taskId);
}

export async function getSideQuestion(
  sessionId: string,
  id: string,
): Promise<SideQuestion | undefined> {
  const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
  return list.find((q) => q.id === id);
}

export async function markPromoted(
  sessionId: string,
  id: string,
  taskId: string,
): Promise<boolean> {
  return withLock(sessionId, async () => {
    const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
    const entry = list.find((q) => q.id === id);
    if (!entry) return false;
    entry.promotedTaskId = taskId;
    await writeJsonFile(fileFor(sessionId), list);
    return true;
  });
}

export async function deleteSideQuestion(sessionId: string, id: string): Promise<boolean> {
  return withLock(sessionId, async () => {
    const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
    const next = list.filter((q) => q.id !== id);
    if (next.length === list.length) return false;
    await writeJsonFile(fileFor(sessionId), next);
    return true;
  });
}
