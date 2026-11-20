/**
 * The move into Walnut's artifacts folder (paths.ts). Since 2026-11-20 the folder is the only place
 * (the user: "only use now location please, migrate all"): nothing writes the places before it, and
 * what is still found there is taken in and moved out.
 *
 * The places before: `agent-skills/<key>.json` (a scope's skills), `agent-memory/<key>/*.md` (a
 * memory folder), a task row's `agent_memory` (its MEMORY.md), and the folder's own first name,
 * `knowledge/`, renamed to `artifacts/` first thing at boot (takeLegacyFolder). Who can still write them: an
 * older release after a roll back, and a sync that brings a row an older box wrote. So they are an
 * inbox, emptied at every boot and before any read or write of what they hold:
 *   - a skill: added where the folder lacks it, or replaces the folder's when it differs and is the
 *     later; a folder's skill is never removed by it
 *   - a note: copied where the folder lacks it, or when it differs and is the later
 *   - a MEMORY.md: merged with the file (mergeMemories), never losing a line of either
 * Each is then moved to `artifacts/.backup/taken/<stamp>/` (a row's memory is cleared only once its
 * file holds it), so nothing is lost and the same thing is never taken twice.
 *
 * Backup: before the first boot of this release touches anything, the whole of what it starts from
 * (both old folders, the artifacts folder, every row's memory in memories.json) is copied to
 * `artifacts/.backup/<stamp>/`; `.moved.json` (version 2) records it.
 *
 * Going back: rollback.ts writes the artifacts folder back to the old places
 * (`bun scripts/artifacts-rollback.ts`, Walnut stopped; docs/reference/artifacts-folder.md).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { fileMtimeMs, readJsonFile, writeTextFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import type { Task } from '../types.js';
import type { AgentMemory } from '../sessions/agent-memory.js';
import { artifactsDir, legacyArtifactsDir, legacyNotesDirOf, legacySkillsFileOf, NOTE_NAME_RE, notesDirOf, SHARED_KEY, skillsDirOf, SKILL_NAME_RE, TASK_ID_RE } from './paths.js';
import { markSkillDirMoved, readSkillDir, writeSkillFile, type SkillFile } from './skill-files.js';
import type { StoredMemory } from './node-memory.js';

export interface MoveReport { backup: string | null; renamed: boolean; skillScopes: number; skills: number; notes: number; memories: number }

/** A row as the releases before wrote it: its MEMORY.md on the row. */
export type LegacyTaskRow = Task & { agent_memory?: AgentMemory };

export const MARKER_VERSION = 2;
const markerFile = (): string => path.join(artifactsDir(), '.moved.json');
const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const errText = (err: unknown): string => err instanceof Error ? err.message : String(err);
const exists = async (p: string): Promise<boolean> => !!(await fsp.stat(p).catch(() => null));

/** One folder per server run for what it takes in. */
const RUN_STAMP = stampNow();

