/**
 * The inbound router's durable ledger: one row per inbound item. Each Area (Personal, Work, ...)
 * has its own file, `<home>/router/areas/<areaId>/items.sqlite`, and one store instance belongs to
 * exactly one Area for its whole life, so no query can read or write another Area's rows. The
 * schema has no area column for that reason: the file is the Area.
 *
 * Every read and write goes through the plugin database worker (`PluginDatabaseClient`), so no
 * SQLite call ever runs on the server's event loop. The file opens on the first call.
 *
 * Rules the rows keep:
 * - `claim` is `INSERT ... ON CONFLICT DO NOTHING` and a reread, so of any number of callers, in
 *   this process or another, exactly one creates the row and sees `fresh: true`. A row once made
 *   is never overwritten by a later claim: the loser reads the winner's row.
 * - A delivery's `messageId` is `qm-route-<hash>` of the Area, the item's key and its target task,
 *   so a retry, or another process, names the same message and the queue can drop a repeat, while
 *   the same source key routed in two Areas never collides in the queue.
 *   `not_routed` carries none.
 * - Nothing here sends anything again by itself. A row left in `routing` stays there until a
 *   caller settles it; the caller shows an old one as uncertain.
 * - `settle` writes only the row with that key, that `messageId` and a status it may leave.
 *   `retry` moves only `failed` back to `routing`.
 * - Each source names one row for good (`router_delivery_aliases`), so a moved mail finds its receipt.
 *   A source's identity is its kind, account, message and `version` (`''` when it has none): a
 *   message handle that later points at another delivery (a reply in the same conversation) is
 *   another source under each version, and never reads or binds a row of another version.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { PluginDatabaseClient } from '../plugins/plugin-storage.js'
import {
  ROUTER_SOURCE_KINDS,
  type RouterClaimResult,
  type RouterDecision,
  type RouterHistoryQuery,
  type RouterItem,
  type RouterLegacyReceipt,
  type RouterRoute,
  type RouterRouteStatus,
  type RouterSettlePatch,
  type RouterSettleResult,
  type RouterSource,
  type RouterSourceKind,
} from './types.js'

export const ROUTER_HISTORY_MAX = 500

/** A safe path segment: lower-case letters, digits, `_` and `-`, never `.`, `/` or empty. */
export const ROUTER_AREA_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/

/** Returns the id when it is a safe Area id, else throws. */
export function routerAreaId(value: unknown): string {
  if (typeof value !== 'string' || !ROUTER_AREA_ID_PATTERN.test(value)) {
    throw new TypeError('Router area id must match ' + String(ROUTER_AREA_ID_PATTERN))
  }
  return value
}

const ROUTE_STATUSES: readonly RouterRouteStatus[] = ['routing', 'routed', 'not_routed', 'failed', 'unknown']

/**
 * Additive only: a later version adds columns and indexes in a new migration, never rewrites a
 * table, so an older Walnut still reads the file. No CHECK on `status`, for the same reason:
 * a status this version does not know reads as `unknown` (`rowToRoute`).
 */
