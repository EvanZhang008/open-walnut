/**
 * Where an Org node's Threads live (threads-model.ts): one JSON file per node task at
 * `WALNUT_HOME/org/threads/<taskId>.json`, written under the file lock (the user's browser and
 * the node's session write at once). Every change emits `org-threads:changed` (envelope only).
 *
 * Only the leader keeps them: the companion has no copy, so its reads are empty and its writes
 * refused, the way Board writes are.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { bus, EventNames } from '../event-bus.js';
import type { OrgThreadsChangedEvent } from '../event-types.js';
import { isCompanion } from '../server-role.js';
import { walnutLetterLanguage as letterLang } from '../human-inbox/walnut-letters/languages.js';
import {
  emptyThreads, fileMessage, markClosesTold, mergeThreads, normalizeThreads, openThread, setAnswers, splitThreadMessage, sweepClosed, ThreadError, updateThread,
  type FileMessageInput, type FileMessageResult, type OpenThreadInput, type OrgThread, type ThreadAnswer, type ThreadPatch, type ThreadsFile, type ThreadWriter,
} from './threads-model.js';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const threadsDir = () => path.join(WALNUT_HOME, 'org', 'threads');

function threadsFile(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new ThreadError('bad_input', 400, `Invalid task id: ${taskId}`);
  return path.join(threadsDir(), `${taskId}.json`);
}

function emit(event: OrgThreadsChangedEvent): void {
  bus.emit(EventNames.ORG_THREADS_CHANGED, event, ['web-ui'], { source: 'org-threads' });
}

function leaderOnly(): void {
  if (isCompanion()) throw new ThreadError('bad_input', 501, 'Threads are kept on the primary; this server holds no copy.');
}

export async function readThreads(taskId: string): Promise<ThreadsFile> {
  if (isCompanion()) return emptyThreads(taskId);
  return normalizeThreads(await readJsonFile<unknown>(threadsFile(taskId), null), taskId);
}

/** Locked read-modify-write; `mutate` throwing writes nothing. */
async function mutateThreads<R>(taskId: string, mutate: (cur: ThreadsFile) => { file: ThreadsFile; out: R }): Promise<R> {
  leaderOnly();
  let out: R | undefined;
  await updateJsonFile<unknown>(threadsFile(taskId), null, (raw) => {
    const res = mutate(normalizeThreads(raw, taskId));
    out = res.out;
    return res.file;
  });
  return out as R;
}

export async function fileThreadMessage(taskId: string, input: FileMessageInput): Promise<FileMessageResult> {
  const lang = input.lang ?? await letterLang();
  const res = await mutateThreads(taskId, (cur) => {
    const r = fileMessage(cur, { ...input, lang });
    return { file: r.file, out: r };
  });
  if (!res.duplicate) emit({ taskId, kind: 'filed', threadId: res.thread.id });
  return res;
}

/** The node opens a thread itself (thread_create): its first post is what reached it. */
export async function openNodeThread(taskId: string, input: OpenThreadInput, by: ThreadWriter): Promise<OrgThread> {
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = openThread(cur, input, by, at);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'opened', threadId: thread.id });
  return thread;
}

export async function patchThread(taskId: string, id: string, patch: ThreadPatch, by: ThreadWriter): Promise<OrgThread> {
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = updateThread(cur, id, patch, by, at);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'updated', threadId: id });
  return thread;
}

export async function mergeThread(taskId: string, fromId: string, intoId: string, by: ThreadWriter): Promise<OrgThread> {
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = mergeThreads(cur, fromId, intoId, by, at);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'merged', threadId: intoId });
  return thread;
}

export async function splitThread(taskId: string, threadId: string, messageId: string, by: ThreadWriter): Promise<{ thread: OrgThread; from: OrgThread }> {
  const at = new Date().toISOString();
  const lang = await letterLang();
  const res = await mutateThreads(taskId, (cur) => {
    const r = splitThreadMessage(cur, threadId, messageId, by, at, undefined, lang);
    return { file: r.file, out: { thread: r.thread, from: r.from } };
  });
  emit({ taskId, kind: 'split', threadId: res.thread.id });
  return res;
}

/** The node was told these threads closed. Quiet: nothing the user sees changed. */
export async function noteClosesTold(taskId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length || isCompanion()) return;
  await mutateThreads(taskId, (cur) => ({ file: markClosesTold(cur, ids), out: undefined }));
}

/** Answers Walnut read from the node's chat (thread-answers.ts), each onto its message. Returns how many landed. */
export async function setThreadAnswers(taskId: string, answers: ReadonlyMap<string, ThreadAnswer>): Promise<number> {
  if (!answers.size || isCompanion()) return 0;
  const changed = await mutateThreads(taskId, (cur) => {
    const r = setAnswers(cur, answers);
    return { file: r.file, out: r.changed };
  });
  // One change for the whole read: a client reads the node's threads once, not once per thread.
  if (changed.length) emit({ taskId, kind: 'answered', ...(changed.length === 1 ? { threadId: changed[0] } : {}) });
  return changed.length;
}

/** The primary's sweep: every node's closed threads past their week are deleted for good. */
export async function sweepClosedThreads(now = Date.now()): Promise<number> {
  if (isCompanion()) return 0;
  const names = await fs.readdir(threadsDir()).catch(() => [] as string[]);
  let dropped = 0;
  const at = new Date(now).toISOString();
  for (const name of names) {
    const taskId = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!TASK_ID_RE.test(taskId)) continue;
    const n = await mutateThreads(taskId, (cur) => {
      const r = sweepClosed(cur, at);
      return { file: r.file, out: r.dropped };
    });
    if (n) { dropped += n; emit({ taskId, kind: 'swept' }); }
  }
  return dropped;
}
