/**
 * The unsubscribe checklist of one group (spec 6.3): `GET /groups/:groupId/unsubscribe-plan`.
 *
 * Built from the newest mail of each of the group's 60 most recent senders. A sender's way out comes
 * from the cached payload (`listUnsubscribe`, from a poll or a body read) or, failing that, from the
 * hints table (headers fetched late). `listKey` is the ledger's own key (`unsubscribeListKey`), and it
 * is exposed on this route only, so the checklist and the ledger can never disagree about a list.
 *
 * Two passes. `check=0` reads the cache and answers at once, with `unchecked`: senders whose newest
 * mail has no header answer yet on an account that can fetch one. `check=1` then asks the provider for
 * those headers (`fetchListHeaders`, a PEEK that never sets `\Seen`), at most 60 senders and 4 s in
 * total, records every answer (an empty one too, so it is not fetched again), re-sorts those rows and
 * answers the new plan (`partial: true` when the clock ran out). Reading headers sends nothing to any
 * sender: nothing leaves Walnut before the batch POST.
 */
import { PRIMARY_ONLY, errorReply, firstQuery, segmentsAfter, withBudget } from './contract.js'
import { pairsOf, parseSortScope } from './routes-sort.js'
import { parseJson, unsubscribeListKey, type MessagePayload, type StoredListUnsubscribe } from './service-dto.js'
import { senderLabel } from './sort-sender.js'
import type { UnsubCandidateRow } from './sort-store.js'
import type { FolderPair, MailSortWriteDeps } from './sort-types.js'
import type { MailListHeaders } from './types.js'

export const PLAN_SENDERS = 60
export const HEADER_CHECK_BUDGET_MS = 4_000
const PLAN_BUDGET_MS = 3_000

export type PlanMethod = 'one-click' | 'mailto' | 'link'

export interface PlanItem {
  listKey: string
  keyedBy: 'list-id' | 'sender'
  label: string
  accountId: string
  messageId: string
  method: PlanMethod
  mails: number
  canSend: boolean
  /** A mailto this account cannot send: the address, so the checklist can offer Copy and the mail app. */
  mailto?: string
  done?: { at: number; method: string }
  attempt?: { status: string; at: number }
}

export interface UnsubscribePlan {
  items: PlanItem[]
  /** Senders in the group with no unsubscribe option cached. */
  withoutOption: number
  /** Of those, the ones whose headers Walnut has never read. */
  headerUnknown: number
  /** `check=0`: senders a `check=1` would fetch headers for. */
  unchecked?: number
  /** `check=1`: the 4 s budget ran out before every fetch answered. */
  partial?: boolean
}

/** A row's way out: the payload first, the late-fetched hints second. */
export function heldOf(row: Pick<UnsubCandidateRow, 'payload' | 'list_headers_json'>): StoredListUnsubscribe | undefined {
  const payload = parseJson<MessagePayload>(row.payload, {})
  const own = payload.listUnsubscribe
  if (own && (own.https?.length || own.mailto?.length || own.bodyLink)) return own
  const hint = row.list_headers_json ? parseJson<MailListHeaders | null>(row.list_headers_json, null) : null
  const late = hint?.listUnsubscribe
  if (late && (late.https?.length || late.mailto?.length)) {
    const listId = hint?.listId ?? late.listId
    return { ...late, ...(listId ? { listId } : {}) }
  }
  return own
}

/** The best rung for this account: one-click, then a link when the account cannot send, then mailto. */
export function bestMethod(held: StoredListUnsubscribe | undefined, canSend: boolean): PlanMethod | undefined {
  if (!held) return undefined
  const https = (held.https?.length ?? 0) > 0
  const link = https || !!held.bodyLink
  if (held.oneClick && https) return 'one-click'
  if (!canSend && link) return 'link'
  if (held.mailto?.length) return 'mailto'
  if (link) return 'link'
  return undefined
}

/** Headers never read: no cached answer, never checked late, and no body read either. */
export function headersUnknown(row: Pick<UnsubCandidateRow, 'payload' | 'headers_checked_at'>): boolean {
  const payload = parseJson<MessagePayload>(row.payload, {})
  return !payload.listUnsubscribe && row.headers_checked_at == null && !payload.bodyFormat
}

