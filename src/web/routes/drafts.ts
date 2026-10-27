/**
 * Unsent drafts: the words a person typed into any box and has not sent yet.
 *
 * The browser keeps each draft in localStorage under its `draft:` key, and
 * mirrors it here (web/src/utils/drafts.ts), so a draft survives cleared
 * browser data and reaches every other browser and window of this Walnut: typed
 * in Chrome, it is there in the Mac app. 2026-10-27, the user: "all the input
 * boxes must save permanently"; a reply typed into the Ask here card was gone
 * after they came back to it.
 *
 * Storage is key → { v, ts } in WALNUT_HOME/local/drafts.json: machine-local
 * (local/ is gitignored and untracked), because a draft changes on every pause
 * in typing and is nothing a git history should carry. `ts` is the client's
 * write time and the merge is last-writer-wins per key; `v: null` is a delete
 * tombstone (the draft was sent or cleared), kept for TOMBSTONE_DAYS so a
 * browser holding an older copy learns it is gone instead of putting it back.
 *
 * A server that is not the Mac (the cloud companion, a host replica) keeps its
 * own file: drafts typed through it reach the browsers that use it.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { withFileLock } from '../../utils/file-lock.js'
import { log } from '../../logging/index.js'

export const draftsRouter = Router()

export const DRAFTS_FILE = () => path.join(WALNUT_HOME, 'local', 'drafts.json')

/** The key families a draft may use (web/src/utils/drafts.ts `isDraftKey`, keep in step). */
export const DRAFT_KEY_PREFIXES = ['draft:', 'side-thread-draft:'] as const
export const MAX_DRAFT_KEY_LEN = 512
/** One draft's text. A longer one stays in its browser only. */
export const MAX_DRAFT_LEN = 64 * 1024
/** The whole file, so a save's read and write stay a few ms on the event loop. */
export const MAX_TOTAL_CHARS = 2 * 1024 * 1024
/** Live drafts are never dropped for the count; only tombstones and, past this, the oldest. */
export const MAX_DRAFTS = 5000
export const TOMBSTONE_DAYS = 30

export interface DraftEntry { v: string | null; ts: number }
export type DraftMap = Record<string, DraftEntry>

export function draftKeyAllowed(key: string): boolean {
  return key.length > 0 && key.length <= MAX_DRAFT_KEY_LEN && DRAFT_KEY_PREFIXES.some((p) => key.startsWith(p))
}

function validEntry(value: unknown): value is DraftEntry {
  if (!value || typeof value !== 'object') return false
  const { v, ts } = value as DraftEntry
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false
  return v === null || (typeof v === 'string' && v.length <= MAX_DRAFT_LEN)
}

/**
 * Merge a patch into the stored drafts, last writer wins per key (a tie goes to
 * the patch, so a retried write lands). Pure: the route and the tests share it.
 */
export function mergeDrafts(stored: DraftMap, patch: Record<string, unknown>, now = Date.now()): DraftMap {
  const out: DraftMap = { ...stored }
  for (const [key, value] of Object.entries(patch)) {
    if (!draftKeyAllowed(key) || !validEntry(value)) continue
    const existing = out[key]
    if (existing && existing.ts > value.ts) continue
    out[key] = { v: value.v === '' ? null : value.v, ts: value.ts }
  }
  return pruneDrafts(out, now)
}

/** Old tombstones go; past MAX_DRAFTS, tombstones first, then the oldest drafts. */
export function pruneDrafts(drafts: DraftMap, now = Date.now()): DraftMap {
  const cutoff = now - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000
  const out: DraftMap = {}
  for (const [key, e] of Object.entries(drafts)) {
    if (e.v === null && e.ts < cutoff) continue
    out[key] = e
  }
  const keys = Object.keys(out)
  let total = 0
  for (const key of keys) total += key.length + (out[key].v?.length ?? 0)
  if (keys.length <= MAX_DRAFTS && total <= MAX_TOTAL_CHARS) return out
  const order = keys.sort((a, b) => {
    const ta = out[a].v === null ? 0 : 1
    const tb = out[b].v === null ? 0 : 1
    return ta - tb || out[a].ts - out[b].ts
  })
  let count = keys.length
  for (const key of order) {
    if (count <= MAX_DRAFTS && total <= MAX_TOTAL_CHARS) break
    total -= key.length + (out[key].v?.length ?? 0)
    delete out[key]
    count--
  }
  return out
}

/**
 * The stored drafts. A file that does not parse (a crash mid-write on an old
 * disk) is set aside as `.corrupt-<time>` and reads as none, so one bad write
 * never stops every later save.
 */
async function loadDrafts(): Promise<DraftMap> {
  let raw: unknown
  try {
    raw = await readJsonFile<Record<string, unknown>>(DRAFTS_FILE(), {})
  } catch (err) {
    const aside = `${DRAFTS_FILE()}.corrupt-${Date.now()}`
    await fsp.rename(DRAFTS_FILE(), aside).catch(() => {})
    log.web.warn('drafts.json did not parse; set aside', { aside, error: err instanceof Error ? err.message : String(err) })
    raw = {}
  }
  const out: DraftMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (draftKeyAllowed(key) && validEntry(value)) out[key] = value
  }
  return out
}

/**
 * The browser fixture shares one server across every spec, and each spec's new
 * browser expects empty storage: there (`WALNUT_DRAFTS_MIRROR=opt-in`) the mirror
 * serves only requests that carry the `x-walnut-drafts-mirror: 1` header (a spec
 * that tests the mirror sets it on its browsers), and every other browser reads
 * no drafts and writes nowhere. Unset, the mirror serves every request.
 */
export const DRAFTS_MIRROR_HEADER = 'x-walnut-drafts-mirror'
export function mirrorServes(req: Pick<Request, 'headers'>, mode = process.env.WALNUT_DRAFTS_MIRROR): boolean {
  return mode !== 'opt-in' || req.headers[DRAFTS_MIRROR_HEADER] === '1'
}

// GET /api/drafts → { drafts: Record<key, { v: string|null, ts }> }
draftsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mirrorServes(req)) { res.json({ drafts: {} }); return }
    res.json({ drafts: await loadDrafts() })
  } catch (err) {
    next(err)
  }
})

// PUT /api/drafts { drafts: { key: { v, ts } } }: LWW merge; v null = sent or cleared.
draftsRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const patch = req.body?.drafts
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'drafts object is required' })
      return
    }
    if (!mirrorServes(req)) { res.json({ ok: true }); return }
    await withFileLock(DRAFTS_FILE(), async () => {
      await writeJsonFile(DRAFTS_FILE(), mergeDrafts(await loadDrafts(), patch as Record<string, unknown>))
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
