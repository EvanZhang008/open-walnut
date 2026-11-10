import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MANIFEST_SUFFIX, MIN_FILE_BYTES, archiveTranscripts, archivedSessionOf, ensurePlain, noteSessionOpened, plainFindResults, restoreForRead, restoreSession, restoreSessionAnywhere, resumeSourceId, transcriptSessionId,
} from '../../src/providers/transcript-archive.js'

const DAY = 86_400_000
// Files made by a test have a ctime of now, so the pass runs "100 days from now".
const FUTURE = Date.now() + 100 * DAY
const OLD = { olderThanMs: 60 * DAY, now: FUTURE }

let root: string
let projects: string
let proj: string
beforeEach(() => {
  // <root>/projects is the projects dir; <root>/sessions is Claude Code's process registry beside it.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-archive-'))
  projects = path.join(root, 'projects')
  proj = path.join(projects, '-Users-someone-repo')
  fs.mkdirSync(proj, { recursive: true })
})
/** Both steps: compress and set aside, then (an hour later, by the clock the pass is given) remove the asides. */
async function archiveFully(opts = OLD) {
  const first = await archiveTranscripts([projects], opts)
  const second = await archiveTranscripts([projects], opts)
  return { first, second }
}
const leftovers = () => fs.readdirSync(proj).filter(n => n.endsWith('.gz') || n.endsWith(MANIFEST_SUFFIX) || n.includes('walnut-tmp') || n.endsWith('.walnut-orig'))
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

