/**
 * One process per machine. The witnesses treat another process of the same machine as
 * another machine (rules.ts ownLive), and the instance lock keeps a second process from
 * asking at all, frees itself when its owner crashed, and stops an owner that comes back
 * after another took over. The lock runs against the real file system and real processes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, PermitClient, acquireInstanceLock, createHolderClock, type LockFs } from '../../../../src/core/leader/permit/index.js'
import { CALM, World, firstStart, lastStop, pilot } from './sim.js'

const W = ['w1', 'w2', 'w3']
const P = DEFAULT_PERMIT_PARAMS

describe('two processes of one machine', () => {
  function run(shareNonce: boolean) {
    const w = new World(P, { ...CALM }, 5)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    const first = w.addMachine('A', W, shareNonce ? { nonce: 'same' } : {})
    first.c.requestGrant()
    w.run(1_000)
    expect(first.c.mayAct()).toBe(true)
    // A second server process on the same machine, started while the first runs.
    w.addMachine('A', W, { key: 'A#2', clockOf: 'A', ...(shareNonce ? { nonce: 'same' } : {}) })
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    pilot(w, 'A#2', { wantsLead: true, tickMs: 500 })
    w.run(120_000)
    return w
  }

  it('the second never acts while the first renews: its renews and grants are refused', () => {
    const w = run(false)
    expect(w.violations).toEqual([])
    expect(firstStart(w, 'A#2')).toBeNull()
  })

  it('negative control: two processes with one incarnation are one holder to the witnesses, and both act', () => {
    expect(run(true).violations.length).toBeGreaterThan(0)
  })

  it('after the first stops, the second takes over only once the first one\'s permission ran out', () => {
    const w = new World(P, { ...CALM }, 5)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    const first = w.addMachine('A', W)
    first.c.requestGrant()
    w.run(1_000)
    w.addMachine('A', W, { key: 'A#2', clockOf: 'A' })
    pilot(w, 'A#2', { wantsLead: true, tickMs: 500 })
    // The first renews once more (with a progress stamp, as every renew of the wiring), then hangs.
    first.c.renew({ seq: 1, writtenAt: 1 })
    w.run(2_000)
    w.run(200_000)
    const started = firstStart(w, 'A#2')
    expect(started).not.toBeNull()
    expect(started!).toBeGreaterThan(lastStop(w, 'A')!)
    expect(started!).toBeGreaterThan(2_000 + P.validMs)
    expect(w.violations).toEqual([])
  })
})

// --- The instance lock ------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const child = path.join(here, 'fixtures', 'lock-child.ts')
const kids: ChildProcess[] = []
const dirs: string[] = []
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null && k.signalCode === null) { try { k.kill('SIGCONT'); k.kill('SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-lock-'))
  dirs.push(d)
  return path.join(d, 'leader.lock')
}

/** Start a lock-child; resolves with its first line. `lines` keeps every later one. */
function startChild(lock: string, staleMs: number, beatMs: number): Promise<{ proc: ChildProcess; first: Record<string, unknown>; lines: Array<Record<string, unknown>>; exited: Promise<number | null> }> {
  const proc = spawn(process.execPath, [child, lock, String(staleMs), String(beatMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(proc)
  const lines: Array<Record<string, unknown>> = []
  const exited = new Promise<number | null>((res) => proc.on('exit', (code) => res(code)))
  return new Promise((resolve, reject) => {
    let buf = ''
    let err = ''
    proc.stderr!.on('data', (d) => { err += String(d) })
    proc.stdout!.on('data', (d) => {
      buf += String(d)
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
        buf = buf.slice(i + 1)
        if (lines.length === 0) resolve({ proc, first: line, lines, exited })
        lines.push(line)
      }
    })
    proc.on('exit', (code) => { if (lines.length === 0) reject(new Error(`lock-child exited ${code}: ${err}`)) })
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the instance lock, between real processes', () => {
  it('refuses a second process while the first lives, and frees itself at once when the first crashed', async () => {
    const lock = tmp()
    const a = await startChild(lock, 20_000, 1_000)
    expect(a.first).toEqual({ ok: true, pid: a.proc.pid })
    const b = await startChild(lock, 20_000, 1_000)
    expect(b.first).toMatchObject({ ok: false, owner: a.proc.pid })
    a.proc.kill('SIGKILL')
    await a.exited
    // No wait for staleness: the owner's process is gone.
    const c = await startChild(lock, 20_000, 1_000)
    expect(c.first).toEqual({ ok: true, pid: c.proc.pid })
  }, 30_000)

  it('an owner stopped longer than staleAfterMs loses it; when it runs again it finds that and stops', async () => {
    const lock = tmp()
    const a = await startChild(lock, 1_500, 200)
    expect(a.first.ok).toBe(true)
    a.proc.kill('SIGSTOP')
    await sleep(2_200)
    const b = await startChild(lock, 1_500, 200)
    expect(b.first).toEqual({ ok: true, pid: b.proc.pid })
    a.proc.kill('SIGCONT')
    expect(await a.exited).toBe(3)
    expect(a.lines[1]).toEqual({ lost: true, by: b.proc.pid })
    // The new owner keeps it.
    await sleep(600)
    expect(b.proc.exitCode).toBeNull()
  }, 30_000)

  it('an owner that beats keeps it, however long it lives', async () => {
    const lock = tmp()
    const a = await startChild(lock, 1_000, 200)
    await sleep(2_500)
    const b = await startChild(lock, 1_000, 200)
    expect(b.first).toMatchObject({ ok: false, owner: a.proc.pid })
    expect(a.proc.exitCode).toBeNull()
  }, 30_000)
})

/** An fs whose every step waits a random moment, so concurrent takers interleave every way. */
function jitterFs(rand: () => number): LockFs {
  const wait = () => new Promise((r) => setTimeout(r, rand() * 3))
  const wrap = <K extends keyof LockFs>(k: K) => (async (...a: unknown[]) => { await wait(); return (fsp[k] as (...x: unknown[]) => unknown)(...a) }) as LockFs[K]
  return { link: wrap('link'), rename: wrap('rename'), readFile: wrap('readFile'), readdir: wrap('readdir'), unlink: wrap('unlink'), open: wrap('open'), mkdir: wrap('mkdir'), readlink: wrap('readlink') }
}
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 }
}
const clock = { kind: 'test', now: () => Date.now() }

const gen = (lock: string, n: number) => `${lock}.g${String(n).padStart(12, '0')}`
/** The generation files there, newest first, as [number, token]. */
function generations(lock: string): Array<[number, string]> {
  const base = path.basename(lock)
  return fs.readdirSync(path.dirname(lock))
    .filter((f) => f.startsWith(`${base}.g`) && /^\d{12}$/.test(f.slice(base.length + 2)))
    .map((f): [number, string] => [Number(f.slice(base.length + 2)), JSON.parse(fs.readFileSync(path.join(path.dirname(lock), f), 'utf8')).token])
    .sort((a, b) => b[0] - a[0])
}
const ns = process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : ''
const dead = (n = 1) => JSON.stringify({ token: `dead${n}`, pid: 999_999, clock: 'test', takenAt: 0, gen: n, ns })

/** `n` takers at once, each on its own randomly slowed file system. */
async function race(n: number, seed: number, take: (pid: number, fs: LockFs) => Promise<boolean>): Promise<number> {
  const r = seeded(seed)
  const won = await Promise.all(Array.from({ length: n }, (_, i) => take(10_000 + i, jitterFs(r))))
  return won.filter(Boolean).length
}

describe('the instance lock under processes that take it at once', () => {
  const isAlive = (pid: number) => pid !== 999_999 && pid !== 0

  it('of eight takers of a stale lock, exactly one wins, in every interleaving tried (40 rounds)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const lock = tmp()
      fs.writeFileSync(gen(lock, 1), dead())
      const owners: string[] = []
      const winners = await race(8, seed, async (pid, f) => {
        const res = await acquireInstanceLock({ path: lock, pid, isAlive, clock, fs: f })
        if (res.ok) owners.push(res.lock.owner.token)
        return res.ok
      })
      expect(winners, `seed ${seed}`).toBe(1)
      // The newest generation names that winner, and the dead one is cleared.
      expect(generations(lock)).toEqual([[2, owners[0]]])
    }
  }, 60_000)

  it('of eight takers of a free lock, exactly one wins (40 rounds)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const lock = tmp()
      const winners = await race(8, seed, async (pid, f) => (await acquireInstanceLock({ path: lock, pid, isAlive, clock, fs: f })).ok)
      expect(winners, `seed ${seed}`).toBe(1)
    }
  }, 60_000)

  it('negative control: one file that a taker removes when it judged it stale lets two win', async () => {
    let doubles = 0
    for (let seed = 1; seed <= 40 && doubles === 0; seed++) {
      const lock = tmp()
      fs.writeFileSync(lock, dead())
      const winners = await race(8, seed, async (pid, f) => {
        // The naive way: read, judge, unlink, link our own.
        const text = await f.readFile(lock, 'utf8').catch(() => null)
        if (text && isAlive(JSON.parse(String(text)).pid)) return false
        await f.unlink(lock).catch(() => {})
        const t = `${lock}.${pid}.tmp`
        await fsp.writeFile(t, JSON.stringify({ token: `t${pid}`, pid, clock: 'test', takenAt: 0 }))
        try { await f.link(t, lock); return true } catch { return false } finally { await fsp.unlink(t).catch(() => {}) }
      })
      if (winners > 1) doubles++
    }
    expect(doubles).toBeGreaterThan(0)
  }, 60_000)

  /** A file system whose first link of `name` waits for `gate`. */
  function gatedLink(name: string, gate: Promise<void>): LockFs {
    let first = true
    return { ...fsp, link: (async (a: string, b: string) => { if (b === name && first) { first = false; await gate } return fsp.link(a, b) }) as LockFs['link'] }
  }

  it('a taker that judged a generation stale while another took the next one finds the new owner and gives way', async () => {
    const lock = tmp()
    fs.writeFileSync(gen(lock, 1), dead())
    let release!: () => void
    const p = acquireInstanceLock({ path: lock, pid: 10_001, isAlive, clock, fs: gatedLink(gen(lock, 2), new Promise((r) => { release = r })) })
    await sleep(50)
    const q = await acquireInstanceLock({ path: lock, pid: 10_002, isAlive, clock })
    expect(q.ok).toBe(true)
    release()
    const pr = await p
    expect(pr).toMatchObject({ ok: false, owner: { pid: 10_002 } })
    expect(q.ok && (await q.lock.check())).toBe(true)
  })

  it('a slow taker that links a number a cleanup freed yields to the newer generation', async () => {
    const lock = tmp()
    fs.writeFileSync(gen(lock, 1), dead())
    let release!: () => void
    // P judged generation 1 stale and stalls before it links 2.
    const p = acquireInstanceLock({ path: lock, pid: 10_001, isAlive, clock, fs: gatedLink(gen(lock, 2), new Promise((r) => { release = r })) })
    await sleep(50)
    // Meanwhile Q takes 2 and gives it up (3), and R takes 4 and clears 1 to 3.
    const q = await acquireInstanceLock({ path: lock, pid: 10_002, isAlive, clock })
    if (!q.ok) throw new Error('q')
    await q.lock.release()
    const r = await acquireInstanceLock({ path: lock, pid: 10_003, isAlive, clock })
    if (!r.ok) throw new Error('r')
    expect(r.lock.owner.gen).toBe(4)
    expect(generations(lock).map(([g]) => g)).toEqual([4])
    release()
    const pr = await p
    expect(pr).toMatchObject({ ok: false, owner: { pid: 10_003 } })
    expect(await r.lock.check()).toBe(true)
    expect(generations(lock).map(([g]) => g)).toEqual([4])
  })
})