export interface PlanContext {
  canSend(accountId: string): boolean
  /** Can this account's provider fetch list headers late? */
  canFetch(accountId: string): boolean
  /** Ledger rows for these candidates (`store.write.unsubscribesFor`), newest first. */
  ledger: ReadonlyArray<{ account_id: string; message_id: string; list_key: string; method: string; status: string; at: number }>
  /** Message ids fetched by this very request: listed after the ones already known. */
  fresh?: ReadonlySet<string>
}

/** The plan from the candidate rows (pure, so every rule above is testable without a database). */
export function buildPlan(candidates: ReadonlyArray<UnsubCandidateRow>, ctx: PlanContext): UnsubscribePlan {
  const doneByList = new Map<string, { at: number; method: string }>()
  const own = new Map<string, { status: string; at: number }>()
  for (const row of ctx.ledger) {
    const list = `${row.account_id}\u0000${row.list_key}`
    if (row.status === 'done' && !doneByList.has(list)) doneByList.set(list, { at: row.at, method: row.method })
    const mine = `${row.account_id}\u0000${row.message_id}`
    if (!own.has(mine)) own.set(mine, { status: row.status, at: row.at })
  }
  const items = new Map<string, PlanItem>()
  const late: PlanItem[] = []
  let withoutOption = 0
  let headerUnknown = 0
  let unchecked = 0
  for (const row of candidates) {
    const held = heldOf(row)
    const canSend = ctx.canSend(row.account_id)
    const method = bestMethod(held, canSend)
    if (!method) {
      withoutOption += 1
      if (headersUnknown(row)) {
        headerUnknown += 1
        if (ctx.canFetch(row.account_id)) unchecked += 1
      }
      continue
    }
    const payload = parseJson<MessagePayload>(row.payload, {})
    const listKey = unsubscribeListKey(held, row.from_addr, row.message_id)
    const key = `${row.account_id}\u0000${listKey}`
    const existing = items.get(key)
    if (existing) { existing.mails += Number(row.mails) || 0; continue }
    const done = doneByList.get(key)
    const attempt = own.get(`${row.account_id}\u0000${row.message_id}`)
    const item: PlanItem = {
      listKey,
      keyedBy: held?.listId ? 'list-id' : 'sender',
      label: senderLabel(row.from_addr, payload.from?.name),
      accountId: row.account_id,
      messageId: row.message_id,
      method,
      mails: Number(row.mails) || 0,
      canSend,
      ...(method === 'mailto' && !canSend && held?.mailto?.[0] ? { mailto: held.mailto[0] } : {}),
      ...(done ? { done } : {}),
      ...(attempt && attempt.status !== 'done' ? { attempt } : {}),
    }
    items.set(key, item)
    if (ctx.fresh?.has(row.message_id)) late.push(item)
  }
  const early = [...items.values()].filter((item) => !late.includes(item))
  return { items: [...early, ...late], withoutOption, headerUnknown, unchecked }
}

/** Candidates whose headers a `check=1` fetches: unknown, on a fetching account, newest first. */
export function toCheck(candidates: ReadonlyArray<UnsubCandidateRow>, canFetch: (accountId: string) => boolean): UnsubCandidateRow[] {
  return candidates
    .filter((row) => !bestMethod(heldOf(row), true) && headersUnknown(row) && canFetch(row.account_id))
    .slice(0, PLAN_SENDERS)
}

type PlanDeps = Pick<MailSortWriteDeps, 'store' | 'service' | 'sort'>

async function accountAbilities(deps: PlanDeps): Promise<{ canSend(id: string): boolean; canFetch(id: string): boolean }> {
  const accounts = await deps.service.listAccounts({ capabilities: true }).catch(() => [])
  const send = new Map(accounts.map((one) => [one.accountId, one.capabilities?.send]))
  const specOf = (accountId: string) => { try { return deps.service.provider(accountId) } catch { return undefined } }
  return {
    canSend: (id) => send.get(id) ?? specOf(id)?.capabilities.send ?? false,
    canFetch: (id) => typeof specOf(id)?.fetchListHeaders === 'function',
  }
}

/**
 * `check=1`: fetch the unknown headers, per folder, inside ONE 4 s budget, and record every answer.
 * Returns the ids that answered and whether the budget ran out.
 */
