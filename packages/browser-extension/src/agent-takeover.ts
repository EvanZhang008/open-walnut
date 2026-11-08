/**
 * Take over (2026-11-08, the user: "I want it to be able to take over if needed"): from the task's
 * Browser view in Walnut the person takes an agent's tab for a while (to sign in, solve a check,
 * look around), uses it with their own mouse and keys in Chrome, and hands it back.
 *
 *   - Take over brings that tab's window to the front with the tab on screen. It is the one place
 *     an agent's window is ever focused, and only on the person's own click in Walnut (the route
 *     takes it from a person's request only, browser-view-v1.ts); never on an agent's command.
 *   - While the person has the tab, every agent command on it is refused (`person_driving`), so the
 *     agent never fights them; its other tabs go on. The tab's pill says who has it, with Hand back.
 *   - Hand back, from the Browser view or the pill (the person's trusted click), gives the tab to
 *     the agent again; Walnut hears it at once (POST /browser/handback) and an agent waiting for
 *     the person (request_sign_in) carries on.
 */
import { ext } from './ext'
import { AgentError, agentTabs, agentWindowId, mark, personsTab, where, type AgentTab, type WireCommand } from './agent-shared'

/** The person has the tab: since when (ms). */
export const drivingSince = (rec: AgentTab | undefined): number | undefined => (typeof rec?.driving === 'number' ? rec.driving : undefined)

/**
 * The person has the front tab of this window (they took it over): nothing else may be brought up
 * there, neither a picture of another tab nor an agent's screenshot, or it would pull their tab
 * away mid sign-in (review 2026-11-08).
 */
export async function frontDriven(windowId: number | undefined): Promise<boolean> {
  if (windowId === undefined) return false
  const [front] = await ext.tabs.query({ active: true, windowId }).catch(() => [])
  return front?.id !== undefined && drivingSince(await agentTabs.get(front.id)) !== undefined
}

/** Refused while the person has the tab. */
export function drivingRefusal(rec: AgentTab | undefined): AgentError | null {
  const since = drivingSince(rec)
  if (since === undefined) return null
  const at = new Date(since).toISOString().slice(11, 16)
  return new AgentError(
    `The person took this tab over (Take over in the task's Browser view, since ${at} UTC) and is using it now. `
    + 'Do not act in it until they hand it back: work in another tab, or wait (request_sign_in waits for them when you asked them to sign in).',
    'person_driving', { since: new Date(since).toISOString() })
}

const ownerOf = (c: WireCommand) => (typeof c.args.owner === 'string' ? c.args.owner : undefined)

/** `view_takeover {tab, owner}`: the person's click on Take over. */
export async function takeOver(c: WireCommand): Promise<Record<string, unknown>> {
  const tabId = typeof c.args.tab === 'number' ? c.args.tab : NaN
  const want = ownerOf(c)
  const since = Date.now()
  let held = false
  await agentTabs.update(tabId, (rec) => {
    if (want && rec.owner !== want) return rec
    held = true
    return { ...rec, driving: drivingSince(rec) ?? since }
  })
  if (!held) throw new AgentError('That tab is no agent\'s now (closed, or given back with Stop).', 'not_your_tab')
  const tab = await ext.tabs.get(tabId).catch(() => null)
  if (!tab || tab.windowId === undefined) throw new AgentError('That tab was closed.', 'not_your_tab')
  const rec = await agentTabs.get(tabId)
  // Only the agent's own window is brought forward. A tab of the person's (handed over, or taken
  // in their window) is already where they work: their window is never switched or focused.
  if (!personsTab(rec) && tab.windowId === await agentWindowId()) {
    await ext.tabs.update(tabId, { active: true })
    // The person's own click on Take over, never an agent's command: the window comes forward for them.
    await ext.windows.update?.(tab.windowId, { focused: true })
  }
  await mark(tabId, true, rec?.who, 'driving')
  return { ...(await where(tabId)), driving: true, since: new Date(drivingSince(rec) ?? since).toISOString() }
}

/**
 * `view_handback {tab, owner}` from the Browser view, or the pill's Hand back: the agent may use
 * the tab again. True when the person had it.
 */
export async function handBack(tabId: number, want?: string): Promise<boolean> {
  let had = false
  await agentTabs.update(tabId, (rec) => {
    if ((want && rec.owner !== want) || drivingSince(rec) === undefined) return rec
    had = true
    const { driving: _d, ...rest } = rec
    return rest
  })
  const rec = await agentTabs.get(tabId)
  if (rec) await mark(tabId, true, rec.who)
  return had
}
