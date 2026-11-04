/**
 * Every deadline of a service change is monotonic (2026-11-04 review): on a Mac, timers stop
 * during sleep while Date.now() jumps ahead on wake, so a wall-clock deadline met in the middle
 * of a confirm or a trial read as "no answer in time" and rolled a healthy daemon back.
 *
 * MACHINE SAFETY: the runtime dir is this file's temp dir; nothing is started or signalled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { daemonReady } from '../../src/providers/daemon-service-cli.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-monotonic-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const SOURCES = [
  'daemon-boot-proof.ts', 'daemon-service-cli.ts', 'daemon-service-launchd.ts', 'daemon-service-manager.ts',
  'daemon-service-handback.ts', 'daemon-service-cron-host.ts', 'daemon-service-systemd.ts', 'daemon-service-cron.ts', 'daemon-service-ready.ts',
]
/** Wall-clock reads that are no deadline: a file's age (mtimes are wall clock), a timestamp written down. */
const WALL_CLOCK_OK = [
  /export async function sweepProofDirs\(base: string, now = Date\.now\(\)\)/,
  /`v=uninstall at=\$\{Date\.now\(\)\} result=removed\\n`/,
]

describe('service change deadlines', () => {
  it('daemonReady waits its whole time when the wall clock jumps an hour ahead (a sleep and a wake)', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'rt-'))
    const real = Date.now
    let reads = 0
    const jump = vi.spyOn(Date, 'now').mockImplementation(() => real() + (++reads > 1 ? 60 * 60_000 : 0))
    try {
      const started = performance.now()
      await expect(daemonReady(dir, undefined, 1_200)).resolves.toBe(false)
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_100)
    } finally { jump.mockRestore() }
  })

  it.each(SOURCES)('%s reads no wall clock for a deadline', (file) => {
    const text = fs.readFileSync(path.join(__dirname, '../../src/providers', file), 'utf8')
    const reads = text.split('\n').filter((line) => /Date\.now\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !WALL_CLOCK_OK.some((ok) => ok.test(line)))
    expect(reads).toEqual([])
  })
})
