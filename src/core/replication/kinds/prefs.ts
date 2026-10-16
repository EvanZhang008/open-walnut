/**
 * The `prefs` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4 and
 * WP5): the Mac's ui prefs (config/share/ui-prefs.json, layout state only) and
 * its favorites, carved out of config.yaml (never the rest of that file), on
 * each host replica in `cache/replica/prefs.json` (file-copy.ts). On the host,
 * GET /api/ui-prefs and GET /api/favorites read this copy; their writes wait
 * for the Mac.
 *
 * Rows: `ui:<key>` -> `{v, ts}` per pref, and `favorites` -> `{projects, notes}`.
 * A ui-prefs file or a config.yaml the Mac fails to read throws, so the round
 * skips the kind. Unordered, no digest, floor 0 (the half rule always applies).
 */

import { UI_PREFS_FILE } from '../../../constants.js'
import { MAX_KEY_LEN, syncableKey } from '../../ui-prefs-keys.js'
import { readJsonFile } from '../../../utils/fs.js'
import { secretShapedValue } from '../config-allowlist.js'
import { sha12 } from '../kind.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'

export const PREFS_SCHEMA_VERSION = 1
export const PREFS_REMOVAL_FLOOR = 0
const UI = 'ui:'
const MAX_VALUE_LEN = 8 * 1024

export interface UiPref { v: string | null; ts: number }
export interface Favorites { projects: string[]; notes: string[] }
export type PrefsRow = { key: string; pref: UiPref } | { key: 'favorites'; favorites: Favorites }

/** Layout keys only: the ui-prefs route's own rule (core/ui-prefs-keys.ts), not a copy of it. */
export function copyableUiPrefKey(key: string): boolean {
  return key.length <= MAX_KEY_LEN && syncableKey(key)
}

function prefOf(value: unknown): UiPref | null {
  if (typeof value === 'string') return { v: value, ts: 0 }
  const e = value as Partial<UiPref> | null
  if (!e || typeof e !== 'object' || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return null
  if (e.v !== null && typeof e.v !== 'string') return null
  return { v: e.v, ts: e.ts }
}

function prefAdmissible(p: UiPref): boolean {
  return p.v === null || (p.v.length <= MAX_VALUE_LEN && secretShapedValue(p.v) === null)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

async function leaderRows(): Promise<PrefsRow[]> {
  const raw = await readJsonFile<Record<string, unknown>>(UI_PREFS_FILE, {}, { readErrors: 'throw' })
  const rows: PrefsRow[] = []
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    const pref = copyableUiPrefKey(k) ? prefOf(v) : null
    if (pref && prefAdmissible(pref)) rows.push({ key: UI + k, pref })
  }
  const { readLeaderConfig } = await import('./config.js')
  const fav = (await readLeaderConfig()).favorites as { projects?: unknown; notes?: unknown } | undefined
  rows.push({ key: 'favorites', favorites: { projects: strings(fav?.projects), notes: strings(fav?.notes) } })
  return rows
}

const hashes = new WeakMap<object, string>()
function hashOf(row: PrefsRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const PREFS_KIND: CopyKind<PrefsRow> = {
  kind: 'prefs',
  schemaVersion: PREFS_SCHEMA_VERSION,
  key: (r) => r.key,
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'prefs',
  rows: leaderRows,
  watch: (soon) => {
    const stops: Array<() => void> = []
    let stopped = false
    void Promise.all([import('../../config-manager.js'), import('../../../web/routes/ui-prefs.js')]).then(([cm, ui]) => {
      if (!stopped) stops.push(cm.onConfigWritten(soon), ui.onUiPrefsWritten(soon))
    })
    return () => { stopped = true; for (const s of stops) s() }
  },
}

// --- Follower ---

function isRow(v: unknown): v is PrefsRow {
  const r = v as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || typeof r.key !== 'string') return false
  if (r.key === 'favorites') {
    const f = r.favorites as Partial<Favorites> | undefined
    return Object.keys(r).length === 2 && !!f && Array.isArray(f.projects) && Array.isArray(f.notes)
  }
  const p = prefOf(r.pref)
  return Object.keys(r).length === 2 && r.key.startsWith(UI) && copyableUiPrefKey(r.key.slice(UI.length)) && !!p && typeof r.pref === 'object'
}

function admit(r: PrefsRow): boolean {
  if ('favorites' in r) return [...r.favorites.projects, ...r.favorites.notes].every((s) => typeof s === 'string' && secretShapedValue(s) === null)
  return prefAdmissible(r.pref)
}

const copy = createFileCopy<PrefsRow>({
  kind: 'prefs',
  schemaVersion: PREFS_SCHEMA_VERSION,
  label: 'prefs copy',
  removalFloor: PREFS_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.key,
  admit,
})

export const prefsFollower = copy.follower

/** The copied ui prefs (key -> {v, ts}), or null when there is no copy. */
export async function readUiPrefsCopy(): Promise<Record<string, UiPref> | null> {
  const rows = await copy.read()
  if (!rows) return null
  const out: Record<string, UiPref> = {}
  for (const r of Object.values(rows)) if ('pref' in r) out[r.key.slice(UI.length)] = r.pref
  return out
}

/** The copied favorites, or null when there is no copy. */
export async function readFavoritesCopy(): Promise<Favorites | null> {
  const rows = await copy.read()
  if (!rows) return null
  const f = rows.favorites
  return f && 'favorites' in f ? f.favorites : { projects: [], notes: [] }
}

/** Tests only. */
export function _resetPrefsCopyForTesting(): void {
  copy.reset()
}
