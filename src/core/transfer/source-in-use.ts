/**
 * Is a task still in use, so a handoff must not close it?
 *
 * 2026-10-28: a lead found a task's session refusing messages (the user had it
 * open in a terminal), took the task for broken, moved its work to a new task and
 * completed the one the user was working in. A handoff from a session now leaves
 * the source open when any of these holds:
 *   - a person sent it a message in the last week (console, phone, CLI, a letter);
 *   - its session was found open in another process in the last week (a
 *     terminal's `claude -r`, the user's most often);
 *   - it leads work: open subtasks, an org role, or an armed trigger.
 * Never throws: a fact that cannot be read counts as absent.
 */

import type { Task } from '../types.js';

/** How long a person's message or a terminal holding the session keeps a task in use. */
export const IN_USE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type InUseCode = 'user_wrote' | 'open_in_terminal' | 'open_subtasks' | 'org_role' | 'armed_triggers';

export interface InUseReason {
  code: InUseCode;
  /** Plain words, for the op outcome and the log. */
  text: string;
}

const recent = (iso: string | undefined, now: number) => {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) && now - at <= IN_USE_WINDOW_MS;
};

/**
 * `callerSid`: the session asking. When it is the source's own session, the user's
 * activity there is the ask itself ("move this to Codex"), so only the work the
 * task leads keeps it open.
 */
export async function sourceInUse(task: Task, callerSid?: string, now = Date.now()): Promise<InUseReason[]> {
  const out: InUseReason[] = [];
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const all = await getSessionsForTask(task.id).catch(() => []);
    const sessions = callerSid && all.some((s) => s.claudeSessionId === callerSid) ? [] : all;
    const wrote = sessions.map((s) => s.humanInputAt).filter((at) => recent(at, now)).sort().pop();
    if (wrote) out.push({ code: 'user_wrote', text: `the user wrote in it at ${wrote}` });
    const held = sessions.map((s) => s.heldElsewhere).filter((h) => h && recent(h.at, now))
      .sort((a, b) => a!.at.localeCompare(b!.at)).pop();
    if (held) {
      out.push({
        code: 'open_in_terminal',
        text: held.holder === 'terminal'
          ? `its session was open in a terminal at ${held.at}${held.pid ? ` (pid ${held.pid})` : ''}`
          : `its session was open in another Walnut at ${held.at}`,
      });
    }
  } catch { /* sessions unreadable: no session fact */ }
  if (task.org_role) out.push({ code: 'org_role', text: `it is the ${task.org_role} of the org` });
  try {
    const { listOpenSubtasks } = await import('../sessions/open-items.js');
    const { subtasks, more } = await listOpenSubtasks(task.id);
    const n = subtasks.length + more;
    if (n > 0) out.push({ code: 'open_subtasks', text: `it has ${n} open subtask${n === 1 ? '' : 's'}` });
  } catch { /* no subtask fact */ }
  try {
    const { triggersWatching } = await import('../task-wait-until.js');
    const armed = (await triggersWatching(task.id)).filter((t) => t.state === 'armed').length;
    if (armed > 0) out.push({ code: 'armed_triggers', text: `it has ${armed} armed trigger${armed === 1 ? '' : 's'}` });
  } catch { /* no trigger fact */ }
  return out;
}
