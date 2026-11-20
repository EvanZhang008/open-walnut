/**
 * Walnut's artifacts folder: one place per task for everything it makes and keeps (2026-11-19, the
 * user: "I want a unified way, to store all these ... we can have an artifacts folder, which has
 * skills, memory?"; 2026-11-20: "each session has a assign location to store all the artifacts ...
 * the folder should be named as artifacts, skills, memory, drawing whatever for that project").
 * Markdown where it can be, apart from the user's own notes.
 *
 *   WALNUT_HOME/artifacts/
 *     org/skills/<name>/SKILL.md             the org's skills (every session may read them)
 *     nodes/<taskId>/MEMORY.md               a task's MEMORY.md (node-memory.ts)
 *     nodes/<taskId>/guidance.md             the team guidance its reflection writes
 *     nodes/<taskId>/reflections/<d>.md      its reflection's day records
 *     nodes/<taskId>/skills/<name>/SKILL.md  its own skills
 *     nodes/<taskId>/notes/*.md              its memory folder (Walnut's moved prompt blocks, its own notes)
 *     nodes/<taskId>/drawings/               its drawings (drawingsDirOf)
 *     shared/notes/*.md, shared/drawings/    what belongs to no one task
 *     .backup/<stamp>/                       the whole of what the move started from, untouched (migrate.ts)
 *
 * By task id, not by project: a task that moves to another project keeps its folder. The only place
 * since 2026-11-20 (the user: "only use now location please, migrate all"). The places before it
 * (agent-skills/*.json, agent-memory/<taskId>/, a task row's agent_memory, and this folder's first
 * name, knowledge/) are never written again: what an older release still writes there is taken in
 * and moved out (migrate.ts), and only migrate.ts and rollback.ts name them
 * (tests/core/artifacts/legacy-places-ratchet.test.ts).
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { homeOfTask, memoryHomeOf } from './unify/task-homes.js';

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHARED_KEY = '_shared';

export const artifactsDir = (): string => path.join(WALNUT_HOME, 'artifacts');

/**
 * Which layout the folder is in: by task id (nodes/, org/, shared/), or the one tree by project
 * (unify/layout.ts: projects/<project>/{skills,memory/<taskId>,drawings}, the root's own for no
 * project), set at boot once the move ran.
 */
let byProject = false;
export const setArtifactsByProject = (on: boolean): void => { byProject = on; };
export const artifactsByProject = (): boolean => byProject;

const checkedId = (taskId: string): string => {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  return taskId;
};

/** One node's folder (its MEMORY.md, notes, guidance, reflections). Throws on an id that is no task id (a path, a placeholder). */
export function nodeArtifactsDir(taskId: string): string {
  const id = checkedId(taskId);
  return byProject ? path.join(artifactsDir(), memoryHomeOf(id)) : path.join(artifactsDir(), 'nodes', id);
}

/** A skills folder: the org's, or one task's own (by project: its project's, which its tasks share). */
export const skillsDirOf = (scope: 'own' | 'org', taskId: string): string => {
  if (scope === 'org') return byProject ? path.join(artifactsDir(), 'skills') : path.join(artifactsDir(), 'org', 'skills');
  if (!byProject) return path.join(nodeArtifactsDir(taskId), 'skills');
  const home = homeOfTask(checkedId(taskId));
  return home ? path.join(artifactsDir(), home, 'skills') : path.join(nodeArtifactsDir(taskId), 'skills');
};

/** A memory folder: a task's, or the shared one (no task, or SHARED_KEY). */
export const notesDirOf = (taskId: string | null | undefined): string => {
  const key = taskId && taskId.trim() ? taskId.trim() : SHARED_KEY;
  if (key !== SHARED_KEY) return path.join(nodeArtifactsDir(key), 'notes');
  return byProject ? path.join(artifactsDir(), 'memory', SHARED_KEY, 'notes') : path.join(artifactsDir(), 'shared', 'notes');
};

export const memoryCopyOf = (taskId: string): string => path.join(nodeArtifactsDir(taskId), 'MEMORY.md');

/** A task's drawings folder, or the shared one (no task). By project: its project's (or the root's) drawings. */
export const drawingsDirOf = (taskId: string | null | undefined): string => {
  const id = taskId && taskId.trim() && taskId.trim() !== SHARED_KEY ? taskId.trim() : null;
  if (!byProject) return id ? path.join(nodeArtifactsDir(id), 'drawings') : path.join(artifactsDir(), 'shared', 'drawings');
  const home = id ? homeOfTask(checkedId(id)) : null;
  return home ? path.join(artifactsDir(), home, 'drawings') : path.join(artifactsDir(), 'drawings');
};

/** A memory-folder note's file name, and a skill's name (its folder's). */
export const NOTE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}\.md$/;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** The places before the artifacts folder: read and emptied by migrate.ts, written only by rollback.ts. */
export const legacyArtifactsDir = (): string => path.join(WALNUT_HOME, 'knowledge');
export const legacySkillsFileOf = (scope: 'own' | 'org', taskId: string): string =>
  path.join(WALNUT_HOME, 'agent-skills', `${scope === 'org' ? '_org' : taskId}.json`);
export const legacyNotesDirOf = (taskId: string | null | undefined): string =>
  path.join(WALNUT_HOME, 'agent-memory', taskId && taskId.trim() ? taskId.trim() : SHARED_KEY);
