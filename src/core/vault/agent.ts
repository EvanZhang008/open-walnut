/**
 * Agents and the vault (docs/reference/passwords.md, "Agents"). An agent never holds a vault
 * session: it names an item and says why, and Walnut decides.
 *
 *   - the switch `passwords.agents` is `off`             → refused, agents_off
 *   - the item's agent access is `never`                  → refused, agent_never
 *   - the item allows agents (or the switch is `allow`),
 *     and it is not sensitive; or this task holds a grant → released now
 *   - otherwise                                           → a person approves it on the Mac or
 *     the phone (approvals/), with Face ID or Touch ID for a sensitive item; an approval lets one
 *     use through, or, when the agent asked `scope: "task"`, gives that task the item for an hour.
 *
 * Brakes, per asker (its task, else its host): at most ASK_MAX asks waiting at once, at most
 * RELEASE_MAX releases in RELEASE_WINDOW_MS, and after DENY_MAX denials in DENY_WINDOW_MS its
 * asks pause for DENY_WINDOW_MS. Every outcome goes to the agent log, sealed (agent-log.ts).
 * Grants and pending asks live in memory: a restart ends them, and Lock all ends every grant.
 */
import { appendAgentLog, type AgentLogEntry } from './agent-log.js'
import { getItem, listItems, markUsed, VaultError } from './store.js'
import { parseTotp, totpAt } from './totp.js'
import type { VaultItem, VaultItemSummary } from './types.js'
import { displayHost, matchItem, siteKey } from './url-match.js'

export type AgentsSwitch = 'off' | 'ask' | 'allow'
export type AgentScope = 'once' | 'task'

export const ASK_MAX = 3
export const RELEASE_MAX = 30
export const RELEASE_WINDOW_MS = 10 * 60_000
export const DENY_MAX = 3
export const DENY_WINDOW_MS = 30 * 60_000
export const GRANT_MS = 60 * 60_000
const APPROVAL_TIMEOUT_MS = 10 * 60_000
/** A released ask stays readable this long, for a retry whose answer was lost on the way. */
const REREAD_MS = 60_000

export interface AgentRequester {
  host: string
  taskId?: string
  taskTitle?: string
  sessionId?: string
  cwd?: string
  command?: string
}

/** What an agent may see of an item before any approval: never a secret. */
export interface AgentItemView {
  id: string
  title: string
  type: VaultItem['type']
  sites?: string[]
  envName?: string
  /** The fields this item has that an agent may ask for. */
  fields: string[]
  access: 'allow' | 'ask'
  sensitive?: boolean
}

export interface UseInput {
  /** An item id, its exact name, a site (github.com) or an env var name (GITHUB_TOKEN). */
  item: string
  /** password (default), username, totp, notes, card_number, card_code, card_expiry, or a custom field's name. */
  fields?: string[]
  purpose: string
  scope?: AgentScope
  requester: AgentRequester
  agents: AgentsSwitch
  testRun?: string
}

export type UseResult =
  | { status: 'released'; item: AgentItemView; values: Record<string, string>; via: 'allow' | 'grant' | 'approval'; grantedUntil?: string }
  | { status: 'pending'; requestId: string; waitToken: string; item: AgentItemView; mode: 'tap' | 'biometric'; expiresAt: string; downgraded?: string }

interface PendingAsk {
  itemId: string
  fields: string[]
  purpose: string
  scope: AgentScope
  asker: string
  /** Who holds a grant this ask makes: the task and the session that asked (grantHolder). */
  holder: string
  requester: AgentRequester
  /** When the approval runs out: an ask nobody waits on any more is swept after it. */
  expiresAt: number
  releasedAt?: number
  releasing?: Promise<Record<string, string>>
}

interface Grant { until: number; fields: Set<string> }

const pending = new Map<string, PendingAsk>()
const grants = new Map<string, Grant>()
const releases = new Map<string, number[]>()
const denials = new Map<string, number[]>()
/**
 * Bumped by Lock all and by every move of the switch: an ask or a release that began before
 * gives nothing after it, even when its approval comes back approved.
 */
let epoch = 0

export function resetAgentStateForTest(): void {
  pending.clear(); grants.clear(); releases.clear(); denials.clear()
  epoch++
}

/** The switch moved (or Lock all): asks and releases still running give nothing. */
export function bumpAgentEpoch(): void {
  epoch++
}

