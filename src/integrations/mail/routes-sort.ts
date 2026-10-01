/**
 * Inbox sorting's READ routes (`/groups`, `/groups/summary`, `/rules`) and the rename.
 *
 * A group is UNREAD mail: its number is its unread, and a group with none is not in the answer at
 * all. Every number is a CACHED count (the mail Walnut keeps), except `providerTotal` and
 * `providerUnread`, which are the mailbox rows' own figures. Every route answers inside a budget: a
 * slow database answers with the last result and `stale: true` rather than holding one of the
 * browser's six connections.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { PRIMARY_ONLY, errorReply, firstQuery, readBody, segmentsAfter, withBudget } from './contract.js'
import type { MailFilterMover } from './mail-filter-moves.js'
import type { MailProviderRegistry } from './provider-registry.js'
import { IMPORTANT } from './sort-classify.js'
import type { MailSortEngine } from './sort-engine.js'
import { builtinSummaries } from './sort-rule-summary.js'
import { disambiguateLabels, senderLabel } from './sort-sender.js'
import { bySenderRank, type SenderStatRow } from './sort-store.js'
import type {
  FolderPair, GroupItem, GroupsResponse, GroupsScope, GroupsSummary, RulesResponse,
} from './sort-types.js'
import type { MailStore } from './store.js'

export const GROUPS_BUDGET_MS = 3_000
export const SUMMARY_BUDGET_MS = 1_000
const SENDERS_BUDGET_MS = 3_000
const MAX_SENDERS_PAGE = 100

type Query = Record<string, string | string[] | undefined>

/** A query scope: `scope=role:inbox`, or `account=<id>&mailbox=<id>`. Both, or neither, is an error. */
export function parseSortScope(query: Query): GroupsScope | { error: string } {
  const scope = firstQuery(query.scope)
  const account = firstQuery(query.account)
  const mailbox = firstQuery(query.mailbox)
  if (scope && (account || mailbox)) return { error: 'scope covers every inbox; do not also pass account or mailbox' }
  if (scope) return scope === 'role:inbox' ? { role: 'inbox' } : { error: 'scope must be role:inbox' }
  if (account && mailbox) return { accountId: account, mailboxId: mailbox }
  return { error: 'pass scope=role:inbox, or account and mailbox' }
}

/** A JSON body scope (`{role:'inbox'}` or `{accountId, mailboxId}`). */
export function parseBodyScope(value: unknown): GroupsScope | { error: string } {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return { error: 'scope is required' }
  const hasPair = typeof raw.accountId === 'string' || typeof raw.mailboxId === 'string'
  if (raw.role !== undefined && hasPair) return { error: 'scope is either role or accountId + mailboxId' }
  if (raw.role === 'inbox') return { role: 'inbox' }
  if (typeof raw.accountId === 'string' && raw.accountId && typeof raw.mailboxId === 'string' && raw.mailboxId) {
    return { accountId: raw.accountId, mailboxId: raw.mailboxId }
  }
  return { error: 'scope must be { role: "inbox" } or { accountId, mailboxId }' }
}

/** The (account, mailbox) pairs a scope covers, from the cached mailbox rows. */
export async function pairsOf(store: MailStore, scope: GroupsScope): Promise<FolderPair[]> {
  if ('role' in scope) {
    const rows = await store.mailboxesByRole(scope.role)
    return rows.map((row) => ({ accountId: row.account_id, mailboxId: row.mailbox_id }))
  }
  return [{ accountId: scope.accountId, mailboxId: scope.mailboxId }]
}

export function scopeKey(scope: GroupsScope): string {
  return 'role' in scope ? `role:${scope.role}` : JSON.stringify([scope.accountId, scope.mailboxId])
}

function labelsOf(rows: SenderStatRow[]): string[] {
  return disambiguateLabels(rows.map((row) => ({ key: row.sender_key, label: senderLabel(row.addr, row.name) })))
}

