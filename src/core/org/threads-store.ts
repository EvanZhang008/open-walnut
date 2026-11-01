/**
 * Where an Org node's Threads live (threads-model.ts): one JSON file per node task at
 * `WALNUT_HOME/org/threads/<taskId>.json`, written under the file lock (the user's browser and
 * the node's session write at once). Every change emits `org-threads:changed` (envelope only).
 *
 * Only the leader keeps them: the companion has no copy, so its reads are empty and its writes
 * refused, the way Board writes are.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { bus, EventNames } from '../event-bus.js';
import type { OrgThreadsChangedEvent } from '../event-types.js';
import { isCompanion } from '../server-role.js';
import {
  emptyThreads, fileMessage, markClosesTold, mergeThreads, normalizeThreads, splitThreadMessage, ThreadError, updateThread,
  type FileMessageInput, type FileMessageResult, type OrgThread, type ThreadPatch, type ThreadsFile, type ThreadWriter,
} from './threads-model.js';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function threadsFile(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new ThreadError('bad_input', 400, `Invalid task id: ${taskId}`);
  return path.join(WALNUT_HOME, 'org', 'threads', `${taskId}.json`);
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
  const res = await mutateThreads(taskId, (cur) => {
    const r = fileMessage(cur, input);
    return { file: r.file, out: r };
  });
  if (!res.duplicate) emit({ taskId, kind: 'filed', threadId: res.thread.id });
  return res;
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
  const res = await mutateThreads(taskId, (cur) => {
    const r = splitThreadMessage(cur, threadId, messageId, by, at);
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
