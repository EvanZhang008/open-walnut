/**
 * Which answered threads a node already checked against one message of his (2026-11-20, Main: the
 * turn-end check named the same 7 threads at every turn end for his one message at 08:09Z, which
 * touched none of them; its memory lived in the server process, and the server restarts at every
 * deploy). A thread is named for one message of his once: the node looked at it then, and leaving it
 * as it is was its answer. His next message names it again.
 *
 * Kept in `WALNUT_HOME/org/thread-checks.json` as `{ [taskId]: { [threadId]: hisMessageAt } }`, so a
 * restart remembers it. Only the thread's newest check is kept, and a task keeps at most
 * MAX_PER_TASK of them (the oldest go first); a lost file only means one more check.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';

type Checks = Record<string, Record<string, string>>;

const FILE = () => path.join(WALNUT_HOME, 'org', 'thread-checks.json');
const MAX_PER_TASK = 200;
const MAX_TASKS = 500;

/** The thread ids of this task already checked against his message at `hisAt`. */
export async function checkedFor(taskId: string, hisAt: string): Promise<Set<string>> {
  const all = await readJsonFile<Checks>(FILE(), {}).catch(() => ({} as Checks));
  const mine = all[taskId] ?? {};
  return new Set(Object.keys(mine).filter((id) => mine[id] === hisAt));
}

/** Record that the node was named these threads for his message at `hisAt`. */
export async function markChecked(taskId: string, threadIds: readonly string[], hisAt: string): Promise<void> {
  if (!threadIds.length) return;
  await updateJsonFile<Checks>(FILE(), {}, (all) => {
    const mine = { ...(all[taskId] ?? {}) };
    for (const id of threadIds) { delete mine[id]; mine[id] = hisAt; }
    const ids = Object.keys(mine);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PER_TASK))) delete mine[id];
    delete all[taskId];
    all[taskId] = mine;
    const tasks = Object.keys(all);
    for (const t of tasks.slice(0, Math.max(0, tasks.length - MAX_TASKS))) delete all[t];
    return all;
  }).catch(() => {});
}
