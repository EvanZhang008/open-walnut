/**
 * The data repo's boot order (src/web/data-repo-boot.ts): compaction recovery, then ensureRepo
 * once, then the boot pull. ensureRepo untracks machine-local files that are still tracked, so a
 * pull that started before it resolved could let a remote deletion of one reach the disk
 * (2026-07-25); since ensureRepo is async (2026-11-22) a pull that waited only for the recovery
 * could run first (A3b review finding 6).
 *
 * MACHINE SAFETY: no git runs: ensureRepo, the pull and the recovery are stand-ins.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootPull, dataRepoReady, type RepoState } from '../../src/web/data-repo-boot.js'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const settle = () => new Promise<void>((r) => setImmediate(r))

describe('the data repo at boot', () => {
  it('a pull never starts before ensureRepo resolved, and ensureRepo never before the recovery', async () => {
    const steps: string[] = []
    const recovered = deferred<void>()
    const ensured = deferred<RepoState>()
    const ready = dataRepoReady(recovered.promise, () => { steps.push('ensureRepo'); return ensured.promise })
      .then((repo) => repo.available)
    const pulled = bootPull(ready, async () => { steps.push('after') }, async () => { steps.push('pull') })
    await settle()
    expect(steps).toEqual([])
    recovered.resolve()
    await settle()
    expect(steps).toEqual(['ensureRepo'])
    ensured.resolve({ available: true })
    expect(await pulled).toBe(true)
    expect(steps).toEqual(['ensureRepo', 'pull', 'after'])
  })

  it('no pull when the repo is not there or ensureRepo failed', async () => {
    let pulls = 0
    const pull = async () => { pulls++ }
    const missing = dataRepoReady(Promise.resolve(), async () => ({ available: false, error: 'git not found in PATH' }))
    expect(await missing).toEqual({ available: false, error: 'git not found in PATH' })
    expect(await bootPull(missing.then((r) => r.available), async () => {}, pull)).toBe(false)
    const threw = dataRepoReady(Promise.resolve(), async () => { throw new Error('boom') })
    expect(await threw).toEqual({ available: false, error: 'boom' })
    expect(await bootPull(threw.then((r) => r.available), async () => {}, pull)).toBe(false)
    expect(pulls).toBe(0)
  })

  it('the server\'s boot pull waits for the auto-commit loop\'s `ready`, which is this check', () => {
    // A source check: the wiring lives inside startServer, which a unit test cannot boot alone.
    const server = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/web/server.ts'), 'utf8')
    expect(server).toMatch(/const repoReady = gitAutoCommitHandle\?\.ready \?\? compactionRecovered\.then\(\(\) => true\)\s+void bootPull\(repoReady,/)
    expect(server).toMatch(/const ready = dataRepoReady\(recovered\)/)
    // No other boot pull of the data repo that skips the check.
    expect(server).not.toMatch(/compactionRecovered\s*\.then\(\(\) => gitPullWalnut\(\)\)/)
  })
})
