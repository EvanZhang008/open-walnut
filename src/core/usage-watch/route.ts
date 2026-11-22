/**
 * Where a real-use alarm goes, and how it gets there without noise.
 *
 * Owner: the armed watch covering the alarm's target whose ship is the latest (production runs
 * the latest ship), or the open task its `who` names. A complete owner is never reopened by an
 * automated note: its project's lead hears it, named. No watch: the project's lead (Walnut's
 * own tools: the Walnut project's). No lead or the org off: Walnut Health's fix-task path.
 *
 * Delivery: one note row per recipient and day sequence, written before it is sent. The first
 * of a day goes at once; later alarms that day join the next row, sent 4 hours after the one
 * before. A row is marked sent only after the session took it; a failed send is tried again
 * every 10 minutes, 6 times; rows survive a restart, and a resend uses the row's id, so a row
 * is never delivered twice.
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'
import { usageDb, readEvents } from './store.js'
import { armedWatchesFor, type Watch } from './watches.js'
import type { UsageKind } from './agg.js'

const HOUR_MS = 3_600_000
export const BATCH_GAP_MS = 4 * HOUR_MS
const RETRY_MS = 10 * 60_000
const MAX_TRIES = 6
/** Walnut's own tools and pages belong to the Walnut project's lead when no watch names them. */
export const TOOLS_PROJECT = 'Walnut'

export interface UsageAlarm {
  /** The Health alarm instance id (`usage.op.cut{op=thread_update}`). */
  alarmId: string
  /** When this episode began: with alarmId, the item's identity. */
  since: number
  title: string
  kind: UsageKind
  name: string
  /** One line with the numbers. */
  line: string
}

export interface NoteItem { key: string; title: string; name: string; target: string; line: string; at: number; shipped?: string; watch?: string; ownerTask?: string; ownerTitle?: string; ownerComplete?: boolean }

export type RouteResult =
  | { handled: true; delivered: boolean; taskId: string; detail: string }
  | { handled: false; fallback: boolean; detail: string }

export interface RouteDeps {
  enabled: () => Promise<boolean>
  taskInfo: (id: string) => Promise<{ id: string; title: string; project?: string; complete: boolean } | null>
  leadOf: (project: string) => Promise<{ id: string; title: string } | null>
  deliver: (taskId: string, text: string, rowId: string) => Promise<{ ok: boolean; detail: string }>
  now?: () => number
}

export function targetOf(kind: UsageKind, name: string): string {
  return kind === 'op' ? `op:${name}` : kind === 'http' ? `route:${name}` : `page:${name}`
}

function dayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

interface SendRow { id: string; recipient: string; day: string; seq: number; dueAt: number; items: NoteItem[]; state: 'pending' | 'sent' | 'failed'; tries: number; sentAt?: number; detail?: string }

function readRows(recipient: string, day: string): SendRow[] {
  return usageDb([], (d) => (d.prepare('SELECT * FROM sends WHERE recipient = ? AND day = ? ORDER BY seq').all(recipient, day) as Array<Record<string, unknown>>).map(toRow))
}

function toRow(r: Record<string, unknown>): SendRow {
  let items: NoteItem[] = []
  try { items = JSON.parse(String(r.items)) as NoteItem[] } catch { /* none */ }
  return {
    id: String(r.id), recipient: String(r.recipient), day: String(r.day), seq: Number(r.seq), dueAt: Number(r.due_at), items,
    state: String(r.state) as SendRow['state'], tries: Number(r.tries), ...(r.sent_at != null ? { sentAt: Number(r.sent_at) } : {}), ...(r.detail ? { detail: String(r.detail) } : {}),
  }
}

