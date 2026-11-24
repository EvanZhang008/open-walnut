/**
 * Which `walnut` a session of a host's one Walnut service runs (the daemon runtime inside the follower
 * server, src/binary/service-entry.ts), on a box with an older released `walnut` first on PATH.
 *
 * Incident (2026-11-24): such a host runs no separate follower (no server spec kept, no follower
 * socket), so a rule that counted only those put the shim last, the session ran the older CLI, and it
 * answered 401 not_paired from the service's own root. Pinned on the real runtime, in one process
 * (tests/providers/fixtures/one-service-session-walnut.ts):
 *   - the follower service's own session, its settings naming the service's root: the shim first;
 *   - the Mac's leading service (`leads`), its own session naming its root: the installed CLI first.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'

const BUN = process.versions.bun ? process.execPath : null
const FIXTURE = path.resolve(__dirname, 'fixtures/one-service-session-walnut.ts')
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

type Said = { ok: boolean; error: string | null; walnut: string | null; path: string | null; shim: string; oldWalnut: string }

function run(kind: 'follower' | 'leader'): Promise<Said> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osw-')))
  roots.push(root)
  const env = { ...process.env, PATH: guardedPath([], process.env.PATH ?? '/usr/bin:/bin') }
  return new Promise((resolve, reject) => {
    execFile(BUN!, [FIXTURE, root, kind], { env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const last = String(stdout).trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(last) as Said) } catch { reject(new Error(`${error?.message ?? ''}\n${String(stderr).slice(-3000)}\n${String(stdout).slice(-1500)}`)) }
    })
  })
}

describe.skipIf(!BUN)('a host\'s one Walnut service: its own session\'s bare `walnut`', () => {
  it('the follower service (no spec kept, no follower socket) runs the shim ahead of an older walnut', async () => {
    const s = await run('follower')
    expect(s.ok, s.error ?? '').toBe(true)
    expect(s.walnut).toBe(s.shim)
    expect(s.path?.split(':')[0]).toBe(path.dirname(s.shim))
  }, 120_000)

  it('the Mac\'s leading service keeps the installed CLI first for its own session', async () => {
    const s = await run('leader')
    expect(s.ok, s.error ?? '').toBe(true)
    expect(s.walnut).toBe(s.oldWalnut)
    expect(s.path?.split(':').at(-1)).toBe(path.dirname(s.shim))
  }, 120_000)
})
