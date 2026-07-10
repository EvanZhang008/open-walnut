/**
 * UI preferences routes — server-side persistence for browser layout state
 * (section collapse flags, splitter ratios, dragged heights, panel widths).
 *
 * The web client mirrors its localStorage layout keys here (see
 * web/src/utils/ui-prefs-sync.ts), so the layout survives new browsers,
 * other devices, and cleared browser data — not just page reloads.
 *
 * Storage is key → { v, ts } in WALNUT_HOME/ui-prefs.json. `ts` is the
 * client's write time (last-writer-wins): a PUT only replaces an entry when
 * its ts is >= the stored one, so a page-unload flush racing the next page
 * load's GET can't resurrect stale values. `v: null` is a delete tombstone.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'

export const uiPrefsRouter = Router()

const PREFS_FILE = () => path.join(WALNUT_HOME, 'ui-prefs.json')

interface PrefEntry { v: string | null; ts: number }

// Same allowlist as the client sync layer — layout state only. Rejecting
// everything else keeps auth tokens, drafts, and per-session blobs out.
function syncableKey(key: string): boolean {
  if (key.startsWith('open-walnut-diff-review:')) return false
  if (key === 'open-walnut-ui-prefs-sync-meta') return false
  return key.startsWith('open-walnut-') || key.startsWith('walnut-todo-')
}

const MAX_KEYS = 1000
const MAX_KEY_LEN = 200
const MAX_VALUE_LEN = 8 * 1024

/** Load prefs, migrating legacy plain-string values to { v, ts: 0 } (any client write beats them). */
async function loadPrefs(): Promise<Record<string, PrefEntry>> {
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
    res.json({ prefs: await loadPrefs() })
  } catch (err) {
    next(err)
  }
})

// PUT /api/ui-prefs { prefs: { key: { v, ts } } } — LWW merge; v null = delete tombstone.
uiPrefsRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
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
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