const askerOf = (r: AgentRequester) => (r.taskId ? `task:${r.taskId}` : `host:${r.host}`)
/** A grant is the task's in the session that asked, on the host it asked from. */
const grantHolder = (r: AgentRequester) => `${askerOf(r)}|${r.sessionId ?? ''}|${r.host}`
const grantKey = (holder: string, itemId: string) => `${holder}\u0000${itemId}`

/** Asks nobody can use any more: their approval ran out unanswered, or their re-read window passed. */
function sweepPending(now: number): void {
  for (const [id, p] of pending) {
    if (p.releasedAt === undefined ? now > p.expiresAt + 60_000 : now - p.releasedAt > REREAD_MS) pending.delete(id)
  }
}

function recent(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const kept = (map.get(key) ?? []).filter((t) => now - t < windowMs)
  if (kept.length) map.set(key, kept)
  else map.delete(key)
  return kept
}

function accessOf(item: Pick<VaultItem, 'agentAccess'>): 'never' | 'ask' | 'allow' {
  return item.agentAccess ?? 'ask'
}

function fieldsOf(item: VaultItem): string[] {
  const out: string[] = []
  if (item.password) out.push('password')
  if (item.username) out.push('username')
  if (item.totp) out.push('totp')
  if (item.notes) out.push('notes')
  if (item.card?.number) out.push('card_number')
  if (item.card?.code) out.push('card_code')
  if (item.card?.expMonth || item.card?.expYear) out.push('card_expiry')
  for (const f of item.fields ?? []) out.push(f.name)
  return out
}

function viewOf(item: VaultItem, agents: AgentsSwitch): AgentItemView {
  const access = accessOf(item)
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    ...(item.urls?.length ? { sites: item.urls.map(displayHost) } : {}),
    ...(item.envName ? { envName: item.envName } : {}),
    fields: fieldsOf(item),
    access: access === 'allow' || agents === 'allow' ? 'allow' : 'ask',
    ...(item.sensitive ? { sensitive: true } : {}),
  }
}

function refuse(status: number, code: string, message: string): never {
  throw new VaultError(message, status, code)
}

/** Items an agent may ask for (not `never`, not in the trash), optionally filtered. */
export async function agentItems(opts: { query?: string; site?: string; agents: AgentsSwitch }): Promise<AgentItemView[]> {
  if (opts.agents === 'off') refuse(403, 'agents_off', 'Agents may not use passwords: the person turned it off in Settings, Passwords.')
  const summaries = (await listItems()).filter((s) => !s.trashedAt && accessOf(s) !== 'never')
  const q = (opts.query ?? '').trim().toLowerCase()
  const picked = summaries.filter((s) => {
    if (opts.site && !matchItem(s.urls, opts.site)) return false
    if (!q) return true
    return [s.title, s.envName ?? '', ...(s.urls ?? []).map(displayHost)].some((t) => t.toLowerCase().includes(q))
  })
  const out: AgentItemView[] = []
  for (const s of picked) out.push(viewOf(await getItem(s.id), opts.agents))
  return out
}

/**
 * The item an agent named, among the items agents may ask for. An item kept from agents is
 * found only to say so (agent_never): its name never appears in another answer, and it never
 * makes an allowed item's name ambiguous.
 */
async function resolveItem(ref: string): Promise<VaultItem> {
  const r = ref.trim()
  if (!r) refuse(400, 'bad_request', 'Name the item: its id, its name, a site or an env var name.')
  const live = (await listItems()).filter((s) => !s.trashedAt)
  const hit = await findIn(live.filter((s) => accessOf(s) !== 'never'), r, true)
  if (hit) return hit
  const kept = await findIn(live.filter((s) => accessOf(s) === 'never'), r, false)
  if (kept) return kept
  refuse(404, 'not_found', `No item matches "${r}". password_list shows what an agent may ask for.`)
}

async function findIn(all: VaultItemSummary[], r: string, named: boolean): Promise<VaultItem | null> {
  const byId = all.find((s) => s.id === r)
  if (byId) return getItem(byId.id)
  const lower = r.toLowerCase()
  const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(r) ? r : `https://${r}`
  // A site finds the items saved for that host; only a bare registrable domain (github.com)
  // also finds the ones saved for its subdomains, never one subdomain another's.
  const key = siteKey(asUrl)
  const bareDomain = !!key && key.host === key.domain
  const tiers: Array<(s: VaultItemSummary) => boolean> = [
    (s) => s.title.toLowerCase() === lower,
    (s) => !!s.envName && s.envName === r,
    (s) => matchItem(s.urls, asUrl) === 'exact_host',
    (s) => bareDomain && matchItem(s.urls, asUrl) === 'domain',
  ]
  for (const tier of tiers) {
    const hits = all.filter(tier)
    if (hits.length === 1) return getItem(hits[0].id)
    if (hits.length > 1) {
      if (!named) refuse(403, 'agent_never', `"${r}" is never given to agents. Ask the person to do this step themselves.`)
      const names = hits.slice(0, 8).map((h) => `${h.title} (${h.id}${h.username ? `, ${h.username}` : ''})`).join('; ')
      refuse(409, 'ambiguous', `More than one item matches "${r}": ${names}. Ask again with the id.`)
    }
  }
  return null
}

