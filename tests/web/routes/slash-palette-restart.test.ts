/**
 * The slash palette's host scans outlive a server restart (src/web/routes/slash-commands-disk.ts).
 *
 * 2026-11-25: the server restarts about 70 times a day (every land deploys), and each restart
 * emptied the palette's per-host caches, so the first palette of every remote session after a
 * deploy waited out its 1.5 s budget and often answered without the host's commands. Pinned:
 *  - after a restart (a new module instance reading the same file), the palette answers from
 *    the kept scan at once, without waiting for the host, and still revalidates it in the
 *    background when it is past its TTL;
 *  - the stream looks ride the same file;
 *  - a corrupt or other-version file is ignored: the palette scans as on a first boot.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-slash-restart'))

const looks = vi.hoisted(() => ({ forDisk: [] as unknown[], restored: [] as unknown[] }))
vi.mock('../../../src/core/sessions/cli-slash-commands-recover.js', () => ({
  recoverCliSlashCommandsFromStream: async () => null,
  streamLooksKept: {
    forDisk: () => looks.forDisk,
    restore: async (data: Promise<unknown>) => { looks.restored.push(await data) },
    onChange: () => {},
  },
}))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { box: { hostname: 'box.example.test' } } }),
}))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({}) }))
vi.mock('../../../src/core/hosts/remote-read-bound.js', () => ({
  boundHostRead: (_host: string, read: () => Promise<unknown>) => read(),
  hostReadFailureLevel: () => 'warn',
}))
const listRemoteSkills = vi.hoisted(() => ({ fn: (async () => []) as () => Promise<unknown[]>, calls: 0 }))
vi.mock('../../../src/core/remote-skill-loader.js', () => ({
  listRemoteSkills: () => { listRemoteSkills.calls++; return listRemoteSkills.fn() },
  listRemoteProjectCommands: async () => [{ name: 'ship', description: 'Ship the folder' }],
  listRemoteProjectSkills: async () => [],
}))

/** The kept file, the same for every boot (each module instance makes its own temp home). */
const KEPT_DIR = path.join(os.tmpdir(), `walnut-slash-restart-${process.pid}-${Math.random().toString(36).slice(2)}`)
const KEPT_FILE = path.join(KEPT_DIR, 'cache', 'slash-palette.json')

type Routes = typeof import('../../../src/web/routes/slash-commands.js')
type Disk = typeof import('../../../src/web/routes/slash-commands-disk.js')

/** A server process: fresh module instances (empty caches), the kept file read back. */
async function boot(): Promise<{ routes: Routes; disk: Disk }> {
  vi.resetModules()
  const routes = await import('../../../src/web/routes/slash-commands.js')
  const disk = await import('../../../src/web/routes/slash-commands-disk.js')
  await routes.startSlashPaletteDisk(KEPT_FILE)
  return { routes, disk }
}

const skill = (name: string) => ({ dirName: name, description: `${name} desc` })
const names = (items: Array<{ name: string }>) => items.map((i) => i.name)
let running: { routes: Routes; disk: Disk } | null = null

beforeEach(async () => {
  await fs.rm(KEPT_DIR, { recursive: true, force: true })
  listRemoteSkills.fn = async () => [skill('deploy'), skill('review')]
  listRemoteSkills.calls = 0
  looks.forDisk = [['sid-1', { path: '/s', epoch: 'e', fileSize: 10, scannedTo: 10, names: ['compact'] }]]
  looks.restored = []
})
afterEach(async () => {
  if (running) {
    await running.routes.settleRemoteSlashReadsForTest()
    running.routes.resetRemoteSlashCacheForTest()
    running.disk._stopPaletteDiskForTesting()
  }
  running = null
  vi.restoreAllMocks()
})
afterAll(async () => { await fs.rm(KEPT_DIR, { recursive: true, force: true }) })

