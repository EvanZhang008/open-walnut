/**
 * What a page in the Files preview keeps the way a browser keeps it for a site (its localStorage,
 * persistent cookies, IndexedDB, Cache API, and its place), per file, on this machine's disk:
 * WALNUT_HOME/local/preview-storage/<sha256 of the page's URL path>.json (local/ never syncs: a
 * browser's storage stays on its machine too). The page's state script writes it through the
 * console (web/src/components/common/preview-frame.ts), and the raw route puts it back into the
 * page it serves (serveRawFileContent -> withPreviewBridge), so it outlives a reload of Walnut and
 * a restart of the app. src/web/preview-state-script.ts says what is in it.
 *
 * The text is kept and served as the page wrote it, never parsed here: up to 8 MB of JSON would
 * hold the event loop (the page parses it, and drops one that does not parse).
 *
 * A page is named by its URL path as the browser asked for it (`/api/file-raw/<host>/<path>`, the
 * page's own `location.pathname`), so the page, the console and this route never disagree on how a
 * path is written.
 *
 *   PUT    /api/preview-storage?doc=<the page's URL path>   body: the state (text)
 *   DELETE /api/preview-storage?doc=<the page's URL path>
 */
import { Router, type Request, type Response } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { PREVIEW_STATE_MAX } from '../../lib/preview-state-envelope.js'
import { log } from '../../logging/index.js'

export const PREVIEW_STORAGE_DIR = () => path.join(WALNUT_HOME, 'local', 'preview-storage')
/** All files together; past it the least recently written go first. */
export const PREVIEW_STORAGE_TOTAL_MAX = 256 * 1024 * 1024
const MAX_PATH = 8192

export const previewStorageRouter = Router()

function fileFor(doc: string): string {
  const key = createHash('sha256').update(doc).digest('hex')
  return path.join(PREVIEW_STORAGE_DIR(), `${key}.json`)
}

/** A state the page wrote: JSON text of envelope version 2, within the cap, every `<` escaped (it goes
 *  into the page's script element as it is: preview-bridge.ts). */
export function looksLikeState(text: unknown): text is string {
  return typeof text === 'string' && text.length <= PREVIEW_STATE_MAX && text.startsWith('{"v":2,') && text.endsWith('}') && !text.includes('<')
}

/** A page's URL path as the raw route answers it. */
export function isPreviewDoc(doc: unknown): doc is string {
  return typeof doc === 'string' && doc.length <= MAX_PATH && /^\/api\/(v1\/)?file-raw\//.test(doc)
}

/** The state the page at this URL path last wrote, or null. */
export async function readPreviewSeed(doc: string): Promise<string | null> {
  if (!isPreviewDoc(doc)) return null
  try {
    const text = await fsp.readFile(fileFor(doc), 'utf8')
    return looksLikeState(text) ? text : null
  } catch {
    return null
  }
}

let lastPrune = 0
/** Keep the folder under PREVIEW_STORAGE_TOTAL_MAX, the least recently written files first out. */
export async function prunePreviewStorage(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastPrune < 60_000) return
  lastPrune = now
  const dir = PREVIEW_STORAGE_DIR()
  let names: string[]
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')) } catch { return }
  const files = (await Promise.all(names.map(async (n) => {
    try { const st = await fsp.stat(path.join(dir, n)); return { n, size: st.size, at: st.mtimeMs } } catch { return null }
  }))).filter((f): f is { n: string; size: number; at: number } => f !== null)
  let total = files.reduce((s, f) => s + f.size, 0)
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= PREVIEW_STORAGE_TOTAL_MAX) break
    await fsp.rm(path.join(dir, f.n), { force: true }).catch(() => {})
    total -= f.size
  }
}

function target(req: Request, res: Response): string | null {
  const doc = req.query.doc
  if (!isPreviewDoc(doc)) {
    res.status(400).json({ error: 'doc names the previewed page by its URL path (/api/file-raw/...)' })
    return null
  }
  return fileFor(doc)
}

previewStorageRouter.put('/', async (req: Request, res: Response) => {
  const file = target(req, res)
  if (!file) return
  if (!looksLikeState(req.body)) {
    res.status(400).json({ error: `the body is a preview state (JSON text, version 2, at most ${PREVIEW_STATE_MAX} characters)` })
    return
  }
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    await fsp.writeFile(tmp, req.body, 'utf8')
    await fsp.rename(tmp, file)
    res.status(204).end()
    void prunePreviewStorage()
  } catch (err) {
    log.web.warn('preview storage write failed', { file, error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'could not keep the preview state' })
  }
})

previewStorageRouter.delete('/', async (req: Request, res: Response) => {
  const file = target(req, res)
  if (!file) return
  await fsp.rm(file, { force: true }).catch(() => {})
  res.status(204).end()
})
