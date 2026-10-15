/**
 * Journal v2 note bodies and locks (src/providers/offline-journal-core.ts), second review
 * round: folded note saves free the body they replace at once under the dir's blob lock,
 * a body is never removed by a process that does not hold that lock, a stale lock is
 * removed only while the path still names the file judged, and a saved line is never
 * answered as a failed save because state.json could not be written after it.
 * Real files in temp dirs; a second store on the same dir stands in for another process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { JHOME, SID_A, DEVICE, journalTmpDir, cleanupJournalDirs, journalStore, keyOf } from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const bodies = (dir: string) => { try { return fs.readdirSync(path.join(dir, 'blobs')) } catch { return [] } }
const big = (n: number) => Buffer.alloc(256 * 1024, n % 251)

/** An fs whose calls named in `hooks` run the hook first (once each, unless it returns true to stay). */
function hookedFs(hooks: Partial<Record<'renameSync' | 'unlinkSync', (a: string, b?: string) => boolean | void>>): typeof fs {
  const live = new Map(Object.entries(hooks))
  return new Proxy(fs, {
    get(target, key: string) {
      const hook = live.get(key)
      const real = (target as unknown as Record<string, unknown>)[key]
      if (!hook || typeof real !== 'function') return real
      return (...args: unknown[]) => {
        if (live.has(key) && hook(String(args[0]), args[1] === undefined ? undefined : String(args[1])) !== true) live.delete(key)
        return (real as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

afterEach(() => cleanupJournalDirs())

describe('journal v2: folded note saves free the bodies they replace', () => {
  it('400 saves of a 256 KB note by one device leave at most two bodies, before and after an ack', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock)
    const base = Buffer.from('the text before the Mac went away')
    for (let i = 0; i < 400; i++) {
      clock.now += 100
      const r = j.appendNote(JHOME, { path: 'notes/acme.md', mode: 'put', baseHash: 'h-base', base, ours: big(i) }, { actor: DEVICE })
      expect(r.ok).toBe(true)
    }
    expect(j.records(JHOME)).toHaveLength(1)
    // The first base and the latest body: nothing else is kept on disk.
    expect(bodies(dir).length).toBeLessThanOrEqual(2)
    expect(j.stats(JHOME, JOURNAL_V2_DRAINS)).toMatchObject({ records: 1 })
    const d = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS })
    // A save onto the drained (frozen) record keeps the frozen one's bodies until its ack.
    j.appendNote(JHOME, { path: 'notes/acme.md', mode: 'put', baseHash: 'h-base', base, ours: big(1000) }, { actor: DEVICE })
    j.appendNote(JHOME, { path: 'notes/acme.md', mode: 'put', baseHash: 'h-base', base, ours: big(1001) }, { actor: DEVICE })
    expect(bodies(dir).length).toBeLessThanOrEqual(3)
    j.ack(JHOME, { seqs: d.records.map((r) => r.seq) })
    expect(bodies(dir).length).toBeLessThanOrEqual(2)
    const left = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records
    j.ack(JHOME, { seqs: left.map((r) => r.seq) })
    expect(bodies(dir)).toEqual([])
  })

  it('saves from two stores (two processes) on one dir leave at most two bodies', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const a = journalStore(dir, clock)
    const b = journalStore(dir, clock)
    for (let i = 0; i < 60; i++) {
      clock.now += 100
      const s = i % 2 ? a : b
      expect(s.appendNote(JHOME, { path: 'notes/acme.md', mode: 'put', baseHash: 'h-base', base: Buffer.from('base'), ours: big(i) }, { actor: DEVICE }).ok).toBe(true)
    }
    expect(journalStore(dir, clock).records(JHOME)).toHaveLength(1)
    expect(bodies(dir).length).toBeLessThanOrEqual(2)
  })
})

describe('journal v2: only the blob lock holder removes a body', () => {
  it('while another live process holds the blob lock, nothing is freed; the next save frees it', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock, { lockWaitMs: 20 })
    const save = (n: number) => j.appendNote(JHOME, { path: 'notes/acme.md', mode: 'create', ours: big(n) }, { actor: DEVICE })
    expect(save(1).ok).toBe(true)
    const rec = j.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records[0]
    // Another process is between a body and its record (it holds the blob lock).
    const lockFile = path.join(dir, 'journal-blobs.lock')
    fs.writeFileSync(lockFile, `${process.ppid} -`)
    j.ack(JHOME, { seqs: [rec.seq] })
    expect(j.records(JHOME)).toEqual([])
    expect(bodies(dir)).toHaveLength(1)
    // A save needs the blob lock too: refused while it is held, nothing journaled.
    expect(save(2)).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'locked' })
    fs.unlinkSync(lockFile)
    const again = journalStore(dir, clock)
    expect(again.appendNote(JHOME, { path: 'notes/other.md', mode: 'create', ours: Buffer.from('x') }, { actor: DEVICE }).ok).toBe(true)
    // The first store frees what it still holds at its next save.
    expect(save(3).ok).toBe(true)
    expect(bodies(dir).sort()).toEqual([String(again.records(JHOME)[0].oursBlob), String(j.records(JHOME)[1].oursBlob)].sort())
  })
})

