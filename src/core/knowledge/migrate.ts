/**
 * The move into Walnut's knowledge folder (paths.ts), run by the primary at every boot.
 *
 * First boot: the folders it moves from (`agent-skills/`, `agent-memory/`) are copied whole to
 * `knowledge/.backup/<stamp>/` before anything is read, and `knowledge/.moved.json` records it.
 * Every boot: each skills scope and each memory-folder file is brought in line where the place it
 * moved from holds something else and was written later (never moved yet, or the release before
 * this one wrote it after a roll back); the knowledge folder's own newer files are never overwritten. Then each node's MEMORY.md
 * is copied to `knowledge/nodes/<id>/MEMORY.md`, and kept current while the server runs: the task
 * record stays the memory's source (offline hosts and older clients write it), the file is for
 * reading it beside the rest.
 *
 * Going back: the release before reads `agent-skills/*.json` and `agent-memory/`, which this one
 * keeps writing, so it starts as it was. To take the folder away too, remove `knowledge/org/skills`,
 * `knowledge/shared`, `knowledge/nodes/<id>/{skills,notes,MEMORY.md}` and `knowledge/.moved.json`
 * (guidance.md and reflections/ belong to the reflection duty); the backup holds the old folders as
 * they were at the move.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { fileMtimeMs as mtime, writeTextFile } from '../../utils/fs.js';
import type { Task } from '../types.js';
import { knowledgeDir, memoryCopyOf, notesDirOf, SHARED_KEY, skillsDirOf, TASK_ID_RE } from './paths.js';


export interface MoveReport { backup: string | null; skillScopes: number; skills: number; notes: number; memories: number }


async function backupOnce(): Promise<string | null> {
  const marker = path.join(knowledgeDir(), '.moved.json');
  if (await fsp.stat(marker).catch(() => null)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(knowledgeDir(), '.backup', stamp);
  for (const name of ['agent-skills', 'agent-memory']) {
    const from = path.join(WALNUT_HOME, name);
    if (!(await fsp.stat(from).catch(() => null))) continue;
    await fsp.cp(from, path.join(dest, name), { recursive: true, filter: (src) => !src.endsWith('.lock') });
  }
  await fsp.mkdir(knowledgeDir(), { recursive: true });
  await fsp.writeFile(marker, `${JSON.stringify({ version: 1, at: new Date().toISOString(), backup: path.relative(knowledgeDir(), dest) }, null, 2)}\n`, 'utf-8');
  return dest;
}

async function moveSkills(report: MoveReport): Promise<void> {
  const { moveAgentSkillScope } = await import('../sessions/agent-skills.js');
  const files = (await fsp.readdir(path.join(WALNUT_HOME, 'agent-skills')).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  for (const f of files) {
    const key = f.slice(0, -'.json'.length);
    const scope = key === '_org' ? 'org' : 'own';
    if (scope === 'own' && !TASK_ID_RE.test(key)) continue;
    try {
      const had = !!(await fsp.stat(skillsDirOf(scope, key)).catch(() => null));
      const n = await moveAgentSkillScope(scope, key);
      if (n || !had) { report.skillScopes++; report.skills += n; }
    } catch (err) {
      log.memory.warn('knowledge move: a skills scope was not moved', { scope: key, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function moveNotes(report: MoveReport): Promise<void> {
  const { MEMORY_FILE_NAME_RE } = await import('../sessions/memory-folder.js');
  const root = path.join(WALNUT_HOME, 'agent-memory');
  for (const key of await fsp.readdir(root).catch(() => [] as string[])) {
    if (key !== SHARED_KEY && !TASK_ID_RE.test(key)) continue;
    const from = path.join(root, key);
    const to = notesDirOf(key);
    for (const name of (await fsp.readdir(from).catch(() => [] as string[])).filter((n) => MEMORY_FILE_NAME_RE.test(n))) {
      try {
        // Only a file that differs, and was written after the knowledge folder's copy (or has none).
        const [a, b] = await Promise.all([mtime(path.join(from, name)), mtime(path.join(to, name))]);
        if (!a || (b && a <= b)) continue;
        if (b && (await fsp.readFile(path.join(from, name))).equals(await fsp.readFile(path.join(to, name)))) continue;
        await fsp.mkdir(to, { recursive: true });
        await fsp.copyFile(path.join(from, name), path.join(to, name));
        report.notes++;
      } catch (err) {
        log.memory.warn('knowledge move: a memory folder file was not moved', { folder: key, file: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

/** A node's MEMORY.md as its copy in the knowledge folder reads. Pure. */
export function memoryCopyText(task: Pick<Task, 'id' | 'title' | 'agent_memory'>): string {
  const m = task.agent_memory!;
  return `<!-- Walnut keeps this file: a copy of the MEMORY.md of "${task.title.replace(/-->/g, '')}" (${task.id}) as of ${m.at}. `
    + 'It is written again when the memory changes; change the memory through Walnut (the node\'s Memory & instructions panel, or agent_memory_write). -->\n\n'
    + `${m.text.trim()}\n`;
}

