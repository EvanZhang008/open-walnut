// Confirms before the arrival is announced, so ordinary triage never reads a matched private item as unassigned.
// Capture only reads: an item written then (before the body prefetch) could wake the router at a version about to change.
import { readRouterAreas, type RouterAreasFile, type RouterRuleBinding } from '../../core/router/areas.js'
import {
  confirmRouterIncoming, pendingRuleAreas, readPendingRuleMatches, sameRuleBinding, type PendingRuleMatch,
} from '../../core/router/rules.js'
import type { RouterSource } from '../../core/router/types.js'
import type { MailIncomingCapture, MailIncomingFinish } from './contract.js'
import type { MailHeadline } from './events.js'
import type { MailStore, MessageRow } from './store.js'
import { mailRouterKey, mailRowDeliveryVersion } from './router-source.js'

/** Rows per cache query and sources per confirm call. */
export const ROUTER_INTAKE_BATCH = 200

const noop: MailIncomingFinish = async () => undefined

type Identity = Pick<MessageRow,
  'rowid' | 'sent_at' | 'received_at' | 'rfc_message_id' | 'from_addr' | 'subject' | 'thread_id' | 'attachments_json'>

const identityOf = (row: MessageRow): Identity => ({
  rowid: row.rowid,
  sent_at: row.sent_at,
  received_at: row.received_at,
  rfc_message_id: row.rfc_message_id,
  from_addr: row.from_addr,
  subject: row.subject,
  thread_id: row.thread_id,
  attachments_json: row.attachments_json,
})

// A body read may fill a sender the listing left blank (gap fill); it never changes a known one.
const sameSender = (initial: string, current: string): boolean => initial === current || (!initial && !!current)

const sameDelivery = (a: Identity, b: Identity): boolean =>
  a.rowid === b.rowid && a.sent_at === b.sent_at && a.received_at === b.received_at
  && a.rfc_message_id === b.rfc_message_id && sameSender(a.from_addr, b.from_addr) && a.subject === b.subject
  && a.thread_id === b.thread_id && a.attachments_json === b.attachments_json

export interface MailRouterIntakeConfirmDeps {
  expectedRuleBindings: readonly RouterRuleBinding[]
}

export interface MailRouterIntakeDeps {
  store: Pick<MailStore, 'messagesByIds'>
  home: string
  readAreas?: (home: string) => Promise<RouterAreasFile>
  pendingRules?: (file: RouterAreasFile, home: string) => Promise<ReadonlyArray<PendingRuleMatch>>
  /** Answers the sources it wrote into an area; only those may be announced. */
  confirm?: (sources: readonly RouterSource[], home: string, deps: MailRouterIntakeConfirmDeps) => Promise<readonly RouterSource[]>
}

const sourceKey = (one: RouterSource) => JSON.stringify([one.kind, one.account, one.message, one.version ?? ''])

// A blank sender is not known yet (a body read may fill it), so it cannot clear a sender rule.
const probeOf = (row: MessageRow) => ({ kind: 'mail' as const, sender: row.from_addr || undefined, subject: row.subject })

const mayMatch = (rules: ReadonlyArray<PendingRuleMatch>, row: MessageRow) =>
  rules.filter((one) => pendingRuleAreas([one], probeOf(row)).size > 0)

async function rowsByIds(store: MailRouterIntakeDeps['store'], accountId: string, ids: readonly string[]): Promise<Map<string, MessageRow>> {
  const rows = new Map<string, MessageRow>()
  for (let at = 0; at < ids.length; at += ROUTER_INTAKE_BATCH) {
    for (const row of await store.messagesByIds(accountId, ids.slice(at, at + ROUTER_INTAKE_BATCH))) rows.set(row.message_id, row)
  }
  return rows
}

