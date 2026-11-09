/**
 * The extension closes the tabs it opened for agents once no agent holds them (2026-11-08, the
 * user: "in browser so many open and keep there ... clean up after used"). Walnut closes a task's
 * tabs when the task is done or leaves them unused (browser-tab-tidy.ts on the server); what is
 * left is a tab no agent holds any more that the person did not take (Stop, the side panel and
 * agents off make it theirs: forgetAgentMade), which this closes LEFT_MS after it was let go.
 *
 * Only tabs this extension made itself, in the agent window: never a tab the person opened, never
 * the person's own window, never the tab the person is looking at in a focused window, never the
 * agent window's own page.
 */
import { ext } from './ext'
import { agentTabs, agentWindowId } from './agent-shared'
import { ungroupBeforeClose, type GroupApi } from './agent-groups'

export const LEFT_MS = 10 * 60_000
const KEY = 'agentMade'

/** id → when no agent held it first seen (0 while one holds it). */
type Made = Record<string, number>

async function read(): Promise<Made> {
  return ((await ext.storage.session.get(KEY))[KEY] ?? {}) as Made
}

/** One change of the list at a time, so a note made while a pass runs is never written over. */
let chain: Promise<unknown> = Promise.resolve()
function change<T>(work: (made: Made) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const made = await read()
    const out = await work(made)
    await ext.storage.session.set({ [KEY]: made })
    return out
  })
  chain = run.catch(() => undefined)
  return run
}

/** A tab this extension opened for an agent (the agent window's open, a page's new tab). */
export function noteAgentMade(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return Promise.resolve()
  return change(async (made) => { made[String(tabId)] = 0 })
}

/** The person took the tab (Stop, the side panel, agents off): theirs now, never tidied away. */
export function forgetAgentMade(tabId: number): Promise<void> {
  return change(async (made) => { delete made[String(tabId)] })
}

/** One pass (the agent alarm, once a minute): the tabs closed. */
export function tidyLeftovers(now = Date.now()): Promise<number[]> {
  return change(async (made) => {
    const win = await agentWindowId()
    const closed: number[] = []
    for (const [k, since] of Object.entries(made)) {
      const id = Number(k)
      const tab = await ext.tabs.get(id).catch(() => null)
      if (!tab) { delete made[k]; continue }
      if (await agentTabs.get(id)) { made[k] = 0; continue }
      if (!since) { made[k] = now; continue }
      if (now - since < LEFT_MS || tab.windowId !== win) continue
      // The person is on it right now: it stays until they leave it.
      const w = tab.active ? await ext.windows.get(tab.windowId!).catch(() => null) as { focused?: boolean } | null : null
      if (w?.focused) continue
      await ungroupBeforeClose(ext as unknown as GroupApi, id)
      await ext.tabs.remove(id).catch(() => undefined)
      delete made[k]
      closed.push(id)
    }
    return closed
  })
}
