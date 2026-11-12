/**
 * Test videos are sharp: every Playwright config imports this file.
 *
 * Playwright's own default is what made proof clips unreadable (2026-11-12: 800x450 at
 * 61 kbit/s): with no `recordVideo.size` it scales the viewport down until its long side is
 * 800 px (playwright-core lib/server/browserContext.js), and its screencast then asks the
 * engine for frames no bigger than that. Hence:
 *
 * - In every run, a context that records gets a video the size of the frames its engine
 *   sends, unless its caller gave a size: WebKit's screencast sends device pixels, so a
 *   1280x720 Desktop Safari page (2x) records 2560x1440; Chromium's headless screencast sends
 *   CSS pixels whatever the deviceScaleFactor (measured 2026-11-12: 1280x720 frames at 2x, so a
 *   2x video was padded gray), so a Chromium page records its viewport. The scale is at most
 *   2 and the long side at most 2560 px. It never changes a context's deviceScaleFactor: what
 *   test.use and the project say is what renders. A spec gives no size of its own
 *   (tests/setup/proof-video.test.ts).
 * - In a PW_VIDEO run (proof videos: walnut-dev webkit --video, or PW_VIDEO=1):
 *   - every context draws the pointer (pointer-overlay.ts; PW_POINTER=0 leaves it out).
 *   - the reporter (pw-video-reporter.ts) encodes each video .webm of the run's output to an
 *     .mp4 beside it (H.264, CRF 18; scripts/proof-video.mjs), when ffmpeg is on PATH.
 *
 * The size is set where Playwright's server makes the context (its Browser.newContext, in this
 * process): only there are the engine and the options test.use and the project merged in both
 * known. The pointer rides the client instrumentation the runner uses itself.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { POINTER_OVERLAY_JS } from './pointer-overlay.js'

type Size = { width: number; height: number }
/** A context's options as Playwright's server gets them (after the client merged them). */
export interface ContextOptionsLike {
  recordVideo?: { dir: string; size?: Size }
  viewport?: Size
  noDefaultViewport?: boolean
  deviceScaleFactor?: number
}

export const RECORDING = !!process.env.PW_VIDEO

/** The `use.video` of a config: on in a PW_VIDEO run, sized per context below. */
export const VIDEO_USE = RECORDING ? ('on' as const) : ('off' as const)

/** Playwright's own viewport when a context has none (playwright-core browserContext.js). */
const DEFAULT_VIEWPORT: Size = { width: 1280, height: 720 }
const MAX_SCALE = 2
export const MAX_LONG_SIDE = 2560
/** The engines whose screencast frames are device pixels. */
const DEVICE_PIXEL_FRAMES = new Set(['webkit'])

/**
 * The video size of a context in `engine`: its viewport in the pixels of the engine's frames
 * (scale at most 2, long side at most 2560), even (yuv420p needs it). Undefined for a context
 * with no viewport, which keeps Playwright's own default.
 */
export function videoSize(engine: string, options: ContextOptionsLike): Size | undefined {
  if (options.noDefaultViewport) return undefined
  const vp = options.viewport ?? DEFAULT_VIEWPORT
  let scale = DEVICE_PIXEL_FRAMES.has(engine) ? Math.min(Math.max(options.deviceScaleFactor ?? 1, 1), MAX_SCALE) : 1
  scale = Math.min(scale, MAX_LONG_SIDE / Math.max(vp.width, vp.height))
  return { width: Math.round(vp.width * scale) & ~1, height: Math.round(vp.height * scale) & ~1 }
}

/** Give a recording context with no size of its own the size of its frames. */
export function fitVideo(engine: string, options: ContextOptionsLike): void {
  const rec = options.recordVideo
  if (!rec || rec.size) return
  const size = videoSize(engine, options)
  if (size) options.recordVideo = { ...rec, size }
}

/** The reporters of a config: its own, plus the MP4 encode in a PW_VIDEO run. */
export const REPORTER_FILE = path.join(import.meta.dirname, 'pw-video-reporter.ts')
export function withVideoReporter(base: 'list' | 'line' | 'dot' = 'list'): 'list' | 'line' | 'dot' | [string][] {
  return RECORDING ? [[base], [REPORTER_FILE]] : base
}

interface ContextLike { addInitScript(script: { content: string }): Promise<unknown> }
interface Instrumentation {
  addListener(listener: { runAfterCreateBrowserContext?: (c: ContextLike) => Promise<void> }): void
}

const FLAG = Symbol.for('walnut.pwVideo')
export const SIZED = Symbol.for('walnut.pwVideo.sized')
interface ServerBrowser { options: { name: string }; newContext(progress: unknown, options: ContextOptionsLike): Promise<unknown> }

/** Wrap Playwright's server Browser.newContext once; false when this Playwright has none. */
export function sizeServerContexts(proto: Record<string | symbol, unknown> | undefined): boolean {
  if (!proto || typeof proto.newContext !== 'function') return false
  if (proto[SIZED]) return true
  const newContext = proto.newContext as ServerBrowser['newContext']
  proto.newContext = function (this: ServerBrowser, progress: unknown, options: ContextOptionsLike) {
    try { if (options) fitVideo(this.options?.name ?? '', options) } catch { /* keep Playwright's size */ }
    return newContext.call(this, progress, options)
  }
  proto[SIZED] = true
  return true
}

const g = globalThis as { [FLAG]?: boolean }
if (!g[FLAG]) {
  g[FLAG] = true
  const req = createRequire(import.meta.url)
  try {
    const root = path.dirname(req.resolve('playwright-core/package.json'))
    const server = req(path.join(root, 'lib/server/browser.js')) as { Browser?: { prototype: Record<string | symbol, unknown> } }
    if (!sizeServerContexts(server.Browser?.prototype)) throw new Error('no Browser.newContext in lib/server/browser.js')
  } catch (e) {
    console.warn(`[pw-video] test videos keep Playwright's default size: ${(e as Error).message}`)
  }
  if (RECORDING && process.env.PW_POINTER !== '0') {
    try {
      const core = req('playwright-core') as { _instrumentation?: Instrumentation }
      core._instrumentation?.addListener({ runAfterCreateBrowserContext: async (context) => { await context.addInitScript({ content: POINTER_OVERLAY_JS }) } })
    } catch (e) {
      console.warn(`[pw-video] proof videos draw no pointer: ${(e as Error).message}`)
    }
  }
}
