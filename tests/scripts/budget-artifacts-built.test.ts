/**
 * The budget E2Es (tests/e2e/session-budget*.test.ts) check the artifacts BUDGET_ARTIFACTS names,
 * and build-daemon.sh writes their manifest. Every name must be a file build-daemon.sh still
 * writes: 080f465b9e stopped building usage-core.cjs and acp-daemon-core.cjs while the list still
 * named them, so on a clean checkout the manifest step failed and both E2Es read "no manifest".
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUDGET_ARTIFACTS, HOST_DAEMON_BINARY } from '../e2e/fixtures/budget-artifacts.js'

const build = fs.readFileSync(path.resolve(__dirname, '../../scripts/build-daemon.sh'), 'utf8')

describe('the budget E2E artifacts', () => {
  it('names only files build-daemon.sh writes into its output dir', () => {
    const notBuilt = BUDGET_ARTIFACTS
      .filter((name) => name !== HOST_DAEMON_BINARY)
      .filter((name) => !build.includes(`"$OUTDIR/${name}"`))
    expect(notBuilt).toEqual([])
  })

  it('names the daemon binary of this machine, which build-daemon.sh builds per platform', () => {
    expect(BUDGET_ARTIFACTS).toContain(HOST_DAEMON_BINARY)
    expect(build).toMatch(/daemon-\$\{?\w+/)
  })
})
