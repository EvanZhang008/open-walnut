/**
 * Reading the grants files (exec-grants.ts) when they are not whole.
 *
 * 2026-11-24 08:39Z: a data sync's merge left git conflict markers in host-exec-grants.json for a
 * few seconds; every lookup parsed nothing and three tasks' reads were refused as if the user had
 * revoked their grants. A file with markers still holds both versions, each whole: the lines
 * outside the markers belong to both, the hunks to one side each. Read both, and take a grant as
 * either side has it with a revoke on either side winning, so the user's revoke is never lost and
 * a grant he gave never vanishes because a merge was in flight.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ExecAsk, ExecGrant } from './exec-grants.js'

export type Parsed<T> = { ok: true; value: T } | { ok: false; why: 'missing' | 'unparsable'; sides: T[] }

/** The two versions a text with merge conflict markers holds (`ours`, `theirs`), or null when it has none or they are broken. */
export function markerSides(text: string): [string, string] | null {
  if (!/^<<<<<<<( |$)/m.test(text)) return null
  const ours: string[] = []
  const theirs: string[] = []
  let at: 'both' | 'ours' | 'base' | 'theirs' = 'both'
  for (const line of text.split('\n')) {
    if (/^<<<<<<<( |$)/.test(line)) { if (at !== 'both') return null; at = 'ours'; continue }
    if (/^\|\|\|\|\|\|\|( |$)/.test(line) && at === 'ours') { at = 'base'; continue }
    if (line === '=======' && (at === 'ours' || at === 'base')) { at = 'theirs'; continue }
    if (/^>>>>>>>( |$)/.test(line) && at === 'theirs') { at = 'both'; continue }
    if (at === 'both' || at === 'ours') ours.push(line)
    if (at === 'both' || at === 'theirs') theirs.push(line)
  }
  return at === 'both' ? [ours.join('\n'), theirs.join('\n')] : null
}

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(text) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** A JSON object read whole from `f`, or why not, with each side of its conflict markers that parses. */
export function parseObject(f: string): Parsed<Record<string, unknown>> {
  let text: string
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch (err) {
    return { ok: false, why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unparsable', sides: [] }
  }
  const whole = objectOf(text)
  if (whole) return { ok: true, value: whole }
  const sides = markerSides(text)
  return { ok: false, why: 'unparsable', sides: (sides ?? []).map(objectOf).filter((s): s is Record<string, unknown> => s !== null) }
}

export interface Store { grants: ExecGrant[]; asks: ExecAsk[] }

export function storeOf(raw: Record<string, unknown>): Store {
  return { grants: Array.isArray(raw.grants) ? raw.grants : [], asks: Array.isArray(raw.asks) ? raw.asks : [] }
}

/**
 * Several copies of the store as one: every grant any copy has (grants are revoked, never
 * removed), revoked when any copy revoked it; for a task and host, the Deny when any copy holds
 * one, else the newest ask, and none that a grant made after it answered (or a pending one a live
 * grant answered). The first copy's order leads.
 */
export function mergeStores(copies: Store[]): Store {
  const grants = new Map<string, ExecGrant>()
  for (const s of copies) {
    for (const g of s.grants) {
      if (!g || typeof g.id !== 'string') continue
      const had = grants.get(g.id)
      if (!had) { grants.set(g.id, { ...g }); continue }
      const revokedAt = [had.revokedAt, g.revokedAt].filter((t): t is number => typeof t === 'number')
      if (revokedAt.length) had.revokedAt = Math.min(...revokedAt)
      if ((g.runs ?? 0) > (had.runs ?? 0)) had.runs = g.runs
      if ((g.lastRunAt ?? 0) > (had.lastRunAt ?? 0)) { had.lastRunAt = g.lastRunAt; had.lastCommand = g.lastCommand }
    }
  }
  const live = new Set([...grants.values()].filter((g) => !g.revokedAt).map((g) => `${g.taskId}\n${g.host}`))
  const asks = new Map<string, ExecAsk>()
  for (const s of copies) {
    for (const a of s.asks) {
      if (!a || typeof a.taskId !== 'string') continue
      const key = `${a.taskId}\n${a.host}`
      const had = asks.get(key)
      const denied = a.state === 'denied'
      const better = !had || (denied && had.state !== 'denied') || (denied === (had.state === 'denied') && a.askedAt > had.askedAt)
      if (better) asks.set(key, { ...a })
    }
  }
  // A grant made after an ask answered it (grant() drops the asks of its task and host): that ask,
  // a Deny included, is over, so a later revoke of the grant asks again instead of reading declined.
  const grantedAt = new Map<string, number>()
  for (const g of grants.values()) {
    const key = `${g.taskId}\n${g.host}`
    grantedAt.set(key, Math.max(grantedAt.get(key) ?? 0, g.grantedAt ?? 0))
  }
  const over = (key: string, a: ExecAsk) => (a.state === 'pending' && live.has(key)) || (grantedAt.get(key) ?? -1) >= (a.answeredAt ?? a.askedAt ?? 0)
  return {
    grants: [...grants.values()],
    asks: [...asks.entries()].filter(([key, a]) => !over(key, a)).map(([, a]) => a),
  }
}

/** How many unreadable copies `keepAside` keeps per file. */
const ASIDE_KEEP = 10

/**
 * Keep a file that could not be read whole before writing over it, in `local/unreadable/` beside
 * it: a machine-local folder the data sync never takes (git-sync CRITICAL_IGNORE_DIRS), so the copy
 * never rides to the hub. The newest few per file are kept. Never throws; null when it could not.
 */
export async function keepAside(target: string): Promise<string | null> {
  const dir = path.join(path.dirname(target), 'local', 'unreadable')
  const base = path.basename(target)
  const aside = path.join(dir, `${base}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.promises.copyFile(target, aside)
    const mine = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(`${base}.`)).sort()
    for (const old of mine.slice(0, Math.max(0, mine.length - ASIDE_KEEP))) await fs.promises.rm(path.join(dir, old), { force: true })
    return aside
  } catch {
    return null
  }
}

/** The text a store file is written as: the store with its own clock, which the data sync's merge reads first (git-sync-merge.ts chooseLww). */
export function storeText(value: Record<string, unknown>): string {
  return JSON.stringify({ lastUpdated: new Date().toISOString(), ...value }, null, 2) + '\n'
}
