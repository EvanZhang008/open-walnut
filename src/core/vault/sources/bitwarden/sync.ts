/**
 * One-way sync from Bitwarden (docs/reference/passwords.md, "Sync from Bitwarden"). Input: an
 * unencrypted Bitwarden JSON export, held in memory only (Walnut never writes it to disk and
 * never logs it). Bitwarden is the source; the vault must be open.
 *
 * Each Bitwarden item id is linked to one Walnut item in `bitwarden-sync.json` (a side file
 * sealed with the vault key, state.ts), with a hash of what Bitwarden last said about it (the
 * fields Bitwarden owns: name, login, sites, notes, fields, card, folder, favorite), so a person's
 * edit in Walnut never loses the link. "The Walnut copy changed" means those fields differ from
 * that hash, or it was moved to the trash; a Walnut-only setting (agent access, sensitive, an env
 * var name) is no change:
 *
 *   - new in Bitwarden          → added; unless an unlinked Walnut item is the same one (an
 *                                 earlier plain import): same type, title, username and first
 *                                 site (a note, card or identity: type and title), which is
 *                                 adopted (unchanged, or updated when its fields differ). Only a
 *                                 match of exactly one item on each side is adopted; more than one
 *                                 look-alike on either side is added as new (`ambiguous`). An
 *                                 adopted item keeps its own agent access and sensitive mark.
 *   - changed in Bitwarden      → updated, unless the Walnut copy changed since the last sync too:
 *                                 then both are kept, the Walnut one tagged `conflict` (and no
 *                                 longer linked) and Bitwarden's added as a new item
 *   - gone from Bitwarden       → its Walnut item moves to the trash (30 days to restore). An
 *                                 export item that is there but does not read (skipped) is not
 *                                 gone: its link and its Walnut copy stay. A sync that would trash
 *                                 more than 20% of the linked items, and more than 5, is refused
 *                                 (`sync_mass_trash`) unless a person's session allows it.
 *   - unchanged                 → nothing (a Walnut-only edit stays)
 *
 * An update keeps what only Walnut has: the agent access, an env var name, sensitive (either
 * side's), passkeys made in Walnut, password history (the old password goes into it), when it
 * was used. All changes are one vault write. Counts come back per item type.
 */
import crypto from 'node:crypto'
import { randomBytes, seal, sealJson } from '../../crypto.js'
import { aadItem, aadItemKey, mutate, openSide, updateSide, VaultError, type VaultFile } from '../../state.js'
import { cleanInput } from '../../items.js'
import { parseBitwardenExport } from '../../import.js'
import { PASSWORD_HISTORY_MAX, type VaultItem, type VaultItemInput } from '../../types.js'

const FILE = 'bitwarden-sync.json'
export const CONFLICT_TAG = 'conflict'

/** `ambiguous`: new in Bitwarden, added as a new item because more than one look-alike (either side) made adoption a guess. */
export interface SyncCounts { added: number; updated: number; trashed: number; conflicts: number; unchanged: number; ambiguous: number }
export type SyncTrigger = 'agent' | 'person' | 'daily' | 'cli'

export interface SyncReport {
  at: string
  ok: boolean
  trigger: SyncTrigger
  counts: SyncCounts
  byType: Record<string, SyncCounts>
  /** Items in the export, per type (login, note, card, identity). */
  bitwarden: Record<string, number>
  /** Walnut items linked to a Bitwarden item after the sync, per type: equal to `bitwarden` when every item came across. */
  linked: Record<string, number>
  skipped: Array<{ row: number; title?: string; reason: string }>
  /** Not run, and why (the vault is locked, no BW_SESSION, bw failed). */
  error?: string
}

interface Link { itemId: string; hash: string; revisionDate?: string; type: string; walnutAt: string }
interface SyncState { links: Record<string, Link>; last?: SyncReport }

const zero = (): SyncCounts => ({ added: 0, updated: 0, trashed: 0, conflicts: 0, unchanged: 0, ambiguous: 0 })

