/**
 * fs.ls time budgets (fs-ls-core.ts, shared by both daemon twins). A symlink
 * into a hung mount used to hold the whole listing until the server gave up
 * and said "Could not connect". A fake fs whose stat never resolves stands in
 * for the hung mount; budgets are shortened so the suite stays fast, and one
 * case runs the real 1.5s / 6s defaults.
 */
import { describe, it, expect } from 'vitest'
import { createFsLs, type FsLsDirent, type FsLsStat } from '../../src/providers/fs-ls-core.js'

function dirent(name: string, kind: 'dir' | 'file' | 'link'): FsLsDirent {
  return { name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' }
}
const DIR_STAT: FsLsStat = { isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 1 }
const FILE_STAT: FsLsStat = { isDirectory: () => false, isFile: () => true, size: 42, mtimeMs: 7 }
const never = <T>(): Promise<T> => new Promise<T>(() => {})

interface FakeFs {
  entries: FsLsDirent[]
  /** full path → how stat answers ('hang' never resolves). */
  stats: Record<string, FsLsStat | 'hang' | 'enoent'>
  /** link path → its target (readlink). Stats are keyed by the LINK path either way. */
  links: Record<string, string>
  statCalls: string[]
  readdirHang?: boolean
  readdirCalls: number
  /** Most stats running at once. */
  maxConcurrent: number
}

function fakeFs(entries: FsLsDirent[], stats: FakeFs['stats'], links: FakeFs['links'] = {}): FakeFs {
  return { entries, stats, links, statCalls: [], readdirCalls: 0, maxConcurrent: 0 }
}

function lister(f: FakeFs, opts: { statTimeoutMs?: number; listBudgetMs?: number; maxInFlight?: number; trustMs?: number } = {}) {
  let running = 0
  return createFsLs({
    readdir: async () => { f.readdirCalls++; return f.readdirHang ? never() : f.entries },
    readlink: async (p) => {
      const t = f.links[p]
      if (t === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
      return t
    },
    stat: (p) => {
      f.statCalls.push(p)
      const s = f.stats[p]
      if (s === 'hang') { running++; f.maxConcurrent = Math.max(f.maxConcurrent, running); return never() }
      running++
      f.maxConcurrent = Math.max(f.maxConcurrent, running)
      return new Promise((resolve, reject) => setTimeout(() => {
        running--
        if (!s || s === 'enoent') reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        else resolve(s)
      }, 1))
    },
    ...opts,
  })
}

describe('fs.ls budgets', () => {
  it('a link into a hung mount comes back unknown + timedOut; everything else answers', async () => {
    const f = fakeFs(
      [dirent('src', 'dir'), dirent('work', 'link'), dirent('nas', 'link'), dirent('gone', 'link'), dirent('a.txt', 'file')],
      { '/home/me/work': DIR_STAT, '/home/me/nas': 'hang', '/home/me/gone': 'enoent' },
      { '/home/me/work': '/local/home/me/work', '/home/me/nas': '/mnt/nas/me', '/home/me/gone': '../nowhere/x' },
    )
    const t0 = Date.now()
    const r = await lister(f, { statTimeoutMs: 80 }).list('/home/me', false)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r.timedOut).toBe(1)
    expect(r.entries).toEqual([
      { name: 'src', type: 'dir' },
      { name: 'work', type: 'dir', symlink: true },
      { name: 'nas', type: 'unknown', symlink: true, timedOut: true },
      { name: 'gone', type: 'other', symlink: true },
      { name: 'a.txt', type: 'file' },
    ])
  })

  it('detail stats that hang keep the type readdir knew and count as timed out', async () => {
    const f = fakeFs([dirent('ok.log', 'file'), dirent('slow.log', 'file')], { '/d/ok.log': FILE_STAT, '/d/slow.log': 'hang' })
    const r = await lister(f, { statTimeoutMs: 50 }).list('/d', true)
    expect(r.entries).toEqual([
      { name: 'ok.log', type: 'file', size: 42, mtimeMs: 7 },
      { name: 'slow.log', type: 'file', timedOut: true },
    ])
    expect(r.timedOut).toBe(1)
  })

  it('a hung stat is never started twice: a second listing reuses it', async () => {
    const f = fakeFs([dirent('nas', 'link')], { '/h/nas': 'hang' })
    const ls = lister(f, { statTimeoutMs: 30 })
    await ls.list('/h', false)
    await ls.list('/h', false)
    expect(f.statCalls).toEqual(['/h/nas'])
  })

  it('six links into one dead NAS pin ONE stat, and a healthy directory listed next still answers', async () => {
    // The review case: the old gate counted hung stats after the fact, so all
    // six fired at once, and past two hung every later link anywhere came back
    // timed out without being asked, until the daemon restarted.
    const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    const a = fakeFs(names.map((n) => dirent(n, 'link')),
      Object.fromEntries(names.map((n) => [`/a/${n}`, 'hang' as const])),
      Object.fromEntries(names.map((n) => [`/a/${n}`, `/mnt/nas/${n}`])))
    const ls = lister(a, { statTimeoutMs: 40 })
    const r = await ls.list('/a', false)
    expect(r.timedOut).toBe(6)
    expect(a.statCalls).toEqual(['/a/p1'])       // one thread pinned, not six
    // Dir B, same lister: its link points somewhere healthy.
    a.entries = [dirent('src', 'link')]
    a.stats['/b/src'] = DIR_STAT
    a.links['/b/src'] = '/home/me/src'
    const b = await ls.list('/b', false)
    expect(b.entries).toEqual([{ name: 'src', type: 'dir', symlink: true }])
    expect(b.timedOut).toBe(0)
  })

  it('a new link into the dead NAS is answered without a stat; the group heals when its stat settles', async () => {
    let release: (s: FsLsStat) => void = () => {}
    const stuck = new Promise<FsLsStat>((resolve) => { release = resolve })
    const statCalls: string[] = []
    const entries = [dirent('p1', 'link')]
    const ls = createFsLs({
      readdir: async () => entries,
      readlink: async (p) => (p.endsWith('p1') || p.endsWith('p2') ? `/mnt/nas/${p.split('/').pop()}` : '/elsewhere/x'),
      stat: (p) => { statCalls.push(p); return p === '/a/p1' ? stuck : Promise.resolve(DIR_STAT) },
      statTimeoutMs: 30,
    })
    expect((await ls.list('/a', false)).timedOut).toBe(1)
    entries.splice(0, 1, dirent('p2', 'link'))
    expect((await ls.list('/a', false)).entries).toEqual([{ name: 'p2', type: 'unknown', symlink: true, timedOut: true }])
    expect(statCalls).toEqual(['/a/p1'])
    release(DIR_STAT)                                // the NAS came back
    await new Promise((r) => setTimeout(r, 5))
    expect((await ls.list('/a', false)).entries).toEqual([{ name: 'p2', type: 'dir', symlink: true }])
  })

  it('every slot held by a hung stat: a waiter gives up after one timeout of no progress, not at the listing budget', async () => {
    const f = fakeFs([dirent('x', 'link'), dirent('y', 'link'), dirent('z', 'link')],
      { '/s/x': 'hang', '/s/y': 'hang', '/s/z': DIR_STAT },
      { '/s/x': '/mnt/one/x', '/s/y': '/mnt/two/y', '/s/z': '/home/me/z' })
    const t0 = Date.now()
    const r = await lister(f, { statTimeoutMs: 60, listBudgetMs: 5_000, maxInFlight: 2 }).list('/s', false)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r.timedOut).toBe(3)
    expect(f.statCalls.sort()).toEqual(['/s/x', '/s/y'])
  })

  it('a big healthy directory queues through the semaphore and answers in full', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `f${i}.log`)
    const f = fakeFs(names.map((n) => dirent(n, 'file')), Object.fromEntries(names.map((n) => [`/big/${n}`, FILE_STAT])))
    const r = await lister(f, { statTimeoutMs: 200, maxInFlight: 2 }).list('/big', true)
    expect(r.timedOut).toBe(0)
    expect(r.entries.every((e) => e.size === 42)).toBe(true)
    expect(f.maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('a directory that does not answer at all fails within the whole-listing budget (and is not re-read)', async () => {
    const f = fakeFs([], {})
    f.readdirHang = true
    const ls = lister(f, { listBudgetMs: 120 })
    const t0 = Date.now()
    await expect(ls.list('/hung', false)).rejects.toThrow(/did not answer within/)
    expect(Date.now() - t0).toBeLessThan(1_000)
    await expect(ls.list('/hung', false)).rejects.toThrow(/did not answer/)
    expect(f.readdirCalls).toBe(1)
  })

  it('the whole-listing budget also caps the per-entry waits', async () => {
    const f = fakeFs([dirent('x', 'link'), dirent('y', 'link')], { '/b/x': 'hang', '/b/y': 'hang' },
      { '/b/x': '/mnt/one/x', '/b/y': '/mnt/two/y' })
    const t0 = Date.now()
    const r = await lister(f, { statTimeoutMs: 10_000, listBudgetMs: 150 }).list('/b', false)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r.timedOut).toBe(2)
  })

  it('with the real defaults a hung link costs about 1.5s, not the mount timeout', async () => {
    const f = fakeFs([dirent('nas', 'link'), dirent('src', 'dir')], { '/r/nas': 'hang' }, { '/r/nas': '/mnt/nas' })
    const t0 = Date.now()
    const r = await lister(f).list('/r', false)
    const ms = Date.now() - t0
    expect(ms).toBeGreaterThanOrEqual(1_400)
    expect(ms).toBeLessThan(3_000)
    expect(r.timedOut).toBe(1)
  })

  it('the factory survives the text injection the source twin uses', async () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rebuilt = new Function('"use strict"; return ' + createFsLs.toString())() as typeof createFsLs
    const f = fakeFs([dirent('nas', 'link')], { '/i/nas': 'hang' })
    const r = await rebuilt({ readdir: async () => f.entries, stat: () => never(), statTimeoutMs: 20 }).list('/i', false)
    expect(r.timedOut).toBe(1)
  })
})
