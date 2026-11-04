/**
 * Agent grants (docs/reference/passwords.md, "Agents"): an approved ask lets the task that asked,
 * in the session that asked, on the host it asked from, use the fields it asked for of one item
 * for the grant length the person picked (policy.ts grantMs: once, an hour, 12 hours, until
 * revoked). Lock all, a new master password and the switch moving to Off end every grant; the
 * person ends one in Agent Activity.
 *
 * A grant carries the use it was approved for (`fill`, `env`, `reveal`): a reveal grant covers env
 * and fill too, a fill or env grant covers only its own use, never a reveal (grantCovers). A grant
 * an older Walnut kept, with no use, reads `fill`, the narrowest.
 *
 * Grants live in memory. They are also kept, sealed with the vault key, in `agent-grants.json`
 * only while the machine key is on (the vault reopens by itself after a restart, so a grant may
 * outlive one): with it off a restart locks the vault anyway, and the grants end with it. Every
 * change rewrites the file (an empty list once the machine key is off), so a grant ended here
 * never comes back from disk.
 */
import crypto from 'node:crypto'
import { isOpen, loadFile, loadMachine, openSide, updateSide } from './state.js'

/** The uses a grant is approved for (agent.ts AgentUse, without importing it: agent.ts imports this file). */
export type GrantUse = 'fill' | 'env' | 'reveal'

/** What a grant with no recorded use (an older Walnut's) reads. */
export const LEGACY_GRANT_USE: GrantUse = 'fill'

export const grantUseOf = (g: { use?: unknown }): GrantUse => (g.use === 'reveal' || g.use === 'env' || g.use === 'fill' ? g.use : LEGACY_GRANT_USE)

/** Whether a grant approved for `held` covers a use `wanted`: reveal covers every use; fill and env only themselves. */
export function grantCovers(held: GrantUse, wanted: GrantUse): boolean {
  return held === 'reveal' || held === wanted
}

const FILE = 'agent-grants.json'

export interface Grant {
  holder: string
  itemId: string
  /** ms since the epoch; Infinity = until the person revokes it. */
  until: number
  fields: string[]
  /** The use the person approved; absent (an older record) reads `fill`. */
  use?: GrantUse
  grantedAt: number
  asker: string
  host: string
  taskId?: string
  taskTitle?: string
  sessionId?: string
  itemTitle?: string
  approvedBy?: string
}

/** What a client sees of a grant: never a value. `until` null = until revoked. */
export interface GrantView {
  id: string
  asker: string
  itemId: string
  itemTitle?: string
  until: string | null
  grantedAt: string
  fields: string[]
  use: GrantUse
  host: string
  taskId?: string
  taskTitle?: string
  sessionId?: string
  approvedBy?: string
}

interface StoredGrant extends Omit<Grant, 'until'> { until: number | null }

const grants = new Map<string, Grant>()
let loading: Promise<void> | null = null
let loaded = false
let saving: Promise<void> = Promise.resolve()

export const grantKey = (holder: string, itemId: string) => `${holder}\u0000${itemId}`
export const grantId = (key: string) => crypto.createHash('sha256').update(`walnut-agent-grant\0${key}`).digest('hex').slice(0, 16)

export function resetGrantsForTest(): void {
  grants.clear()
  loading = null
  loaded = false
  saving = Promise.resolve()
}

async function machineKeyOn(): Promise<boolean> {
  const [f, m] = await Promise.all([loadFile(), loadMachine()])
  return !!(f?.wraps.machine && m?.machineKey && m.vaultId === f.id)
}

/** Read the kept grants once per process, when the vault is open and the machine key is on. */
export async function loadGrants(): Promise<void> {
  if (loaded || !isOpen()) return
  if (!loading) {
    loading = (async () => {
      try {
        if (!(await machineKeyOn())) { loaded = true; return }
        const kept = (await openSide<StoredGrant[]>(FILE)) ?? []
        const now = Date.now()
        // Loaded before anything changed here: a grant made or ended since this process started wins.
        if (loaded) return
        for (const g of Array.isArray(kept) ? kept : []) {
          if (!g || typeof g.holder !== 'string' || typeof g.itemId !== 'string' || !Array.isArray(g.fields)) continue
          const until = g.until === null ? Infinity : Number(g.until)
          if (!(until > now)) continue
          const k = grantKey(g.holder, g.itemId)
          if (!grants.has(k)) grants.set(k, { ...g, until, use: grantUseOf(g) })
        }
        loaded = true
      } catch {
        // Unreadable now (closed meanwhile): try again on the next use.
      } finally {
        loading = null
      }
    })()
  }
  await loading
}

function schedulePersist(): void {
  // From the first change on, memory is the truth: a later load never brings back a grant ended here.
  loaded = true
  const snapshot = (): StoredGrant[] => [...grants.values()].filter((g) => g.until > Date.now()).map((g) => ({ ...g, until: Number.isFinite(g.until) ? g.until : null }))
  saving = saving.then(async () => {
    if (!isOpen()) return
    const on = await machineKeyOn().catch(() => false)
    await updateSide<StoredGrant[]>(FILE, () => (on ? snapshot() : [])).catch(() => undefined)
  })
}

/** Every write so far is on disk (Lock all waits for this before the vault may close). */
export function flushGrants(): Promise<void> {
  return saving
}

export function getGrant(holder: string, itemId: string, now = Date.now()): Grant | undefined {
  const k = grantKey(holder, itemId)
  const g = grants.get(k)
  if (g && g.until <= now) { grants.delete(k); schedulePersist(); return undefined }
  return g
}

export function putGrant(g: Grant): void {
  grants.set(grantKey(g.holder, g.itemId), g)
  schedulePersist()
}

export function listGrantViews(now = Date.now()): GrantView[] {
  const out: GrantView[] = []
  let dropped = false
  for (const [k, g] of grants) {
    if (g.until <= now) { grants.delete(k); dropped = true; continue }
    out.push({
      id: grantId(k), asker: g.asker, itemId: g.itemId, ...(g.itemTitle ? { itemTitle: g.itemTitle } : {}),
      until: Number.isFinite(g.until) ? new Date(g.until).toISOString() : null,
      grantedAt: new Date(g.grantedAt).toISOString(), fields: [...g.fields], use: grantUseOf(g), host: g.host,
      ...(g.taskId ? { taskId: g.taskId } : {}), ...(g.taskTitle ? { taskTitle: g.taskTitle } : {}),
      ...(g.sessionId ? { sessionId: g.sessionId } : {}), ...(g.approvedBy ? { approvedBy: g.approvedBy } : {}),
    })
  }
  if (dropped) schedulePersist()
  return out.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
}

/** End one grant by its id (GrantView.id). The ended grant, or null when there is none. */
export function revokeGrantById(id: string): Grant | null {
  for (const [k, g] of grants) {
    if (grantId(k) !== id) continue
    grants.delete(k)
    schedulePersist()
    return g
  }
  return null
}

/** End every grant; how many there were. */
export function clearGrants(): number {
  const n = grants.size
  grants.clear()
  schedulePersist()
  return n
}
