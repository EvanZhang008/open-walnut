/**
 * Agents and the vault (docs/reference/passwords.md, "Agents"). An agent never holds a vault
 * session: it names an item and says why, and Walnut decides (decideAgentUse, the whole matrix):
 *
 *   - the item's agent access is `never`                → refused, agent_never (any mode)
 *   - this task holds a grant covering the fields       → released (via grant)
 *   - the switch is `off`                               → a person approves it (the only way in)
 *   - the item is sensitive                             → a person approves it, Face ID or Touch ID
 *   - the switch is `allow` ("Any"), or the item allows → released (via allow)
 *   - otherwise (`ask`)                                 → a person approves it
 *
 * An approval (approvals/, on the Mac or the phone) gives the task that asked, in its session,
 * a grant for the policy's grant length (policy.ts grantMs: once, 1 h, 12 h, until revoked; the
 * agent may ask for less with `scope: "once"`). Under `off` an agent sees no list (agentItems is
 * empty) and an ambiguous name never lists the matches.
 *
 * Brakes, per asker (its task, else its host): at most ASK_MAX asks waiting at once, at most
 * RELEASE_MAX releases in RELEASE_WINDOW_MS, and after DENY_MAX denials in DENY_WINDOW_MS its
 * asks pause for DENY_WINDOW_MS. Every outcome goes to the agent log, sealed (agent-log.ts),
 * with how the value was used (reveal, env, fill). Grants: agent-grants.ts. Pending asks live
 * in memory: a restart ends them, and Lock all ends every grant and ask.
 */
import { appendAgentLog, type AgentLogEntry, type AgentUseKind } from './agent-log.js'
import {
  clearGrants, getGrant, grantCovers, grantUseOf, listGrantViews, loadGrants, putGrant, revokeGrantById, resetGrantsForTest,
  type Grant, type GrantView,
} from './agent-grants.js'
import { getItem, listItems, markUsed, VaultError } from './store.js'
import { parseTotp, totpAt } from './totp.js'
import type { AgentAccess, VaultItem, VaultItemSummary } from './types.js'
import { displayHost, matchItem, siteKey } from './url-match.js'

export type AgentsSwitch = 'off' | 'ask' | 'allow'
export type AgentScope = 'once' | 'task'
export type { GrantView }

export const ASK_MAX = 3
export const RELEASE_MAX = 30
export const RELEASE_WINDOW_MS = 10 * 60_000
export const DENY_MAX = 3
export const DENY_WINDOW_MS = 30 * 60_000
/** The grant length when the caller names none and the policy cannot be read (policy.ts DEFAULT_GRANT_MS). */
export const GRANT_MS = 48 * 3_600_000
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

/** How the values are used once released: `reveal` (back to the agent), `env` (a command's environment), `fill` (a browser page). */
export type AgentUse = Exclude<AgentUseKind, 'list'>

export interface UseInput {
  /** An item id, its exact name, a site (github.com) or an env var name (GITHUB_TOKEN). */
  item: string
  /** password (default), username, totp, notes, card_number, card_code, card_expiry, or a custom field's name. */
  fields?: string[]
  purpose: string
  /** `once`: this use only, whatever the grant length. Absent or `task`: an approval gives the policy's grant. */
  scope?: AgentScope
  requester: AgentRequester
  agents: AgentsSwitch
  /** The grant an approval gives, in ms (policy.ts); absent: read from the policy. */
  grantMs?: number
  testRun?: string
  use?: AgentUse
  /** Older name for `use: 'fill'` (browser fill_login). */
  logKind?: 'fill'
}

export type UseResult =
  | { status: 'released'; item: AgentItemView; values: Record<string, string>; via: 'allow' | 'grant' | 'approval' | 'approvals-off'; grantedUntil?: string | null }
  | { status: 'pending'; requestId: string; waitToken: string; item: AgentItemView; mode: 'tap' | 'biometric'; expiresAt: string; downgraded?: string }

// ── the decision, pure ──

export type AgentDecision =
  | { kind: 'refuse'; status: number; code: 'agent_never'; message: string }
  | { kind: 'release'; via: 'allow' | 'grant' | 'approvals-off' }
  | { kind: 'ask'; biometric: boolean }