/** Where something taken from an old place is kept: `.backup/taken/<run>/<rel>`, never over an earlier one. */
async function keepTaken(from: string, rel: string): Promise<void> {
  let dest = path.join(artifactsDir(), '.backup', 'taken', RUN_STAMP, rel);
  if (await exists(dest)) dest = `${dest}.${Date.now()}`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(from, dest);
  } catch {
    await fsp.cp(from, dest, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** A copy of a file about to be replaced, under `.backup/taken/<run>/<rel>`. */
async function keepCopy(file: string, rel: string): Promise<void> {
  const dest = path.join(artifactsDir(), '.backup', 'taken', RUN_STAMP, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(file, (await exists(dest)) ? `${dest}.${Date.now()}` : dest);
}

// ── backup ────────────────────────────────────────────────────────────────

let backingUp: Promise<string | null> | null = null;

/**
 * The backup, made once before anything is taken from an old place: the boot move and every take
 * on a read wait for it, so the backup holds what was there before any of them. Made again when its
 * record is gone (a roll back sets it back, a test home is new).
 */
let backupSettled = false;

async function backupReady(): Promise<string | null> {
  // One in flight serves every caller; a settled one only while its record is still there.
  if (backingUp && (!backupSettled || (await currentMarkerVersion()) >= MARKER_VERSION)) return backingUp;
  backupSettled = false;
  const run = (async () => {
    const { listTasks } = await import('../task-manager.js');
    return backupOnce(await listTasks().catch(() => [] as Task[]) as LegacyTaskRow[]);
  })();
  backingUp = run;
  run.then(() => { if (backingUp === run) backupSettled = true; }, () => { if (backingUp === run) backingUp = null; });
  return run;
}

const currentMarkerVersion = async (): Promise<number> =>
  (await readJsonFile<{ version?: number } | null>(markerFile(), null).catch(() => null))?.version ?? 0;

async function backupOnce(tasks: readonly LegacyTaskRow[]): Promise<string | null> {
  const marker = await readJsonFile<{ version?: number; backup?: string } | null>(markerFile(), null).catch(() => null);
  if ((marker?.version ?? 0) >= MARKER_VERSION) return null;
  const dest = path.join(artifactsDir(), '.backup', stampNow());
  for (const name of ['agent-skills', 'agent-memory']) {
    const from = path.join(WALNUT_HOME, name);
    if (await exists(from)) await fsp.cp(from, path.join(dest, name), { recursive: true, filter: (src) => !src.endsWith('.lock') });
  }
  // The artifacts folder as it is, its backups aside (a copy into itself is refused).
  for (const name of await fsp.readdir(artifactsDir()).catch(() => [] as string[])) {
    if (name === '.backup' || name.endsWith('.lock')) continue;
    // A clone where the disk can: once the notes are in the folder too (unify/), this is all of them.
    await fsp.cp(path.join(artifactsDir(), name), path.join(dest, 'artifacts', name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (src) => !src.endsWith('.lock') });
  }
  const memories = Object.fromEntries(tasks.filter((t) => t.agent_memory).map((t) => [t.id, t.agent_memory]));
  await writeTextFile(path.join(dest, 'memories.json'), `${JSON.stringify(memories, null, 2)}\n`);
  await writeTextFile(markerFile(), `${JSON.stringify({
    version: MARKER_VERSION, at: new Date().toISOString(), backup: path.relative(artifactsDir(), dest),
    ...(marker?.backup ? { earlier: marker.backup } : {}),
  }, null, 2)}\n`);
  return dest;
}

// ── skills ────────────────────────────────────────────────────────────────

const skillKey = (scope: 'own' | 'org', taskId: string): string => scope === 'org' ? '_org' : taskId;

function legacySkills(raw: unknown): SkillFile[] {
  const skills = (raw as { skills?: unknown } | null)?.skills;
  return (Array.isArray(skills) ? skills : []).filter((s): s is SkillFile => !!s && typeof s.name === 'string'
    && typeof s.text === 'string' && typeof s.description === 'string' && typeof s.at === 'string');
}

/** Whether an older release left a JSON file for a scope. */
export const legacySkillsWaiting = (scope: 'own' | 'org', taskId: string): Promise<boolean> => exists(legacySkillsFileOf(scope, taskId));

/**
 * Take a scope's old JSON file in, the caller holding the scope's lock (agent-skills.ts). Answers
 * how many skills it wrote; 0 when there was no file.
 */
export async function takeLegacySkillsLocked(scope: 'own' | 'org', taskId: string, nameRe: RegExp): Promise<number> {
  const json = legacySkillsFileOf(scope, taskId);
  if (!(await exists(json))) return 0;
  await backupReady();
  const legacy = legacySkills(await readJsonFile<unknown>(json, null)).filter((s) => nameRe.test(s.name));
  const dir = skillsDirOf(scope, taskId);
  const have = new Map(((await readSkillDir(dir, nameRe)) ?? []).map((s) => [s.name, s]));
  const jsonAt = await fileMtimeMs(json);
  let wrote = 0;
  for (const s of legacy) {
    const cur = have.get(s.name);
    if (cur && cur.description === s.description && cur.text.trim() === s.text.trim()) continue;
    // A folder's own later change stays: the JSON's skill is the later only when its file is.
    if (cur && jsonAt <= await fileMtimeMs(path.join(dir, s.name, 'SKILL.md'))) continue;
    // The folder's version it replaces is kept beside what was taken.
    if (cur) await keepCopy(path.join(dir, s.name, 'SKILL.md'), path.join('replaced', scope === 'org' ? 'org' : taskId, 'skills', s.name, 'SKILL.md'));
    await writeSkillFile(dir, s, scope);
    wrote++;
  }
  await markSkillDirMoved(dir);
  await keepTaken(json, path.join('agent-skills', `${skillKey(scope, taskId)}.json`));
  return wrote;
}

async function takeAllSkills(report: MoveReport): Promise<void> {
  const root = path.join(WALNUT_HOME, 'agent-skills');
  for (const f of (await fsp.readdir(root).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))) {
    const key = f.slice(0, -'.json'.length);
    const scope = key === '_org' ? 'org' as const : 'own' as const;
    if (scope === 'own' && !TASK_ID_RE.test(key)) continue;
    try {
      const n = await withFileLock(skillsDirOf(scope, key), () => takeLegacySkillsLocked(scope, key, SKILL_NAME_RE));
      report.skillScopes++;
      report.skills += n;
    } catch (err) {
      log.memory.warn('artifacts move: a skills scope was not taken in', { scope: key, error: errText(err) });
    }
  }
  await removeIfEmpty(root);
}

// ── memory folders ────────────────────────────────────────────────────────

/** The lock a memory folder's writes take (sessions/memory-folder.ts). */
export const notesLockOf = (key: string | null): string => `${notesDirOf(key)}.notes`;

/** Take a memory folder's old files in, the caller holding its lock. Answers how many it copied. */
export async function takeLegacyNotesLocked(key: string | null): Promise<number> {
  const from = legacyNotesDirOf(key);
  const names = await fsp.readdir(from).catch(() => null);
  if (!names) return 0;
  await backupReady();
  const to = notesDirOf(key);
  const k = key && key.trim() ? key.trim() : SHARED_KEY;
  let copied = 0;
  for (const name of names.filter((n) => NOTE_NAME_RE.test(n))) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    const [aAt, bAt] = await Promise.all([fileMtimeMs(a), fileMtimeMs(b)]);
    const same = bAt > 0 && (await fsp.readFile(a)).equals(await fsp.readFile(b));
    if (!same && (!bAt || aAt > bAt)) {
      if (bAt) await keepCopy(b, path.join('replaced', k, 'notes', name));
      await fsp.mkdir(to, { recursive: true });
      await fsp.copyFile(a, b);
      await fsp.utimes(b, new Date(), new Date(aAt));
      copied++;
    }
    await keepTaken(a, path.join('agent-memory', k, name));
  }
  await removeIfEmpty(from);
  return copied;
}

/** The same, taking the folder's lock; a no-op when the old folder is gone. */
export async function takeLegacyNotes(key: string | null): Promise<number> {
  if (!(await exists(legacyNotesDirOf(key)))) return 0;
  return withFileLock(notesLockOf(key), () => takeLegacyNotesLocked(key));
}

async function takeAllNotes(report: MoveReport): Promise<void> {
  const root = path.join(WALNUT_HOME, 'agent-memory');
  for (const key of await fsp.readdir(root).catch(() => [] as string[])) {
    if (key !== SHARED_KEY && !TASK_ID_RE.test(key)) continue;
    try {
      report.notes += await takeLegacyNotes(key === SHARED_KEY ? null : key);
    } catch (err) {
      log.memory.warn('artifacts move: a memory folder was not taken in', { folder: key, error: errText(err) });
    }
  }
  await removeIfEmpty(root);
}

async function removeIfEmpty(dir: string): Promise<void> {
  const left = await fsp.readdir(dir).catch(() => null);
  if (left && left.every((n) => n.endsWith('.lock'))) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ── MEMORY.md ─────────────────────────────────────────────────────────────

const later = (a: string, b: string): string => (Date.parse(a) || 0) >= (Date.parse(b) || 0) ? a : b;

/**
 * The file's memory and a row's old one as one, losing no line of either. Pure. The longer that holds
 * the other whole is kept (an older release appended to it); two that each hold lines the other lacks
 * are kept both, the row's under a heading that says where it came from.
 */
export function mergeMemories(file: StoredMemory | undefined, row: AgentMemory, fileIsCopy = false): StoredMemory {
  const rowWins = (): StoredMemory => ({ ...row, ...(file?.ops ? { ops: file.ops } : {}) });
  // The release before's read copy holds the row's text and none of its fields (its writer, a refusal).
  if (!file || !file.text.trim() || fileIsCopy) return rowWins();
  const a = file.text.trim();
  const b = row.text.trim();
  if (a === b || b.includes(a)) return rowWins();
  if (!b || a.includes(b)) return file;
  return {
    ...file,
    text: `${a}\n\n## Kept from an older Walnut (its MEMORY.md as of ${row.at})\n\n${b}`,
    at: later(file.at, row.at),
  };
}

async function rowOf(taskId: string): Promise<LegacyTaskRow | null> {
  const { getTask } = await import('../task-manager.js');
  return (await getTask(taskId).catch(() => null)) as LegacyTaskRow | null;
}

/** Whether a task's row still carries its MEMORY.md (or an empty one to clear). */
export async function hasLegacyMemory(taskId: string): Promise<boolean> {
  return (await rowOf(taskId))?.agent_memory !== undefined;
}

/**
 * A row's old MEMORY.md merged with the file's (node-memory.ts, under the file's lock), and how to
 * clear it from the row once the file holds it. Null when the row has none.
 */
export async function takeLegacyMemory(taskId: string, file: StoredMemory | undefined, fileIsCopy = false): Promise<{ memory: StoredMemory | undefined; clearRow: () => Promise<void> } | null> {
  const row = (await rowOf(taskId))?.agent_memory;
  if (row === undefined) return null;
  await backupReady();
  const memory = row?.text?.trim() ? mergeMemories(file, row, fileIsCopy) : file;
  const clearRow = async (): Promise<void> => {
    const { updateTaskRaw } = await import('../task-manager.js');
    await updateTaskRaw(taskId, (cur) => {
      const now = (cur as LegacyTaskRow).agent_memory;
      if (now === undefined) return null;
      // Changed since it was read (another old writer): left for the next take.
      if (row && (now?.at !== row.at || now?.text !== row.text)) return null;
      // null clears a field (undefined is no change).
      return { agent_memory: null } as unknown as Partial<Task>;
    });
  };
  return { memory, clearRow };
}

async function takeAllMemories(tasks: readonly LegacyTaskRow[], report: MoveReport): Promise<void> {
  const { changeNodeMemory } = await import('./node-memory.js');
  for (const t of tasks) {
    if (t.agent_memory === undefined || !TASK_ID_RE.test(t.id)) continue;
    try {
      await changeNodeMemory(t.id, () => null);
      report.memories++;
    } catch (err) {
      log.memory.warn('artifacts move: a MEMORY.md was not taken in', { taskId: t.id, error: errText(err) });
    }
  }
}

// ── the folder's first name ───────────────────────────────────────────────

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.endsWith('.lock')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)).map((f) => path.join(e.name, f)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/**
 * The folder's first name, `knowledge/` (2026-11-19 to 11-20): renamed whole when `artifacts/` is not
 * there yet; else each of its files `artifacts/` lacks, or holds an older other version of, comes in
 * (the version it replaces kept), and the old folder is moved to the backups. Answers whether it found one.
 */
async function takeLegacyFolder(): Promise<boolean> {
  const from = legacyArtifactsDir();
  // A real folder only: the link linkFirstName leaves there is the folder itself, and the one
  // tree's folder of links there (unify/boot.ts) points into the tree.
  if (!(await fsp.lstat(from).catch(() => null))?.isDirectory()) return false;
  if (await exists(path.join(from, '.walnut-links'))) return false;
  if (!(await exists(artifactsDir()))) {
    await fsp.rename(from, artifactsDir());
    return true;
  }
  for (const rel of await filesUnder(from)) {
    const a = path.join(from, rel);
    const b = path.join(artifactsDir(), rel);
    const [aAt, bAt] = await Promise.all([fileMtimeMs(a), fileMtimeMs(b)]);
    if (bAt && (aAt <= bAt || (await fsp.readFile(a)).equals(await fsp.readFile(b)))) continue;
    if (bAt) await keepCopy(b, path.join('replaced', rel));
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.copyFile(a, b);
  }
  await keepTaken(from, 'knowledge');
  return true;
}

/**
 * The folder's first name stays a link to the folder (2026-11-20: a note the reflection sent at
 * 03:45 named `knowledge/nodes/<id>/reflections/<day>.md`, and the rename a minute later left it
 * pointing nowhere). A path an earlier message names keeps opening, by an agent's own Read or in
 * the app. Relative, so it holds on every host the data reaches; nothing of Walnut's writes through it.
 */
export async function linkFirstName(): Promise<boolean> {
  const link = legacyArtifactsDir();
  if (await fsp.lstat(link).catch(() => null)) return false;
  if (!(await exists(artifactsDir()))) return false;
  if (process.platform === 'win32') await fsp.symlink(artifactsDir(), link, 'junction');
  else await fsp.symlink(path.basename(artifactsDir()), link);
  return true;
}

// ── the whole move ────────────────────────────────────────────────────────

/** The whole move. Each step is on its own: one that fails is logged and the others still run. */
export async function moveIntoArtifacts(tasks: readonly Task[]): Promise<MoveReport> {
  const rows = tasks as readonly LegacyTaskRow[];
  const report: MoveReport = { backup: null, renamed: false, skillScopes: 0, skills: 0, notes: 0, memories: 0 };
  try {
    report.renamed = await takeLegacyFolder();
  } catch (err) {
    log.memory.warn('artifacts move: the folder\'s first name (knowledge/) was not taken in', { error: errText(err) });
  }
  try {
    await linkFirstName();
  } catch (err) {
    log.memory.warn('artifacts move: the folder\'s first name (knowledge/) was not linked to it', { error: errText(err) });
  }
  try {
    report.backup = (await currentMarkerVersion()) >= MARKER_VERSION ? null : await backupReady();
  } catch (err) {
    // No backup, no move: the old places stay as they are until a boot can make one.
    log.memory.warn('artifacts move: the backup failed, nothing moved', { error: errText(err) });
    return report;
  }
  await takeAllSkills(report);
  await takeAllNotes(report);
  await takeAllMemories(rows, report);
  return report;
}

let started = false;

/** The primary's boot: the move. Idempotent. */
export async function startArtifacts(): Promise<void> {
  if (started) return;
  started = true;
  const { listTasks } = await import('../task-manager.js');
  const report = await moveIntoArtifacts(await listTasks().catch(() => [] as Task[]));
  log.memory.info('artifacts: in line', { ...report });
}
