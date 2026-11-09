/**
 * Every test browser is silent on the machine it runs on (2026-11-08: a WebKit run on a
 * Mac with a person at it woke its built-in speaker at every page's first click).
 *
 * Every browser context the runner makes gets the page silencer
 * (src/lib/automation-silence.ts) as an init script, which Playwright runs at
 * document start in every page and every frame: a plugin's page, a dev server in the
 * Web view, an HTML file preview and a sandboxed frame included, before their own
 * scripts, in every engine (WebKit has no mute switch of its own). It hooks the same
 * client instrumentation the runner uses for its traces, once per process; every
 * Playwright config imports this file (tests/web/automation-silence.test.ts checks), and
 * tests/e2e/browser/automation-silence.spec.ts fails if the hook stops working.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { AUTOMATION_SILENCE_JS } from '../../../src/lib/automation-silence.js'
import { guardWebkitPasteboard } from './pw-pasteboard.js'

interface ContextLike { addInitScript(script: { content: string }): Promise<void> }
interface Instrumentation { addListener(listener: { runAfterCreateBrowserContext?: (c: ContextLike) => Promise<void> }): void }

/** No sound from Chromium itself either, headed or not. */
export const CHROMIUM_SILENT = ['--mute-audio']

/**
 * The launch args an engine gets: WebKit and Firefox refuse to start on Chromium's own
 * switches (2026-11-08: every spec that switches to WebKit inside a Chromium project, the
 * *.webkit.spec.ts files, inherited --mute-audio and failed at launch, 113 tests in CI).
 */
export function engineArgs(engine: string, args: readonly string[] | undefined): string[] | undefined {
  if (!args) return undefined
  return engine === 'chromium' ? [...args] : args.filter((a) => !CHROMIUM_SILENT.includes(a))
}

interface Launcher { launch(options?: { args?: string[] }): Promise<unknown> }

const FLAG = Symbol.for('walnut.pwSilence')
const g = globalThis as { [FLAG]?: boolean }
if (!g[FLAG]) {
  g[FLAG] = true
  try {
    const core = createRequire(import.meta.url)('playwright-core') as { _instrumentation?: Instrumentation }
    core._instrumentation?.addListener({
      runAfterCreateBrowserContext: async (context) => { await context.addInitScript({ content: AUTOMATION_SILENCE_JS }) },
    })
    // The runner hands every engine the project's launch options (the browser fixture's
    // defaults), so another engine's launch drops the Chromium switches first.
    const lib = core as unknown as Record<string, Launcher | undefined> & { _defaultLaunchOptions?: { args?: string[] } }
    for (const engine of ['webkit', 'firefox']) {
      const type = lib[engine]
      if (!type?.launch) continue
      const launch = type.launch.bind(type)
      type.launch = (options = {}) => launch({ ...options, args: engineArgs(engine, options.args ?? lib._defaultLaunchOptions?.args) })
    }
  } catch (e) {
    console.warn(`[pw-silence] could not silence test browsers: ${(e as Error).message}`)
  }
  // Nor does a WebKit test browser on a Mac ever write the person's clipboard (pw-pasteboard.ts).
  // Outside the try above: when it cannot be put in place, the run stops instead of going on.
  const core = createRequire(import.meta.url)('playwright-core') as Record<string, unknown> & { _defaultLaunchOptions?: { env?: Record<string, string>; executablePath?: string } }
  guardWebkitPasteboard(core.webkit as Parameters<typeof guardWebkitPasteboard>[0], process.platform, undefined, () => core._defaultLaunchOptions)
}

// On a Mac, no WebKit test browser ever becomes the frontmost app (src/providers/pw-noactivate-core.ts).
// Outside the flag: a runner's older preload may have silenced the pages already, and only this
// branch's copy knows the runner. It wraps each library once.
try {
  const req = createRequire(import.meta.url)
  ;(req('./pw-silence-preload.cjs') as { quietWebkit(root: string): boolean }).quietWebkit(path.dirname(req.resolve('playwright-core')))
} catch (e) {
  console.warn(`[pw-silence] a WebKit test browser may come to the front: ${(e as Error).message}`)
}
