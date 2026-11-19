/**
 * Walnut's knowledge folder: what agents read as standing knowledge, one place, one format
 * (Markdown), separate from the user's own notes (2026-11-19, the user: "I want a unified way, to
 * store all these ... we can have an artifacts folder, which has skills, memory?"; the lead picked
 * the recommended layout for him).
 *
 *   WALNUT_HOME/knowledge/
 *     org/skills/<name>/SKILL.md          the org's skills (every session may read them)
 *     nodes/<taskId>/MEMORY.md            a node's MEMORY.md (a copy: the task record stays its source)
 *     nodes/<taskId>/guidance.md          the team guidance its reflection writes
 *     nodes/<taskId>/reflections/<d>.md   its reflection's day records
 *     nodes/<taskId>/skills/<name>/SKILL.md  its own skills
 *     nodes/<taskId>/notes/*.md           its memory folder (Walnut's moved prompt blocks, its own notes)
 *     shared/notes/*.md                   the memory folder every session shares
 *     .backup/<stamp>/                    what the move copied from, untouched (migrate.ts)
 *
 * The places before it (agent-skills/*.json, agent-memory/<taskId>/) are still written beside it,
 * so the release before this one reads the same skills and notes (migrate.ts says how to go back).
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHARED_KEY = '_shared';

export const knowledgeDir = (): string => path.join(WALNUT_HOME, 'knowledge');

/** One node's folder. Throws on an id that is no task id (a path, a placeholder). */
export function nodeKnowledgeDir(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  return path.join(knowledgeDir(), 'nodes', taskId);
}

/** A skills folder: the org's, or one task's own. */
export const skillsDirOf = (scope: 'own' | 'org', taskId: string): string =>
  scope === 'org' ? path.join(knowledgeDir(), 'org', 'skills') : path.join(nodeKnowledgeDir(taskId), 'skills');

/** A memory folder: a task's, or the shared one (no task, or SHARED_KEY). */
export const notesDirOf = (taskId: string | null | undefined): string => {
  const key = taskId && taskId.trim() ? taskId.trim() : SHARED_KEY;
  return key === SHARED_KEY ? path.join(knowledgeDir(), 'shared', 'notes') : path.join(nodeKnowledgeDir(key), 'notes');
};

export const memoryCopyOf = (taskId: string): string => path.join(nodeKnowledgeDir(taskId), 'MEMORY.md');

/** The places before the knowledge folder, still written for the release before this one. */
export const legacySkillsFileOf = (scope: 'own' | 'org', taskId: string): string =>
  path.join(WALNUT_HOME, 'agent-skills', `${scope === 'org' ? '_org' : taskId}.json`);
export const legacyNotesDirOf = (taskId: string | null | undefined): string =>
  path.join(WALNUT_HOME, 'agent-memory', taskId && taskId.trim() ? taskId.trim() : SHARED_KEY);