/** Everything the group rows need, for one scope: unread mail only, newest group first. */
export async function buildGroups(
  store: MailStore,
  sort: MailSortEngine,
  pairs: FolderPair[],
  canArchive?: (accountId: string) => boolean,
): Promise<GroupsResponse> {
  await sort.ready().catch(() => undefined)
  const [counts, unread, stats, provider, seq, ai, latest, lines] = await Promise.all([
    store.sort.groupCounts(pairs),
    store.sort.unreadGroups(pairs),
    store.sort.senderStats(pairs, undefined, true),
    store.sort.providerCounts(pairs),
    store.sort.seq(pairs),
    sort.aiStatus(pairs),
    store.summaries.latestSubjects(pairs),
    store.summaries.stored(),
  ])
  const important = { total: 0, unread: 0 }
  let cachedTotal = 0
  let cachedUnread = 0
  for (const row of counts) {
    cachedTotal += row.total
    cachedUnread += row.unread
    if (row.grp === IMPORTANT) { important.total += row.total; important.unread += row.unread }
  }
  const byGroup = new Map<string, GroupItem>()
  const readOnly = new Map<string, Set<string>>()
  const stuck = new Map<string, Set<string>>()
  for (const row of unread) {
    if (row.unread <= 0) continue
    let group = byGroup.get(row.grp)
    if (!group) {
      group = {
        id: row.grp, label: sort.labelOf(row.grp, row.label), unread: 0, newestAt: 0, topSenders: [],
        unsubscribable: 0, markableUnread: 0, readOnlyAccounts: [], watermark: { at: 0, seq: 0 }, summary: '',
      }
      if (sort.isRenamed(row.grp)) group.renamed = true
      byGroup.set(row.grp, group)
    }
    group.unread += row.unread
    group.newestAt = Math.max(group.newestAt, row.newest_at ?? 0)
    group.watermark = { at: group.newestAt, seq: Math.max(group.watermark.seq, row.max_rowid ?? 0) }
    if (sort.canMarkRead(row.account_id)) group.markableUnread += row.unread
    else {
      const set = readOnly.get(row.grp) ?? new Set<string>()
      set.add(sort.accountLabel(row.account_id))
      readOnly.set(row.grp, set)
    }
    if (canArchive && !canArchive(row.account_id)) {
      const set = stuck.get(row.grp) ?? new Set<string>()
      set.add(sort.accountLabel(row.account_id))
      stuck.set(row.grp, set)
    }
  }
  const perGroup = new Map<string, SenderStatRow[]>()
  for (const row of stats) {
    if (!byGroup.has(row.grp)) continue
    const list = perGroup.get(row.grp) ?? []
    list.push(row)
    perGroup.set(row.grp, list)
  }
  for (const [id, group] of byGroup) {
    const rows = (perGroup.get(id) ?? []).sort(bySenderRank)
    const top = rows.slice(0, 3)
    const labels = labelsOf(top)
    group.topSenders = top.map((row, index) => ({ key: row.sender_key, label: labels[index]!, unread: row.unread }))
    group.unsubscribable = rows.filter((row) => (row.unsub_rank ?? 0) > 0).length
    group.readOnlyAccounts = [...(readOnly.get(id) ?? [])].sort()
    if (canArchive) group.cannotArchive = [...(stuck.get(id) ?? [])].sort()
    // One unread mail: its subject says it exactly. More: the model's line, when it wrote one.
    const line = group.unread > 1 ? lines.get(id)?.summary : ''
    if (line) { group.summary = line; group.summaryBy = 'ai' }
    else group.summary = latest.get(id) ?? ''
  }
  const groups = [...byGroup.values()].sort((a, b) => b.newestAt - a.newestAt || a.label.localeCompare(b.label))
  const recomputing = sort.recomputing()
  const rulesError = sort.rulesError
  return {
    rulesRev: sort.rulesRev,
    seq,
    ...(recomputing ? { recomputing } : {}),
    ...(rulesError ? { rulesError } : {}),
    ai,
    important,
    cachedTotal,
    cachedUnread,
    providerTotal: provider.reduce((sum, row) => sum + row.total, 0),
    providerUnread: provider.reduce((sum, row) => sum + row.unread, 0),
    groups,
  }
}

