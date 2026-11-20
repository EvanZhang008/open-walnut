/**
 * Going back to a release before the artifacts folder was the only place (migrate.ts): write what
 * the folder holds back to the places those releases read, so they start with every skill, note and
 * MEMORY.md as this one left them. Run with Walnut stopped (`bun scripts/artifacts-rollback.ts`),
 * then start the older release.
 *
 *   artifacts/{org,nodes/<id>}/skills/<name>/SKILL.md  -> agent-skills/{_org,<id>}.json
 *   artifacts/{shared,nodes/<id>}/notes/*.md           -> agent-memory/{_shared,<id>}/
 *   artifacts/nodes/<id>/MEMORY.md                     -> the task row's agent_memory
 *   artifacts/ (skills, notes, guidance, reflections)  -> knowledge/, the folder's first name
 *
 * Each MEMORY.md moves to `artifacts/.backup/rolled-back/<stamp>/` once its row holds it, so coming
 * forward again takes the row whole (the older release may have rewritten it) instead of merging it
 * with a version from before the roll back. `.moved.json` goes back to version 1, so the next start
 * of this release backs everything up again first.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeJsonFile, writeTextFile } from '../../utils/fs.js';
import type { Task } from '../types.js';
import {
  artifactsDir, legacyArtifactsDir, legacyNotesDirOf, legacySkillsFileOf, memoryCopyOf, NOTE_NAME_RE, notesDirOf, skillsDirOf,
  SKILL_NAME_RE, TASK_ID_RE,
} from './paths.js';
import { readSkillDir } from './skill-files.js';
import { readMemoryFileAt } from './node-memory.js';

export interface RollbackReport { skillScopes: number; notes: number; memories: number; skipped: string[] }

/** The release before read this much of the folder under its first name; MEMORY.md and drawings it never had. */
const keepsOnRollback = (rel: string): boolean =>
  !rel.startsWith('.backup') && !rel.endsWith('.lock') && !/(^|\/)MEMORY\.md$/.test(rel) && !/(^|\/)drawings(\/|$)/.test(rel);

export async function rollbackArtifacts(): Promise<RollbackReport> {
  const report: RollbackReport = { skillScopes: 0, notes: 0, memories: 0, skipped: [] };
  const nodes = (await fsp.readdir(path.join(artifactsDir(), 'nodes')).catch(() => [] as string[])).filter((n) => TASK_ID_RE.test(n));

  // Skills, each scope as one JSON file.
  for (const [scope, key] of [['org', '_org'] as const, ...nodes.map((id) => ['own', id] as const)]) {
    const skills = await readSkillDir(skillsDirOf(scope, key), SKILL_NAME_RE);
    if (!skills) continue;
    await writeJsonFile(legacySkillsFileOf(scope, key), { version: 1, skills });
    report.skillScopes++;
  }

  // Memory folders, file by file.
  for (const key of [null, ...nodes]) {
    const from = notesDirOf(key);
    for (const name of (await fsp.readdir(from).catch(() => [] as string[])).filter((n) => NOTE_NAME_RE.test(n))) {
      await writeTextFile(path.join(legacyNotesDirOf(key), name), await fsp.readFile(path.join(from, name), 'utf-8'));
      report.notes++;
    }
  }

  // The folder under its first name, for the release that read it there: a real folder again, not
  // the link this release leaves (migrate.ts linkFirstName), which a copy would write through.
  if ((await fsp.lstat(legacyArtifactsDir()).catch(() => null))?.isSymbolicLink()) await fsp.unlink(legacyArtifactsDir());
  await fsp.cp(artifactsDir(), legacyArtifactsDir(), {
    recursive: true, force: true,
    filter: (src) => { const rel = path.relative(artifactsDir(), src).split(path.sep).join('/'); return !rel || keepsOnRollback(rel); },
  });

  // MEMORY.md, back onto each task's row, then out of the folder.
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  const moved = path.join(artifactsDir(), '.backup', 'rolled-back', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const id of nodes) {
    const read = await readMemoryFileAt(memoryCopyOf(id));
    if (read.format === 'none') continue;
    const { ops: _ops, ...memory } = read.memory;
    if (!(await getTask(id).catch(() => null))) { report.skipped.push(id); continue; }
    await updateTaskRaw(id, { agent_memory: memory } as Partial<Task>);
    await fsp.mkdir(path.join(moved, id), { recursive: true });
    await fsp.rename(memoryCopyOf(id), path.join(moved, id, 'MEMORY.md'));
    report.memories++;
  }

  for (const dir of [artifactsDir(), legacyArtifactsDir()]) {
    const marker = path.join(dir, '.moved.json');
    const was = await readJsonFile<Record<string, unknown> | null>(marker, null).catch(() => null);
    if (was) await writeJsonFile(marker, { ...was, version: 1, rolled_back_at: new Date().toISOString() });
  }
  return report;
}
