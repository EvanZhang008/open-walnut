/**
 * Every test browser is silent on the machine it runs on (2026-11-08: a WebKit run on a
 * Mac with a person at it woke its built-in speaker at every page's first click).
 *
 * Every browser context the runner makes gets the page silencer
 * (web/src/utils/automation-silence.ts) as an init script, which Playwright runs at
 * document start in every page and every frame: a plugin's page, a dev server in the
 * Web view, an HTML file preview and a sandboxed frame included, before their own
 * scripts, in every engine (WebKit has no mute switch of its own). It hooks the same
 * client instrumentation the runner uses for its traces, once per process; every
 * Playwright config imports this file (tests/web/automation-silence.test.ts checks), and
 * tests/e2e/browser/automation-silence.spec.ts fails if the hook stops working.
 */
import { createRequire } from 'node:module'
import { AUTOMATION_SILENCE_JS } from '../../../web/src/utils/automation-silence.js'

interface ContextLike { addInitScript(script: { content: string }): Promise<void> }
interface Instrumentation { addListener(listener: { runAfterCreateBrowserContext?: (c: ContextLike) => Promise<void> }): void }

const FLAG = Symbol.for('walnut.pwSilence')
const g = globalThis as { [FLAG]?: boolean }
if (!g[FLAG]) {
  g[FLAG] = true
  try {
    const core = createRequire(import.meta.url)('playwright-core') as { _instrumentation?: Instrumentation }
    core._instrumentation?.addListener({
      runAfterCreateBrowserContext: async (context) => { await context.addInitScript({ content: AUTOMATION_SILENCE_JS }) },
    })
  } catch (e) {
    console.warn(`[pw-silence] could not silence test browsers: ${(e as Error).message}`)
  }
}

/** No sound from Chromium itself either, headed or not. */
export const CHROMIUM_SILENT = ['--mute-audio']
