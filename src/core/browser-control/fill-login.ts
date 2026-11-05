/**
 * `browser fill_login`: a saved login from the person's vault filled into an agent's tab, the
 * agent never seeing it. The vault decides exactly as for password_use (core/vault/agent.ts
 * agentUse: the switch, the item's agent access, sensitive, grants, approvals, the brakes), and
 * the username and password go only to the extension, which fills them the way its own autofill
 * does. The agent hears `{ filled, fields, item: { id, title } }`. Logged as kind `fill`.
 *
 * The login is the one saved for the tab's site (several: `which_login`, the agent names one);
 * a login saved for another site is never filled. An approval answers 202 with a `request` id:
 * the agent calls fill_login again with it (and wait_ms) until the person answered. After the
 * approval the tab must still be on the origin the ask named (scheme, host and port), and right
 * before the fill the item's own sites must still match the page (matchItem): the item may have
 * been edited meanwhile. The extension refuses a page an agent's script or real input touched
 * since it loaded (`page_tampered`, agent.ts in the extension).
 */
import { BrowserError } from './hub.js'
import type { AgentItemView, AgentRequester, AgentsSwitch, ApprovalCreator, ApprovalWaiter } from '../vault/agent.js'

export interface FillDeps {
  /** One command to the browser holding the tab. */
  send: (action: string, args: Record<string, unknown>, ms: number) => Promise<unknown>
  agents: () => Promise<AgentsSwitch>
  createApproval: ApprovalCreator
  waitApproval: ApprovalWaiter
}

export interface FillInput {
  owner: string
  tab: number
  item?: string
  request?: string
  purpose?: string
  waitMs: number
  requester: AgentRequester
  testRun?: string
}

export type FillOutcome = { status: 200 | 202; body: Record<string, unknown> }

interface PendingFill { owner: string; tab: number; token: string; url: string; item: { id: string; title: string }; fields: string[]; at: number }
const pendingFills = new Map<string, PendingFill>()
const PENDING_MS = 15 * 60_000

export function _resetFillLoginForTesting(): void { pendingFills.clear() }

function needsOk(id: string, p: Pick<PendingFill, 'item'>): FillOutcome {
  return {
    status: 202,
    body: {
      status: 'needs_ok', code: 'login_needs_ok', request: id, approvalId: id, item: p.item,
      error: `Waiting for the person to let you sign in with "${p.item.title}" (a notification on their Mac and phone).`,
    },
  }
}

async function tabUrl(deps: FillDeps, owner: string, tab: number): Promise<string> {
  const r = await deps.send('tabs', { owner }, 15_000) as { tabs?: Array<{ id: number; url?: string; owner?: string }> }
  const t = (r.tabs ?? []).find((x) => x.id === tab && x.owner === owner)
  if (!t?.url) throw new BrowserError('That tab is not one an agent opened (or the person took it back with Stop).', 403, 'not_your_tab')
  return t.url
}

/** The login for this page: the one named among the site's, else the site's only one. */
async function pick(url: string, named: string | undefined, agents: AgentsSwitch): Promise<AgentItemView> {
  const { agentItems } = await import('../vault/agent.js')
  const { listItems } = await import('../vault/store.js')
  const { siteKey } = await import('../vault/url-match.js')
  const site = siteKey(url)?.domain ?? url
  // The page's own host in the words (a login saved for shop.example.com is "for shop.example.com", not for example.com).
  const here = (() => { try { return new URL(url).host } catch { return site } })()
  const logins = (await agentItems({ site: url, agents, forUse: true })).filter((i) => i.type === 'login' && i.fields.includes('password'))
  const users = new Map((await listItems()).map((s) => [s.id, s.username ?? '']))
  const list = (items: AgentItemView[]) => items.slice(0, 20).map((i) => ({ id: i.id, title: i.title, ...(users.get(i.id) ? { username: users.get(i.id) } : {}) }))
  // The choices in the words too: a shell sees only the message.
  const namedList = (items: AgentItemView[]) => list(items).map((l) => `${l.id} "${l.title}"${l.username ? ` (${l.username})` : ''}`).join('; ')
  if (named) {
    const n = named.trim().toLowerCase()
    const hits = logins.filter((i) => i.id === named.trim()).length ? logins.filter((i) => i.id === named.trim())
      : logins.filter((i) => i.title.toLowerCase() === n || (users.get(i.id) ?? '').toLowerCase() === n)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new BrowserError(`More than one login for ${here} matches "${named}": name one by its id (item): ${namedList(hits)}.`, 409, 'which_login', { logins: list(hits) })
    const anywhere = (await agentItems({ query: named, agents, forUse: true })).length > 0
    throw anywhere
      ? new BrowserError(`"${named}" is not saved for ${here}: Walnut fills a login only on its own site.`, 409, 'other_site')
      : new BrowserError(`No login "${named}" for ${here} that agents may use.`, 404, 'no_login')
  }
  if (!logins.length) {
    // Saved for another part of the same site (a sibling host, tier 2): never filled here by itself.
    const { siblingHost } = await import('../vault/url-match.js')
    const urls = new Map((await listItems()).map((s) => [s.id, s.urls]))
    const elsewhere = (await agentItems({ agents, forUse: true }))
      .filter((i) => i.type === 'login' && i.fields.includes('password'))
      .map((i) => ({ i, host: siblingHost(urls.get(i.id), url) }))
      .filter((x): x is { i: AgentItemView; host: string } => !!x.host)
    if (elsewhere.length) {
      const named = elsewhere.slice(0, 5).map(({ i, host }) => `${i.id} "${i.title}" (saved for ${host})`).join('; ')
      throw new BrowserError(
        `No login is saved for ${here} itself; ${elsewhere.length === 1 ? 'one is' : `${elsewhere.length} are`} saved for another part of ${site}: ${named}. `
          + `Walnut fills such a login here only once its website's match rule is "base" (every host of ${site}): ask the person to set that on the login `
          + `(in Passwords, its website ending in "#walnut-match=base"), or to sign in themselves.`,
        404, 'no_login', { otherPart: elsewhere.slice(0, 20).map(({ i, host }) => ({ id: i.id, title: i.title, host })) })
    }
    throw new BrowserError(`No saved login for ${here} that agents may use. Ask the person to add one in Passwords, or to sign in themselves.`, 404, 'no_login')
  }
  if (logins.length > 1) throw new BrowserError(`${logins.length} logins are saved for ${here}: say which with item (its id, name or username): ${namedList(logins)}.`, 409, 'which_login', { logins: list(logins) })
  return logins[0]
}

