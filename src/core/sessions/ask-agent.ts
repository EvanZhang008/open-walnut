/**
 * "Ask <agent>": which console agent an Ask Walnut launch speaks to, and the
 * two names that follow from it.
 *
 * An Ask Walnut launch is an ordinary task session spawned with a persona.
 * The persona used to be fixed (the Personal AI, id 'general'); every other
 * console agent (Mentor, Note Assistant, config-defined ones) is the same
 * launch with `agentId` naming it. What differs per agent:
 *   - the persona (buildLaneProfile resolves it from the registry)
 *   - the project the task is filed under ("Ask Walnut" / "Ask Mentor" / …),
 *     so each agent's conversations group on the board like any project
 *   - the placeholder title the task wears until auto-titling names it (the
 *     same string as the project — see matchPlaceholderTitle)
 *   - the `agent_id` stamp on the task, absent for general, which is how the
 *     chat slot's drawer and the persona drift repair know whose ask it is
 *
 * Keep the naming rule in sync with the client's `askProjectFor`
 * (web/src/components/chat/ask-walnut-slot-model.ts): the drawer lists an
 * agent's asks by that stamp OR by project name, so both sides must derive the
 * same project from the same agent.
 */

export const GENERAL_AGENT_ID = 'general';

/** The general agent's project. The client twin is ASK_WALNUT_PROJECT. */
export const ASK_WALNUT_PROJECT = 'Ask Walnut';

export interface AskAgentRef {
  id: string;
  name: string;
}

/**
 * The project an agent's asks are filed under.
 *
 * A project name becomes a directory segment (assertValidProjectName in
 * task-manager), and an agent's display name is free text, so the name is
 * folded to what the gate accepts: separators and `..` are not allowed and the
 * length is capped; the id stands in for a name that folds to nothing. The
 * leading "Ask " already rules out the hidden-directory and reserved-key cases.
 * Client twin: askProjectFor in web/src/components/chat/ask-walnut-slot-model.ts
 * (same folding, so both derive the same project for the same agent).
 */
export function askProjectFor(agent: AskAgentRef): string {
  if (agent.id === GENERAL_AGENT_ID) return ASK_WALNUT_PROJECT;
  return `Ask ${projectSafeName(agent.name) || projectSafeName(agent.id) || 'agent'}`;
}

function projectSafeName(raw: string): string {
  return raw
    .replace(/[/\\\0]/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, 60)
    .trim();
}

/**
 * Resolve an ask's agent from the registry, or undefined when no agent has that
 * id (an unknown id or a deleted config agent). `general` never hits the
 * registry: it is the Personal AI, which exists even when a config override
 * drops its console flag.
 *
 * ANY registry agent resolves, not only a console one. The console flag decides
 * which agents the chat drawer OFFERS (getConsoleAgents); it cannot decide who
 * may be asked, because the dispatcher (subagent-runner) launches its runs
 * through this same resolution and a hook's `run_agent` action names a
 * background agent by design (a stateful tracker, a config agent saved without
 * the flag). A background agent's persona builds exactly like a console agent's,
 * so the run is a normal session with that agent's identity.
 */
export async function resolveAskAgent(agentId: string | undefined): Promise<AskAgentRef | undefined> {
  const id = agentId?.trim() || GENERAL_AGENT_ID;
  if (id === GENERAL_AGENT_ID) return { id, name: 'Walnut' };
  const { getAgent } = await import('../agent-registry.js');
  const def = await getAgent(id);
  return def ? { id: def.id, name: def.name } : undefined;
}

/**
 * The agent an EXISTING ask was launched with, from its task stamp; undefined
 * for Walnut's asks, an unknown task, or a store hiccup. A retry on an existing
 * ask (the slot's Retry, ▶ Start on a stamped task) names no agent itself, and
 * without this it would be resumed as the Personal AI.
 */
export async function stampedAgentId(taskId: string): Promise<string | undefined> {
  const { getTask } = await import('../task-manager.js');
  return getTask(taskId).then((t) => t.agent_id || undefined, () => undefined);
}
