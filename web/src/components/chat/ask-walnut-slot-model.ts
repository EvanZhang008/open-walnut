/**
 * The Ask Walnut slot's selection model — pure, no React.
 *
 * The slot on the home page is a view over ORDINARY tasks: every Ask Walnut
 * launch stamps `walnut_agent` on the task it creates and files it under the
 * agent's project ("Ask Walnut" for the Personal AI, "Ask Mentor" for the
 * Mentor agent, …), so the drawer's list is "that agent's asks, most recently
 * used first" and the panel below is the selected task's session. Keeping the
 * decisions here (which agent owns a task, which tasks, which one is selected)
 * means they can be pinned without a DOM: a browser spec can only observe them
 * indirectly, and each one has a silent failure mode (a list that reorders
 * under the cursor, a selection that jumps off the task the user just launched).
 *
 * WHICH TASKS AND IN WHAT ORDER is not decided here either: that is the shared
 * asks-list module (`@open-walnut/ask-list`, src/core/sessions/ask-list.ts),
 * which `GET /api/v1/asks` serves the phone from, so the two drawers cannot
 * drift. This file adapts it to the slot (agents, selection).
 *
 * WHICH SESSION a task's panel mounts is deliberately NOT here — it is
 * `resolveTaskSessionId` in utils/session-status.ts, the one precedence every
 * other surface (board row, dock card, focus locate) already uses.
 */

import type { Task } from '@open-walnut/core';
import {
  GENERAL_AGENT_ID,
  askProjectFor as sharedAskProjectFor,
  compareAsks,
  isAskOf as sharedIsAskOf,
  selectAsks,
} from '@open-walnut/ask-list';

/** The Personal AI's agent id. Its asks carry no `agent_id` stamp. */
export { GENERAL_AGENT_ID };

/** A console agent as the slot sees it: identity plus the project its asks
 *  file under. Built by `toAskAgent` from the registry's definition. */
export interface AskAgent {
  id: string;
  name: string;
  description?: string;
  project: string;
}

/** The general agent before (or without) the registry: the slot must work on
 *  first paint and on a server whose agent list failed to load. */
export const GENERAL_ASK_AGENT: AskAgent = { id: GENERAL_AGENT_ID, name: 'Walnut', project: 'Ask Walnut' };

/**
 * The project an agent's asks are filed under: the shared rule, the very
 * function the server files a launch with, so an agent's own asks can never
 * vanish from its list over a naming drift.
 */
export function askProjectFor(agent: { id: string; name: string }): string {
  return sharedAskProjectFor(agent);
}

export function toAskAgent(def: { id: string; name: string; description?: string }): AskAgent {
  return {
    id: def.id,
    name: def.id === GENERAL_AGENT_ID ? GENERAL_ASK_AGENT.name : def.name,
    ...(def.description ? { description: def.description } : {}),
    project: askProjectFor(def),
  };
}

/**
 * The agents the slot lists, from the registry's definitions: Walnut first and always present, then
 * every console agent. The slot and "Find on Home" both use it, so a task the slot would not show is
 * never sent there.
 */
export function slotAgents(defs: readonly { id: string; name: string; description?: string; console?: boolean }[]): AskAgent[] {
  const consoleAgents = defs.filter((a) => a.console || a.id === GENERAL_AGENT_ID).map(toAskAgent);
  const general = consoleAgents.find((a) => a.id === GENERAL_AGENT_ID) ?? GENERAL_ASK_AGENT;
  return [general, ...consoleAgents.filter((a) => a.id !== GENERAL_AGENT_ID)];
}

/**
 * Whether a task belongs to an agent's list: born its ask (stamp) OR filed
 * under its project now. The shared rule (see ask-list.ts MEMBERSHIP).
 */
export function isAskOf(task: Task, agent: AskAgent): boolean {
  return sharedIsAskOf(task, agent);
}

/** Every ask of ONE agent, most recently used first (the shared ORDER: the
 *  stamp the row prints is the stamp it sorts by). Never mutates the input
 *  list (it is the shared task store's array). */
export function selectAgentTasks(tasks: readonly Task[], agent: AskAgent): Task[] {
  return selectAsks(tasks, agent);
}

/**
 * Which of the known agents a task belongs to, or null for a task that is
 * nobody's ask. Used to open the drawer on the agent of the ask the slot is
 * showing after a reload. The stamp wins over the project (a Mentor ask dragged
 * into "Ask Walnut" is still Mentor's), then the first agent whose project it
 * lives under.
 */
export function agentOfTask(task: Task, agents: readonly AskAgent[]): AskAgent | null {
  if (task.walnut_agent === true) {
    const byStamp = agents.find((a) => a.id === (task.agent_id || GENERAL_AGENT_ID));
    if (byStamp) return byStamp;
  }
  return agents.find((a) => sharedIsAskOf({ id: task.id, project: task.project }, a)) ?? null;
}

/**
 * Which task is selected after the task list changed.
 *
 * The persisted id wins while its task still exists; otherwise the drawer's TOP
 * row takes over, the most recently used ask (a deleted or archived-away
 * selection must not leave the slot blank).
 *
 * The top row prefers a task that HAS a conversation (`hasSession`): the project
 * rule lets a plain todo dragged into the Ask Walnut project into the list, and
 * a fresh window with no persisted pick would otherwise open on that todo's
 * "no session yet" card instead of the last conversation. It stays a candidate
 * (picking it by hand is fine); it just is not the default. Only when nothing
 * has a session does the newest bare task win.
 *
 * An EMPTY list keeps the persisted pick instead of clearing it. The task store
 * starts empty on every page load and fills a tick later, so "no candidates" is
 * the ordinary state at first paint, not evidence the task is gone — clearing
 * there is exactly how a reload used to lose the selection (it also erased the
 * persisted id on the way out, so the next resolve had nothing to restore). The
 * caller renders its composer off "no rows", never off a null selection, so a
 * selection pointing at a task nobody can see costs nothing.
 *
 * Sort-independent: it derives the top row with the same comparator the drawer
 * sorts by (`compareAsks`) rather than trusting the caller to have sorted, so a
 * raw store array is a legal argument and the default pick is always the TOP row.
 */
export function resolveSelection(
  persistedId: string | null | undefined,
  tasks: readonly Task[],
  hasSession: (task: Task) => boolean = () => true,
): string | null {
  if (persistedId && tasks.some((t) => t.id === persistedId)) return persistedId;
  if (!tasks.length) return persistedId ?? null;
  let newest: Task | null = null;
  let newestWithSession: Task | null = null;
  for (const t of tasks) {
    if (!newest || compareAsks(t, newest) < 0) newest = t;
    if (hasSession(t) && (!newestWithSession || compareAsks(t, newestWithSession) < 0)) newestWithSession = t;
  }
  return (newestWithSession ?? newest)?.id ?? null;
}