export interface DecisionInput {
  mode: AgentsSwitch
  /** The item's own setting (absent reads `ask`). */
  access: AgentAccess | undefined
  sensitive: boolean
  /** The fields asked for, and the grant this asker holds for the item (if any, still live). */
  fields: string[]
  /** How the values will be used; absent reads `reveal` (the widest, so no grant covers it by mistake). */
  use?: AgentUse
  /** `use` absent: an older record, read as `fill`. */
  grant?: { until: number; fields: Iterable<string>; use?: AgentUse }
  now?: number
  /** Approvals on (approvals/ask-me.ts). Off (false), an item that would ask is released, except one
   *  the person marked sensitive or never, or with the agents switch off: those are their own choice. */
  askMe?: boolean
}

/**
 * What Walnut does with one agent use, from the switch, the item's access, sensitive and a live
 * grant: refuse, release now, or ask a person (with Face ID or Touch ID when `biometric`). The
 * same answer for password_use, `walnut pass run` and browser fill_login.
 */
export function decideAgentUse(d: DecisionInput): AgentDecision {
  const access = d.access ?? 'ask'
  if (access === 'never') return { kind: 'refuse', status: 403, code: 'agent_never', message: 'This item is never given to agents. Ask the person to do this step themselves.' }
  const now = d.now ?? Date.now()
  if (d.grant && d.grant.until > now && grantCovers(grantUseOf(d.grant), d.use ?? 'reveal')) {
    const held = new Set(d.grant.fields)
    if (d.fields.every((f) => held.has(f))) return { kind: 'release', via: 'grant' }
  }
  if (d.mode === 'off') return { kind: 'ask', biometric: d.sensitive }
  if (d.sensitive) return { kind: 'ask', biometric: true }
  if (d.mode === 'allow' || access === 'allow') return { kind: 'release', via: 'allow' }
  if (d.askMe === false) return { kind: 'release', via: 'approvals-off' }
  return { kind: 'ask', biometric: false }
}

/** How a grant of `grantMs` reads to the person ("for 12 hours"). */
export function grantLengthText(grantMs: number): string {
  if (grantMs < 0) return 'until you revoke it'
  if (grantMs === 0) return 'this one use'
  if (grantMs % 3_600_000 === 0) { const h = grantMs / 3_600_000; return `for ${h === 1 ? 'an hour' : `${h} hours`}` }
  return `for ${Math.round(grantMs / 60_000)} minutes`
}

interface PendingAsk {
  itemId: string
  fields: string[]
  purpose: string
  scope: AgentScope
  grantMs: number
  use: AgentUse
  asker: string
  /** Who holds a grant this ask makes: the task and the session that asked (grantHolder). */
  holder: string
  requester: AgentRequester
  /** When the approval runs out: an ask nobody waits on any more is swept after it. */
  expiresAt: number
  releasedAt?: number
  releasing?: Promise<Record<string, string>>
  grantedUntil?: string | null
}

const pending = new Map<string, PendingAsk>()
const releases = new Map<string, number[]>()
const denials = new Map<string, number[]>()
/**
 * Bumped by Lock all and by every move of the switch: an ask or a release that began before
 * gives nothing after it, even when its approval comes back approved.
 */
let epoch = 0

export function resetAgentStateForTest(): void {
  pending.clear(); releases.clear(); denials.clear()
  resetGrantsForTest()
  epoch++
}

/** The switch moved (or Lock all): asks and releases still running give nothing. */
export function bumpAgentEpoch(): void {
  epoch++
}

const askerOf = (r: AgentRequester) => (r.taskId ? `task:${r.taskId}` : `host:${r.host}`)
/** A grant is the task's in the session that asked, on the host it asked from. */
const grantHolder = (r: AgentRequester) => `${askerOf(r)}|${r.sessionId ?? ''}|${r.host}`

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
    access: agents !== 'off' && (access === 'allow' || agents === 'allow') ? 'allow' : 'ask',
    ...(item.sensitive ? { sensitive: true } : {}),
  }
}

function refuse(status: number, code: string, message: string): never {
  throw new VaultError(message, status, code)
}

async function policyGrantMs(): Promise<number> {
  try {
    const { readPolicy } = await import('./policy.js')
    return (await readPolicy()).grantMs
  } catch {
    return GRANT_MS
  }
}

