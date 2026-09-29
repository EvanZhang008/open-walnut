/**
 * The ask half of a human launch: what an "Ask <agent>" start fills in that an
 * ordinary start leaves to its caller.
 *
 * Two surfaces launch asks for a person, and they must produce the SAME task:
 *   - the web draft, POST /api/sessions/quick-start { walnutAgent, agentId }
 *   - the phone's New chat, POST /api/v1/sessions { walnutAgent, agentId }
 * The Mac's drawer and the phone's list both come from ask-list.ts, so an ask
 * born on the phone has to land in the same project, tier and folder as one born
 * on the Mac, or the two lists stop agreeing the moment the user switches device.
 * These rules used to live inline in the quick-start route; they live here so
 * the second surface cannot drift from the first.
 *
 * What is NOT here, because quickStartSession already owns it for every caller
 * (routines and triage included): resolving the persona (buildLaneProfile), the
 * `walnut_agent` marker and the `agent_id` stamp. A launch hands it
 * `walnutAgent: true` + `agentId` and those follow.
 */
import { WALNUT_HOME } from '../../constants.js';
import { resolveModelSwitchValue } from '../types.js';
import { askProjectFor, resolveAskAgent, stampedAgentId, type AskAgentRef } from './ask-agent.js';
import { getAskWalnutLaunchPrefs, rememberAskWalnutLaunch } from './ask-walnut-launch.js';

/** An ask runs where the server runs: its home is a server fact, never a client pick. */
export const ASK_LAUNCH_CWD = WALNUT_HOME;

/** The refusal both surfaces answer when an ask names a host. */
export const ASK_HOST_REFUSAL = 'walnutAgent sessions run on the server host';

/** An ask is born in Focus unless the caller named a tier (null = "don't pin"). */
export const ASK_DEFAULT_TIER = 'focus';

/**
 * Whose ask this launch is. A retry on an existing ask names no agent: the
 * task's own stamp decides, so a Mentor ask is never resumed as Walnut.
 * undefined = no such agent (the caller answers 400 before writing anything).
 */
export async function resolveLaunchAskAgent(
  agentId: string | undefined,
  existingTaskId: string | undefined,
): Promise<AskAgentRef | undefined> {
  const id = agentId ?? (existingTaskId ? await stampedAgentId(existingTaskId) : undefined);
  return resolveAskAgent(id);
}

/** The project a NEW ask files under: the caller's pick, else "Ask <name>". */
export function askLaunchProject(project: string | undefined, agent: AskAgentRef): string {
  return project?.trim() || askProjectFor(agent);
}

/** The tier a new ask is born in: the caller's pick (null included), else Focus. */
export function askLaunchTier(pinTier: string | null | undefined): string | null {
  return pinTier === undefined ? ASK_DEFAULT_TIER : pinTier;
}

/**
 * The model an ask that names none starts on: the last one picked FOR an ask,
 * in CLI form. Native engine only: the memory was picked in the claude model
 * picker, and an ACP adapter would refuse an id it never advertised.
 */
export async function rememberedAskModel(nativeEngine: boolean): Promise<string | undefined> {
  if (!nativeEngine) return undefined;
  const remembered = (await getAskWalnutLaunchPrefs()).model;
  return remembered ? resolveModelSwitchValue(remembered) ?? undefined : undefined;
}

/**
 * Remember the model a NEW ask named. `rawModel` is the body's value as sent:
 * absent = "whatever is remembered" (nothing to store), 'default' = the picker's
 * Auto row (clears the memory), anything else is kept verbatim so a picker can
 * re-select it. Retries keep the old memory: the user re-picked nothing.
 */
export function rememberAskModelPick(rawModel: unknown, existingTaskId: string | undefined): void {
  if (existingTaskId || rawModel === undefined) return;
  const pick = typeof rawModel === 'string' && rawModel && rawModel !== 'default' ? rawModel : undefined;
  rememberAskWalnutLaunch({ model: pick }).catch(() => {});
}
