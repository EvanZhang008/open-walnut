/**
 * Open in Chrome (2026-11-17, the user: "any time it can jump there"): the person's click in the
 * task's Browser view brings the task's tab to the front in Chrome, the agent window and all. It
 * comes only from a person's request (the server's POST /browser/view/reveal refuses a session's),
 * and the window comes forward only through `revealForPerson` (agent-window.ts), the one place a
 * person's own action may raise a window. Unlike Take over the agent keeps the tab.
 *
 * With no tab left (the agent closed it), the server sends the page of a replay step: it opens
 * again in the agent window as the task's tab, as an agent's open does (`reopen`), then comes forward.
 */
import { ext } from './ext'
import { AgentError, agentTabs, type WireCommand } from './agent-shared'
import { revealForPerson } from './agent-window'
import { noteGroupUse, type GroupApi } from './agent-groups'

/**
 * The tab in front for the person: its window focused, and the task's tab group kept open (a quiet
 * group folds to its chip and puts the agent window's own page in front, agent-groups.ts).
 */
async function bringUp(tabId: number, owner: string): Promise<void> {
  await revealForPerson(ext, tabId, 'reveal')
  noteGroupUse(ext as unknown as GroupApi, owner)
}

/** `view_reveal {owner, tab}` or `{owner, url}`. */
export async function reveal(c: WireCommand, reopen: (url: string, owner: string) => Promise<unknown>): Promise<Record<string, unknown>> {
  const owner = typeof c.args.owner === 'string' ? c.args.owner : ''
  if (!owner) throw new AgentError('Whose tab: an owner.', 'bad_request')
  if (typeof c.args.tab === 'number') {
    const tabId = c.args.tab
    const rec = await agentTabs.get(tabId)
    if (!rec || rec.owner !== owner) throw new AgentError('That tab is not this task\'s now (closed, or given back with Stop).', 'not_your_tab')
    if (!(await ext.tabs.get(tabId).catch(() => null))) throw new AgentError('That tab was closed.', 'not_your_tab')
    await bringUp(tabId, owner)
    return { tab: tabId, revealed: true }
  }
  const url = typeof c.args.url === 'string' ? c.args.url : ''
  if (!/^https?:\/\//i.test(url)) throw new AgentError('Open in Chrome needs a web address (http or https).', 'bad_request')
  const opened = (await reopen(url, owner) ?? {}) as Record<string, unknown>
  if (typeof opened.tab !== 'number') throw new AgentError('The browser did not open the page.', 'open_failed')
  await bringUp(opened.tab, owner)
  return { ...opened, revealed: true, reopened: true }
}
