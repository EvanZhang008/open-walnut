/**
 * Which project each task's artifacts live under, once the notes and artifacts are one tree by
 * project (layout.ts). The path functions (../paths.ts) answer synchronously, so the answer is
 * a table in memory: filled at boot from every task, kept by the task events, and a task that
 * moves to another project takes its memory folder (MEMORY.md, notes, guidance, reflections)
 * and its drawings' task folder with it. Its skills stay: they are its project's skills now.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bus, EventNames } from '../../event-bus.js';
import { log } from '../../../logging/index.js';
import type { Task } from '../../types.js';
import { projectDirOf } from './layout.js';

/** taskId -> its project's folder ("projects/<name>"), or null for a task with no project. */
const homes = new Map<string, string | null>();
let root: string | null = null;

export const homeOfTask = (taskId: string): string | null | undefined => homes.get(taskId);

/** The memory folder of a task, relative to the tree: under its project, else under the root. */
export const memoryHomeOf = (taskId: string): string => {
  const dir = homes.get(taskId);
  return dir ? `${dir}/memory/${taskId}` : `memory/${taskId}`;
};

export function loadTaskHomes(treeRoot: string, tasks: readonly Pick<Task, 'id' | 'project'>[]): void {
  root = treeRoot;
  homes.clear();
  for (const t of tasks) homes.set(t.id, projectDirOf(t.project));
}

export function clearTaskHomes(): void {
  root = null;
  homes.clear();
}

/** A project's folder renamed (boot.ts followProjectRename): every task at home there follows. */
export function renameHomes(from: string, to: string): void {
  for (const [id, dir] of homes) if (dir === from) homes.set(id, to);
}

async function moveTree(from: string, to: string): Promise<boolean> {
  if (!(await fsp.lstat(from).catch(() => null))) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (!(await fsp.lstat(to).catch(() => null))) { await fsp.rename(from, to); return true; }
  // Already there (a write that raced the move): what the new place lacks comes over, the rest stays and is named.
  const { mergeInto } = await import('./migrate-unified.js');
  await mergeInto(from, to);
  await fsp.rmdir(from).catch(() => log.memory.warn('one tree: some of a task\'s files stay in its old place, the new one has their names', { from, to }));
  return true;
}

/** One move at a time per task, in the order asked: two updates never cross. */
const chains = new Map<string, Promise<void>>();

/**
 * A task's project changed: its home moves with it (memory folder, and its drawings' task folder).
 * The project is read from the task as it is when the move runs, so an event that carried an
 * older copy of the task never moves it back.
 */
export function followTaskProject(taskId: string, project: string | null | undefined): Promise<void> {
  const run = (chains.get(taskId) ?? Promise.resolve()).then(() => moveHome(taskId, project)).catch((err) => {
    log.memory.warn('one tree: a task\'s memory did not follow its project', { taskId, error: String(err) });
  });
  chains.set(taskId, run);
  void run.finally(() => { if (chains.get(taskId) === run) chains.delete(taskId); });
  return run;
}

async function moveHome(taskId: string, asked: string | null | undefined): Promise<void> {
  let project = asked;
  try { project = (await (await import('../../task-manager.js')).getTask(taskId)).project; } catch { /* a task not stored (yet): as asked */ }
  const next = projectDirOf(project);
  // A task the table did not know yet (made after boot, elsewhere) was answered at the root.
  const had = homes.get(taskId) ?? null;
  if (!root || had === next) { homes.set(taskId, next); return; }
  const fromMem = path.join(root, had ? `${had}/memory/${taskId}` : `memory/${taskId}`);
  const toMem = path.join(root, next ? `${next}/memory/${taskId}` : `memory/${taskId}`);
  // The files first, then the table: a write in between still lands in the folder that moves.
  const moved = await moveTree(fromMem, toMem);
  // Its drawings sit in "<task title> (<task id>)/" folders under the drawings folder.
  const fromDraw = path.join(root, had ? `${had}/drawings` : 'drawings');
  const toDraw = path.join(root, next ? `${next}/drawings` : 'drawings');
  for (const name of await fsp.readdir(fromDraw).catch(() => [] as string[])) {
    if (name.endsWith(`(${taskId})`)) await moveTree(path.join(fromDraw, name), path.join(toDraw, name)).catch(() => false);
  }
  homes.set(taskId, next);
  if (moved) log.memory.info('one tree: a task\'s memory followed it to its project', { taskId, from: had ?? '(root)', to: next ?? '(root)' });
}

let unsubscribe: (() => void) | null = null;

/** Keep the table and the folders in step with the tasks, and a project's folder with its name, from boot on. */
export function watchTaskHomes(onProjectRenamed?: (from: string, to: string) => Promise<void>): void {
  if (unsubscribe) return;
  const off = bus.subscribe('artifacts-task-homes', async (event) => {
    if (event.name === EventNames.PROJECT_RENAMED) {
      const { from, to } = event.data as { from?: string; to?: string };
      if (from && to && onProjectRenamed) await onProjectRenamed(from, to).catch((err) => log.memory.warn('one tree: a renamed project did not follow', { from, to, error: String(err) }));
      return;
    }
    const task = (event.data as { task?: Task | null }).task;
    if (!task?.id) return;
    if (event.name === EventNames.TASK_CREATED && !homes.has(task.id)) homes.set(task.id, projectDirOf(task.project));
    else if (event.name === EventNames.TASK_UPDATED) await followTaskProject(task.id, task.project);
  }, { global: true, interest: [EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.PROJECT_RENAMED] });
  unsubscribe = typeof off === 'function' ? off : () => {};
}
