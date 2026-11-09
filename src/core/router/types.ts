/**
 * The inbound router's ledger types: one durable row per inbound item (a mail message, a chat
 * message), recording where it went. The store (`store.ts`) owns the rows; the caller decides
 * the route and delivers it.
 */

export const ROUTER_SOURCE_KINDS = ['mail', 'slack', 'wechat'] as const

export type RouterSourceKind = (typeof ROUTER_SOURCE_KINDS)[number]

/** Where an item came from: the channel, the exact account (never folded), the message id in it. */
export interface RouterSource {
  kind: RouterSourceKind
  account: string
  message: string
  /** Cache-owned delivery identity when a message handle can point at a later reply. */
  version?: string
}

/**
 * An inbound item as the router sees it. `key` is the source adapter's canonical identity of the
 * item (one row per key), or `routerKey(source)` when the message id already is one.
 */
export interface RouterItem {
  source: RouterSource
  key: string
  /**
   * What the source's cache says copies of this item share (a mail's RFC id), for area
   * restrictions only: never the ledger's delivery identity, which stays `key`.
   */
  scopeKey?: string
  threadKey?: string
  sender: string
  subject: string
  preview?: string
}

/**
 * - `routing`: claimed for a task, delivery started; its outcome is not known yet. A row that stays
 *   here is never sent again by the store: the caller shows it as uncertain.
 * - `routed`: delivered under `messageId`.
 * - `not_routed`: decided to go nowhere; carries no `messageId`.
 * - `failed`: delivery refused; `retry` may claim it again.
 * - `unknown`: delivery may or may not have happened (a timeout, a lost answer).
 */
export type RouterRouteStatus = 'routing' | 'routed' | 'not_routed' | 'failed' | 'unknown'

export interface RouterRoute {
  areaId: string
  key: string
  source: RouterSource
  threadKey?: string
  sender: string
  subject: string
  status: RouterRouteStatus
  taskId?: string
  reason: string
  ruleId?: string
  byTaskId?: string
  /** Epoch ms of the row's latest state change (claim, settle, retry). */
  at: number
  /** `qm-route-<hash>` of the key and the target task: stable across retries. */
  messageId?: string
  error?: string
  /** What shows the item was handled; only on a receipt recorded after the fact. */
  evidence?: string
  /** `legacy`: recorded after the fact for an item handled before the router, never delivered by it. Absent: a normal route. */
  origin?: 'legacy'
}

/** A receipt for an item handled before the router: written by `recordLegacy` only, never through `claim`. */
export interface RouterLegacyReceipt {
  taskId: string
  reason: string
  evidence: string
  at: number
  byTaskId?: string
}

export interface RouterDecision {
  taskId?: string
  reason: string
  ruleId?: string
  byTaskId?: string
  status: 'routing' | 'not_routed'
}

export interface RouterSettlePatch {
  status: 'routed' | 'failed' | 'unknown'
  error?: string
}

export interface RouterHistoryQuery {
  kind: RouterSourceKind
  account: string
  threadKey?: string
  sender?: string
  limit: number
}

export interface RouterClaimResult {
  /** True only for the caller whose write created (or, for `retry`, re-claimed) the row. */
  fresh: boolean
  route: RouterRoute
}

export interface RouterSettleResult {
  /** True when this call changed the row; false leaves it exactly as `route` shows. */
  settled: boolean
  route: RouterRoute | undefined
}
