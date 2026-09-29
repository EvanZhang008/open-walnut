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
 * The naming rule (askProjectFor) is defined once in ask-list.ts and
 * re-exported here: the drawer lists an agent's asks by that stamp OR by
 * project name, so both sides must derive the same project from the same agent.
 */

// The naming rule lives in ask-list.ts, the one pure module the web drawer
// imports too (`@open-walnut/ask-list`), so the server and the browser derive
// the same project from the same agent by construction, not by keeping twins.
export { ASK_WALNUT_PROJECT, GENERAL_AGENT_ID, askProjectFor, type AskAgentRef } from './ask-list.js';
import { GENERAL_AGENT_ID, type AskAgentRef } from './ask-list.js';

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
 * for Walnut's own asks and for a task nobody has. A retry on an existing ask
 * (the slot's Retry, ▶ Start on a stamped task) names no agent itself, and
 * without this it would be resumed as the Personal AI.
 *
 * A STORE FAILURE THROWS, and that is the whole point of the shape. Folding it
 * into `undefined` made "this ask is Walnut's" and "I could not read the stamp"
 * the same answer, so a hiccup resumed a Mentor ask as Walnut: the wrong persona,
 * the wrong memory, and a task whose own `agent_id` disagreed with the session
 * running under it. Refusing the launch is recoverable (the human retries); a
 * session wearing another agent's identity is not. The one failure that stays
 * `undefined` is the task genuinely not being there, because the caller's own
 * lookup turns that into the 404 it should be.
 */
export async function stampedAgentId(taskId: string): Promise<string | undefined> {
  const { getTask } = await import('../task-manager.js');
  try {
    const task = await getTask(taskId);
    return task.agent_id || undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No task found matching')) return undefined;
    throw err;
  }
}