const originOf = (u: string): string => { try { return new URL(u).origin } catch { return '' } }

async function fill(deps: FillDeps, tab: number, url: string, item: { id: string; title: string }, values: Record<string, string>): Promise<FillOutcome> {
  // The item as it is now: its sites must still be this page's (it may have been edited or trashed since the ask).
  const { getItem } = await import('../vault/store.js')
  const { matchItem } = await import('../vault/url-match.js')
  const now = await getItem(item.id).catch(() => null)
  if (!now || now.trashedAt || !matchItem(now.urls, url)) {
    throw new BrowserError(`"${item.title}" is not saved for the page the tab is on now: nothing was filled.`, 409, 'other_site')
  }
  const r = await deps.send('fill_login', { tab, url, username: values.username, password: values.password }, 30_000) as { filled?: boolean }
  if (!r?.filled) throw new BrowserError('No sign-in form to fill on that page (or it moved to another site): snapshot and try again.', 409, 'no_login_form')
  return { status: 200, body: { filled: true, fields: Object.keys(values).filter((f) => f === 'username' || f === 'password'), item, tab } }
}

export async function fillLogin(input: FillInput, deps: FillDeps): Promise<FillOutcome> {
  const agents = await deps.agents()
  const now = Date.now()
  for (const [id, p] of pendingFills) if (now - p.at > PENDING_MS) pendingFills.delete(id)
  if (input.request) {
    const p = pendingFills.get(input.request)
    if (!p || p.owner !== input.owner || p.tab !== input.tab) throw new BrowserError('No such sign-in ask for this tab: call fill_login again without request.', 404, 'no_such_request')
    const { agentWait } = await import('../vault/agent.js')
    const w = await agentWait(input.request, p.token, input.waitMs, agents, deps.waitApproval)
    if (w.status === 'pending') return needsOk(input.request, p)
    pendingFills.delete(input.request)
    if (w.status !== 'released') throw new BrowserError('Nobody answered the ask in time: call fill_login again to ask anew.', 409, 'login_expired')
    // The page must still be where the person approved it for.
    const url = await tabUrl(deps, input.owner, input.tab)
    if (!originOf(url) || originOf(url) !== originOf(p.url)) throw new BrowserError('The tab moved to another site while the person was asked: nothing was filled.', 409, 'page_changed')
    return fill(deps, input.tab, url, p.item, w.values)
  }
  const url = await tabUrl(deps, input.owner, input.tab)
  const view = await pick(url, input.item, agents)
  const item = { id: view.id, title: view.title }
  const fields = ['username', 'password'].filter((f) => view.fields.includes(f))
  const { agentUse } = await import('../vault/agent.js')
  const { siteKey } = await import('../vault/url-match.js')
  const purpose = (input.purpose?.trim() || `sign in on ${siteKey(url)?.domain ?? 'a site'} in the browser`).slice(0, 200)
  const u = await agentUse({ item: view.id, fields, purpose, requester: input.requester, agents, testRun: input.testRun, use: 'fill' }, deps.createApproval)
  if (u.status === 'pending') {
    pendingFills.set(u.requestId, { owner: input.owner, tab: input.tab, token: u.waitToken, url, item, fields, at: now })
    return needsOk(u.requestId, { item })
  }
  return fill(deps, input.tab, url, item, u.values)
}
