/**
 * Guard: a browser spec that fakes the platform (navigator.platform) fakes userAgentData too.
 *
 * isMacPlatform (web/src/hooks/usePanelKeyRouter.ts) reads userAgentData.platform first, and
 * Chromium has it, naming the runner's own system. A spec that fakes only navigator.platform
 * runs as a Mac in WebKit and as Linux in Chromium (2026-11-10: keyboard-triage.spec.ts passed
 * on WebKit and failed 17 tests on GitHub's Chromium job).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '../e2e/browser')

describe('platform stubs in browser specs', () => {
  it('every spec that fakes navigator.platform also fakes userAgentData', () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const src = readFileSync(join(DIR, f), 'utf8')
        return /defineProperty\(\s*Navigator\.prototype\s*,\s*['"]platform['"]/.test(src)
          && !/defineProperty\(\s*Navigator\.prototype\s*,\s*['"]userAgentData['"]/.test(src)
      })
    expect(offenders, 'fake userAgentData.platform beside navigator.platform (Chromium reads it first)').toEqual([])
  })
})