async function valuesOf(item: VaultItem, fields: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    let v: string | undefined
    if (f === 'password') v = item.password
    else if (f === 'username') v = item.username
    else if (f === 'notes') v = item.notes
    else if (f === 'card_number') v = item.card?.number
    else if (f === 'card_code') v = item.card?.code
    else if (f === 'card_expiry') v = item.card?.expMonth || item.card?.expYear ? `${item.card?.expMonth ?? ''}/${item.card?.expYear ?? ''}` : undefined
    else if (f === 'totp') {
      const p = item.totp ? parseTotp(item.totp) : null
      v = p ? (await totpAt(p, Date.now())).code : undefined
    } else v = item.fields?.find((x) => x.name === f)?.value
    if (v === undefined || v === '') refuse(404, 'no_such_field', `"${item.title}" has no ${f}. It has: ${fieldsOf(item).join(', ') || 'nothing an agent may ask for'}.`)
    out[f] = v
  }
  return out
}

function logBase(item: VaultItem | undefined, fields: string[] | undefined, purpose: string | undefined, r: AgentRequester): Omit<AgentLogEntry, 'at' | 'kind'> {
  return {
    ...(item ? { itemId: item.id, itemTitle: item.title } : {}),
    ...(fields ? { fields } : {}),
    ...(purpose ? { purpose } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    ...(r.taskTitle ? { taskTitle: r.taskTitle } : {}),
    host: r.host,
    ...(r.command ? { command: r.command } : {}),
  }
}

async function release(item: VaultItem, ask: { fields: string[]; purpose: string; asker: string; requester: AgentRequester }, via: 'allow' | 'grant' | 'approval', approvalId?: string, since = epoch) {
  const now = Date.now()
  if (recent(releases, ask.asker, RELEASE_WINDOW_MS, now).length >= RELEASE_MAX) {
    await appendAgentLog({ kind: 'refused', reason: 'agent_rate', ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    refuse(429, 'agent_rate', `This task got ${RELEASE_MAX} passwords in ${RELEASE_WINDOW_MS / 60_000} minutes; wait before asking again.`)
  }
  const values = await valuesOf(item, ask.fields)
  if (since !== epoch) refuse(409, 'withdrawn', 'Agent access changed (Lock all, or the switch moved) while this ran: ask again.')
  releases.set(ask.asker, [...recent(releases, ask.asker, RELEASE_WINDOW_MS, now), now])
  await markUsed(item.id).catch(() => undefined)
  await appendAgentLog({ kind: 'released', via, ...(approvalId ? { approvalId } : {}), ...logBase(item, ask.fields, ask.purpose, ask.requester) })
  return values
}

function cleanFields(raw: string[] | undefined): string[] {
  const fields = [...new Set((raw?.length ? raw : ['password']).map((f) => String(f).trim()).filter(Boolean))]
  if (fields.length > 10) refuse(400, 'bad_request', 'Ask for at most 10 fields at once.')
  return fields
}

function cleanPurpose(raw: string): string {
  const p = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (p.length < 4) refuse(400, 'purpose_required', 'Say why you need it (purpose), in a few words the person reads: "sign in to github.com to merge PR 12".')
  return p.slice(0, 200)
}

function approvalText(item: VaultItem, ask: { fields: string[]; purpose: string; scope: AgentScope; requester: AgentRequester }) {
  const r = ask.requester
  // The title is what the person decides on: which item, which fields, and why. Who asked is
  // the card's next line (the task, or the command and host), and the rest is in the detail.
  const what = ask.fields.length === 1 && ask.fields[0] === 'password' ? 'password' : ask.fields.join(', ')
  const head = `${item.title} ${what}: ${ask.purpose}`
  const lines = [
    `Item: ${item.title}${item.urls?.length ? ` (${item.urls.map(displayHost).join(', ')})` : ''}`,
    `Fields: ${ask.fields.join(', ')}`,
    `Why: ${ask.purpose}`,
    `For: ${ask.scope === 'task' ? 'this task, for an hour' : 'this one use'}`,
    ...(r.taskTitle ? [`Task: ${r.taskTitle}`] : []),
    `Host: ${r.host}`,
    ...(r.cwd ? [`Directory: ${r.cwd}`] : []),
    ...(r.command ? [`Command: ${r.command}`] : []),
  ]
  return { what: head.length > 300 ? head.slice(0, 297) + '...' : head, detail: lines.join('\n') }
}

/** The approval mode an item needs, given whether any device can sign. */
export type ApprovalCreator = (input: { what: string; detail: string; biometric: boolean; timeoutMs: number; requester: AgentRequester; testRun?: string }) =>
  Promise<{ id: string; waitToken: string; mode: 'tap' | 'biometric'; expiresAt: string; downgraded?: string; cancel?: () => Promise<void> }>

export async function agentUse(input: UseInput, createApproval: ApprovalCreator): Promise<UseResult> {
  const since = epoch
  const r = input.requester
  const asker = askerOf(r)
  const holder = grantHolder(r)
  sweepPending(Date.now())
  if (input.agents === 'off') {
    await appendAgentLog({ kind: 'refused', reason: 'agents_off', ...logBase(undefined, input.fields, input.purpose, r) })
    refuse(403, 'agents_off', 'Agents may not use passwords: the person turned it off in Settings, Passwords.')
  }
  const purpose = cleanPurpose(input.purpose)
  const fields = cleanFields(input.fields)
  const scope: AgentScope = input.scope === 'task' && r.taskId ? 'task' : 'once'
  const item = await resolveItem(input.item)
  const view = viewOf(item, input.agents)
  if (accessOf(item) === 'never') {
    await appendAgentLog({ kind: 'refused', reason: 'agent_never', ...logBase(item, fields, purpose, r) })
    refuse(403, 'agent_never', `"${item.title}" is never given to agents. Ask the person to do this step themselves.`)
  }
  fieldsOf(item) // validate fields before any approval: an ask the person approves must be answerable
  await valuesOf(item, fields)

  const now = Date.now()
  // A grant covers the fields the person approved, nothing more.
  const grant = grants.get(grantKey(holder, item.id))
  if (grant && grant.until > now && fields.every((f) => grant.fields.has(f))) {
    return { status: 'released', item: view, values: await release(item, { fields, purpose, asker, requester: r }, 'grant', undefined, since), via: 'grant', grantedUntil: new Date(grant.until).toISOString() }
  }
  if (!item.sensitive && (accessOf(item) === 'allow' || input.agents === 'allow')) {
    return { status: 'released', item: view, values: await release(item, { fields, purpose, asker, requester: r }, 'allow', undefined, since), via: 'allow' }
  }

  const denied = recent(denials, asker, DENY_WINDOW_MS, now)
  if (denied.length >= DENY_MAX) {
    const until = new Date(denied[0] + DENY_WINDOW_MS)
    await appendAgentLog({ kind: 'refused', reason: 'agent_paused', ...logBase(item, fields, purpose, r) })
    refuse(429, 'agent_paused', `The person said no ${DENY_MAX} times in ${DENY_WINDOW_MS / 60_000} minutes, so this task's asks pause until ${until.toISOString()}. Do not ask again before then.`)
  }
  const waiting = [...pending.values()].filter((p) => p.asker === asker && p.releasedAt === undefined).length
  if (waiting >= ASK_MAX) refuse(429, 'too_many_asks', `${waiting} asks of this task already wait for the person; wait for those first.`)

  const text = approvalText(item, { fields, purpose, scope, requester: r })
  const a = await createApproval({ ...text, biometric: !!item.sensitive, timeoutMs: APPROVAL_TIMEOUT_MS, requester: r, testRun: input.testRun })
  // Lock all or the switch moved while the card was being made: no ask is kept, so nothing is released from it.
  if (since !== epoch) {
    await a.cancel?.()
    refuse(409, 'withdrawn', 'Agent access changed (Lock all, or the switch moved) while asking: ask again.')
  }
  pending.set(a.id, { itemId: item.id, fields, purpose, scope, asker, holder, requester: r, expiresAt: Date.parse(a.expiresAt) || Date.now() + APPROVAL_TIMEOUT_MS })
  await appendAgentLog({ kind: 'asked', approvalId: a.id, ...logBase(item, fields, purpose, r) })
  return { status: 'pending', requestId: a.id, waitToken: a.waitToken, item: view, mode: a.mode, expiresAt: a.expiresAt, ...(a.downgraded ? { downgraded: a.downgraded } : {}) }
}

export type ApprovalWaiter = (id: string, token: string, waitMs: number) =>
  Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'; used: boolean; answeredBy?: string }>

export type WaitResult =
  | { status: 'released'; item: AgentItemView; values: Record<string, string>; via: 'approval'; grantedUntil?: string; answeredBy?: string }
  | { status: 'pending' }
  | { status: 'expired' | 'canceled' }

export async function agentWait(requestId: string, token: string, waitMs: number, agents: AgentsSwitch, waitApproval: ApprovalWaiter): Promise<WaitResult> {
  const since = epoch
  const ask = pending.get(requestId)
  if (!ask) refuse(404, 'not_found', 'No such ask (Walnut restarted, or it was used): ask again.')
  if (ask.releasedAt !== undefined && Date.now() - ask.releasedAt > REREAD_MS) {
    pending.delete(requestId)
    refuse(409, 'approval_used', 'This approval was already used; ask again.')
  }
  const a = await waitApproval(requestId, token, waitMs)
  if (a.status === 'pending') return { status: 'pending' }
  // Withdrawn while the wait held (Lock all, the switch moved): an approval that comes back now gives nothing.
  if (pending.get(requestId) !== ask || since !== epoch) refuse(409, 'withdrawn', 'This ask was withdrawn (Lock all, or the switch moved): ask again.')
  const item = await getItem(ask.itemId).catch(() => undefined)
  if (a.status === 'denied') {
    pending.delete(requestId)
    const now = Date.now()
    denials.set(ask.asker, [...recent(denials, ask.asker, DENY_WINDOW_MS, now), now])
    await appendAgentLog({ kind: 'denied', approvalId: requestId, ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    refuse(403, 'denied', `The person said no${a.answeredBy ? ` (${a.answeredBy})` : ''}. Do not ask for this again in this task unless the person tells you to.`)
  }
  if (a.status === 'expired' || a.status === 'canceled') {
    pending.delete(requestId)
    if (a.status === 'expired') await appendAgentLog({ kind: 'expired', approvalId: requestId, ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    return { status: a.status }
  }
  if (agents === 'off') refuse(403, 'agents_off', 'Agents may not use passwords: the person turned it off in Settings, Passwords.')
  if (!item || item.trashedAt) refuse(404, 'not_found', 'The item was deleted after the ask.')
  if (accessOf(item) === 'never') refuse(403, 'agent_never', `"${item.title}" is never given to agents now.`)
  // Claimed before any await: two waits on one approval release (and count) once.
  // A second wait reads only after the first one's release went through.
  const first = ask.releasedAt === undefined
  if (first) {
    ask.releasedAt = Date.now()
    ask.releasing = release(item, ask, 'approval', requestId, since)
    ask.releasing.catch(() => { pending.delete(requestId) })
  }
  const values = first ? await ask.releasing! : (await ask.releasing, await valuesOf(item, ask.fields))
  let grantedUntil: string | undefined
  if (first) {
    if (ask.scope === 'task') {
      const until = Date.now() + GRANT_MS
      grants.set(grantKey(ask.holder, item.id), { until, fields: new Set(ask.fields) })
      grantedUntil = new Date(until).toISOString()
    }
  } else {
    const g = grants.get(grantKey(ask.holder, item.id))
    if (g) grantedUntil = new Date(g.until).toISOString()
  }
  return { status: 'released', item: viewOf(item, agents), values, via: 'approval', ...(grantedUntil ? { grantedUntil } : {}), ...(a.answeredBy ? { answeredBy: a.answeredBy } : {}) }
}

/** The asker gave up: forget the ask (the caller withdraws the approval). */
export function agentForget(requestId: string): boolean {
  return pending.delete(requestId)
}

export interface GrantView { asker: string; itemId: string; until: string; fields: string[] }

export function listGrants(): GrantView[] {
  const now = Date.now()
  const out: GrantView[] = []
  for (const [k, g] of grants) {
    if (g.until <= now) { grants.delete(k); continue }
    const [holder, itemId] = k.split('\u0000')
    out.push({ asker: holder.split('|')[0], itemId, until: new Date(g.until).toISOString(), fields: [...g.fields] })
  }
  return out
}

/** Lock all, or the person ending agent access: every grant ends, and pending asks are forgotten. */
export function endAllGrants(): { grants: number; asks: string[] } {
  epoch++
  const n = grants.size
  grants.clear()
  const asks = [...pending.entries()].filter(([, p]) => p.releasedAt === undefined).map(([id]) => id)
  // Released ones go too: their re-read window gives nothing after Lock all.
  pending.clear()
  return { grants: n, asks }
}