export function createMailRouterIntake(deps: MailRouterIntakeDeps): MailIncomingCapture {
  const readAreas = deps.readAreas ?? readRouterAreas
  const confirm = deps.confirm ?? confirmRouterIncoming
  return async (accountId: string, headlines: readonly MailHeadline[]): Promise<MailIncomingFinish> => {
    const wanted = new Map<string, Set<string>>()
    for (const one of headlines) {
      if (!one.messageId || !one.version) continue
      wanted.set(one.messageId, (wanted.get(one.messageId) ?? new Set<string>()).add(one.version))
    }
    if (wanted.size === 0) return noop
    // The capture-time snapshot: bindings and live rules. Without bindings nothing is confirmed, but the event
    // still names only exact current deliveries.
    const file = await readAreas(deps.home)
    const pendingRules = deps.pendingRules ?? readPendingRuleMatches
    const initialRules = await pendingRules(file, deps.home)
    const confirmBatches = async (sources: readonly RouterSource[], confirmDeps: MailRouterIntakeConfirmDeps, into: Set<string>): Promise<void> => {
      for (let at = 0; at < sources.length; at += ROUTER_INTAKE_BATCH) {
        for (const one of await confirm(sources.slice(at, at + ROUTER_INTAKE_BATCH), deps.home, confirmDeps)) into.add(sourceKey(one))
      }
    }

    // Per arrival, the capture-time rules that may match it: the only ones that can grant it. Nothing is written yet.
    const captured = new Map<string, { identity: Identity; possible: PendingRuleMatch[] }>()
    const initialRows = await rowsByIds(deps.store, accountId, [...wanted.keys()])
    for (const [id, versions] of wanted) {
      const row = initialRows.get(id)
      const version = row ? mailRowDeliveryVersion(row) : undefined
      if (row && version && versions.has(version)) captured.set(id, { identity: identityOf(row), possible: mayMatch(initialRules, row) })
    }
    if (captured.size === 0) return async () => []

    // Once, after the prefetch: the same delivery at its final exact version (changed or not), under the capture snapshot.
    return async () => {
      const currentFile = await readAreas(deps.home)
      // Read again: a rule edit or a completed target leaves the bindings file as it was.
      const currentRules = await pendingRules(currentFile, deps.home)
      const initialBindings = new Map((file.ruleBindings ?? []).map((one) => [one.ruleId, one]))
      const currentBindings = new Map((currentFile.ruleBindings ?? []).map((one) => [one.ruleId, one]))
      const liveRules = new Set(currentRules.flatMap((one) => one.ruleId ? [one.ruleId] : []))
      // Still exactly the binding confirmed at capture, for a rule still live; a match with no rule id never qualifies.
      const kept = (one: PendingRuleMatch): RouterRuleBinding | undefined => {
        const before = one.ruleId ? initialBindings.get(one.ruleId) : undefined
        const now = one.ruleId ? currentBindings.get(one.ruleId) : undefined
        return before && now && sameRuleBinding(before, now) && before.areaId === one.areaId && liveRules.has(now.ruleId) ? now : undefined
      }
      const groups = new Map<string, { bindings: RouterRuleBinding[]; sources: RouterSource[] }>()
      // A headline with a rule candidate waits for its exact source to be confirmed; `key` is unset for one no rule may match.
      const candidates: Array<{ headline: MailHeadline; key?: string }> = []
      const currentRows = await rowsByIds(deps.store, accountId, [...captured.keys()])
      for (const [id, initial] of captured) {
        const row = currentRows.get(id)
        if (!row || !sameDelivery(initial.identity, identityOf(row))) continue
        const version = mailRowDeliveryVersion(row)
        const probe = probeOf(row)
        const unchanged = initial.possible.filter((one) => kept(one))
        const changed = initial.possible.filter((one) => !kept(one))
        const keptAreas = pendingRuleAreas(unchanged, probe)
        const changedAreas = pendingRuleAreas(changed, probe)
        // A binding added or moved since capture that may match: a new rule or another area never inherits the arrival.
        const arisen = [...pendingRuleAreas(currentRules, probe)].some((area) => !keptAreas.has(area) && !changedAreas.has(area))
        // Two areas may match: the confirm would refuse it, so it is withheld now.
        if (arisen || (changedAreas.size > 0 && keptAreas.size === 0) || keptAreas.size > 1) continue
        const headline: MailHeadline = {
          from: row.from_addr, subject: row.subject, messageId: id, version,
          canonicalKey: mailRouterKey(accountId, id, row.rfc_message_id),
        }
        if (keptAreas.size === 0) { candidates.push({ headline }); continue }
        const source: RouterSource = { kind: 'mail', account: accountId, message: id, version }
        const bindings = mayMatch(unchanged, row).map((one) => kept(one)!).sort((a, b) => a.ruleId.localeCompare(b.ruleId))
        const groupKey = JSON.stringify(bindings)
        const group = groups.get(groupKey) ?? { bindings, sources: [] }
        group.sources.push(source)
        groups.set(groupKey, group)
        candidates.push({ headline, key: sourceKey(source) })
      }
      const confirmed = new Set<string>()
      for (const group of groups.values()) await confirmBatches(group.sources, { expectedRuleBindings: group.bindings }, confirmed)
      // The confirm's answer is the authority: a restricted arrival it did not write stays out of the event.
      return candidates.filter((one) => one.key === undefined || confirmed.has(one.key)).map((one) => one.headline)
    }
  }
}
