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
  answer: string;
  createdAt: string;
  /** Set once promoted into a task, so the UI can show "✓ task created". */
  promotedTaskId?: string;
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
): Promise<void> {
  await withLock(sessionId, async () => {
    const list = await readJsonFile<SideQuestion[]>(fileFor(sessionId), []);
    const entry = list.find((q) => q.id === id);
    if (entry) {
      entry.promotedTaskId = taskId;
      await writeJsonFile(fileFor(sessionId), list);
    }
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
