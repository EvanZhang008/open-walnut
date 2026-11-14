/**
 * Transfer packs do not pile up on a host (src/core/transfer/workspace.ts).
 * 2026-11-14: the Mac held 14.8 GB in its transfers folder: 293 source packs of
 * moves to another host (9.4 GB) kept a week after their verified copy, 48
 * start-placement folders (`xf-place-…`) the prune never matched, and the prune
 * ran only when a new transfer started.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const removePath = vi.fn(async () => {})
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class { constructor(public host: string) {} removePath = (...a: unknown[]) => removePath(this.host, ...a) },
}))
const relayFile = vi.fn(async () => {})
const reach = { reachable: false }
const fetchFromHost = vi.fn(async () => ({ ok: true, results: [] }))
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', () => ({
  relayFile: (...a: unknown[]) => relayFile(...a),
  reachHost: async () => (reach.reachable ? { reachable: true } : { reachable: false, error: 'no' }),
  fetchFromHost: (...a: unknown[]) => fetchFromHost(...a),
}))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: {} }) }))
vi.mock('../../../src/core/hosts/host-profile.js', () => ({
  readHostProfile: async () => null, recordReach: async () => {}, repoKey: () => 'k',
}))

const { TRANSFER_ENTRY, copyPack, dropSourcePack, pruneLocalTransfers, transfersDir } = await import('../../../src/core/transfer/workspace.js')

const DAY = 86_400_000
const SRC = path.resolve(__dirname, '../../../src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('every name Walnut gives a transfer folder is one the prune removes', () => {
  // One sample per literal prefix after `xf-` in a template id. A NEW prefix fails here
  // until it gets a sample, and the sample must match TRANSFER_ENTRY.
  const SAMPLES: Record<string, string> = {
    '': 'xf-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f',
    'place-': 'xf-place-mw72orri-mwd15xbg',
  }
  it('enumerates the prefixes from the source', () => {
    const found = new Set<string>()
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/`xf-([a-z-]*)\$\{/g)) found.add(m[1]!)
    }
    expect(found.size).toBeGreaterThan(0)
    for (const prefix of found) {
      expect(SAMPLES, `new transfer folder prefix "xf-${prefix}": add a sample and make TRANSFER_ENTRY match it`).toHaveProperty([prefix])
    }
    for (const sample of Object.values(SAMPLES)) expect(sample).toMatch(TRANSFER_ENTRY)
    // Old task ids (uuids) slice to hex, new ones to base36.
    expect('xf-place-e278220d-mwd15xbg').toMatch(TRANSFER_ENTRY)
    expect('notes').not.toMatch(TRANSFER_ENTRY)
    expect('es-6f1c2a9e').not.toMatch(TRANSFER_ENTRY)
  })
})

describe('pruneLocalTransfers', () => {
  const dir = transfersDir('__local__')
  const made: string[] = []
  function entry(name: string, ageDays: number, extra?: string): string {
    const p = path.join(dir, name)
    fs.mkdirSync(path.join(p, '0', 'pack'), { recursive: true })
    fs.writeFileSync(path.join(p, '0', 'pack', 'repo.bundle'), 'x')
    if (extra) fs.writeFileSync(path.join(p, extra), '')
    const t = new Date(Date.now() - ageDays * DAY)
    fs.utimesSync(p, t, t)
    made.push(p)
    return p
  }
  beforeEach(() => { expect(dir).not.toBe(path.join(process.env.HOME ?? '', '.open-walnut-transfers')) })
  afterEach(() => { for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true }) })

  it('removes week-old transfer and placement folders, keeps new ones, stages and other names', async () => {
    // Only this test's entries count: the folder may hold another test file's.
    const before = fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set<string>()
    const oldXf = entry('xf-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f', 8)
    const oldPlace = entry('xf-place-mw72orri-mwd15xbg', 8)
    const freshPlace = entry('xf-place-mw72orri-mwz00000', 1)
    const staged = entry('xf-0a0a0a0a-3b4d-4c5e-8f70-1a2b3c4d5e6f', 8, '.attempt')
    const other = entry('es-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f', 30)
    const removed = await pruneLocalTransfers()
    const stillThere = (n: string) => fs.existsSync(path.join(dir, n))
    expect(removed - [...before].filter((n) => !stillThere(n)).length).toBe(2)
    expect(fs.existsSync(oldXf)).toBe(false)
    expect(fs.existsSync(oldPlace)).toBe(false)
    expect(fs.existsSync(freshPlace)).toBe(true)
    expect(fs.existsSync(staged)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
  })
})

describe('dropSourcePack', () => {
  beforeEach(() => { removePath.mockClear(); relayFile.mockClear(); fetchFromHost.mockClear(); reach.reachable = false })

  it('removes the source copy only when it went to another host', async () => {
    const out = '/Users/u/.open-walnut-transfers/xf-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f/pack'
    expect(await dropSourcePack(out, { sourceHost: '__local__', targetHost: '__local__' })).toBe(false)
    expect(removePath).not.toHaveBeenCalled()
    expect(await dropSourcePack(out, { sourceHost: '__local__', targetHost: 'devbox' })).toBe(true)
    expect(removePath).toHaveBeenCalledWith('__local__', out, true, 60_000)
  })

  it('never removes a path that is not a pack folder of a transfer entry', async () => {
    for (const p of ['/Users/u/.open-walnut-transfers', '/Users/u/.open-walnut-transfers/xf-1', '/Users/u/work/app/pack', '/Users/u/.open-walnut-transfers/xf-1/0/pack/..']) {
      expect(await dropSourcePack(p, { sourceHost: '__local__', targetHost: 'devbox' })).toBe(false)
    }
    expect(await dropSourcePack('~/.open-walnut-transfers/xf-place-mw72orri-mwd15xbg/2/pack', { sourceHost: 'devbox', targetHost: '__local__' })).toBe(true)
    expect(await dropSourcePack('~/.open-walnut-transfers/xf-1/0/pack-again-2', { sourceHost: 'devbox', targetHost: '__local__' })).toBe(true)
    // The same folder under two names is the one the target applies.
    const same = '~/.open-walnut-transfers/xf-1/pack'
    expect(await dropSourcePack(same, { sourceHost: 'devbox', targetHost: 'devbox-alias', bundleDir: same })).toBe(false)
    expect(removePath).toHaveBeenCalledTimes(2)
  })

  it('copyPack drops the source copy after every file arrived, never after a failed copy', async () => {
    const pack = {
      outDir: '/Users/u/.open-walnut-transfers/xf-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f/pack',
      files: [{ name: 'repo.bundle', size: 1, sha256: 'a' }, { name: 'meta.json', size: 1, sha256: 'b' }],
      meta: { kind: 'git', root: '/w/app' },
    } as never
    const opts = { sourceHost: '__local__', targetHost: 'devbox', bundleDir: '~/.open-walnut-transfers/xf-6f1c2a9e-3b4d-4c5e-8f70-1a2b3c4d5e6f/pack', dropSource: true }
    relayFile.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('link dropped') })
    await expect(copyPack(pack, opts)).rejects.toThrow('link dropped')
    await new Promise((r) => setImmediate(r))
    expect(removePath).not.toHaveBeenCalled()
    await copyPack(pack, opts)
    await vi.waitFor(() => expect(removePath).toHaveBeenCalledWith('__local__', (pack as { outDir: string }).outDir, true, 60_000))
  })

  it('copyPack over the direct route drops the source copy too', async () => {
    reach.reachable = true
    const pack = { outDir: '~/.open-walnut-transfers/xf-1/pack', files: [{ name: 'meta.json', size: 1, sha256: 'b' }], meta: { kind: 'git', root: '/w/app' } } as never
    const moved = await copyPack(pack, { sourceHost: 'devbox', targetHost: '__local__', bundleDir: '/Users/u/.open-walnut-transfers/xf-1/pack', dropSource: true })
    expect(moved.route).toBe('direct')
    expect(relayFile).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(removePath).toHaveBeenCalledWith('devbox', '~/.open-walnut-transfers/xf-1/pack', true, 60_000))
  })

  it('a caller that reads the source pack again (a task move backs a shared checkout up from it) keeps it', async () => {
    const pack = { outDir: '/Users/u/.open-walnut-transfers/xf-1/0/pack', files: [{ name: 'changes.patch', size: 1, sha256: 'a' }], meta: { kind: 'git', root: '/w/app' } } as never
    await copyPack(pack, { sourceHost: '__local__', targetHost: 'devbox', bundleDir: '~/.open-walnut-transfers/xf-1/0/pack' })
    await new Promise((r) => setTimeout(r, 20))
    expect(removePath).not.toHaveBeenCalled()
    // task-work.ts (backupFrom) must never ask for the drop.
    const src = fs.readFileSync(path.join(SRC, 'core/transfer/task-work.ts'), 'utf8')
    expect(src).toContain('backupFrom: pack.outDir')
    expect(src).not.toMatch(/dropSource/)
  })
})
