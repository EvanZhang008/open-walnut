/**
 * UI preferences routes — server-side persistence for browser layout state
 * (section collapse flags, splitter ratios, dragged heights, panel widths).
 *
 * The web client mirrors its localStorage layout keys here (see
 * web/src/utils/ui-prefs-sync.ts), so the layout survives new browsers,
 * other devices, and cleared browser data — not just page reloads.
 *
 * Keys whose NAME embeds an absolute path are excluded (MACHINE_LOCAL_PREFIXES):
 * this file is synced now, and such an entry is meaningless on another device.
 *
 * Storage is key → { v, ts } in CONFIG_SHARE_DIR/ui-prefs.json (git-tracked
 * warm data — the layout follows the user to another DEVICE, not just another
 * browser). `ts` is the client's write time (last-writer-wins): a PUT only
 * replaces an entry when its ts is >= the stored one, so a page-unload flush
 * racing the next page load's GET can't resurrect stale values. `v: null` is a
 * delete tombstone.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME, UI_PREFS_FILE } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { log } from '../../logging/index.js'
import { MAX_KEY_LEN, machineLocalKey, syncableKey } from '../../core/ui-prefs-keys.js'
import { isHostReplicaProgram } from '../../core/server-role.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'
import { KIND_NOT_COPIED } from '../../core/replication/kinds/gate.js'

export const uiPrefsRouter = Router()

/** Called after every write of ui-prefs.json (the prefs copy kind starts a round). */
const writeListeners = new Set<() => void>()
export function onUiPrefsWritten(cb: () => void): () => void {
  writeListeners.add(cb)
  return () => { writeListeners.delete(cb) }
}

const PREFS_FILE = () => UI_PREFS_FILE

/** Pre-2026-08 location: the WALNUT_HOME root, where it was gitignored (and so
 *  device-local) purely because the root had no synced/unsynced distinction. */
const LEGACY_PREFS_FILE = () => path.join(WALNUT_HOME, 'ui-prefs.json')

interface PrefEntry { v: string | null; ts: number }

// The key rule (syncableKey, machine-local families, MAX_KEY_LEN) is shared with the prefs copy kind.

/**
 * One-time move of the root ui-prefs.json into config/share/, dropping the
 * machine-local entries on the way through (they were only ever local, so
 * carrying them into a synced file would export this box's paths to every
 * other device).
 *
 * Same shape as migrateLegacyMemoryFile() in core/init.ts: run only when the
 * old path exists AND the new one doesn't, memoized per process, and never
 * throws — the worst outcome of a failure is a fresh empty prefs file, which
 * must not turn into a 500 on the boot GET.
 */
let migration: Promise<void> | null = null

async function migrateLegacyPrefs(): Promise<void> {
  const from = LEGACY_PREFS_FILE()
  const to = PREFS_FILE()
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return

    let parsed: Record<string, unknown> | null = null
    try {
      const value = JSON.parse(await fsp.readFile(from, 'utf-8')) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
    } catch { /* corrupt/unreadable — moved verbatim below rather than dropped */ }

    if (parsed) {
      const kept: Record<string, unknown> = {}
      let dropped = 0
      for (const [key, value] of Object.entries(parsed)) {
        if (machineLocalKey(key)) dropped++
        else kept[key] = value
      }
      await writeJsonFile(to, kept)
      await fsp.rm(from, { force: true })
      log.web.info('Migrated ui-prefs.json into config/share/', { keys: Object.keys(kept).length, droppedMachineLocal: dropped })
      return
    }

    await fsp.mkdir(path.dirname(to), { recursive: true })
    try {
      await fsp.rename(from, to)
    } catch {
      // EXDEV (separate filesystems) — copy, then drop the original only once
      // the copy landed.
      await fsp.copyFile(from, to)
      await fsp.rm(from, { force: true })
    }
    log.web.info('Migrated ui-prefs.json into config/share/ (unparsable — moved verbatim)')
  } catch (err) {
    log.web.warn('ui-prefs migration into config/share/ failed (retried on next access)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Await before the first read/write. Runs at most once per process. */
export function ensureUiPrefsMigrated(): Promise<void> {
  migration ??= migrateLegacyPrefs()
  return migration
}

/** Test hook: forget the memoized migration so a fresh WALNUT_HOME re-runs it. */
export function _resetUiPrefsMigrationForTest(): void {
  migration = null
}

const MAX_KEYS = 1000
const MAX_VALUE_LEN = 8 * 1024

/** Load prefs, migrating legacy plain-string values to { v, ts: 0 } (any client write beats them). */
async function loadPrefs(): Promise<Record<string, PrefEntry>> {
  await ensureUiPrefsMigrated()
  const raw = await readJsonFile<Record<string, unknown>>(PREFS_FILE(), {})
  const prefs: Record<string, PrefEntry> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      prefs[key] = { v: value, ts: 0 }
    } else if (value && typeof value === 'object' && 'ts' in value) {
      const e = value as PrefEntry
      if ((typeof e.v === 'string' || e.v === null) && typeof e.ts === 'number') prefs[key] = e
    }
  }
  return prefs
}

// GET /api/ui-prefs → { prefs: Record<string, { v: string|null, ts: number }> }
uiPrefsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // A host replica holds the Mac's prefs as a copy (core/replication/kinds/prefs.ts).
    if (isHostReplicaProgram()) {
      const prefs = await (await import('../../core/replication/kinds/prefs.js')).readUiPrefsCopy()
      // No copy yet (or the host turned it off): not "no prefs", which a client would merge as such.
      if (!prefs) throw new NeedsLeaderError(KIND_NOT_COPIED)
      res.json({ prefs })
      return
    }
    res.json({ prefs: await loadPrefs() })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ui-prefs { prefs: { key: { v, ts } } } — LWW merge; v null = delete tombstone.
uiPrefsRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The copy is the Mac's: a layout change made here waits for it.
    if (isHostReplicaProgram()) throw new NeedsLeaderError('prefs_writes_need_mac')
    const patch = req.body?.prefs
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'prefs object is required' })
      return
    }
    const prefs = await loadPrefs()
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!syncableKey(key) || key.length > MAX_KEY_LEN) continue
      if (!value || typeof value !== 'object') continue
      const { v, ts } = value as PrefEntry
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
      if (v !== null && (typeof v !== 'string' || v.length > MAX_VALUE_LEN)) continue
      const existing = prefs[key]
      if (existing && existing.ts > ts) continue // stale write loses
      prefs[key] = { v, ts }
    }
    // Size backstop — a runaway writer can't grow the file without bound.
    const keys = Object.keys(prefs)
    if (keys.length > MAX_KEYS) {
      for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete prefs[k]
    }
    await writeJsonFile(PREFS_FILE(), prefs)
    for (const cb of writeListeners) { try { cb() } catch { /* never fails the write */ } }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
