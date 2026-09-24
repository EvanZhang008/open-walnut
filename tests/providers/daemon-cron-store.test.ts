import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronSupervisionStore } from '../../src/providers/daemon-cron-store.js'
import { createCronSupervision, disableCronSupervision } from '../../src/providers/daemon-cron-supervision.js'

const sid = '11111111-2222-4333-8444-555555555555'
const launch = { cwd: '/workspace/demo', args: ['claude', '-p'], mode: 'default', cliVersion: '2.1.258' }
let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cron-store-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('cron supervision durable store', () => {
  it('requires initialization and preserves user stop through reload', async () => {
    const store = new CronSupervisionStore(directory)
    expect(() => store.get(sid)).toThrow('not loaded')
    await store.load()
    await store.update(sid, () => createCronSupervision(sid, launch, 10))
    await store.update(sid, (current) => disableCronSupervision(current!, 20))
    const restarted = new CronSupervisionStore(directory)
    await restarted.load()
    expect(restarted.get(sid)).toMatchObject({ enabled: false, state: 'disabled', generation: 2 })
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(directory, `${sid}.json`))).mode & 0o777).toBe(0o600)
  })

  it('serializes same-session writes and does not leak mutable references', async () => {
    const store = new CronSupervisionStore(directory)
    await store.load()
    await store.update(sid, () => createCronSupervision(sid, launch, 10))
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.update(sid, (current) => ({
      ...current!, generation: current!.generation + 1, updatedAt: 20 + i,
    }))))
    expect(store.get(sid)?.generation).toBe(26)
    const copy = store.get(sid)!
    copy.launch!.args.push('--wrong')
    expect(store.get(sid)?.launch?.args).not.toContain('--wrong')
    const restarted = new CronSupervisionStore(directory)
    await restarted.load()
    expect(restarted.get(sid)?.generation).toBe(26)
  })

  it('does not treat a corrupt or future record as an empty store', async () => {
    await fs.writeFile(path.join(directory, `${sid}.json`), '{"version":2,"record":{}}', { mode: 0o600 })
    const store = new CronSupervisionStore(directory)
    await expect(store.load()).rejects.toThrow('Invalid cron supervision record')
    expect(() => store.list()).toThrow('not loaded')
  })

  it('ignores incomplete temporary files without losing a committed stop', async () => {
    const store = new CronSupervisionStore(directory)
    await store.load()
    await store.update(sid, () => disableCronSupervision(createCronSupervision(sid, launch, 10), 20))
    await fs.writeFile(path.join(directory, `${sid}.json.incomplete.tmp`), '{"version":1')
    const restarted = new CronSupervisionStore(directory)
    await restarted.load()
    expect(restarted.get(sid)?.enabled).toBe(false)
  })

  it('refuses further work after a persistence failure until explicitly reloaded', async () => {
    const store = new CronSupervisionStore(directory)
    await store.load()
    await store.update(sid, () => createCronSupervision(sid, launch, 10))
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }))
    await expect(store.update(sid, (current) => disableCronSupervision(current!, 20))).rejects.toThrow('disk failure')
    expect(() => store.get(sid)).toThrow('not loaded')
    await expect(store.update(sid, (current) => current)).rejects.toThrow('not loaded')
  })

  it('rejects linked records and non-private directories without repairing foreign permissions', async () => {
    const target = path.join(directory, 'other.json')
    await fs.writeFile(target, JSON.stringify({ version: 1, record: createCronSupervision(sid, launch, 10) }), { mode: 0o600 })
    await fs.symlink(target, path.join(directory, `${sid}.json`))
    await expect(new CronSupervisionStore(directory).load()).rejects.toThrow('not private')
    await fs.chmod(directory, 0o755)
    await expect(new CronSupervisionStore(directory).load()).rejects.toThrow('not private')
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o755)
  })

  it('does not reload while an atomic write is in flight', async () => {
    const store = new CronSupervisionStore(directory)
    await store.load()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => { entered(); await wait; await rename(from, to) })
    const write = store.update(sid, () => createCronSupervision(sid, launch, 10))
    await started
    await expect(store.load()).rejects.toThrow('writes are still pending')
    release()
    await write
    expect(store.get(sid)?.generation).toBe(1)
  })

  it('rejects path traversal before any record write', async () => {
    const store = new CronSupervisionStore(directory)
    await store.load()
    await expect(store.update('../escape', () => createCronSupervision(sid, launch, 10))).rejects.toThrow('Invalid session id')
    expect(await fs.readdir(directory)).toEqual([])
  })
})
