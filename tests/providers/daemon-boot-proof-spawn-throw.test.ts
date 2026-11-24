/**
 * macOS drill M1: Bun on macOS throws from spawn() itself for a daemon file that cannot be exec'd
 * (EBADEXEC: a build cut short), where Node emits 'error'. The trial's spawn sat in a try/finally with
 * no catch, so the throw left the trial and the update answered a raw
 * `hostError: EBADEXEC: unknown error, posix_spawn '...'` instead of the boot proof's verdict (nothing
 * was changed either way). The trial gives the same verdict as a spawn that fails with 'error'.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  spawn: (file: string) => {
    throw Object.assign(new Error(`EBADEXEC: unknown error, posix_spawn '${file}'`), { code: 'EBADEXEC' })
  },
}))

import { proveDaemonBoot } from '../../src/providers/daemon-boot-proof.js'

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-proof-throw-')))
afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

describe('the trial of a file spawn() throws on', () => {
  it('answers the verdict "could not be started", and leaves no proof dir', async () => {
    const exe = path.join(work, 'versions', 'cut-short', 'daemon')
    const why = await proveDaemonBoot({ executable: exe, args: ['--service'], path: '/usr/bin:/bin', base: work, waitMs: 1_000, aliveMs: 100 })
    expect(why).toBe(`it could not be started (EBADEXEC: unknown error, posix_spawn '${exe}') before it listened`)
    expect(fs.readdirSync(work).filter((name) => name.startsWith('walnut-proof-'))).toEqual([])
  })
})