/** A sync may trash at most this share of the linked items (and MASS_TRASH_MIN items) without a person allowing it. */
export const MASS_TRASH_SHARE = 0.2
export const MASS_TRASH_MIN = 5

export interface SyncOptions {
  /** A person's session allowed a sync that trashes many items (the export really lost them). */
  allowMassTrash?: boolean
}

/** What Bitwarden decides of an item: the hash that says whether it changed. */
function comparable(i: Pick<VaultItem, 'type' | 'title' | 'username' | 'password' | 'urls' | 'totp' | 'notes' | 'fields' | 'card' | 'tags' | 'favorite'>): unknown {
  return {
    type: i.type, title: i.title, username: i.username ?? '', password: i.password ?? '', urls: i.urls ?? [], totp: i.totp ?? '', notes: i.notes ?? '',
    fields: (i.fields ?? []).map((f) => [f.name, f.value, !!f.hidden]),
    card: i.card ? [i.card.holder ?? '', i.card.number ?? '', i.card.expMonth ?? '', i.card.expYear ?? '', i.card.code ?? '', i.card.brand ?? ''] : null,
    tags: (i.tags ?? []).filter((t) => t !== CONFLICT_TAG), favorite: !!i.favorite,
  }
}

function hashOf(i: Parameters<typeof comparable>[0]): string {
  return crypto.createHash('sha256').update(JSON.stringify(comparable(i))).digest('hex')
}

function matchKey(i: Pick<VaultItem, 'type' | 'title' | 'username' | 'urls'>): string {
  return i.type === 'login' || i.type === 'api_key'
    ? `${i.type}\u0000${i.title}\u0000${i.username ?? ''}\u0000${i.urls?.[0] ?? ''}`
    : `${i.type}\u0000${i.title}`
}

async function writeItem(f: VaultFile, key: Uint8Array, item: VaultItem): Promise<void> {
  // The same sealing as items.ts writeItem: a fresh item key under the vault key.
  const ik = randomBytes(32)
  f.items[item.id] = {
    key: await seal(key, ik, aadItemKey(f.id, item.id)),
    data: await sealJson(ik, item, aadItem(f.id, item.id)),
    updatedAt: item.updatedAt,
  }
}