/**
 * Items an agent may ask for (not `never`, not in the trash), optionally filtered. Under `off`
 * the list is empty: an agent then only asks for one item it names. `forUse`: Walnut resolving
 * the item for a use it was asked for (browser fill_login picks the site's login), never shown
 * to the agent as a list, so it holds under `off` too.
 */
export async function agentItems(opts: { query?: string; site?: string; agents: AgentsSwitch; forUse?: boolean }): Promise<AgentItemView[]> {
  if (opts.agents === 'off' && !opts.forUse) return []
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

/** An agent read the list (the route logs it: who, what it searched, how many it saw). */
export async function logAgentListing(r: AgentRequester, count: number, query?: string): Promise<void> {
  await appendAgentLog({ kind: 'listed', use: 'list', count, ...(query ? { purpose: query.slice(0, 200) } : {}), ...logBase(undefined, undefined, undefined, r) })
}

/**
 * The item an agent named, among the items agents may ask for. An item kept from agents is
 * found only to say so (agent_never): its name never appears in another answer, and it never
 * makes an allowed item's name ambiguous. `quiet` (switch off): an ambiguous name lists nothing.
 */
async function resolveItem(ref: string, quiet: boolean): Promise<VaultItem> {
  const r = ref.trim()
  if (!r) refuse(400, 'bad_request', 'Name the item: its id, its name, a site or an env var name.')
  const live = (await listItems()).filter((s) => !s.trashedAt)
  const hit = await findIn(live.filter((s) => accessOf(s) !== 'never'), r, true, quiet)
  if (hit) return hit
  const kept = await findIn(live.filter((s) => accessOf(s) === 'never'), r, false, quiet)
  if (kept) return kept
  refuse(404, 'not_found', quiet ? `No item matches "${r}".` : `No item matches "${r}". password_list shows what an agent may ask for.`)
}

async function findIn(all: VaultItemSummary[], r: string, named: boolean, quiet: boolean): Promise<VaultItem | null> {
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
      if (quiet) refuse(409, 'ambiguous', `More than one item matches "${r}". Ask the person which one, then ask again with its exact name.`)
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
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    host: r.host,
    ...(r.command ? { command: r.command } : {}),
  }
}