describe('slash palette after a restart', () => {
  it('answers from the kept scan at once, without the host, and revalidates it in the background', async () => {
    running = await boot()
    const first = await running.routes.buildSlashCommandItems({ host: 'box', cwd: '/work' })
    expect(names(first.items)).toEqual(expect.arrayContaining(['deploy', 'review', 'ship']))
    expect(listRemoteSkills.calls).toBe(1)
    await running.disk.flushPaletteDisk()
    running.disk._stopPaletteDiskForTesting()

    // A minute later, a new process; the host now hangs (a cold link after a deploy).
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    let land!: (v: unknown[]) => void
    listRemoteSkills.fn = () => new Promise((r) => { land = r })
    running = await boot()
    const began = performance.now()
    const after = await running.routes.buildSlashCommandItems({ host: 'box', cwd: '/work' })
    const tookMs = performance.now() - began
    // Old code: nothing cached, so it waited the whole budget and answered degraded.
    expect(after.degraded).toBeUndefined()
    expect(names(after.items)).toEqual(expect.arrayContaining(['deploy', 'review', 'ship']))
    expect(tookMs).toBeLessThan(500)
    // The kept scan is past its TTL: one revalidation went to the host, in the background.
    expect(listRemoteSkills.calls).toBe(2)
    land([skill('deploy'), skill('fresh-skill')])
    await running.routes.settleRemoteSlashReadsForTest()
    const revalidated = await running.routes.buildSlashCommandItems({ host: 'box', cwd: '/work' })
    expect(names(revalidated.items)).toContain('fresh-skill')
    expect(names(revalidated.items)).not.toContain('review')

    // The stream looks rode the same file.
    expect(looks.restored.at(-1)).toEqual(looks.forDisk)
  })

  it('a scan still fresh after the restart answers without asking the host at all', async () => {
    running = await boot()
    await running.routes.buildSlashCommandItems({ host: 'box' })
    await running.disk.flushPaletteDisk()
    running.disk._stopPaletteDiskForTesting()
    running = await boot()
    const after = await running.routes.buildSlashCommandItems({ host: 'box' })
    expect(names(after.items)).toEqual(expect.arrayContaining(['deploy', 'review']))
    expect(listRemoteSkills.calls).toBe(1)
  })

  it('a scan kept more than a day ago is not taken back: the host is scanned as on a first boot', async () => {
    running = await boot()
    await running.routes.buildSlashCommandItems({ host: 'box' })
    await running.disk.flushPaletteDisk()
    running.disk._stopPaletteDiskForTesting()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    listRemoteSkills.fn = async () => [skill('today')]
    running = await boot()
    const after = await running.routes.buildSlashCommandItems({ host: 'box' })
    expect(names(after.items)).toContain('today')
    expect(names(after.items)).not.toContain('review')
    expect(listRemoteSkills.calls).toBe(2)
  })

  it('a corrupt or other-version file is ignored: the palette scans the host as on a first boot', async () => {
    const file = KEPT_FILE
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const body of ['{"v":1,"skills":[["box",', JSON.stringify({ v: 99, skills: [['box', Date.now(), [{ name: 'stale', description: '', source: 'skill' }]]] }),
      JSON.stringify({ v: 1, skills: [['box', Date.now(), [{ name: 42 }]], 'junk'], project: 'nope', streams: 7 })]) {
      await fs.writeFile(file, body)
      listRemoteSkills.calls = 0
      running = await boot()
      const out = await running.routes.buildSlashCommandItems({ host: 'box' })
      expect(names(out.items)).toEqual(expect.arrayContaining(['deploy', 'review']))
      expect(names(out.items)).not.toContain('stale')
      expect(listRemoteSkills.calls).toBe(1)
      await running.routes.settleRemoteSlashReadsForTest()
      running.disk._stopPaletteDiskForTesting()
    }
  })

  it('the write temps a crash left beside the file go at boot; a recent one (a write still running) stays', async () => {
    const { atomicTempName } = await import('../../../src/core/config-file-io.js')
    await fs.mkdir(path.dirname(KEPT_FILE), { recursive: true })
    const stale = atomicTempName(KEPT_FILE)
    const recent = atomicTempName(KEPT_FILE)
    const other = atomicTempName(path.join(path.dirname(KEPT_FILE), 'other.json'))
    for (const f of [stale, recent, other]) await fs.writeFile(f, '{"v":1,')
    const hourAgo = new Date(Date.now() - 3_600_000)
    for (const f of [stale, other]) await fs.utimes(f, hourAgo, hourAgo)
    running = await boot()
    await expect(fs.stat(stale)).rejects.toThrow()
    await expect(fs.stat(recent)).resolves.toBeTruthy()
    await expect(fs.stat(other)).resolves.toBeTruthy()
  })
})