/** The memory each copy holds (its `at`, '' for none), and the write in flight per task, one at a time. */
const copied = new Map<string, string>();
const copying = new Map<string, Promise<boolean>>();

async function writeCopy(task: Pick<Task, 'id' | 'title' | 'agent_memory'>): Promise<boolean> {
  const m = task.agent_memory;
  const at = m?.text?.trim() ? m.at : '';
  if (copied.get(task.id) === at) return false;
  try {
    const file = memoryCopyOf(task.id);
    if (!at) {
      // The memory was cleared: so is its copy.
      await fsp.rm(file, { force: true });
    } else {
      const text = memoryCopyText(task);
      if ((await fsp.readFile(file, 'utf-8').catch(() => null)) !== text) await writeTextFile(file, text);
    }
    copied.set(task.id, at);
    return !!at;
  } catch (err) {
    log.memory.warn('knowledge: MEMORY.md copy not written', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Write a task's MEMORY.md copy when its memory changed since the last copy, after the one in flight. Never throws. */
export function copyMemory(task: Pick<Task, 'id' | 'title' | 'agent_memory'>): Promise<boolean> {
  if (!TASK_ID_RE.test(task.id) || (!task.agent_memory && !copied.get(task.id))) return Promise.resolve(false);
  const run = (copying.get(task.id) ?? Promise.resolve(false)).then(() => writeCopy(task));
  copying.set(task.id, run);
  void run.finally(() => { if (copying.get(task.id) === run) copying.delete(task.id); });
  return run;
}

/** A deleted task's copy goes with it (memory-folder.ts removeMemoryFolder). */
export function forgetMemoryCopy(taskId: string): void {
  copied.delete(taskId);
}

/** The whole move. Each step is on its own: one that fails is logged and the others still run. */
export async function moveIntoKnowledge(tasks: readonly Task[]): Promise<MoveReport> {
  const report: MoveReport = { backup: null, skillScopes: 0, skills: 0, notes: 0, memories: 0 };
  try {
    report.backup = await backupOnce();
  } catch (err) {
    // No backup, no move: the old folders stay the only copy until a boot can make one.
    log.memory.warn('knowledge move: the backup failed, nothing moved', { error: err instanceof Error ? err.message : String(err) });
    return report;
  }
  await moveSkills(report);
  await moveNotes(report);
  for (const t of tasks) if (await copyMemory(t)) report.memories++;
  return report;
}

let following = false;

/** The primary's boot: the move, then each node's MEMORY.md copy kept current. Idempotent. */
export async function startKnowledge(): Promise<void> {
  if (following) return;
  following = true;
  const [{ listTasks }, { bus, EventNames }] = await Promise.all([import('../task-manager.js'), import('../event-bus.js')]);
  // Followed first, so a memory written while the move runs is copied too (copies of one task run one at a time).
  bus.subscribe('knowledge-memory-copy', (e) => {
    const task = (e.data as { task?: Task | null } | null)?.task;
    if (task) void copyMemory(task);
  }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_CREATED] });
  const report = await moveIntoKnowledge(await listTasks().catch(() => [] as Task[]));
  log.memory.info('knowledge: in line', { ...report });
}
