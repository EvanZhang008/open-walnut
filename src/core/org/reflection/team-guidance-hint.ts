/**
 * Team guidance reaches the sessions a node manages (2026-11-19, the user's lead, for the user:
 * "the sessions under a VP read it when they start and after every compaction"): the built-in
 * message hint `team-guidance` (hints/hint-registry.ts) carries the guidance lines of the task's
 * manager (team.ts managerOf), written by its reflection (records.ts). A session whose manager
 * has none hears nothing. Read on the hint's own triggers only, never every turn.
 *
 * The same hint names the org's skills to a session that is no org node (2026-11-19: the org skill
 * registry reached only Main and the VPs, which read its index in their own read-back; a worker had
 * no way to know a skill the reflection wrote for it): one line a skill, read whole with
 * agent_skill_read.
 */
import type { Task } from '../../types.js';
import { screenDocumentForPrompt } from '../../memory-safety.js';
import { guidanceFileOf, readGuidance } from './records.js';

export interface TeamGuidanceState {
  /** The managing node's lines; none when it has no manager or the manager wrote none. */
  node?: string;
  lines: string[];
  file?: string;
  /** The org's skills, for a session that is no org node. */
  skills?: Array<{ name: string; description: string }>;
}

/**
 * Room the hint text keeps: the head lines, then where the rest is. The hint rides a session's start,
 * its compactions and a change of the lines, never every turn, so it may hold a full guidance
 * (2026-11-23 audit: at 1,800 characters a node's 12 lines filled it, and every lesson after them
 * was dropped as "not added").
 */
const TEXT_ROOM = 3600;
/** With skills to name, the guidance leaves them at least this much of the room: lessons come first. */
const SKILLS_ROOM_MIN = 300;
/** The org's skills are read again at most this often: the hint's identity is checked at every send. */
const ORG_SKILLS_TTL_MS = 60_000;
let orgSkillsCache: { at: number; skills: Array<{ name: string; description: string }> } | null = null;

async function orgSkills(taskId: string): Promise<Array<{ name: string; description: string }>> {
  if (orgSkillsCache && Date.now() - orgSkillsCache.at < ORG_SKILLS_TTL_MS) return orgSkillsCache.skills;
  const { listAgentSkills } = await import('../../sessions/agent-skills.js');
  const skills = (await listAgentSkills('org', taskId).catch(() => [])).map((s) => ({ name: s.name, description: s.description }));
  orgSkillsCache = { at: Date.now(), skills };
  return skills;
}

const isNode = (t: Task): boolean => t.org_role === 'main' || t.org_role === 'lead';

export async function teamGuidanceFor(task: Task | undefined | null): Promise<TeamGuidanceState | null> {
  if (!task) return null;
  // Read on demand: the hint registry loads this file, and the org's modules must not load with it.
  const [{ orgTasks }, { orgDisplayTitle }, { managerOf }] = await Promise.all([
    import('../org-store.js'), import('../org-tree.js'), import('./team.js'),
  ]);
  const manager = managerOf(task, await orgTasks());
  const lines = manager ? (await readGuidance(manager.id)).map((l) => l.text) : [];
  const skills = isNode(task) || task.walnut_agent ? [] : await orgSkills(task.id);
  if (!lines.length && !skills.length) return null;
  return {
    lines,
    ...(manager && lines.length ? { node: orgDisplayTitle(manager), file: guidanceFileOf(manager.id) } : {}),
    ...(skills.length ? { skills } : {}),
  };
}

/** What changes the hint's text: told again when it changes. */
export function teamGuidanceIdentity(s: TeamGuidanceState): string {
  return [...s.lines, ...(s.skills ?? []).map((k) => `skill ${k.name}: ${k.description}`)].join('\n');
}

function fit(rows: string[], room: number, more: (left: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (const [i, row] of rows.entries()) {
    if (used + row.length + 1 > room) {
      out.push(more(rows.length - i));
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  return out;
}

const guidanceHead = (node: string | undefined): string => `Team guidance from ${node}: lessons its reflection took from this team's sessions. Follow them; the user's own words win.`;

/**
 * Characters still free for guidance lines so that every line shows in the hint of a session that is
 * also told the org's skills (the tightest case), or less than 0 when some line already falls out
 * (guidance-merge.ts: a merge never grows the lines past it). Pure.
 */
export function guidanceRoomLeft(nodeName: string, lines: readonly string[]): number {
  const room = TEXT_ROOM - SKILLS_ROOM_MIN - guidanceHead(nodeName).length;
  return room - lines.reduce((n, l) => n + l.length + 3, 0);
}

export function teamGuidanceText(s: TeamGuidanceState): string {
  const out: string[] = [];
  if (s.lines.length) {
    const head = guidanceHead(s.node);
    const room = TEXT_ROOM - (s.skills?.length ? SKILLS_ROOM_MIN : 0) - head.length;
    out.push(head, ...fit(s.lines.map((l) => `- ${l}`), room, (n) => `- ... ${n} more in ${s.file}`));
  }
  if (s.skills?.length) {
    const head = 'Org skills: ways of working the org wrote down. Before work one covers, read it through: agent_skill_read name:"<name>".';
    const used = out.join('\n').length;
    const room = TEXT_ROOM - used - head.length - 1;
    out.push(head, ...fit(s.skills.map((k) => `- ${k.name}: ${k.description}`), room, (n) => `- ... ${n} more: agent_skill_read with no name lists them.`));
  }
  // Both files can be edited by hand (guidance.md, a SKILL.md's description): screened as the skills index is.
  return screenDocumentForPrompt(out.join('\n'), 'team guidance');
}