const ROUTER_MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS router_items (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account TEXT NOT NULL,
  message TEXT NOT NULL,
  thread_key TEXT,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  reason TEXT NOT NULL,
  rule_id TEXT,
  by_task_id TEXT,
  message_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS router_items_account ON router_items(kind, account, created_at DESC, key DESC);
CREATE INDEX IF NOT EXISTS router_items_thread ON router_items(kind, account, thread_key, created_at DESC, key DESC);
CREATE INDEX IF NOT EXISTS router_items_sender ON router_items(kind, account, sender, created_at DESC, key DESC);
`,
  },
  {
    // No FOREIGN KEY clause, so an older Walnut still opens the file; every write checks the key.
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS router_source_aliases (
  kind TEXT NOT NULL,
  account TEXT NOT NULL,
  message TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, account, message)
);
CREATE INDEX IF NOT EXISTS router_source_aliases_key ON router_source_aliases(key);
CREATE INDEX IF NOT EXISTS router_items_source ON router_items(kind, account, message, created_at, key);
`,
  },
  {
    // The source's delivery version joins its identity. Every older row and alias is version '',
    // so they read exactly as before; v2's alias table stays for an older Walnut to read.
    version: 3,
    sql: `
ALTER TABLE router_items ADD COLUMN source_version TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS router_delivery_aliases (
  kind TEXT NOT NULL,
  account TEXT NOT NULL,
  message TEXT NOT NULL,
  source_version TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, account, message, source_version)
);
CREATE INDEX IF NOT EXISTS router_delivery_aliases_key ON router_delivery_aliases(key);
CREATE INDEX IF NOT EXISTS router_items_source_version ON router_items(kind, account, message, source_version, created_at, key);
INSERT INTO router_delivery_aliases (kind, account, message, source_version, key, created_at)
  SELECT kind, account, message, '', key, created_at FROM router_source_aliases WHERE true
  ON CONFLICT(kind, account, message, source_version) DO NOTHING;
`,
  },
  {
    // Every existing row is a route the router made; an older Walnut's inserts take the same default.
    version: 4,
    sql: `
ALTER TABLE router_items ADD COLUMN evidence TEXT;
ALTER TABLE router_items ADD COLUMN receipt_origin TEXT NOT NULL DEFAULT 'router';
`,
  },
]

export const ROUTER_EVIDENCE_MAX = 2000

/** The version part of a source's identity: `''` for a source without one. */
function versionOf(source: RouterSource): string {
  return source.version ?? ''
}

// Old aliases restrict unversioned rows only; a versioned lookup never falls back to one.
const RESOLVE_SOURCE = `COALESCE(
  (SELECT a.key FROM router_delivery_aliases a WHERE a.kind = ? AND a.account = ? AND a.message = ? AND a.source_version = ?),
  (SELECT l.key FROM router_source_aliases l JOIN router_items lr ON lr.key = l.key AND lr.source_version = ''
    WHERE ? = '' AND l.kind = ? AND l.account = ? AND l.message = ?),
  (SELECT o.key FROM router_items o WHERE o.kind = ? AND o.account = ? AND o.message = ? AND o.source_version = ?
    ORDER BY o.created_at, o.key LIMIT 1))`

function resolveParams(source: RouterSource): unknown[] {
  const version = versionOf(source)
  return [source.kind, source.account, source.message, version, version, source.kind, source.account, source.message,
    source.kind, source.account, source.message, version]
}

/** Binds only to an existing row of the same kind, account and version, never over another key. */
const BIND_SOURCE = `INSERT INTO router_delivery_aliases (kind, account, message, source_version, key, created_at)
  SELECT ?, ?, ?, ?, key, ? FROM router_items WHERE key = ? AND kind = ? AND account = ? AND source_version = ?
  AND COALESCE(${RESOLVE_SOURCE}, key) = key
  ON CONFLICT(kind, account, message, source_version) DO NOTHING`

function bindParams(source: RouterSource, key: string, at: number): unknown[] {
  const version = versionOf(source)
  return [source.kind, source.account, source.message, version, at, key, source.kind, source.account, version, ...resolveParams(source)]
}

/** A source that cannot name this key: no such row, another account or kind, or already another key. */
export class RouterStoreError extends Error {
  constructor(readonly code: 'route_missing' | 'source_mismatch' | 'source_bound_elsewhere', message: string) {
    super(message)
    this.name = 'RouterStoreError'
  }
}

const COLUMNS = 'key, kind, account, message, source_version, thread_key, sender, subject, status, task_id, reason, rule_id, by_task_id, message_id, error, at, evidence, receipt_origin'

interface RouterRow extends Record<string, unknown> {
  key: string
  kind: string
  account: string
  message: string
  source_version: string | null
  thread_key: string | null
  sender: string
  subject: string
  status: string
  task_id: string | null
  reason: string
  rule_id: string | null
  by_task_id: string | null
  message_id: string | null
  error: string | null
  at: number
  evidence: string | null
  receipt_origin: string | null
}