export async function checkHeaders(
  deps: PlanDeps,
  rows: ReadonlyArray<UnsubCandidateRow>,
  budgetMs = HEADER_CHECK_BUDGET_MS,
): Promise<{ fetched: Set<string>; partial: boolean }> {
  const deadline = Date.now() + budgetMs
  const byFolder = new Map<string, { accountId: string; mailboxId: string; ids: string[] }>()
  for (const row of rows) {
    const key = `${row.account_id}\u0000${row.mailbox_id}`
    const folder = byFolder.get(key) ?? { accountId: row.account_id, mailboxId: row.mailbox_id, ids: [] }
    folder.ids.push(row.message_id)
    byFolder.set(key, folder)
  }
  const fetched = new Set<string>()
  let partial = false
  await Promise.all([...byFolder.values()].map(async (folder) => {
    const spec = deps.service.provider(folder.accountId)
    if (!spec.fetchListHeaders) return
    const left = deadline - Date.now()
    const answer = left > 0
      ? await withBudget(spec.fetchListHeaders(folder.accountId, folder.mailboxId, folder.ids), left).catch(() => undefined)
      : undefined
    if (!answer) { partial = true; return }
    const asked = new Set(folder.ids)
    const entries = answer
      .filter((one) => one && asked.has(one.messageId))
      .map((one) => ({ messageId: one.messageId, headers: one.headers ?? null }))
    // Every asked id gets an answer on disk, `null` included, so it is never fetched again.
    for (const id of folder.ids) if (!entries.some((one) => one.messageId === id)) entries.push({ messageId: id, headers: null })
    await deps.sort.applyListHeaders(folder.accountId, folder.mailboxId, entries)
    for (const one of entries) if (one.headers) fetched.add(one.messageId)
  }))
  return { fetched, partial }
}

export async function planFor(deps: PlanDeps, pairs: FolderPair[], groupId: string, check: boolean): Promise<UnsubscribePlan> {
  const abilities = await accountAbilities(deps)
  let candidates = await deps.store.sort.unsubCandidates(pairs, groupId, PLAN_SENDERS)
  let fresh: Set<string> | undefined
  let partial = false
  if (check) {
    const pending = toCheck(candidates, abilities.canFetch)
    if (pending.length > 0) {
      const outcome = await checkHeaders(deps, pending)
      fresh = outcome.fetched
      partial = outcome.partial
      candidates = await deps.store.sort.unsubCandidates(pairs, groupId, PLAN_SENDERS)
    }
  }
  const byAccount = new Map<string, { accountId: string; messageIds: string[]; listKeys: string[] }>()
  for (const row of candidates) {
    const group = byAccount.get(row.account_id) ?? { accountId: row.account_id, messageIds: [], listKeys: [] }
    group.messageIds.push(row.message_id)
    group.listKeys.push(unsubscribeListKey(heldOf(row), row.from_addr, row.message_id))
    byAccount.set(row.account_id, group)
  }
  const ledger = byAccount.size > 0 ? await deps.store.write.unsubscribesFor([...byAccount.values()]) : []
  const plan = buildPlan(candidates, { ...abilities, ledger, ...(fresh ? { fresh } : {}) })
  if (check) {
    const { unchecked: _unchecked, ...rest } = plan
    return { ...rest, ...(partial ? { partial: true } : {}) }
  }
  return plan
}

export function registerUnsubPlanRoutes(walnut: MailSortWriteDeps['walnut'], deps: PlanDeps): void {
  walnut.http.route('get', '/groups/:groupId/unsubscribe-plan', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const query = request.query as Record<string, string | string[] | undefined>
    const scope = parseSortScope(query)
    if ('error' in scope) return { status: 400, json: { error: 'invalid', message: scope.error } }
    const groupId = segmentsAfter(request, '/groups/')[0] ?? ''
    if (!groupId) return { status: 400, json: { error: 'invalid', message: 'a group id is required' } }
    const check = firstQuery(query.check) === '1'
    try {
      const pairs = await pairsOf(deps.store, scope)
      const plan = await withBudget(planFor(deps, pairs, groupId, check), PLAN_BUDGET_MS + (check ? HEADER_CHECK_BUDGET_MS : 0))
      return plan
        ? { json: plan }
        : { status: 503, json: { error: 'timeout', message: 'The unsubscribe list is taking too long.' } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
