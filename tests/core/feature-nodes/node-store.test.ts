import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeatureNodeStore } from '../../../src/core/feature-nodes/node-store.js'

const input = { nodeId: 'node-a', accountId: 'account-a', grants: [
  { capability: { id: 'catalog.page', version: 1 }, fingerprint: 'catalog-v1' },
] }
let home: string
let file: string
let store: FeatureNodeStore
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-feature-store-'))
  file = path.join(home, 'credentials.json')
  store = new FeatureNodeStore(file)
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }) })

describe('dedicated feature node credential store', () => {
  it('provisions an isolated readonly identity and never stores the plaintext token', async () => {
    const created = await store.provision(input)
    expect(created.token).toMatch(/^fn\.[a-f0-9]{64}$/)
    expect(created.authority).toEqual({ ...input, permissionVersion: 1 })
    expect(await store.verify(created.token)).toEqual(created.authority)
    expect(await store.lookup('node-a', 'account-a')).toEqual(created.authority)
    expect(await store.lookup('node-a', 'account-b')).toBeUndefined()
    expect(await store.verify('synthetic-machine-token')).toBeUndefined()
    const bytes = await fs.readFile(file, 'utf8')
    expect(bytes).not.toContain(created.token)
    expect(bytes).not.toContain('synthetic-machine-token')
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(Object.isFrozen(created.authority.grants[0].capability)).toBe(true)
  })

  it('loads persisted grants after restart without caller-mutated input', async () => {
    const spec = structuredClone(input)
    const created = await store.provision(spec)
    spec.grants[0].fingerprint = 'changed'
    expect(await new FeatureNodeStore(file).verify(created.token)).toEqual(created.authority)
  })

  it('rotates independently and old tokens stop working after a rebuild', async () => {
    const first = await store.provision(input)
    const second = await new FeatureNodeStore(file).rotate('node-a')
    expect(second.authority.permissionVersion).toBe(2)
    expect(await store.verify(first.token)).toBeUndefined()
    expect(await store.verify(second.token)).toEqual(second.authority)
    await store.revoke('node-a')
    expect(await store.verify(second.token)).toBeUndefined()
    expect(await store.lookup('node-a', 'account-a')).toBeUndefined()
    await store.revoke('node-a')
    await expect(store.rotate('node-a')).rejects.toMatchObject({ code: 'denied' })
    await expect(store.provision(input)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('serializes concurrent provisions without overwriting the winning identity', async () => {
    const results = await Promise.allSettled([store.provision(input), new FeatureNodeStore(file).provision(input)])
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((one) => one.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(record.nodes).toHaveLength(1)
  })

  it('has no automatic enrollment, and rejects peer-supplied permissions and unsupported grants', async () => {
    expect(await store.verify(`fn.${'1'.repeat(64)}`)).toBeUndefined()
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const forged of [
      { ...input, confirmed: true },
      { ...input, permissionVersion: 1 },
      { ...input, grants: [] },
      { ...input, grants: [...input.grants, ...input.grants] },
      { ...input, grants: [{ ...input.grants[0], readonly: true }] },
      { ...input, nodeId: '../node' },
    ]) await expect(store.provision(forged)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on corrupt or unknown files without rewriting or recovering them', async () => {
    for (const data of ['{', JSON.stringify({ version: 2, nodes: [] }), JSON.stringify({ version: 1, nodes: [], extra: true })]) {
      await fs.writeFile(file, data, { mode: 0o600 })
      await expect(store.verify(`fn.${'1'.repeat(64)}`)).rejects.toMatchObject({ code: 'unavailable' })
      await expect(store.provision(input)).rejects.toMatchObject({ code: 'unavailable' })
      expect(await fs.readFile(file, 'utf8')).toBe(data)
    }
  })

  it('rejects oversized or shared-readable files and symbolic links', async () => {
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 })
    await expect(store.verify(`fn.${'1'.repeat(64)}`)).rejects.toMatchObject({ code: 'unavailable' })
    await fs.writeFile(file, JSON.stringify({ version: 1, nodes: [] }))
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o644)
      await expect(store.provision(input)).rejects.toMatchObject({ code: 'unavailable' })
    }
    const target = path.join(home, 'link.json')
    await fs.symlink(file, target)
    await expect(new FeatureNodeStore(target).verify(`fn.${'1'.repeat(64)}`)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects accessor input without invoking getters or returning their exception', async () => {
    let invoked = false
    const forged = Object.defineProperty({ ...input }, 'nodeId', { enumerable: true, get: () => {
      invoked = true; throw new Error('Private detail must not be exposed')
    } })
    await expect(store.provision(forged)).rejects.toMatchObject({ code: 'invalid_input', message: 'invalid_input' })
    expect(invoked).toBe(false)
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects nonregular files before attempting an open', async () => {
    const metadata = await fs.stat(home)
    vi.spyOn(fs, 'lstat').mockResolvedValue(metadata as never)
    const open = vi.spyOn(fs, 'open')
    await expect(store.verify(`fn.${'1'.repeat(64)}`)).rejects.toMatchObject({ code: 'unavailable' })
    expect(open).not.toHaveBeenCalled()
  })

  it('does not report a persisted credential when directory synchronization fails', async () => {
    const first = await store.provision(input)
    const original = await fs.readFile(file, 'utf8')
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === home) {
        handle.sync = async () => { throw new Error('Private storage detail must not be exposed') }
      }
      return handle
    })
    await expect(store.revoke('node-a')).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await store.verify(first.token)).toEqual(first.authority)
    expect((await fs.readdir(home)).filter((name) => name.endsWith('.pending'))).toHaveLength(0)
  })

  it('requires an existing local directory instead of reporting a new directory as durable', async () => {
    const child = path.join(home, 'absent', 'credentials.json')
    await expect(new FeatureNodeStore(child).provision(input)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(fs.stat(path.dirname(child))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports failure after rename when final directory synchronization fails', async () => {
    const first = await store.provision(input)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === home) {
        const sync = handle.sync.bind(handle)
        let calls = 0
        handle.sync = async () => {
          if (++calls === 2) throw new Error('Private storage detail must not be exposed')
          await sync()
        }
      }
      return handle
    })
    await expect(store.revoke('node-a')).rejects.toMatchObject({ code: 'unavailable' })
    expect(await store.verify(first.token)).toBeUndefined()
    expect((await fs.readdir(home)).filter((name) => name.endsWith('.pending'))).toHaveLength(0)
  })

  it('bounds retained identities and never recycles a revoked node id', async () => {
    for (let index = 0; index < 32; index++) await store.provision({ ...input, nodeId: `node-${index}` })
    await store.revoke('node-0')
    await expect(store.provision({ ...input, nodeId: 'node-extra' })).rejects.toMatchObject({ code: 'busy' })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).nodes).toHaveLength(32)
  })
})