/** The badge and digest numbers. */
export async function buildSummary(store: MailStore, sort: MailSortEngine, pairs: FolderPair[]): Promise<GroupsSummary> {
  await sort.ready().catch(() => undefined)
  const [counts, ai] = await Promise.all([store.sort.groupCounts(pairs), sort.aiStatus(pairs)])
  let importantUnread = 0
  let sortedUnread = 0
  for (const row of counts) {
    if (row.grp === IMPORTANT) importantUnread += row.unread
    else sortedUnread += row.unread
  }
  return { importantUnread, sortedUnread, pending: ai.pending, rulesRev: sort.rulesRev }
}

/** `GET /rules`, whole. */
export async function buildRules(sort: MailSortEngine): Promise<RulesResponse> {
  const doc = sort.rules()
  const compiled = new Map(sort.compiledRules().map((rule) => [rule.index, rule.id]))
  const error = sort.rulesError
  return {
    path: sort.rulesPath,
    exists: sort.fileExists,
    rulesRev: sort.rulesRev,
    fileRev: sort.fileRev,
    groups: doc.groups,
    rules: doc.rules.map((rule, index) => ({
      ...rule,
      id: rule.id ?? compiled.get(index) ?? `rule-${index + 1}`,
      summary: sort.summarize(rule),
    })),
    builtins: builtinSummaries(),
    catalog: await sort.catalog(),
    ...(error ? { error } : {}),
  }
}

function bad(message: string) {
  return { status: 400, json: { error: 'invalid', message } }
}

export function registerMailSortRoutes(
  walnut: WalnutServerPluginApi,
  deps: { store: MailStore; sort: MailSortEngine; providers?: MailProviderRegistry; filters?: Pick<MailFilterMover, 'canArchive'> },
): void {
  const { store, sort } = deps
  const canArchive = deps.filters ? (accountId: string) => deps.filters!.canArchive(accountId) : undefined
  const lastGroups = new Map<string, GroupsResponse>()
  const lastSummary = new Map<string, GroupsSummary>()
  const onLate = (what: string) => (outcome: { error?: unknown }) => {
    if (outcome.error) walnut.log.warn(`mail ${what} failed after its budget`, { error: String(outcome.error).slice(0, 200) })
  }

  walnut.http.route('get', '/groups/summary', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const query = request.query as Query
    const scope = firstQuery(query.scope) || firstQuery(query.account) ? parseSortScope(query) : { role: 'inbox' as const }
    if ('error' in scope) return bad(scope.error)
    const key = scopeKey(scope)
    try {
      const answer = await withBudget(pairsOf(store, scope).then((pairs) => buildSummary(store, sort, pairs)), SUMMARY_BUDGET_MS, onLate('group summary'))
      if (answer) { lastSummary.set(key, answer); return { json: answer } }
      const last = lastSummary.get(key)
      return last ? { json: { ...last, stale: true } } : { status: 503, json: { error: 'timeout', message: 'Group counts are taking too long.' } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  // Rename a group: the person's name wins over the model's from then on.
  walnut.http.route('put', '/groups/:groupId/label', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const groupId = segmentsAfter(request, '/groups/')[0] ?? ''
    const body = await readBody(request)
    if (!groupId) return bad('a group id is required')
    if (!body || typeof body.label !== 'string') return bad('label is required')
    try {
      await withBudget(sort.ready(), GROUPS_BUDGET_MS)
      const outcome = await sort.renameGroup(groupId, body.label)
      return outcome.ok ? { json: { label: outcome.label } } : bad(outcome.message)
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/groups', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const scope = parseSortScope(request.query as Query)
    if ('error' in scope) return bad(scope.error)
    const key = scopeKey(scope)
    try {
      const started = Date.now()
      const answer = await withBudget(pairsOf(store, scope).then((pairs) => buildGroups(store, sort, pairs, canArchive)), GROUPS_BUDGET_MS, onLate('groups'))
      if (answer) {
        lastGroups.set(key, answer)
        walnut.log.debug?.('mail groups answered', { scope: key, ms: Date.now() - started, groups: answer.groups.length })
        return { json: answer }
      }
      const last = lastGroups.get(key)
      return last
        ? { json: { ...last, stale: true } }
        : { status: 503, json: { error: 'timeout', message: 'Group counts are taking too long.' } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/rules', async () => {
    if (walnut.replica) return PRIMARY_ONLY
    try {
      await withBudget(sort.ready(), GROUPS_BUDGET_MS)
      return { json: await buildRules(sort) }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