describe('journal v2: a stale lock is removed only while the path names the file judged', () => {
  it('two judges of one dead holder: the second never removes the lock the first then took', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const lockFile = path.join(dir, `journal-${keyOf(JHOME)}.lock`)
    // A holder that died while holding the lock (a pid that is not alive).
    fs.writeFileSync(lockFile, '2147483646 -')
    // Between this store's judgement and its removal, another process judged the same dead
    // holder, removed it and took the lock (it is alive and holds it now).
    const beatIt = () => { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, `${process.ppid} -`) }
    const j = journalStore(dir, clock, {
      lockWaitMs: 30,
      fs: hookedFs({
        renameSync: (a) => { if (a === lockFile) beatIt(); else return true },
        unlinkSync: (a) => { if (a === lockFile) beatIt(); else return true },
      }),
    })
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' })).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'locked' })
    // The live holder's lock is still in place, and nothing was written beside it.
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(`${process.ppid} -`)
    expect(fs.existsSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`))).toBe(false)
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([])
  })

  it('a filesystem that hands the freed inode to the next lock (ext4): the content tells the two holds apart', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const lockFile = path.join(dir, `journal-${keyOf(JHOME)}.lock`)
    fs.writeFileSync(lockFile, '2147483646 -')
    const deadIno = fs.statSync(lockFile).ino
    // Another judge removed the dead hold and took the lock; the new file got the freed inode.
    const live = `${process.ppid} - acme-nonce`
    const beatIt = () => { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, live) }
    let beaten = false
    const reusing = new Proxy(fs, {
      get(target, key: string) {
        const real = (target as unknown as Record<string, unknown>)[key]
        if (key === 'renameSync') {
          return (a: string, b: string) => {
            if (a === lockFile && !beaten) { beaten = true; beatIt() }
            return fs.renameSync(a, b)
          }
        }
        if (key === 'statSync') {
          return (p: string, o?: unknown) => {
            const st = fs.statSync(p, o as undefined)
            return String(p).includes('.stale-') ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: deadIno }) : st
          }
        }
        return real
      },
    })
    const j = journalStore(dir, clock, { lockWaitMs: 30, fs: reusing })
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' })).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'locked' })
    expect(beaten).toBe(true)
    // The live hold is back in place, and nothing was written beside it.
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(live)
    expect(fs.existsSync(path.join(dir, `journal-${keyOf(JHOME)}.ndjson`))).toBe(false)
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([])
  })

  it('every hold writes its own nonce after the pid and start time', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const seen: string[] = []
    const watching = new Proxy(fs, {
      get(target, key: string) {
        const real = (target as unknown as Record<string, unknown>)[key]
        if (key !== 'writeSync') return real
        return (fd: number, data: unknown, ...rest: unknown[]) => {
          // A lock token is the only write that starts with this pid (records are JSON lines).
          if (typeof data === 'string' && data.startsWith(`${process.pid} `)) seen.push(data)
          return (real as (...a: unknown[]) => number).apply(target, [fd, data, ...rest])
        }
      },
    })
    const j = journalStore(dir, clock, { fs: watching })
    for (const effort of ['low', 'high']) expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort }).ok).toBe(true)
    const holds = seen
    expect(holds.length).toBeGreaterThanOrEqual(2)
    for (const t of holds) expect(t).toMatch(new RegExp(`^${process.pid} \\S+ [0-9a-f]{12}$`))
    expect(new Set(holds).size).toBe(holds.length)
  })

  it('a released lock says so: a judge that put it back finds it free once the mark is a second old, never wedged', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const j = journalStore(dir, clock, { lockWaitMs: 20 })
    const lockFile = path.join(dir, `journal-${keyOf(JHOME)}.lock`)
    // A lock file left with the released marker (its holder released while a judge held
    // the file aside, and the judge linked it back). A fresh mark is a release in progress.
    fs.writeFileSync(lockFile, 'free')
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'low' })).toMatchObject({ ok: false, code: 'journal_unwritable', why: 'locked' })
    expect(fs.existsSync(lockFile)).toBe(true)
    // Its holder's unlink never came: a second later the mark is free (the wedge memo does not hold it).
    const old = new Date(Date.now() - 2_000)
    fs.utimesSync(lockFile, old, old)
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' }).ok).toBe(true)
    expect(fs.existsSync(lockFile)).toBe(false)
  })

  it('a writer never takes a lock its holder has marked free but not yet removed (two writers would share one seq)', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const lockFile = path.join(dir, `journal-${keyOf(JHOME)}.lock`)
    const other = journalStore(dir, clock, { lockWaitMs: 20 })
    let between: { ok: boolean; why?: string } | null = null
    // The holder is preempted between its free mark (and its inode check) and its unlink.
    const holder = journalStore(dir, clock, {
      fs: hookedFs({
        unlinkSync: (file) => {
          if (file !== lockFile) return true
          expect(fs.readFileSync(lockFile, 'utf8')).toBe('free')
          between = other.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'other' }) as { ok: boolean; why?: string }
        },
      }),
    })
    expect(holder.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'holder' }).ok).toBe(true)
    // The other writer waited (here, on one thread, until its deadline): it never broke the mark.
    expect(between).toMatchObject({ ok: false, why: 'locked' })
    expect(fs.existsSync(lockFile)).toBe(false)
    expect(other.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'other' })).toMatchObject({ ok: true, seq: 2 })
    holder.close(); other.close()
  })
})

describe('journal v2: a saved line is answered as saved', () => {
  it('a state.json that cannot be written after a row record answers ok; the state follows at the next write', () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    let full = false
    const stateFile = path.join(dir, `journal-${keyOf(JHOME)}.state.json`)
    const j = journalStore(dir, clock, {
      fs: hookedFs({
        renameSync: (_a, b) => {
          if (b === stateFile && full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
          return true
        },
      }),
    })
    full = true
    j.markDirty(JHOME)
    const row = { kind: 'row', row: { id: 'req-acme-1', status: 'pending' } }
    const r = j.append(JHOME, row)
    expect(r).toMatchObject({ ok: true, seq: 1 })
    expect(j.records(JHOME).map((x) => x.seq)).toEqual([1])
    expect(fs.existsSync(stateFile)).toBe(false)
    // The disk has room again: the next write saves the state it still owes.
    full = false
    expect(j.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'high' }).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ v: 2, home: JHOME, nextSeq: 3 })
    // Nothing was written twice.
    expect(journalStore(dir, clock).records(JHOME).map((x) => x.seq)).toEqual([1, 2])
  })
})
