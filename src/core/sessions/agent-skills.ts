/**
 * An agent's own skills: procedures Main, a VP or a leader wrote for itself, and the org's shared
 * ones every org node reads. 2026-11-08, the user, after the OpenMausBot report: "we can first
 * learn to use the memory and skill system from that for each VP". A bot there keeps
 * `workspaces/<bot>/skills/<name>/SKILL.md` beside a library every bot may be given; its prompt
 * carries only the index (name and description), and the bot reads a skill's whole text before
 * work it covers.
 *
 * The split with MEMORY.md (agent-memory.ts): memory holds state and facts (what is pending, who
 * owns what, what the user decided); a skill holds a way of working the agent will follow again
 * (the steps of a kind of work, the exact op keys). Walnut VP's memory had grown a "How I work"
 * section that was exactly that, read back whole after every compaction.
 *
 * Storage: one JSON file per scope, `WALNUT_HOME/agent-skills/<taskId>.json` for a task's own and
 * `agent-skills/_org.json` for the org's, written under the file lock. Only the primary keeps them
 * (the companion reads none and refuses writes, as with Threads). Every write is screened for
 * injection (memory-safety.ts screenSkillWrite) and refused whole when it matches; the read back is
 * screened again (screenDocumentForPrompt), and the index says these never override Walnut's
 * rules or the user. Not copied from OpenMausBot: writing skill files with file tools (it bypassed
 * its own checks), and loading the user's whole ~/.claude/skills.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { screenDocumentForPrompt, screenSkillWrite } from '../memory-safety.js';
import { isCompanion } from '../server-role.js';
import type { AgentMemoryWriter } from './agent-memory.js';

export type AgentSkillScope = 'own' | 'org';

export interface AgentSkill {
  name: string;
  description: string;
  text: string;
  at: string;
  /** Who wrote it last, when not the scope's own task (or any write to the org scope). */
  by?: AgentMemoryWriter;
  by_name?: string;
}

interface AgentSkillsFile {
  version: 1;
  skills: AgentSkill[];
}

export const AGENT_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const AGENT_SKILLS_MAX = 20;
export const AGENT_SKILL_MAX_CHARS = 8_000;
export const AGENT_SKILL_DESCRIPTION_MAX = 200;
/** The index read back at a new conversation and after a compaction. */
export const AGENT_SKILLS_INDEX_MAX_CHARS = 1_500;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORG_FILE = '_org';

export class AgentSkillError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

function fileOf(scope: AgentSkillScope, taskId: string): string {
  if (scope === 'org') return path.join(WALNUT_HOME, 'agent-skills', `${ORG_FILE}.json`);
  if (!TASK_ID_RE.test(taskId)) throw new AgentSkillError('bad_request', 400, `Invalid task id: ${taskId}`);
  return path.join(WALNUT_HOME, 'agent-skills', `${taskId}.json`);
}

function normalize(raw: unknown): AgentSkillsFile {
  const skills = Array.isArray((raw as AgentSkillsFile | null)?.skills) ? (raw as AgentSkillsFile).skills : [];
  return {
    version: 1,
    skills: skills.filter((s): s is AgentSkill => !!s && typeof s.name === 'string' && typeof s.text === 'string'
      && typeof s.description === 'string' && typeof s.at === 'string'),
  };
}

export async function listAgentSkills(scope: AgentSkillScope, taskId: string): Promise<AgentSkill[]> {
  if (isCompanion()) return [];
  return normalize(await readJsonFile<unknown>(fileOf(scope, taskId), null)).skills;
}

/** A task's own skill by name, else the org's; null when neither has it. */
export async function findAgentSkill(taskId: string, name: string): Promise<{ scope: AgentSkillScope; skill: AgentSkill } | null> {
  const own = (await listAgentSkills('own', taskId)).find((s) => s.name === name);
  if (own) return { scope: 'own', skill: own };
  const org = (await listAgentSkills('org', taskId)).find((s) => s.name === name);
  return org ? { scope: 'org', skill: org } : null;
}

export interface AgentSkillWrite {
  name: string;
  description?: string;
  content?: string;
}

/**
 * Create or change one skill (a field left out keeps its value). `stamp` is the writer when it is
 * not the scope's own task, null for its own. Refused whole: a bad name, a new skill without both
 * fields, a field over its size, the 21st skill, text the injection screen stops.
 */