/** `%` and `:` escaped in each part, so the joined key splits back into exactly one source. */
function keyPart(value: string): string {
  return value.replace(/%/g, '%25').replace(/:/g, '%3A')
}

function nonEmpty(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Router ${name} must be a non-empty string`)
  return value
}

function text(name: string, value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`Router ${name} must be a string`)
  return value
}

function optionalId(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  return nonEmpty(name, value)
}

function sourceKind(value: unknown): RouterSourceKind {
  if (!(ROUTER_SOURCE_KINDS as readonly unknown[]).includes(value)) {
    throw new TypeError(`Router source kind must be one of ${ROUTER_SOURCE_KINDS.join(', ')}`)
  }
  return value as RouterSourceKind
}

function stamp(now: number | undefined): number {
  const value = now ?? Date.now()
  if (!Number.isFinite(value)) throw new TypeError('Router time must be a finite number')
  return Math.trunc(value)
}

/**
 * A default ledger key for a source whose message id is already its stable identity (an adapter
 * with a better one, such as a mail's RFC id, builds its own). The account and message are taken
 * exactly as given (no case folding, no trimming): two accounts that differ in one character are
 * two accounts.
 */
export function routerKey(source: RouterSource): string {
  const kind = sourceKind(source?.kind)
  const base = `${kind}:${keyPart(nonEmpty('source account', source.account))}:${keyPart(nonEmpty('source message', source.message))}`
  // Unversioned keys keep their form; a version adds a fourth part, so the two never collide.
  const version = source.version === undefined ? '' : text('source version', source.version)
  return version === '' ? base : `${base}:version=${keyPart(version)}`
}

/** The delivery's message id: the same item to the same task in the same Area is always the same message. */
export function routerMessageId(areaId: string, key: string, taskId: string): string {
  const area = routerAreaId(areaId)
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(['router-route-v1', area, nonEmpty('key', key), nonEmpty('taskId', taskId)]))
    .digest('hex')
  return `qm-route-${hash.slice(0, 32)}`
}

function rowToRoute(row: RouterRow, areaId: string): RouterRoute {
  const status = (ROUTE_STATUSES as readonly string[]).includes(row.status) ? row.status as RouterRouteStatus : 'unknown'
  return {
    areaId,
    key: row.key,
    source: {
      kind: row.kind as RouterSourceKind,
      account: row.account,
      message: row.message,
      ...(row.source_version ? { version: row.source_version } : {}),
    },
    ...(row.thread_key !== null ? { threadKey: row.thread_key } : {}),
    sender: row.sender,
    subject: row.subject,
    status,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    reason: row.reason,
    ...(row.rule_id !== null ? { ruleId: row.rule_id } : {}),
    ...(row.by_task_id !== null ? { byTaskId: row.by_task_id } : {}),
    at: Number(row.at),
    ...(row.message_id !== null ? { messageId: row.message_id } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.evidence !== null && row.evidence !== undefined ? { evidence: row.evidence } : {}),
    ...(row.receipt_origin === 'legacy' ? { origin: 'legacy' as const } : {}),
  }
}

/** The insert both `claim` and `recordLegacy` use: a row only when its source names no other key, never over an existing row. */
const INSERT_ITEM = `INSERT INTO router_items (${COLUMNS}, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`
  + ` WHERE COALESCE(${RESOLVE_SOURCE}, ?) = ? ON CONFLICT(key) DO NOTHING`

export class RouterStore {
  readonly areaId: string
  readonly file: string
  private client: PluginDatabaseClient | null = null
  private opening: Promise<PluginDatabaseClient> | null = null
  private closed = false

  constructor(home: string, areaId: string) {
    const root = path.resolve(nonEmpty('home', home), 'router', 'areas')
    this.areaId = routerAreaId(areaId)
    const dir = path.resolve(root, this.areaId)
    // The pattern already rules out separators and dots; this keeps the file under the root anyway.
    if (path.dirname(dir) !== root) throw new TypeError('Router area id must name one directory under the areas root')
    this.file = path.join(dir, 'items.sqlite')
  }

  async get(key: string): Promise<RouterRoute | undefined> {
    nonEmpty('key', key)
    const client = await this.open()
    const row = await client.get<RouterRow>(`SELECT ${COLUMNS} FROM router_items WHERE key = ?`, [key])
    return row ? rowToRoute(row, this.areaId) : undefined
  }

  /** The row this exact source names; the route keeps the row's original source. */
  async getSource(source: RouterSource): Promise<RouterRoute | undefined> {
    routerKey(source)
    const client = await this.open()
    const row = await client.get<RouterRow>(`SELECT ${COLUMNS} FROM router_items WHERE key = ${RESOLVE_SOURCE}`, resolveParams(source))
    return row ? rowToRoute(row, this.areaId) : undefined
  }

  /** `getSource` for a batch in one statement, keyed by each asked source's `routerKey`. */
  async getSources(sources: readonly RouterSource[]): Promise<Map<string, RouterRoute>> {
    const bySource = new Map<string, RouterRoute>()
    if (sources.length === 0) return bySource
    sources.forEach(routerKey)
    const asked = sources.map((source) => ({ kind: source.kind, account: source.account, message: source.message, version: versionOf(source) }))
    const client = await this.open()
    const rows = await client.all<RouterRow & { asked_kind: string; asked_account: string; asked_message: string; asked_version: string }>(
      `WITH asked AS (SELECT DISTINCT json_extract(value, '$.kind') AS kind, json_extract(value, '$.account') AS account,
        json_extract(value, '$.message') AS message, json_extract(value, '$.version') AS version FROM json_each(?))
      SELECT asked.kind AS asked_kind, asked.account AS asked_account, asked.message AS asked_message, asked.version AS asked_version,
        ${COLUMNS.split(',').map((column) => `r.${column.trim()}`).join(', ')}
      FROM asked JOIN router_items r ON r.key = COALESCE(
        (SELECT a.key FROM router_delivery_aliases a WHERE a.kind = asked.kind AND a.account = asked.account AND a.message = asked.message
          AND a.source_version = asked.version),
        (SELECT l.key FROM router_source_aliases l JOIN router_items lr ON lr.key = l.key AND lr.source_version = ''
          WHERE asked.version = '' AND l.kind = asked.kind AND l.account = asked.account AND l.message = asked.message),
        (SELECT o.key FROM router_items o WHERE o.kind = asked.kind AND o.account = asked.account AND o.message = asked.message
          AND o.source_version = asked.version ORDER BY o.created_at, o.key LIMIT 1))`,
      [JSON.stringify(asked)])
    for (const row of rows) {
      const source: RouterSource = {
        kind: row.asked_kind as RouterSourceKind,
        account: row.asked_account,
        message: row.asked_message,
        ...(row.asked_version ? { version: row.asked_version } : {}),
      }
      bySource.set(routerKey(source), rowToRoute(row, this.areaId))
    }
    return bySource
  }

  /** Records identity only, never authorization: callers bind a source already checked for this Area. */
  async bindSource(source: RouterSource, key: string, now?: number): Promise<{ bound: boolean; route: RouterRoute }> {
    routerKey(source)
    nonEmpty('key', key)
    const at = stamp(now)
    const client = await this.open()
    const inserted = await client.run(BIND_SOURCE, bindParams(source, key, at))
    return { bound: inserted.changes === 1, route: await this.boundRoute(client, source, key) }
  }

  /** Reads the row with `key` and checks that `source` names it, else throws why not. */
  private async boundRoute(client: PluginDatabaseClient, source: RouterSource, key: string): Promise<RouterRoute> {
    const row = await client.get<RouterRow & { bound_key: string | null }>(
      `SELECT ${COLUMNS}, ${RESOLVE_SOURCE} AS bound_key FROM router_items WHERE key = ?`, [...resolveParams(source), key])
    if (!row) throw new RouterStoreError('route_missing', `No item ${key} in this area's ledger to bind a source to.`)
    if (row.kind !== source.kind || row.account !== source.account || (row.source_version ?? '') !== versionOf(source)) {
      throw new RouterStoreError('source_mismatch', 'A source binds only to an item of its own kind, account and version.')
    }
    if (row.bound_key !== key) {
      throw new RouterStoreError('source_bound_elsewhere', 'This source already belongs to another item; it is never rebound.')
    }
    return rowToRoute(row, this.areaId)
  }

  /** One statement for any number of keys; a key with no row is absent from the map. */
  async getMany(keys: readonly string[]): Promise<Map<string, RouterRoute>> {
    if (!Array.isArray(keys)) throw new TypeError('Router getMany takes an array of keys')
    const unique = [...new Set(keys.map((key) => nonEmpty('key', key)))]
    const routes = new Map<string, RouterRoute>()
    if (unique.length === 0) return routes
    const client = await this.open()
    const rows = await client.all<RouterRow>(
      `SELECT ${COLUMNS} FROM router_items WHERE key IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(unique)],
    )
    for (const row of rows) routes.set(row.key, rowToRoute(row, this.areaId))
    return routes
  }

  /** The account's items, newest claim first, at most `ROUTER_HISTORY_MAX`. */
  async history(query: RouterHistoryQuery): Promise<RouterRoute[]> {
    const kind = sourceKind(query?.kind)
    const account = nonEmpty('history account', query.account)
    if (typeof query.limit !== 'number' || !Number.isFinite(query.limit)) throw new TypeError('Router history limit must be a number')
    const limit = Math.min(ROUTER_HISTORY_MAX, Math.max(1, Math.trunc(query.limit)))
    const where = ['kind = ?', 'account = ?']
    const params: unknown[] = [kind, account]
    if (query.threadKey !== undefined) {
      where.push('thread_key = ?')
      params.push(nonEmpty('history threadKey', query.threadKey))
    }
    if (query.sender !== undefined) {
      where.push('sender = ?')
      params.push(text('history sender', query.sender))
    }
    params.push(limit)
    const client = await this.open()
    const rows = await client.all<RouterRow>(
      `SELECT ${COLUMNS} FROM router_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC, key DESC LIMIT ?`,
      params,
    )
    return rows.map((row) => rowToRoute(row, this.areaId))
  }

  /**
   * Records the decision for an item unless the item already has one. `fresh` is true only for
   * the caller whose insert made the row; every other caller gets the existing row unchanged,
   * whatever decision it brought.
   */
  async claim(item: RouterItem, decision: RouterDecision, now?: number): Promise<RouterClaimResult> {
    // The key is the source adapter's canonical identity (a mail's RFC id survives a move), so it
    // is stored as given; the source is checked the same way the default key would check it.
    routerKey(item?.source)
    const key = nonEmpty('item key', item.key)
    const threadKey = optionalId('item threadKey', item.threadKey)
    const sender = text('item sender', item.sender)
    const subject = text('item subject', item.subject)
    const reason = text('decision reason', decision?.reason)
    // Only recordLegacy writes an after-the-fact receipt; a route decision never carries one.
    if (Object.hasOwn(decision, 'origin') || Object.hasOwn(decision, 'evidence')) throw new TypeError('A route decision carries no origin or evidence')
    const ruleId = optionalId('decision ruleId', decision.ruleId)
    const byTaskId = optionalId('decision byTaskId', decision.byTaskId)
    let taskId: string | null
    let messageId: string | null
    if (decision.status === 'routing') {
      taskId = nonEmpty('decision taskId', decision.taskId)
      messageId = routerMessageId(this.areaId, key, taskId)
    } else if (decision.status === 'not_routed') {
      if ((decision.taskId ?? null) !== null) throw new TypeError('A not_routed decision has no taskId')
      taskId = null
      messageId = null
    } else {
      throw new TypeError('Router claim status must be routing or not_routed')
    }
    const at = stamp(now)
    const client = await this.open()
    // One transaction, so a row is never made for a source that names another key.
    const [inserted] = await client.batch([
      {
        sql: INSERT_ITEM,
        params: [key, item.source.kind, item.source.account, item.source.message, versionOf(item.source), threadKey, sender, subject,
          decision.status, taskId, reason, ruleId, byTaskId, messageId, null, at, null, 'router', at, ...resolveParams(item.source), key, key],
      },
      { sql: BIND_SOURCE, params: bindParams(item.source, key, at) },
    ])
    return this.claimed(client, item.source, key, inserted!.changes === 1)
  }

  // No message id: a receipt of prior handling can neither settle nor retry.
  async recordLegacy(item: RouterItem, receipt: RouterLegacyReceipt): Promise<RouterClaimResult> {
    routerKey(item?.source)
    const key = nonEmpty('item key', item.key)
    const threadKey = optionalId('item threadKey', item.threadKey)
    const sender = text('item sender', item.sender)
    const subject = text('item subject', item.subject)
    const taskId = nonEmpty('legacy taskId', receipt?.taskId)
    const reason = nonEmpty('legacy reason', receipt.reason)
    const byTaskId = optionalId('legacy byTaskId', receipt.byTaskId)
    const evidence = text('legacy evidence', receipt.evidence).trim()
    if (!evidence || evidence.length > ROUTER_EVIDENCE_MAX) throw new TypeError(`Router legacy evidence must be 1 to ${ROUTER_EVIDENCE_MAX} characters`)
    if (typeof receipt.at !== 'number') throw new TypeError('Router legacy receipt needs the time it was handled')
    const at = stamp(receipt.at)
    const client = await this.open()
    const [inserted] = await client.batch([
      {
        sql: INSERT_ITEM,
        params: [key, item.source.kind, item.source.account, item.source.message, versionOf(item.source), threadKey, sender, subject,
          'routed', taskId, reason, null, byTaskId, null, null, at, evidence, 'legacy', at, ...resolveParams(item.source), key, key],
      },
      { sql: BIND_SOURCE, params: bindParams(item.source, key, at) },
    ])
    return this.claimed(client, item.source, key, inserted!.changes === 1)
  }

  /**
   * How many items of this area the router itself decided, in each state, and the newest of them:
   * the router page's summary (no item words). Legacy receipts (work handled before the router
   * existed) are no decision of its own and are left out.
   */
  async overview(): Promise<{ counts: Partial<Record<RouterRouteStatus, number>>; latest?: RouterRoute }> {
    const client = await this.open()
    const rows = await client.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM router_items WHERE receipt_origin IS NOT 'legacy' GROUP BY status")
    const counts: Partial<Record<RouterRouteStatus, number>> = {}
    for (const row of rows) {
      const status = (ROUTE_STATUSES as readonly string[]).includes(row.status) ? row.status as RouterRouteStatus : 'unknown'
      counts[status] = (counts[status] ?? 0) + Number(row.n)
    }
    const latest = await client.get<RouterRow>(`SELECT ${COLUMNS} FROM router_items WHERE receipt_origin IS NOT 'legacy' ORDER BY at DESC, key DESC LIMIT 1`)
    return { counts, ...(latest ? { latest: rowToRoute(latest, this.areaId) } : {}) }
  }

  /**
   * True when any row is not a legacy receipt: a decision the router itself made, in any status
   * (routing, routed, not_routed, failed, unknown). No clock is read, so a row from any time counts.
   */
  async hasRouterDecisions(): Promise<boolean> {
    const client = await this.open()
    const row = await client.get<{ found: number }>(
      "SELECT EXISTS(SELECT 1 FROM router_items WHERE receipt_origin IS NOT 'legacy') AS found")
    return Number(row?.found ?? 0) === 1
  }

  private async claimed(client: PluginDatabaseClient, source: RouterSource, key: string, fresh: boolean): Promise<RouterClaimResult> {
    try {
      return { fresh, route: await this.boundRoute(client, source, key) }
    } catch (error) {
      // No row means the guard held it back: the source names another key.
      if (error instanceof RouterStoreError && error.code === 'route_missing') {
        throw new RouterStoreError('source_bound_elsewhere', 'This source already belongs to another item; nothing was claimed.')
      }
      throw error
    }
  }

  /**
   * Records a delivery's outcome, only on the row with this key and this `messageId`, and only
   * from a status it may leave: `routing` to any outcome, `unknown` to `routed` or `failed` (a
   * late answer). Anything else leaves the row as it is and returns it with `settled: false`.
   */
  async settle(key: string, expectedMessageId: string, patch: RouterSettlePatch, now?: number): Promise<RouterSettleResult> {
    nonEmpty('key', key)
    nonEmpty('expected messageId', expectedMessageId)
    const status = patch?.status
    if (status !== 'routed' && status !== 'failed' && status !== 'unknown') {
      throw new TypeError('Router settle status must be routed, failed or unknown')
    }
    const error = status === 'routed' ? null : (patch.error === undefined ? null : text('settle error', patch.error))
    const from = status === 'unknown' ? ['routing'] : ['routing', 'unknown']
    const at = stamp(now)
    const client = await this.open()
    const updated = await client.run(
      `UPDATE router_items SET status = ?, error = ?, at = MAX(at + 1, ?) WHERE key = ? AND message_id = ? AND status IN (${from.map(() => '?').join(', ')})`,
      [status, error, at, key, expectedMessageId, ...from],
    )
    const row = await client.get<RouterRow>(`SELECT ${COLUMNS} FROM router_items WHERE key = ?`, [key])
    return { settled: updated.changes === 1, route: row ? rowToRoute(row, this.areaId) : undefined }
  }

  /**
   * Claims a `failed` row for one more delivery, under the same `messageId`. Only one caller wins
   * (`fresh: true`); a row in any other status is returned unchanged.
   */
  async retry(key: string, now?: number): Promise<{ fresh: boolean; route: RouterRoute | undefined }> {
    nonEmpty('key', key)
    const at = stamp(now)
    const client = await this.open()
    const updated = await client.run(
      "UPDATE router_items SET status = 'routing', error = NULL, at = MAX(at + 1, ?) WHERE key = ? AND status = 'failed' AND message_id IS NOT NULL",
      [at, key],
    )
    const row = await client.get<RouterRow>(`SELECT ${COLUMNS} FROM router_items WHERE key = ?`, [key])
    return { fresh: updated.changes === 1, route: row ? rowToRoute(row, this.areaId) : undefined }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const opening = this.opening
    this.opening = null
    if (opening) await opening.catch(() => undefined)
    const client = this.client
    this.client = null
    if (client) await client.dispose().catch(() => undefined)
  }

  private open(): Promise<PluginDatabaseClient> {
    if (this.closed) return Promise.reject(new Error('Router store is closed'))
    if (this.client) return Promise.resolve(this.client)
    if (this.opening) return this.opening
    const attempt = (async () => {
      const client = await openMigrated(this.file)
      if (this.closed) {
        await client.dispose().catch(() => undefined)
        throw new Error('Router store is closed')
      }
      this.client = client
      return client
    })()
    this.opening = attempt
    // A failed open is not remembered: the next call tries again.
    attempt.then(
      () => { if (this.opening === attempt) this.opening = null },
      () => { if (this.opening === attempt) this.opening = null },
    )
    return attempt
  }
}

/**
 * Opens a fresh worker connection and migrates it. When two connections create the file at once,
 * the losing worker can die during its own setup (the WAL switch or the first schema read), and a
 * dead worker refuses every later request; a new worker on the now-made file then opens cleanly.
 */
async function openMigrated(file: string): Promise<PluginDatabaseClient> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = new PluginDatabaseClient(file)
    try {
      await migrate(client)
      return client
    } catch (error) {
      lastError = error
      await client.dispose().catch(() => undefined)
    }
  }
  throw lastError
}

/**
 * Two processes opening a new file at once both read version 0 before either commits; the
 * second one's transaction then fails on the version row and rolls back whole. Asked again, it
 * reads the version the first one wrote and has nothing to do.
 */
async function migrate(client: PluginDatabaseClient): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.migrate(ROUTER_MIGRATIONS)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
