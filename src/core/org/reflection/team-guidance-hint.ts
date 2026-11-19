/**
 * Team guidance reaches the sessions a node manages (2026-11-19, the user's lead, for the user:
 * "the sessions under a VP read it when they start and after every compaction"): the built-in
 * message hint `team-guidance` (hints/hint-registry.ts) carries the guidance lines of the task's
 * manager (team.ts managerOf), written by its reflection (records.ts). A session whose manager
 * has none hears nothing. Read on the hint's own triggers only, never every turn.
 */
import type { Task } from '../../types.js';
import { guidanceFileOf, readGuidance } from './records.js';

export interface TeamGuidanceState { node: string; lines: string[]; file: string }

/** Room the hint text keeps (HINT_TEXT_MAX is 2000): the head lines, then where the rest is. */
const TEXT_ROOM = 1800;

export async function teamGuidanceFor(task: Task | undefined | null): Promise<TeamGuidanceState | null> {
  if (!task) return null;
  // Read on demand: the hint registry loads this file, and the org's modules must not load with it.
  const [{ orgTasks }, { orgDisplayTitle }, { managerOf }] = await Promise.all([import('../org-store.js'), import('../org-tree.js'), import('./team.js')]);
  const manager = managerOf(task, await orgTasks());
  if (!manager) return null;
  const lines = (await readGuidance(manager.id)).map((l) => l.text);
  return lines.length ? { node: orgDisplayTitle(manager), lines, file: guidanceFileOf(manager.id) } : null;
}

export function teamGuidanceText(s: TeamGuidanceState): string {
  const head = `Team guidance from ${s.node}: lessons its reflection took from this team's sessions. Follow them; the user's own words win.`;
  const out = [head];
  let used = head.length;
  for (const [i, line] of s.lines.entries()) {
    const row = `- ${line}`;
    if (used + row.length + 1 > TEXT_ROOM) {
      out.push(`- ... ${s.lines.length - i} more in ${s.file}`);
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  return out.join('\n');
}
