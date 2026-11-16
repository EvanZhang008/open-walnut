/**
 * A drawing rendered to a picture file an agent opens with its file reader (render.ts draws it).
 *
 * Files live in Walnut's own images folder, `IMAGES_DIR/drawings/<path hash>-<revision>.svg|png`:
 * the same revision of the same drawing is rendered once. Per drawing only the newest
 * KEEP_REVISIONS revisions are kept, and any picture not used for MAX_IDLE_MS is removed (a reuse
 * touches its file), so the folder never grows without bound.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { IMAGES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'
import { cleanScenePath } from './paths.js'
import { renderSceneSvgYielding } from './render.js'
import { isLargeScene, runCodec } from './scene-codec.js'
import { DrawingInputError, type DrawingScene } from './scene.js'
import { readSceneFile, replaceAtomically, resolveVaultFile, tempPathFor } from './vault-files.js'

export const KEEP_REVISIONS = 2
export const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000
const WHERE_NOTE = 'The picture is on the main Walnut machine; a session on another host fetches it with host_copy.'

export interface DrawingRender {
  path: string
  revision: string
  format: 'svg' | 'png'
  /** Absolute path of the picture on the main Walnut machine. */
  svgPath?: string
  pngPath?: string
  width: number
  height: number
  /** Where the picture is, and why a PNG asked for came back as SVG. */
  note: string
}

/** Where rendered pictures of drawings are kept: Walnut's own images folder. */
export function drawingRenderDir(): string {
  return path.join(IMAGES_DIR, 'drawings')
}

function pathKey(rel: string): string {
  return createHash('sha256').update(rel).digest('hex').slice(0, 16)
}

/** True when the file exists; a reuse refreshes its time, so the idle sweep keeps it. */
async function reuse(p: string): Promise<boolean> {
  try {
    const now = new Date()
    await fsp.utimes(p, now, now)
    return true
  } catch {
    return false
  }
}

/** The pixel size an SVG of ours states in its root element (the first bytes of the file). */
async function svgSize(p: string): Promise<{ width: number; height: number } | null> {
  try {
    const handle = await fsp.open(p, 'r')
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0)
      const m = /<svg [^>]*?width="(\d+)" height="(\d+)"/.exec(buffer.subarray(0, bytesRead).toString('utf-8'))
      return m ? { width: Number(m[1]), height: Number(m[2]) } : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** Keep the newest KEEP_REVISIONS revisions of this drawing; drop every picture idle too long. */
let lastSweep = 0
async function prune(dir: string, key: string, now = Date.now()): Promise<void> {
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return }
  const sweep = now - lastSweep > SWEEP_EVERY_MS
  if (sweep) lastSweep = now
  const mine = new Map<string, number>() // revision -> newest mtime
  const stale: string[] = []
  await Promise.all(names.map(async (name) => {
    const m = /^([0-9a-f]{16})-([0-9a-f]+)\.(svg|png)$/.exec(name)
    if (!m) return
    const st = await fsp.stat(path.join(dir, name)).catch(() => null)
    if (!st) return
    if (sweep && now - st.mtimeMs > MAX_IDLE_MS) { stale.push(name); return }
    if (m[1] === key) mine.set(m[2]!, Math.max(mine.get(m[2]!) ?? 0, st.mtimeMs))
  }))
  const old = [...mine.entries()].sort((a, b) => b[1] - a[1]).slice(KEEP_REVISIONS).map(([rev]) => rev)
  for (const rev of old) stale.push(`${key}-${rev}.svg`, `${key}-${rev}.png`)
  await Promise.all(stale.map((name) => fsp.rm(path.join(dir, name), { force: true }).catch(() => {})))
}

/**
 * The drawing as a picture: SVG, or PNG through sharp when it is available here (otherwise the
 * SVG, and the note says why). Parsing a large scene and drawing it never hold the event loop.
 */
export async function renderDrawing(rawPath: unknown, rawFormat: unknown): Promise<DrawingRender> {
  const format = rawFormat === undefined || rawFormat === null || rawFormat === '' ? 'png' : rawFormat
  if (format !== 'png' && format !== 'svg') throw new DrawingInputError('format must be png or svg')
  const rel = cleanScenePath(rawPath)
  const { bytes } = await readSceneFile(await resolveVaultFile(rel))
  const large = isLargeScene(bytes.length)
  const revision = await runCodec<string>('hash', bytes, large)
  const dir = drawingRenderDir()
  await fsp.mkdir(dir, { recursive: true })
  const key = pathKey(rel)
  const svgPath = path.join(dir, `${key}-${revision}.svg`)
  const pngPath = path.join(dir, `${key}-${revision}.png`)
  let size: { width: number; height: number } | null = null
  const draw = async () => {
    const { scene } = await runCodec<{ scene: DrawingScene }>('decode', bytes, large)
    const { svg, width, height } = await renderSceneSvgYielding(scene)
    await replaceAtomically(svgPath, svg)
    size = { width, height }
  }
  if (await reuse(svgPath)) size = await svgSize(svgPath)
  if (!size) await draw()
  const { width, height } = size!
  const base = { path: rel, revision, width, height }
  try {
    if (format === 'svg') return { ...base, format: 'svg', svgPath, note: WHERE_NOTE }
    if (await reuse(pngPath)) return { ...base, format: 'png', pngPath, note: WHERE_NOTE }
    const { loadSharp } = await import('../../utils/image-compress.js')
    const sharp = await loadSharp()
    if (!sharp) return { ...base, format: 'svg', svgPath, note: `PNG rendering is not available on this machine (the image component is missing), so this is the SVG. ${WHERE_NOTE}` }
    const tmp = tempPathFor(pngPath)
    try {
      await sharp(await fsp.readFile(svgPath)).png().toFile(tmp)
      await fsp.rename(tmp, pngPath)
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      log.memory.warn('drawing PNG render failed', { path: rel, error: (err as Error).message })
      return { ...base, format: 'svg', svgPath, note: `PNG rendering failed (${(err as Error).message}), so this is the SVG. ${WHERE_NOTE}` }
    }
    return { ...base, format: 'png', pngPath, note: WHERE_NOTE }
  } finally {
    await prune(dir, key)
  }
}

/** For tests: run the idle sweep on the next render. */
export function _resetRenderSweep(): void {
  lastSweep = 0
}
