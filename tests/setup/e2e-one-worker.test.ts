/**
 * The e2e files share one test home and its instance lock (tests/setup/global-setup.ts),
 * so they run one at a time whatever the environment says: with CI=1 in a dev container
 * the e2e config took 4 workers and two files refused each other with InstanceLockError.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { namesE2eFiles, E2E_MAX_WORKERS } from './worker-budget'

const prevCi = process.env.CI

afterEach(() => {
  if (prevCi === undefined) delete process.env.CI
  else process.env.CI = prevCi
})

describe('e2e files run one at a time', () => {
  it('the e2e config takes one worker under CI=1', async () => {
    process.env.CI = '1'
    vi.resetModules()
    // The case is CI=1 in a Linux dev container. On a Mac, CI=1 is a brake the config
    // refuses at import (tests/setup/mac-brakes.ts, covered by mac-brakes.test.ts), so
    // this inspection alone reads the brakes as that Linux box would; the real checker
    // still runs, and this test's own run is checked as usual.
    vi.doMock('./mac-brakes.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('./mac-brakes.js')>()
      return { ...real, assertMacBrakes: () => real.assertMacBrakes({ platform: 'linux', env: process.env, argv: process.argv }) }
    })
    try {
      const { default: config } = await import('../../vitest.e2e.config.ts')
      expect(config.test?.maxWorkers).toBe(E2E_MAX_WORKERS)
      expect(E2E_MAX_WORKERS).toBe(1)
    } finally {
      vi.doUnmock('./mac-brakes.js')
      vi.resetModules()
    }
  })

  it('a focus run is one worker exactly when it names an e2e file', () => {
    expect(namesE2eFiles(['bun', 'vitest', 'run', 'tests/e2e/test-run-objects.test.ts'])).toBe(true)
    expect(namesE2eFiles(['run', '/w/repo/tests/e2e/x.test.ts'])).toBe(true)
    expect(namesE2eFiles(['run', 'tests/e2e'])).toBe(true)
    expect(namesE2eFiles(['run', 'tests/core/history-tail-window.test.ts'])).toBe(false)
    expect(namesE2eFiles(['run', 'tests/e2e-helpers/x.test.ts'])).toBe(false)
  })
})
