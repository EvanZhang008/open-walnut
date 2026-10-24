/**
 * The audio-capture probe children (src/core/audio-capture.ts, and the
 * component selftest) run `<execPath> -e <script>`. A walnut file runs `-e`
 * only as bun, so they get BUN_BE_BUN=1 by the same rule as every other `-e`
 * child (bunCommand, src/lib/runtime.ts): decided from the executable. The old
 * rule asked isCompiledBinary(), which is false for a walnut file running a
 * dist build as bun, so that probe started the walnut CLI instead of the script.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-audio-probe-env'))

import { addonProbeEnv } from '../../src/core/audio-capture.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('the audio-capture probe env', () => {
  it('tells a walnut executable to be bun, and nothing to a bun binary', () => {
    const env = { OPEN_WALNUT_HOME: '/home/alice/.open-walnut' }
    // A walnut file running a dist build as bun: not the compiled file's own code, still a walnut executable.
    expect(addonProbeEnv(env, '/home/alice/.local/bin/walnut')).toEqual({ ...env, BUN_BE_BUN: '1' })
    expect(addonProbeEnv(env, '/home/alice/.bun/bin/bun')).toEqual(env)
    // A bun binary never hands the variable on to a walnut file it starts.
    expect(addonProbeEnv({ ...env, BUN_BE_BUN: '1' }, '/usr/local/bin/bun')).toEqual(env)
    // The caller's env is copied, never changed.
    expect(env).toEqual({ OPEN_WALNUT_HOME: '/home/alice/.open-walnut' })
  })

  it('is what every probe child spawns with', () => {
    for (const file of ['src/core/audio-capture.ts', 'src/core/components/selftest.ts']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      const spawns = text.match(/spawn\(process\.execPath, \['-e'[\s\S]*?\}\)/g) ?? []
      expect(spawns.length, file).toBeGreaterThan(0)
      for (const call of spawns) expect(call, file).toContain('env: addonProbeEnv()')
    }
    expect(fs.readFileSync(path.join(ROOT, 'src/core/audio-capture.ts'), 'utf8')).not.toMatch(/isCompiledBinary/)
  })
})