function fresh(input: VaultItemInput, now: string): VaultItem {
  return { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
}

function merged(prev: VaultItem, bw: VaultItemInput, now: string): VaultItem {
  let history = prev.passwordHistory ?? []
  if (prev.password && prev.password !== bw.password) history = [{ password: prev.password, replacedAt: now }, ...history].slice(0, PASSWORD_HISTORY_MAX)
  const { passkeys: bwPasskeys, ...rest } = bw
  const passkeys = prev.passkeys?.length ? prev.passkeys : bwPasskeys
  return {
    ...rest, id: prev.id, createdAt: prev.createdAt, updatedAt: now,
    ...(prev.agentAccess ? { agentAccess: prev.agentAccess } : {}),
    ...(prev.envName && !rest.envName ? { envName: prev.envName } : {}),
    ...(prev.sensitive || rest.sensitive ? { sensitive: true } : {}),
    ...(passkeys?.length ? { passkeys } : {}),
    ...(history.length ? { passwordHistory: history } : {}),
    ...(prev.usedAt ? { usedAt: prev.usedAt } : {}),
  }
}

/** An adopted item is the person's own: Bitwarden never sets its agent access or sensitive mark. */
function adopted(own: VaultItem, next: VaultItem): VaultItem {
  const { agentAccess: _a, sensitive: _s, ...rest } = next
  return { ...rest, ...(own.agentAccess ? { agentAccess: own.agentAccess } : {}), ...(own.sensitive ? { sensitive: true } : {}) }
}

let lastInMemory: SyncReport | null = null

/** The last sync's report: this server's memory first (a skip while locked), else the sealed file. */
export async function lastSyncReport(): Promise<SyncReport | null> {
  if (lastInMemory) return lastInMemory
  try { return (await openSide<SyncState>(FILE))?.last ?? null } catch { return null }
}

/** Remember a sync that did not run (locked, bw missing); kept in the file too when the vault is open. */
export async function noteSyncSkipped(trigger: SyncTrigger, error: string): Promise<SyncReport> {
  const r: SyncReport = { at: new Date().toISOString(), ok: false, trigger, counts: zero(), byType: {}, bitwarden: {}, linked: {}, skipped: [], error }
  lastInMemory = r
  await updateSide<SyncState>(FILE, (cur) => ({ links: cur?.links ?? {}, last: r })).catch(() => undefined)
  return r
}

export function resetBitwardenSyncForTest(): void {
  lastInMemory = null
}

/** Run one sync from an export's text. Throws ImportError for a file that is not a Bitwarden JSON export, VaultError when locked. */
export async function syncFromBitwarden(text: string, trigger: SyncTrigger, opts: SyncOptions = {}): Promise<SyncReport> {
  const entries = parseBitwardenExport(text)
  const skipped: SyncReport['skipped'] = []
  const bitwarden: Record<string, number> = {}
  const wanted: Array<{ id: string; revisionDate?: string; input: VaultItemInput; hash: string }> = []
  const seenIds = new Set<string>()
  for (const e of entries) {
    if (!e.id) { skipped.push({ row: e.row, title: e.title, reason: e.item ? 'no Bitwarden id (not from bw export)' : e.skip ?? 'skipped' }); continue }
    if (seenIds.has(e.id)) { skipped.push({ row: e.row, title: e.title, reason: 'the same Bitwarden id twice' }); continue }
    // Seen before it is read: an item Bitwarden still has but that does not read is never "gone".
    seenIds.add(e.id)
    if (!e.item) { skipped.push({ row: e.row, title: e.title, reason: e.skip ?? 'skipped' }); continue }
    let input: VaultItemInput
    try { input = cleanInput(e.item) } catch (err) { skipped.push({ row: e.row, title: e.title, reason: (err as Error).message }); continue }
    bitwarden[input.type] = (bitwarden[input.type] ?? 0) + 1
    wanted.push({ id: e.id, ...(e.revisionDate ? { revisionDate: e.revisionDate } : {}), input, hash: hashOf(input) })
  }

  const counts = zero()
  const byType: Record<string, SyncCounts> = {}
  const bump = (type: string, k: keyof SyncCounts) => { counts[k]++; (byType[type] ??= zero())[k]++ }

  const state = await mutate(async ({ f, key, items }) => {
    const prior = (await openSide<SyncState>(FILE)) ?? { links: {} }
    const links: Record<string, Link> = {}
    const now = new Date().toISOString()
    const linkedIds = new Set(Object.values(prior.links ?? {}).map((l) => l.itemId))

    // Gone from Bitwarden, counted first: a sync that would empty much of the vault is refused before any write.
    const gone = Object.entries(prior.links ?? {}).filter(([bwId, l]) => !seenIds.has(bwId) && !!items.get(l.itemId) && !items.get(l.itemId)!.trashedAt)
    const linkedCount = Object.keys(prior.links ?? {}).length
    if (!opts.allowMassTrash && gone.length > MASS_TRASH_MIN && gone.length > linkedCount * MASS_TRASH_SHARE) {
      throw new VaultError(
        `This sync would move ${gone.length} of ${linkedCount} synced items to the trash, so Walnut did not run it. If Bitwarden really deleted them, the person runs Sync now in Settings, Passwords, and allows it there.`,
        409, 'sync_mass_trash')
    }
    // Unlinked live Walnut items, by what makes them the same one: candidates for adoption.
    const adoptable = new Map<string, VaultItem[]>()
    for (const it of items.values()) {
      if (it.trashedAt || linkedIds.has(it.id)) continue
      const k = matchKey(it)
      adoptable.set(k, [...(adoptable.get(k) ?? []), it])
    }
    // New Bitwarden items (no live link) by the same key: two of them make adoption a guess too.
    const newByKey = new Map<string, number>()
    for (const w of wanted) {
      const l = prior.links?.[w.id]
      if (l && items.get(l.itemId)) continue
      const k = matchKey(w.input)
      newByKey.set(k, (newByKey.get(k) ?? 0) + 1)
    }
    let changed = false
    const put = async (it: VaultItem) => { await writeItem(f, key, it); items.set(it.id, it); changed = true }

    for (const w of wanted) {
      const type = w.input.type
      const link = prior.links?.[w.id]
      const cur = link ? items.get(link.itemId) : undefined
      if (!link || !cur) {
        const k = matchKey(w.input)
        const cands = adoptable.get(k) ?? []
        const ambiguous = cands.length > 1 || (cands.length === 1 && (newByKey.get(k) ?? 0) > 1)
        const hit = !ambiguous ? cands.shift() : undefined
        if (hit) {
          if (hashOf(hit) === w.hash) { bump(type, 'unchanged'); links[w.id] = { itemId: hit.id, hash: w.hash, type, walnutAt: hit.updatedAt, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }; continue }
          const next = adopted(hit, merged(hit, w.input, now))
          await put(next)
          bump(type, 'updated')
          links[w.id] = { itemId: next.id, hash: w.hash, type, walnutAt: next.updatedAt, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }
          continue
        }
        const made = fresh(w.input, now)
        await put(made)
        bump(type, ambiguous ? 'ambiguous' : 'added')
        links[w.id] = { itemId: made.id, hash: w.hash, type, walnutAt: made.updatedAt, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }
        continue
      }
      const bwChanged = link.hash !== w.hash
      const walnutChanged = !!cur.trashedAt || hashOf(cur) !== link.hash
      if (!bwChanged) {
        bump(type, 'unchanged')
        links[w.id] = { ...link, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }
        continue
      }
      if (!walnutChanged) {
        const next = merged(cur, w.input, now)
        await put(next)
        bump(type, 'updated')
        links[w.id] = { itemId: next.id, hash: w.hash, type, walnutAt: next.updatedAt, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }
        continue
      }
      // Both sides changed: keep both. The Walnut copy is tagged and no longer synced; Bitwarden's comes in new.
      await put({ ...cur, tags: [...new Set([...(cur.tags ?? []), CONFLICT_TAG])], updatedAt: now })
      const made = fresh(w.input, now)
      await put(made)
      bump(type, 'conflicts')
      links[w.id] = { itemId: made.id, hash: w.hash, type, walnutAt: made.updatedAt, ...(w.revisionDate ? { revisionDate: w.revisionDate } : {}) }
    }

    // Still in Bitwarden but not read this time (skipped): the link stays as it was.
    for (const [bwId, link] of Object.entries(prior.links ?? {})) {
      if (seenIds.has(bwId) && !links[bwId] && items.get(link.itemId)) links[bwId] = link
    }
    // Gone from Bitwarden: to the trash.
    for (const [, link] of gone) {
      const cur = items.get(link.itemId)!
      await put({ ...cur, trashedAt: now, updatedAt: now })
      bump(link.type, 'trashed')
    }
    return { result: { links, prior }, write: changed }
  })

  const linked: Record<string, number> = {}
  for (const l of Object.values(state.links)) linked[l.type] = (linked[l.type] ?? 0) + 1
  const report: SyncReport = { at: new Date().toISOString(), ok: true, trigger, counts, byType, bitwarden, linked, skipped: skipped.slice(0, 50) }
  // After the items: a crash between leaves new items with no link, which the next sync adopts.
  await updateSide<SyncState>(FILE, () => ({ links: state.links, last: report }))
  lastInMemory = report
  return report
}

/** "12 added, 3 updated, ..." for Settings, the log and the op's outcome. */
export function syncSummary(r: SyncReport): string {
  if (!r.ok) return `not synced: ${r.error ?? 'unknown'}`
  const c = r.counts
  const parts = [`${c.added} added`, `${c.updated} updated`, `${c.trashed} moved to the trash`, `${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'}`, `${c.unchanged} unchanged`]
  if (c.ambiguous) parts.push(`${c.ambiguous} added as new (more than one look-alike, not matched)`)
  return parts.join(', ')
}
