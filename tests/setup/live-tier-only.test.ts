/**
 * Live opt-ins count only in the live tier (tests/setup/live-tier-only.ts).
 *
 * What matters: a mock-tier worker never sees a variable that makes a test
 * reach something real, even when the developer's shell exports one (on the
 * maintainer's Mac WALNUT_LIVE_HOST is exported, so the first case below is a
 * real check there); every test that reads one is a `*.live.test.ts` file, so
 * the live tier can still run it; and the live config does not load the strip.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// Read BEFORE this file loads the module (a static import would be hoisted above
// this line and strip the env itself), so it proves the harness's setup files did.
const envAtStart = Object.keys(process.env)
const { LIVE_OPT_IN, stripLiveOptIns } = await import('./live-tier-only.js')

const REPO = path.resolve(import.meta.dirname, '..', '..')

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFiles(p))
    else if (entry.name.endsWith('.test.ts')) out.push(path.relative(REPO, p))
  }
  return out
}

describe('live opt-ins in a mock tier', () => {
  it('this worker has none, whatever the shell exported', () => {
    expect(envAtStart.filter((k) => LIVE_OPT_IN.test(k))).toEqual([])
  })

  it('removes exactly the live opt-ins', () => {
    const env: NodeJS.ProcessEnv = {
      WALNUT_LIVE_HOST: 'devbox', WALNUT_LIVE_SSH_HOST: 'devbox.example.com', WALNUT_LIVE_IMAP_HOST: 'imap.example.com',
      LIVE: '1', WALNUT_TEST_REAL_CLAUDE: '1',
      WALNUT_DAEMON_DIR: '/x', LIVENESS: 'keep', WALNUT_LIVE: 'keep-no-suffix', PATH: '/usr/bin',
    }
    expect(stripLiveOptIns(env)).toEqual(['LIVE', 'WALNUT_LIVE_HOST', 'WALNUT_LIVE_IMAP_HOST', 'WALNUT_LIVE_SSH_HOST', 'WALNUT_TEST_REAL_CLAUDE'])
    expect(env).toEqual({ WALNUT_DAEMON_DIR: '/x', LIVENESS: 'keep', WALNUT_LIVE: 'keep-no-suffix', PATH: '/usr/bin' })
  })
})

describe('the tier boundary', () => {
  it('every test that reads a live opt-in is a live-tier file', () => {
    const reads = new RegExp(String.raw`process\.env(\.|\[['"])(WALNUT_LIVE_\w+|LIVE\b|WALNUT_TEST_REAL_CLAUDE)|\bisLiveTest\(`)
    const self = path.relative(REPO, import.meta.filename)
    const offenders = testFiles(path.join(REPO, 'tests'))
      .filter((f) => f !== self && !f.endsWith('.live.test.ts'))
      .filter((f) => reads.test(fs.readFileSync(path.join(REPO, f), 'utf8')))
    expect(offenders, 'rename these to *.live.test.ts so only vitest.live.config.ts runs them').toEqual([])
  })

  it('the mock tiers strip opt-ins before anything else, and the live tier does not', () => {
    const isolation = fs.readFileSync(path.join(REPO, 'tests/setup/runtime-dir-isolation.ts'), 'utf8')
    const firstImport = isolation.match(/^import .*$/m)?.[0]
    expect(firstImport).toBe("import './live-tier-only.js'")
    const live = fs.readFileSync(path.join(REPO, 'vitest.live.config.ts'), 'utf8')
    expect(live).not.toContain('runtime-dir-isolation')
    expect(live).not.toContain('live-tier-only')
    expect(live).toMatch(/include:\s*\['tests\/\*\*\/\*\.live\.test\.ts'\]/)
  })
})