function writeRow(r: SendRow): void {
  usageDb(undefined, (d) => {
    d.prepare(`INSERT OR REPLACE INTO sends (id, recipient, family, day, seq, due_at, items, state, tries, sent_at, detail) VALUES (?, ?, 'all', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.recipient, r.day, r.seq, r.dueAt, JSON.stringify(r.items), r.state, r.tries, r.sentAt ?? null, r.detail ?? null)
  })
}

/** Rows a send is under way for: their items are what the note said, so nothing joins them. */
const sending = new Set<string>()

/**
 * Puts an item in the recipient's next note: the day's first goes now, later ones 4 hours after
 * the one before. A row a send was tried for is frozen (its message id names those items), so a
 * new item joins only a row never tried.
 */
function enqueue(recipient: string, item: NoteItem, now: number): SendRow {
  const day = dayOf(now)
  const rows = readRows(recipient, day)
  if (rows.some((r) => r.items.some((i) => i.key === item.key))) return rows.find((r) => r.items.some((i) => i.key === item.key))!
  const open = rows.find((r) => r.state === 'pending' && r.tries === 0 && !sending.has(r.id))
  if (open) {
    open.items.push(item)
    writeRow(open)
    return open
  }
  const last = rows[rows.length - 1]
  const row: SendRow = {
    id: `us-${randomUUID().slice(0, 12)}`, recipient, day, seq: (last?.seq ?? 0) + 1,
    dueAt: last ? Math.max(now, (last.sentAt ?? last.dueAt) + BATCH_GAP_MS) : now,
    items: [item], state: 'pending', tries: 0,
  }
  writeRow(row)
  return row
}

/** The recipient of an alarm on (kind, name), and the note item for it. */
async function ownerOf(a: UsageAlarm, deps: RouteDeps, now: number): Promise<{ recipient: string; item: NoteItem } | null> {
  const target = targetOf(a.kind, a.name)
  const base: NoteItem = { key: `${a.alarmId}@${a.since}`, title: a.title, name: a.name, target, line: a.line, at: now }
  const watches = armedWatchesFor(a.kind, a.name, now)
  const w: Watch | undefined = watches[0]
  if (w) {
    const named = w.who !== 'this task' ? await deps.taskInfo(w.who) : null
    const ownerId = named && !named.complete ? named.id : w.taskId
    const owner = named && !named.complete ? named : await deps.taskInfo(w.taskId)
    const item: NoteItem = { ...base, watch: w.id, ownerTask: ownerId, ...(owner ? { ownerTitle: owner.title, ownerComplete: owner.complete } : {}), ...(w.shipAt ? { shipped: new Date(w.shipAt).toISOString() } : {}) }
    if (owner && !owner.complete) return { recipient: owner.id, item }
    const lead = await deps.leadOf(owner?.project ?? TOOLS_PROJECT)
    return lead ? { recipient: lead.id, item } : null
  }
  const lead = await deps.leadOf(TOOLS_PROJECT)
  return lead ? { recipient: lead.id, item: base } : null
}

/** Routes one alarm episode: delivers the day's first note at once, queues the rest. */
export async function routeUsageAlarm(a: UsageAlarm, deps: RouteDeps): Promise<RouteResult> {
  const now = deps.now?.() ?? Date.now()
  if (!(await deps.enabled())) return { handled: false, fallback: false, detail: 'real-use watch is off (Settings › Experimental): recorded, nobody told' }
  const owner = await ownerOf(a, deps, now)
  if (!owner) return { handled: false, fallback: true, detail: 'no watch and no project lead to tell' }
  const row = enqueue(owner.recipient, owner.item, now)
  const who = await deps.taskInfo(owner.recipient)
  const name = who ? `"${who.title}"` : owner.recipient
  if (row.state === 'sent') return { handled: true, delivered: true, taskId: owner.recipient, detail: `delivered to ${name}` }
  if (sending.has(row.id)) return { handled: true, delivered: false, taskId: owner.recipient, detail: `being sent to ${name}` }
  if (row.dueAt > now) return { handled: true, delivered: false, taskId: owner.recipient, detail: `queued for ${name}: its next note at ${new Date(row.dueAt).toISOString().slice(11, 16)} UTC` }
  const sent = await sendRow(row, deps, now)
  return { handled: true, delivered: sent, taskId: owner.recipient, detail: sent ? `delivered to ${name}` : `queued for ${name}: ${row.detail ?? 'the send failed'}; tried again in 10 minutes` }
}

function readRow(id: string): SendRow | null {
  return usageDb(null, (d) => {
    const r = d.prepare('SELECT * FROM sends WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toRow(r) : null
  })
}

/**
 * Sends one row once at a time: the Health alarm's route and the minute tick may both reach it.
 * It reads the row afresh (an item may have joined since it was listed) and writes back only how
 * the send went, never the items.
 */
async function sendRow(listed: SendRow, deps: RouteDeps, now: number): Promise<boolean> {
  if (sending.has(listed.id)) return false
  sending.add(listed.id)
  try {
    const row = readRow(listed.id) ?? listed
    if (row.state !== 'pending') return row.state === 'sent'
    let r: { ok: boolean; detail: string }
    try {
      r = await deps.deliver(row.recipient, noteText(row.items), row.id)
    } catch (err) {
      r = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    const tries = row.tries + 1
    const state: SendRow['state'] = r.ok ? 'sent' : tries >= MAX_TRIES ? 'failed' : 'pending'
    const dueAt = r.ok || state === 'failed' ? row.dueAt : now + RETRY_MS
    Object.assign(listed, { tries, state, dueAt, detail: r.detail.slice(0, 300), ...(r.ok ? { sentAt: now } : {}) })
    usageDb(undefined, (d) => {
      d.prepare('UPDATE sends SET tries = ?, state = ?, due_at = ?, sent_at = ?, detail = ? WHERE id = ?')
        .run(tries, state, dueAt, r.ok ? now : row.sentAt ?? null, listed.detail ?? null, row.id)
    })
    log.obs.info('usage watch: note', { recipient: row.recipient, row: row.id, items: row.items.length, ok: r.ok, tries })
    return r.ok
  } finally {
    sending.delete(listed.id)
  }
}

/** Sends every row that is due (each minute). */
export async function sendDueNotes(deps: RouteDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  if (!(await deps.enabled())) return
  const due = usageDb([], (d) => (d.prepare("SELECT * FROM sends WHERE state = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20").all(now) as Array<Record<string, unknown>>).map(toRow))
  for (const row of due) await sendRow(row, deps, now)
}

/** The notes the Real Use page lists (newest first). */
export function recentNotes(limit = 50): Array<Omit<SendRow, 'items'> & { items: number; titles: string[] }> {
  return usageDb([], (d) => (d.prepare('SELECT * FROM sends ORDER BY due_at DESC LIMIT ?').all(Math.min(limit, 200)) as Array<Record<string, unknown>>).map(toRow))
    .map((r) => ({ ...r, items: r.items.length, titles: r.items.map((i) => `${i.title}: ${i.name}`) }))
}

/** The note's text: what rang with its numbers, why this reader hears it, and what to do. */
export function noteText(items: readonly NoteItem[]): string {
  const owned = items.filter((i) => i.ownerTask && !i.ownerComplete)
  const handed = items.filter((i) => i.ownerTask && i.ownerComplete)
  const loose = items.filter((i) => !i.ownerTask)
  const out: string[] = [items.length === 1 ? 'Real use: an alarm rang.' : `Real use: ${items.length} alarms rang.`]
  for (const i of items) out.push(`- ${i.title}: ${i.name}. ${i.line} (${i.at ? new Date(i.at).toISOString().slice(11, 16) : ''} UTC)`)
  if (owned.length) {
    out.push(`You hear it because your watch names ${[...new Set(owned.map((i) => i.target))].join(', ')} (usage_watch ${[...new Set(owned.map((i) => i.watch))].join(', ')}).`)
    out.push('Next: fix it (make the answer fit, the call succeed or the page work), then reply with what you changed. Numbers: Settings › Diagnostics › Real Use, or usage_watch {"action":"report","target":"<target>"}.')
  }
  if (handed.length) {
    for (const i of handed) out.push(`"${i.ownerTitle ?? i.ownerTask}" (${i.ownerTask}) shipped ${i.target} and watches it, but is complete: reopen it with task_send force:true and a reason, or hand the alarm to another task.`)
  }
  if (loose.length) {
    out.push(`No armed watch names ${[...new Set(loose.map((i) => i.target))].join(', ')}, so it comes to you as the lead of the ${TOOLS_PROJECT} project: hand it to the task that owns that code, or open one.`)
  }
  out.push('Alarms after this one today arrive together, at most one note every 4 hours. Mute or turn an alarm off in Settings › Diagnostics › Walnut Health.')
  return out.join('\n')
}

/** The newest problem event's numbers for an alarm line (`27,446 characters through MCP`). */
export function lastEventLine(kind: UsageKind, name: string, problem: string): string | null {
  const [e] = readEvents({ kind, name, limit: 20 }).filter((x) => x.problem === problem)
  if (!e) return null
  if (problem === 'cut') {
    const via = e.code === 'cut_cli' ? 'the walnut CLI' : e.code === 'cut_mcp' ? 'MCP' : 'an agent'
    return e.chars ? `Claude Code saved an answer of ${e.chars.toLocaleString("en-US")} ${e.code === "cut_cli" ? "bytes" : "characters"} to a file instead of passing it on (through ${via})` : `Claude Code saved an answer to a file instead of passing it on (through ${via})`
  }
  if (problem === 'slow') return e.ms ? `the slowest took ${(e.ms / 1000).toFixed(1)} s` : null
  if (e.code) return `last error code ${e.code}`
  return null
}

export function _sendsForTesting(): SendRow[] {
  return usageDb([], (d) => (d.prepare('SELECT * FROM sends ORDER BY due_at').all() as Array<Record<string, unknown>>).map(toRow))
}