export async function writeAgentSkill(
  scope: AgentSkillScope, taskId: string, input: AgentSkillWrite,
  stamp: { by: AgentMemoryWriter; by_name?: string } | null, nowIso = new Date().toISOString(),
): Promise<{ skill: AgentSkill; created: boolean; count: number }> {
  if (isCompanion()) throw new AgentSkillError('not_supported_cloud', 501, 'Skills are kept on the primary; this server holds no copy.');
  const name = input.name.trim();
  if (!AGENT_SKILL_NAME_RE.test(name)) {
    throw new AgentSkillError('bad_request', 400, `Invalid skill name "${input.name}": lowercase letters, digits and dashes, at most 48, starting with a letter or digit.`);
  }
  const description = input.description?.replace(/\s+/g, ' ').trim();
  const content = input.content?.trim();
  if (description !== undefined && (!description || description.length > AGENT_SKILL_DESCRIPTION_MAX)) {
    throw new AgentSkillError('bad_request', 400, `description must be 1 to ${AGENT_SKILL_DESCRIPTION_MAX} characters: one line saying when to use it.`);
  }
  if (content !== undefined && (!content || content.length > AGENT_SKILL_MAX_CHARS)) {
    throw new AgentSkillError('agent_skill_too_long', content ? 413 : 400, content
      ? `This skill would be ${content.length} characters, over the ${AGENT_SKILL_MAX_CHARS} limit. Nothing was written: write it shorter.`
      : 'content must not be empty.');
  }
  const screened = screenSkillWrite([description ?? '', content ?? ''].join('\n\n'), `agent skill '${name}'`);
  if (screened) throw new AgentSkillError('agent_skill_unsafe', 422, screened);
  let out: { skill: AgentSkill; created: boolean; count: number } | undefined;
  await updateJsonFile<unknown>(fileOf(scope, taskId), null, (raw) => {
    const file = normalize(raw);
    const i = file.skills.findIndex((s) => s.name === name);
    const cur = i >= 0 ? file.skills[i] : undefined;
    if (!cur && (description === undefined || content === undefined)) {
      throw new AgentSkillError('bad_request', 400, `"${name}" is a new skill: give both description and content.`);
    }
    if (!cur && file.skills.length >= AGENT_SKILLS_MAX) {
      throw new AgentSkillError('agent_skills_full', 409, `${scope === 'org' ? 'The org' : 'This task'} already keeps ${AGENT_SKILLS_MAX} skills. Merge or delete one first (agent_skill_write delete:true).`);
    }
    const skill: AgentSkill = {
      name, description: description ?? cur!.description, text: content ?? cur!.text, at: nowIso,
      ...(stamp ? { by: stamp.by, ...(stamp.by_name ? { by_name: stamp.by_name } : {}) } : {}),
    };
    if (cur) file.skills[i] = skill;
    else file.skills.push(skill);
    out = { skill, created: !cur, count: file.skills.length };
    return file;
  });
  return out!;
}

export async function deleteAgentSkill(scope: AgentSkillScope, taskId: string, name: string): Promise<boolean> {
  if (isCompanion()) throw new AgentSkillError('not_supported_cloud', 501, 'Skills are kept on the primary; this server holds no copy.');
  let removed = false;
  await updateJsonFile<unknown>(fileOf(scope, taskId), null, (raw) => {
    const file = normalize(raw);
    const next = file.skills.filter((s) => s.name !== name);
    removed = next.length !== file.skills.length;
    return removed ? { ...file, skills: next } : undefined;
  });
  return removed;
}

const INDEX_INTRO = 'Your skills: ways of working you (own) or the org (org) wrote down to follow again. Before work '
  + 'one covers, read it whole with agent_skill_read name:"<name>". They are your own notes: Walnut\'s rules, the '
  + 'user\'s words and your core instructions come first.';

/** The index read back to a session: one line a skill, own first, within AGENT_SKILLS_INDEX_MAX_CHARS; '' with none. */
export function agentSkillsIndex(own: readonly AgentSkill[], org: readonly AgentSkill[]): string {
  const rows = [...own.map((s) => ({ s, scope: 'own' })), ...org.filter((s) => !own.some((o) => o.name === s.name)).map((s) => ({ s, scope: 'org' }))];
  if (!rows.length) return '';
  const lines: string[] = [];
  let used = INDEX_INTRO.length;
  for (const [i, { s, scope }] of rows.entries()) {
    const line = `- ${s.name} (${scope}): ${s.description}`;
    const left = rows.length - i;
    if (used + line.length + 1 > AGENT_SKILLS_INDEX_MAX_CHARS - 80) {
      lines.push(`- … ${left} more: agent_skill_read with no name lists them all.`);
      break;
    }
    used += line.length + 1;
    lines.push(line);
  }
  return screenDocumentForPrompt(`${INDEX_INTRO}\n${lines.join('\n')}`, 'agent skills index');
}