describe('the instance lock in places a simple lock gets wrong', () => {
  it('makes its directory when it is missing', async () => {
    const lock = path.join(path.dirname(tmp()), 'not', 'there', 'leader.lock')
    expect((await acquireInstanceLock({ path: lock, clock })).ok).toBe(true)
  })

  it('an owner in another pid namespace (a container beside the host) is judged by its beats, not its pid', async () => {
    const lock = tmp()
    let now = 1_000
    const c = { kind: 'test', now: () => now }
    fs.writeFileSync(gen(lock, 1), JSON.stringify({ token: 'boxed', pid: 999_999, clock: 'test', takenAt: 1_000, gen: 1, ns: 'pid:[other]' }))
    // Its pid means nothing here, and it beat just now: it holds.
    expect(await acquireInstanceLock({ path: lock, clock: c, isAlive: () => false })).toMatchObject({ ok: false, owner: { token: 'boxed' } })
    now += 30_000
    expect((await acquireInstanceLock({ path: lock, clock: c, isAlive: () => false })).ok).toBe(true)
  })
})

describe('the instance lock and the permission', () => {
  it('a lock found lost stops the client at once: mayAct false, nothing proposed again', async () => {
    const lock = tmp()
    const isAlive = () => true
    let lostBy: number | null = null
    let c: PermitClient | null = null
    const a = await acquireInstanceLock({ path: lock, pid: 20_001, isAlive, clock, onLost: (b) => { lostBy = b?.pid ?? null; c?.stop('instance lock taken by another process') } })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const t = 0
    const sent: unknown[] = []
    c = new PermitClient({
      id: 'A', list: W, params: P, guard: () => a.lock.held(),
      clock: createHolderClock({ monotonic: () => t, wall: () => t }), transport: { send: (_w, req) => sent.push(req) },
    })
    // Pretend a majority took A's grant.
    const g = c.requestGrant()
    for (const w of W) c.receive({ witness: w, re: g.number, ok: true, held: g, list: W, joint: null, cfg: g.cfg, epoch: 0, progress: null, ops: [], grantable: false })
    expect(c.mayAct()).toBe(true)
    // Another process took it over (A hung past staleAfterMs): a newer generation.
    fs.writeFileSync(gen(lock, 2), JSON.stringify({ token: 'other', pid: 20_002, clock: 'test', takenAt: 0, gen: 2 }))
    expect(await a.lock.check()).toBe(false)
    expect(lostBy).toBe(20_002)
    expect(c.mayAct()).toBe(false)
    expect(c.stoppedReason()).toMatch(/instance lock/)
    expect(c.renew()).toBeNull()
  })

  it('release frees it at once for the next process, and does nothing once it was lost', async () => {
    const lock = tmp()
    const isAlive = (pid: number) => pid > 1
    const a = await acquireInstanceLock({ path: lock, pid: 20_003, isAlive, clock })
    if (!a.ok) throw new Error('not taken')
    await a.lock.release()
    expect(a.lock.held()).toBe(false)
    const b = await acquireInstanceLock({ path: lock, pid: 20_004, isAlive, clock })
    if (!b.ok) throw new Error('not taken')
    expect(b.lock.owner.gen).toBe(3)
    await a.lock.release()
    expect(await b.lock.check()).toBe(true)
    expect(fs.readdirSync(path.dirname(lock)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