async function release(item: VaultItem, ask: { fields: string[]; purpose: string; asker: string; requester: AgentRequester; use: AgentUse }, via: 'allow' | 'grant' | 'approval' | 'approvals-off', approvalId?: string, since = epoch, approvedBy?: string) {
  const now = Date.now()
  if (recent(releases, ask.asker, RELEASE_WINDOW_MS, now).length >= RELEASE_MAX) {
    await appendAgentLog({ kind: 'refused', reason: 'agent_rate', use: ask.use, ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    refuse(429, 'agent_rate', `This task got ${RELEASE_MAX} passwords in ${RELEASE_WINDOW_MS / 60_000} minutes; wait before asking again.`)
  }
  const values = await valuesOf(item, ask.fields)
  if (since !== epoch) refuse(409, 'withdrawn', 'Agent access changed (Lock all, or the switch moved) while this ran: ask again.')
  releases.set(ask.asker, [...recent(releases, ask.asker, RELEASE_WINDOW_MS, now), now])
  await markUsed(item.id).catch(() => undefined)
  await appendAgentLog({
    kind: ask.use === 'fill' ? 'fill' : 'released', via, use: ask.use,
    ...(approvalId ? { approvalId } : {}), ...(approvedBy ? { approvedBy } : {}),
    ...logBase(item, ask.fields, ask.purpose, ask.requester),
  })
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

const USE_TEXT: Record<AgentUse, string> = {
  reveal: 'shown to the agent',
  env: 'given to a command, never shown to the agent',
  fill: 'filled into a browser page, never shown to the agent',
}

function approvalText(item: VaultItem, ask: { fields: string[]; purpose: string; grants: boolean; grantMs: number; use: AgentUse; requester: AgentRequester; off: boolean }) {
  const r = ask.requester
  // The title is what the person decides on: which item, which fields, and why. Who asked is
  // the card's next line (the task, or the command and host), and the rest is in the detail.
  // A field in the person's words ("totp" is the one-time code).
  const shown = ask.fields.map((f) => (f === 'totp' ? 'one-time code' : f))
  const what = ask.fields.length === 1 && ask.fields[0] === 'password' ? 'password' : shown.join(', ')
  const head = `${item.title} ${what}: ${ask.purpose}`
  const lines = [
    `Item: ${item.title}${item.urls?.length ? ` (${item.urls.map(displayHost).join(', ')})` : ''}`,
    `Fields: ${shown.join(', ')}`,
    `Why: ${ask.purpose}`,
    `Use: ${USE_TEXT[ask.use]}`,
    `For: ${ask.grants ? `this task, ${grantLengthText(ask.grantMs)}` : 'this one use'}`,
    ...(ask.off ? ['Agent access is Off: this item is given only if you approve.'] : []),
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
  const use: AgentUse = input.use ?? (input.logKind === 'fill' ? 'fill' : 'reveal')
  sweepPending(Date.now())
  await loadGrants()
  const purpose = cleanPurpose(input.purpose)
  const fields = cleanFields(input.fields)
  const item = await resolveItem(input.item, input.agents === 'off')
  const view = viewOf(item, input.agents)
  const now = Date.now()
  const grant = getGrant(holder, item.id, now)
  const { asksPerson } = await import('../approvals/ask-me.js')
  const decision = decideAgentUse({ mode: input.agents, access: item.agentAccess, sensitive: !!item.sensitive, fields, use, grant, now, askMe: await asksPerson() })
  if (decision.kind === 'refuse') {
    await appendAgentLog({ kind: 'refused', reason: decision.code, use, ...logBase(item, fields, purpose, r) })
    refuse(decision.status, decision.code, `"${item.title}" is never given to agents. Ask the person to do this step themselves.`)
  }
  await valuesOf(item, fields) // validate fields before any approval: an ask the person approves must be answerable

  if (decision.kind === 'release') {
    const values = await release(item, { fields, purpose, asker, requester: r, use }, decision.via, undefined, since)
    return {
      status: 'released', item: view, values, via: decision.via,
      ...(decision.via === 'grant' && grant ? { grantedUntil: Number.isFinite(grant.until) ? new Date(grant.until).toISOString() : null } : {}),
    }
  }

  const denied = recent(denials, asker, DENY_WINDOW_MS, now)
  if (denied.length >= DENY_MAX) {
    const until = new Date(denied[0] + DENY_WINDOW_MS)
    await appendAgentLog({ kind: 'refused', reason: 'agent_paused', use, ...logBase(item, fields, purpose, r) })
    refuse(429, 'agent_paused', `The person said no ${DENY_MAX} times in ${DENY_WINDOW_MS / 60_000} minutes, so this task's asks pause until ${until.toISOString()}. Do not ask again before then.`)
  }
  const waiting = [...pending.values()].filter((p) => p.asker === asker && p.releasedAt === undefined).length
  if (waiting >= ASK_MAX) refuse(429, 'too_many_asks', `${waiting} asks of this task already wait for the person; wait for those first.`)

  const grantMs = typeof input.grantMs === 'number' ? input.grantMs : await policyGrantMs()
  // A grant needs a task (a bare script on a host gets one use), and the agent may ask for less.
  const scope: AgentScope = input.scope !== 'once' && r.taskId && grantMs !== 0 ? 'task' : 'once'
  const text = approvalText(item, { fields, purpose, grants: scope === 'task', grantMs, use, requester: r, off: input.agents === 'off' })
  const a = await createApproval({ ...text, biometric: decision.biometric, timeoutMs: APPROVAL_TIMEOUT_MS, requester: r, testRun: input.testRun })
  // Lock all or the switch moved while the card was being made: no ask is kept, so nothing is released from it.
  if (since !== epoch) {
    await a.cancel?.()
    refuse(409, 'withdrawn', 'Agent access changed (Lock all, or the switch moved) while asking: ask again.')
  }
  pending.set(a.id, { itemId: item.id, fields, purpose, scope, grantMs, use, asker, holder, requester: r, expiresAt: Date.parse(a.expiresAt) || Date.now() + APPROVAL_TIMEOUT_MS })
  await appendAgentLog({ kind: 'asked', approvalId: a.id, use, ...logBase(item, fields, purpose, r) })
  return { status: 'pending', requestId: a.id, waitToken: a.waitToken, item: view, mode: a.mode, expiresAt: a.expiresAt, ...(a.downgraded ? { downgraded: a.downgraded } : {}) }
}

export type ApprovalWaiter = (id: string, token: string, waitMs: number) =>
  Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'; used: boolean; answeredBy?: string }>

export type WaitResult =
  | { status: 'released'; item: AgentItemView; values: Record<string, string>; via: 'approval'; grantedUntil?: string | null; answeredBy?: string }
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
    await appendAgentLog({ kind: 'denied', approvalId: requestId, use: ask.use, ...(a.answeredBy ? { approvedBy: a.answeredBy } : {}), ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    refuse(403, 'denied', `The person said no${a.answeredBy ? ` (${a.answeredBy})` : ''}. Do not ask for this again in this task unless the person tells you to.`)
  }
  if (a.status === 'expired' || a.status === 'canceled') {
    pending.delete(requestId)
    if (a.status === 'expired') await appendAgentLog({ kind: 'expired', approvalId: requestId, use: ask.use, ...logBase(item, ask.fields, ask.purpose, ask.requester) })
    return { status: a.status }
  }
  if (!item || item.trashedAt) refuse(404, 'not_found', 'The item was deleted after the ask.')
  if (accessOf(item) === 'never') refuse(403, 'agent_never', `"${item.title}" is never given to agents now.`)
  // Claimed before any await: two waits on one approval release (and count) once.
  // A second wait reads only after the first one's release went through.
  const first = ask.releasedAt === undefined
  if (first) {
    ask.releasedAt = Date.now()
    ask.releasing = release(item, ask, 'approval', requestId, since, a.answeredBy)
    ask.releasing.catch(() => { pending.delete(requestId) })
  }
  const values = first ? await ask.releasing! : (await ask.releasing, await valuesOf(item, ask.fields))
  if (first && ask.scope === 'task') {
    const now = Date.now()
    const until = ask.grantMs < 0 ? Infinity : now + ask.grantMs
    const g: Grant = {
      holder: ask.holder, itemId: item.id, until, fields: [...ask.fields], use: ask.use, grantedAt: now, asker: ask.asker, host: ask.requester.host,
      itemTitle: item.title,
      ...(ask.requester.taskId ? { taskId: ask.requester.taskId } : {}), ...(ask.requester.taskTitle ? { taskTitle: ask.requester.taskTitle } : {}),
      ...(ask.requester.sessionId ? { sessionId: ask.requester.sessionId } : {}), ...(a.answeredBy ? { approvedBy: a.answeredBy } : {}),
    }
    putGrant(g)
    ask.grantedUntil = Number.isFinite(until) ? new Date(until).toISOString() : null
  }
  return {
    status: 'released', item: viewOf(item, agents), values, via: 'approval',
    ...(ask.grantedUntil !== undefined ? { grantedUntil: ask.grantedUntil } : {}), ...(a.answeredBy ? { answeredBy: a.answeredBy } : {}),
  }
}

/** The asker gave up: forget the ask (the caller withdraws the approval). */
export function agentForget(requestId: string): boolean {
  return pending.delete(requestId)
}

export function listGrants(): GrantView[] {
  return listGrantViews()
}

/** The person ended one grant (Agent Activity). Logged; null when there was none. */
export async function revokeGrant(id: string): Promise<GrantView | null> {
  await loadGrants()
  const g = revokeGrantById(id)
  if (!g) return null
  await appendAgentLog({
    kind: 'revoked', itemId: g.itemId, ...(g.itemTitle ? { itemTitle: g.itemTitle } : {}), fields: g.fields,
    ...(g.taskId ? { taskId: g.taskId } : {}), ...(g.taskTitle ? { taskTitle: g.taskTitle } : {}), ...(g.sessionId ? { sessionId: g.sessionId } : {}), host: g.host,
  })
  return { id, asker: g.asker, itemId: g.itemId, until: Number.isFinite(g.until) ? new Date(g.until).toISOString() : null, grantedAt: new Date(g.grantedAt).toISOString(), fields: g.fields, use: grantUseOf(g), host: g.host }
}

/** Lock all, a new master password, or the person ending agent access: every grant ends, and pending asks are forgotten. */
export function endAllGrants(): { grants: number; asks: string[] } {
  epoch++
  const n = clearGrants()
  const asks = [...pending.entries()].filter(([, p]) => p.releasedAt === undefined).map(([id]) => id)
  // Released ones go too: their re-read window gives nothing after Lock all.
  pending.clear()
  return { grants: n, asks }
}