const line = (i: number) => JSON.stringify({ type: 'assistant', uuid: `u-${i}`, message: { content: `reply ${i} é中 ${'x'.repeat(200)}` } }) + '\n'
function writeAt(p: string, body: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}
function makeSession(sid: string, mtimeMs: number) {
  const main = Array.from({ length: 300 }, (_, i) => line(i)).join('')
  const agent = Array.from({ length: 100 }, (_, i) => line(i + 1000)).join('')
  const tool = 'tool output '.repeat(2000)
  writeAt(path.join(proj, `${sid}.jsonl`), main, mtimeMs)
  writeAt(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'), agent, mtimeMs)
  writeAt(path.join(proj, sid, 'tool-results', 'r1.txt'), tool, mtimeMs)
  writeAt(path.join(proj, sid, 'tool-results', 'tiny.txt'), 'small', mtimeMs)
  return { main, agent, tool }
}
const exists = (rel: string) => fs.existsSync(path.join(proj, rel))

describe('transcript archive', () => {
  it('archives an old session whole and brings it back byte for byte, mtime kept', async () => {
    const mtime = Date.now() - 5 * DAY
    const body = makeSession('s-old', mtime)
    const { first: r, second } = await archiveFully()
    expect(r).toMatchObject({ sessions: 1, files: 3, failed: 0, aside: 1, finalized: 0 })
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore / 2)
    expect(second).toMatchObject({ sessions: 0, finalized: 1, aside: 0 })
    expect(second.freedBytes).toBe(r.bytesBefore)
    expect(exists('s-old.jsonl.walnut-orig')).toBe(false)
    expect(exists('s-old.jsonl')).toBe(false)
    expect(exists('s-old.jsonl.gz')).toBe(true)
    expect(exists('s-old/subagents/agent-a1.jsonl.gz')).toBe(true)
    expect(exists('s-old/tool-results/r1.txt.gz')).toBe(true)
    // A file under MIN_FILE_BYTES stays plain.
    expect('small'.length).toBeLessThan(MIN_FILE_BYTES)
    expect(exists('s-old/tool-results/tiny.txt')).toBe(true)
    expect(exists('s-old' + MANIFEST_SUFFIX)).toBe(true)

    expect(await ensurePlain(path.join(proj, 's-old.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-old.jsonl'), 'utf8')).toBe(body.main)
    expect(fs.readFileSync(path.join(proj, 's-old/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(fs.readFileSync(path.join(proj, 's-old/tool-results/r1.txt'), 'utf8')).toBe(body.tool)
    expect(Math.abs(fs.statSync(path.join(proj, 's-old.jsonl')).mtimeMs - mtime)).toBeLessThan(1000)
    expect(exists('s-old.jsonl.gz')).toBe(false)
    expect(exists('s-old/subagents/agent-a1.jsonl.gz')).toBe(false)
    expect(exists('s-old' + MANIFEST_SUFFIX)).toBe(false)
  })

  it('opening a sidecar file of an archived session restores the whole session', async () => {
    const body = makeSession('s-side', Date.now())
    await archiveTranscripts([projects], OLD)
    const agent = path.join(proj, 's-side/subagents/agent-a1.jsonl')
    expect(archivedSessionOf(agent)).toEqual({ dir: proj, sid: 's-side' })
    expect(await ensurePlain(agent)).toBe(true)
    expect(fs.readFileSync(agent, 'utf8')).toBe(body.agent)
    expect(exists('s-side.jsonl')).toBe(true)
  })

  it('leaves young, live and dry-run sessions as they are', async () => {
    makeSession('s-young', FUTURE - 10 * DAY)
    makeSession('s-live', Date.now())
    makeSession('s-dry', Date.now())
    const dry = await archiveTranscripts([projects], { ...OLD, isLive: sid => sid === 's-live', dryRun: true })
    expect(dry).toMatchObject({ sessions: 1, skippedLive: 1, dryRun: true })
    expect(exists('s-dry.jsonl')).toBe(true)
    const r = await archiveTranscripts([projects], { ...OLD, isLive: sid => sid === 's-live' })
    expect(r).toMatchObject({ sessions: 1, skippedLive: 1 })
    expect(exists('s-young.jsonl')).toBe(true)
    expect(exists('s-live.jsonl')).toBe(true)
    expect(exists('s-dry.jsonl.gz')).toBe(true)
  })

  it('a session whose sidecar was touched recently stays plain', async () => {
    makeSession('s-mixed', Date.now())
    fs.utimesSync(path.join(proj, 's-mixed/tool-results/r1.txt'), FUTURE / 1000, FUTURE / 1000)
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(0)
    expect(exists('s-mixed.jsonl')).toBe(true)
  })

  it('a session another holder has locked is skipped, and a restore never runs over it', async () => {
    makeSession('s-lock', Date.now())
    fs.writeFileSync(path.join(proj, '.s-lock.walnut-archive.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(0)
    expect(exists('s-lock.jsonl')).toBe(true)
  })

  it('a lock its live holder stopped touching for 10 minutes is broken; a fresh one never is', async () => {
    makeSession('s-aged', Date.now())
    const lock = path.join(proj, '.s-aged.walnut-archive.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'other' }))
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(0)
    const past = (Date.now() - 11 * 60_000) / 1000
    fs.utimesSync(lock, past, past)
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(1)
  })

  it('a pass whose lock someone else took gives up, keeps the originals and leaves their lock', async () => {
    const body = makeSession('s-taken', Date.now())
    const lock = path.join(proj, '.s-taken.walnut-archive.lock')
    const r = await archiveTranscripts([projects], { ...OLD, isLiveNow: () => {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'thief' }))
      return false
    } })
    expect(r).toMatchObject({ sessions: 0, failed: 1 })
    expect(fs.readFileSync(path.join(proj, 's-taken.jsonl'), 'utf8')).toBe(body.main)
    expect(exists('s-taken.jsonl.gz')).toBe(false)
    expect(exists('s-taken' + MANIFEST_SUFFIX)).toBe(false)
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).token).toBe('thief')
  })

  it('a session that turns live during the pass, or is opened, stays plain', async () => {
    const live = makeSession('s-golive', Date.now())
    let r = await archiveTranscripts([projects], { ...OLD, isLiveNow: (sid) => sid === 's-golive' })
    expect(r).toMatchObject({ sessions: 0, failed: 1 })
    expect(fs.readFileSync(path.join(proj, 's-golive.jsonl'), 'utf8')).toBe(live.main)
    expect(fs.readdirSync(proj).filter(n => n.endsWith('.gz') || n.endsWith(MANIFEST_SUFFIX))).toEqual([])
    makeSession('s-opened', Date.now())
    r = await archiveTranscripts([projects], { ...OLD, isLiveNow: (sid) => { if (sid === 's-opened') noteSessionOpened('s-opened'); return false } })
    expect(exists('s-opened.jsonl')).toBe(true)
    expect(exists('s-opened.jsonl.gz')).toBe(false)
    // Opened recently: the next pass leaves it alone.
    expect((await archiveTranscripts([projects], OLD)).skippedLive).toBeGreaterThanOrEqual(1)
  })

  it('a write through a handle a process held lands in the aside: the next pass puts the session back plain with it', async () => {
    const body = makeSession('s-fd', Date.now())
    const plain = path.join(proj, 's-fd.jsonl')
    const fd = fs.openSync(plain, 'a')
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(1)
    fs.writeSync(fd, '{"late":true}\n')
    fs.closeSync(fd)
    const r = await archiveTranscripts([projects], OLD)
    expect(r).toMatchObject({ finalized: 0, conflicts: 1 })
    expect(fs.readFileSync(plain, 'utf8')).toBe(body.main + '{"late":true}\n')
    expect(leftovers()).toEqual([])
  })

  it('a restore while the originals sit aside is a rename: a late write through a held handle comes with it', async () => {
    const body = makeSession('s-fd2', Date.now())
    const plain = path.join(proj, 's-fd2.jsonl')
    const fd = fs.openSync(plain, 'a')
    await archiveTranscripts([projects], OLD)
    fs.writeSync(fd, '{"late":2}\n')
    fs.closeSync(fd)
    // The same state a daemon that crashed right after the move leaves on disk.
    expect(await ensurePlain(plain)).toBe(true)
    expect(fs.readFileSync(plain, 'utf8')).toBe(body.main + '{"late":2}\n')
    expect(leftovers()).toEqual([])
  })

  for (const shape of ['an append by path (a new file holding only the new line)', 'a whole rewrite']) {
    it(`a new file at the plain name while archived (${shape}) is kept, and so is every earlier byte, never merged`, async () => {
      const body = makeSession('s-new', Date.now())
      const plain = path.join(proj, 's-new.jsonl')
      await archiveTranscripts([projects], OLD)
      const written = shape.startsWith('an append') ? '{"type":"user","message":"late line"}\n' : body.main + '{"late":3}\n'
      fs.writeFileSync(plain, written)
      const r = await archiveTranscripts([projects], OLD)
      expect(r).toMatchObject({ finalized: 0, conflicts: 1 })
      expect(fs.readFileSync(plain, 'utf8')).toBe(written)
      const kept = fs.readdirSync(proj).filter(n => n.startsWith('s-new.jsonl.walnut-conflict-'))
      expect(kept).toHaveLength(1)
      expect(fs.readFileSync(path.join(proj, kept[0]), 'utf8')).toBe(body.main)
      expect(fs.readFileSync(path.join(proj, 's-new/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
      expect(leftovers()).toEqual([])
    })
  }

  it('a new file at the plain name after the asides went keeps the archive copy beside it', async () => {
    const body = makeSession('s-after', Date.now())
    const plain = path.join(proj, 's-after.jsonl')
    expect((await archiveFully()).second.finalized).toBe(1)
    fs.writeFileSync(plain, '{"type":"user","message":"late line"}\n')
    expect(await ensurePlain(plain)).toBe(true)
    expect(fs.readFileSync(plain, 'utf8')).toBe('{"type":"user","message":"late line"}\n')
    const kept = fs.readdirSync(proj).filter(n => n.startsWith('s-after.jsonl.walnut-conflict-'))
    expect(fs.readFileSync(path.join(proj, kept[0]), 'utf8')).toBe(body.main)
    expect(leftovers()).toEqual([])
  })

  it('a session Claude Code\'s own registry names for a live process is never archived or finalized', async () => {
    makeSession('s-reg', Date.now())
    fs.mkdirSync(path.join(root, 'sessions'))
    const entry = path.join(root, 'sessions', '424242.json')
    fs.writeFileSync(entry, JSON.stringify({ pid: process.pid, sessionId: 's-reg' }))
    expect(await archiveTranscripts([projects], OLD)).toMatchObject({ sessions: 0, skippedLive: 1 })
    fs.rmSync(entry)
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(1)
    // Live again before the asides go: they stay.
    fs.writeFileSync(entry, JSON.stringify({ pid: process.pid, sessionId: 's-reg' }))
    expect(await archiveTranscripts([projects], OLD)).toMatchObject({ finalized: 0, aside: 1 })
    expect(exists('s-reg.jsonl.walnut-orig')).toBe(true)
    // A dead pid in the registry does not count.
    fs.writeFileSync(entry, JSON.stringify({ pid: 2 ** 22 + 12345, sessionId: 's-reg' }))
    expect(await archiveTranscripts([projects], OLD)).toMatchObject({ finalized: 1 })
  })

  it('the asides stay an hour, and the temp sweep never takes one', async () => {
    makeSession('s-hour', Date.now() - 100 * DAY)
    fs.utimesSync(path.join(proj, 's-hour.jsonl'), (Date.now() - 100 * DAY) / 1000, (Date.now() - 100 * DAY) / 1000)
    // The ctime is now, so this pass runs on the real clock only past the ctime cutoff: give it a later one.
    expect((await archiveTranscripts([projects], { olderThanMs: 1, now: Date.now() + 1000 })).sessions).toBe(1)
    const r = await archiveTranscripts([projects], { olderThanMs: 1, now: Date.now() + 30 * 60_000 })
    expect(r).toMatchObject({ finalized: 0, aside: 1 })
    expect(exists('s-hour.jsonl.walnut-orig')).toBe(true)
    expect((await archiveTranscripts([projects], { olderThanMs: 1, now: Date.now() + 2 * 3_600_000 })).finalized).toBe(1)
    expect(exists('s-hour.jsonl.walnut-orig')).toBe(false)
  })

  it('a restore that cannot finish keeps the archive and the manifest', async () => {
    makeSession('s-fail', Date.now())
    await archiveFully()
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
    await expect(restoreSession(proj, 's-fail')).rejects.toThrow(/no space/)
    vi.restoreAllMocks()
    expect(exists('s-fail' + MANIFEST_SUFFIX)).toBe(true)
    expect(exists('s-fail.jsonl.gz')).toBe(true)
    expect(await ensurePlain(path.join(proj, 's-fail.jsonl'))).toBe(true)
  })

  it('a restore waits for a pass at work on the session (its lock, no manifest yet)', async () => {
    makeSession('s-wait', Date.now())
    const lock = path.join(proj, '.s-wait.walnut-archive.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'pass' }))
    let done = false
    const job = restoreSession(proj, 's-wait').then((v) => { done = true; return v })
    await new Promise(r => setTimeout(r, 300))
    expect(done).toBe(false)
    fs.unlinkSync(lock)
    expect(await job).toBe(true)
  })

  it('names the transcript a resume or a fork reads', () => {
    expect(resumeSourceId(['-p', '--resume', 'old-id', '--fork-session', '--session-id', 'new-id'])).toBe('old-id')
    expect(resumeSourceId(['-r', 'abc'])).toBe('abc')
    expect(resumeSourceId(['--resume=abc'])).toBe('abc')
    expect(resumeSourceId(['--session-id', 'new'])).toBe(null)
    expect(resumeSourceId(['--resume', '../x'])).toBe(null)
  })

  it('a stale lock (dead pid) is broken', async () => {
    makeSession('s-stale', Date.now())
    fs.writeFileSync(path.join(proj, '.s-stale.walnut-archive.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(1)
  })

  it('a corrupt archive is never restored over: the files stay and the open reads as missing', async () => {
    makeSession('s-bad', Date.now())
    await archiveFully()
    const gz = path.join(proj, 's-bad.jsonl.gz')
    const bytes = fs.readFileSync(gz)
    bytes[bytes.length - 6] ^= 0xff // break the CRC
    fs.writeFileSync(gz, bytes)
    expect(await ensurePlain(path.join(proj, 's-bad.jsonl'))).toBe(false)
    expect(exists('s-bad.jsonl.gz')).toBe(true)
    expect(exists('s-bad.jsonl')).toBe(false)
    expect(fs.readdirSync(proj).filter(n => n.includes('walnut-tmp'))).toEqual([])
  })

  it('an archive that does not match its manifest is refused', async () => {
    makeSession('s-swap', Date.now())
    await archiveFully()
    fs.writeFileSync(path.join(proj, 's-swap.jsonl.gz'), gzipSync('{"other":true}\n'))
    await expect(restoreSession(proj, 's-swap')).rejects.toThrow(/does not match its manifest/)
    expect(exists('s-swap.jsonl')).toBe(false)
  })

  it('a pass that crashed halfway (manifest, some originals aside, the transcript not yet) is undone whole', async () => {
    const body = makeSession('s-crash', Date.now())
    await archiveTranscripts([projects], OLD)
    // Simulate a crash after the sidecars were set aside but before the transcript was.
    const t = path.join(proj, 's-crash.jsonl')
    fs.renameSync(t + '.walnut-orig', t)
    expect(exists('s-crash/subagents/agent-a1.jsonl')).toBe(false)
    // The next pass puts the session back whole under the lock; the one after archives it again.
    expect(await archiveTranscripts([projects], OLD)).toMatchObject({ sessions: 0, conflicts: 0 })
    expect(fs.readFileSync(path.join(proj, 's-crash/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect((await archiveTranscripts([projects], OLD)).sessions).toBe(1)
    expect(fs.readdirSync(proj).filter(n => n.includes('walnut-conflict'))).toEqual([])
    expect(await ensurePlain(path.join(proj, 's-crash.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-crash/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(fs.readFileSync(path.join(proj, 's-crash.jsonl'), 'utf8')).toBe(body.main)
  })

  it('finds an archived session by id in any project dir', async () => {
    makeSession('s-any', Date.now())
    await archiveTranscripts([projects], OLD)
    expect(await restoreSessionAnywhere([projects], 's-any')).toBe(path.join(proj, 's-any.jsonl'))
    expect(await restoreSessionAnywhere([projects], 'nope')).toBe(null)
    expect(await restoreSessionAnywhere([projects], '../x')).toBe(null)
  })

  it('an ordinary missing file is not taken for an archive', async () => {
    expect(archivedSessionOf(path.join(proj, 'missing.jsonl'))).toBe(null)
    expect(await ensurePlain(path.join(proj, 'missing.jsonl'))).toBe(false)
  })

  it('names both forms of a transcript', () => {
    expect(transcriptSessionId('abc.jsonl')).toBe('abc')
    expect(transcriptSessionId('abc.jsonl.gz')).toBe('abc')
    expect(transcriptSessionId('abc.json')).toBe(null)
  })

  it('stops at its budget with nothing half done', async () => {
    for (let i = 0; i < 5; i++) makeSession(`s-b${i}`, Date.now())
    const r = await archiveTranscripts([projects], { ...OLD, maxSessions: 2 })
    expect(r).toMatchObject({ sessions: 2, partial: true })
    const plain = fs.readdirSync(proj).filter(n => n.endsWith('.jsonl')).length
    const gz = fs.readdirSync(proj).filter(n => n.endsWith('.jsonl.gz')).length
    expect([plain, gz]).toEqual([3, 2])
    expect(fs.readdirSync(proj).filter(n => n.endsWith('.jsonl.walnut-orig'))).toHaveLength(2)
  })
})

describe('transcript archive at the daemon file commands', () => {
  it('a read under a projects dir restores; a path elsewhere is left alone', async () => {
    const body = makeSession('s-read', Date.now())
    await archiveTranscripts([projects], OLD)
    await restoreForRead(path.join(os.tmpdir(), 'elsewhere', 's-read.jsonl'), [projects])
    expect(exists('s-read.jsonl')).toBe(false)
    await restoreForRead(path.join(proj, 's-read', 'subagents'), [projects])
    expect(fs.readFileSync(path.join(proj, 's-read/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(exists('s-read.jsonl')).toBe(true)
  })

  it('a find hit on an archive is answered as the plain, restored path; our own files never show', async () => {
    makeSession('s-find', Date.now())
    await archiveTranscripts([projects], OLD)
    const hits = [path.join(proj, 's-find.jsonl.gz'), path.join(proj, 's-find' + MANIFEST_SUFFIX), path.join(proj, 's-find.jsonl')]
    expect(await plainFindResults(hits, 's-find.jsonl')).toEqual([path.join(proj, 's-find.jsonl')])
    expect(exists('s-find.jsonl')).toBe(true)
  })
})
