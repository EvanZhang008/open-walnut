/**
 * linkPathsExist (src/web/routes/files.ts): which of a task's link files are still there. The
 * session header draws no link pill until this answers, so a slow host must not hold it: what the
 * host answered by the deadline counts, the rest stays unknown (shown, never hidden on a guess).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const stat = vi.fn<(path: string) => Promise<unknown>>()

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { slowbox: { hostname: 'slowbox.example' } } }),
}))
vi.mock('../../src/replica/self-host.js', () => ({
  hostEntryOf: (hosts: Record<string, unknown> | undefined, host: string) => hosts?.[host],
  selfHostConnection: () => null,
  isSelfHost: () => false,
}))
vi.mock('../../src/core/hosts/remote-read-bound.js', async (orig) => ({
  ...(await orig<object>()),
  boundHostRead: async (_host: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: (_cmd: string, args: { path: string }) => stat(args.path) }),
}))

const { linkPathsExist, linkPathsStat } = await import('../../src/web/routes/files.js')

describe('linkPathsExist', () => {
  it('answers a local path that is there, one that is gone, and leaves out one it may not read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-exists-'))
    const here = path.join(dir, 'here.md')
    await fs.writeFile(here, 'x')
    const gone = path.join(dir, 'gone.md')
    const out = await linkPathsExist([here, gone, `${dir}/../escape.md`], undefined)
    expect(out).toEqual({ [here]: true, [gone]: false })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('a slow host answers what it answered by the deadline; the rest stays unknown', async () => {
    stat.mockImplementation(async (p) => (p.endsWith('quick.md') ? { ok: true, exists: false } : new Promise(() => {})))
    const started = Date.now()
    const out = await linkPathsExist(['/srv/run/quick.md', '/srv/run/stuck.md'], 'slowbox')
    expect(Date.now() - started).toBeLessThan(4_500)
    expect(out).toEqual({ '/srv/run/quick.md': false })
  }, 10_000)

  it('answers the size of each file found, here and on a host; exists stays as it was', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-exists-'))
    const here = path.join(dir, 'report.pdf')
    await fs.writeFile(here, 'x'.repeat(1234))
    const gone = path.join(dir, 'gone.pdf')
    const folder = path.join(dir, 'sub')
    await fs.mkdir(folder)
    expect(await linkPathsStat([here, gone, folder], undefined)).toEqual({
      exists: { [here]: true, [gone]: false, [folder]: true },
      sizes: { [here]: 1234 },
    })
    expect(await linkPathsExist([here, gone, folder], undefined)).toEqual({ [here]: true, [gone]: false, [folder]: true })
    await fs.rm(dir, { recursive: true, force: true })

    stat.mockImplementation(async (p) => (p.endsWith('big.mov')
      ? { ok: true, exists: true, size: 5_000_000_000, mtimeMs: 1 }
      : { ok: true, exists: false }))
    expect(await linkPathsStat(['/srv/u/big.mov', '/srv/u/none.mov'], 'slowbox')).toEqual({
      exists: { '/srv/u/big.mov': true, '/srv/u/none.mov': false },
      sizes: { '/srv/u/big.mov': 5_000_000_000 },
    })
  })
})
