import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MANIFEST_SUFFIX, MIN_FILE_BYTES, archiveTranscripts, archivedSessionOf, ensurePlain, plainFindResults, restoreForRead, restoreSession, restoreSessionAnywhere, transcriptSessionId,
} from '../../src/providers/transcript-archive.js'

const DAY = 86_400_000
// Files made by a test have a ctime of now, so the pass runs "100 days from now".
const FUTURE = Date.now() + 100 * DAY
const OLD = { olderThanMs: 60 * DAY, now: FUTURE }

let root: string
let proj: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-archive-'))
  proj = path.join(root, '-Users-someone-repo')
  fs.mkdirSync(proj, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

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
    const r = await archiveTranscripts([root], OLD)
    expect(r).toMatchObject({ sessions: 1, files: 3, failed: 0 })
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore / 2)
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
    await archiveTranscripts([root], OLD)
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
    const dry = await archiveTranscripts([root], { ...OLD, isLive: sid => sid === 's-live', dryRun: true })
    expect(dry).toMatchObject({ sessions: 1, skippedLive: 1, dryRun: true })
    expect(exists('s-dry.jsonl')).toBe(true)
    const r = await archiveTranscripts([root], { ...OLD, isLive: sid => sid === 's-live' })
    expect(r).toMatchObject({ sessions: 1, skippedLive: 1 })
    expect(exists('s-young.jsonl')).toBe(true)
    expect(exists('s-live.jsonl')).toBe(true)
    expect(exists('s-dry.jsonl.gz')).toBe(true)
  })

  it('a session whose sidecar was touched recently stays plain', async () => {
    makeSession('s-mixed', Date.now())
    fs.utimesSync(path.join(proj, 's-mixed/tool-results/r1.txt'), FUTURE / 1000, FUTURE / 1000)
    expect((await archiveTranscripts([root], OLD)).sessions).toBe(0)
    expect(exists('s-mixed.jsonl')).toBe(true)
  })

  it('a session another holder has locked is skipped, and a restore never runs over it', async () => {
    makeSession('s-lock', Date.now())
    fs.writeFileSync(path.join(proj, '.s-lock.walnut-archive.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    expect((await archiveTranscripts([root], OLD)).sessions).toBe(0)
    expect(exists('s-lock.jsonl')).toBe(true)
  })

  it('a stale lock (dead pid) is broken', async () => {
    makeSession('s-stale', Date.now())
    fs.writeFileSync(path.join(proj, '.s-stale.walnut-archive.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
    expect((await archiveTranscripts([root], OLD)).sessions).toBe(1)
  })

  it('a corrupt archive is never restored over: the files stay and the open reads as missing', async () => {
    makeSession('s-bad', Date.now())
    await archiveTranscripts([root], OLD)
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
    await archiveTranscripts([root], OLD)
    fs.writeFileSync(path.join(proj, 's-swap.jsonl.gz'), gzipSync('{"other":true}\n'))
    await expect(restoreSession(proj, 's-swap')).rejects.toThrow(/does not match its manifest/)
    expect(exists('s-swap.jsonl')).toBe(false)
  })

  it('a pass that crashed halfway (manifest, some originals gone) is finished, never half-restored', async () => {
    const body = makeSession('s-crash', Date.now())
    await archiveTranscripts([root], OLD)
    // Simulate a crash after the sidecars were removed but before the transcript was:
    // the transcript is plain again, its sidecars are only archived.
    await ensurePlain(path.join(proj, 's-crash.jsonl'))
    await archiveTranscripts([root], OLD)
    fs.writeFileSync(path.join(proj, 's-crash.jsonl'), body.main)
    fs.utimesSync(path.join(proj, 's-crash.jsonl'), Date.now() / 1000, Date.now() / 1000)
    expect(exists('s-crash/subagents/agent-a1.jsonl')).toBe(false)
    // The next pass restores the sidecars under the lock and archives the session whole.
    expect((await archiveTranscripts([root], OLD)).sessions).toBe(1)
    expect(await ensurePlain(path.join(proj, 's-crash.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-crash/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(fs.readFileSync(path.join(proj, 's-crash.jsonl'), 'utf8')).toBe(body.main)
  })

  it('finds an archived session by id in any project dir', async () => {
    makeSession('s-any', Date.now())
    await archiveTranscripts([root], OLD)
    expect(await restoreSessionAnywhere([root], 's-any')).toBe(path.join(proj, 's-any.jsonl'))
    expect(await restoreSessionAnywhere([root], 'nope')).toBe(null)
    expect(await restoreSessionAnywhere([root], '../x')).toBe(null)
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
    const r = await archiveTranscripts([root], { ...OLD, maxSessions: 2 })
    expect(r).toMatchObject({ sessions: 2, partial: true })
    const plain = fs.readdirSync(proj).filter(n => n.endsWith('.jsonl')).length
    const gz = fs.readdirSync(proj).filter(n => n.endsWith('.jsonl.gz')).length
    expect([plain, gz]).toEqual([3, 2])
  })
})

describe('transcript archive at the daemon file commands', () => {
  it('a read under a projects dir restores; a path elsewhere is left alone', async () => {
    const body = makeSession('s-read', Date.now())
    await archiveTranscripts([root], OLD)
    await restoreForRead(path.join(os.tmpdir(), 'elsewhere', 's-read.jsonl'), [root])
    expect(exists('s-read.jsonl')).toBe(false)
    await restoreForRead(path.join(proj, 's-read', 'subagents'), [root])
    expect(fs.readFileSync(path.join(proj, 's-read/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(exists('s-read.jsonl')).toBe(true)
  })

  it('a find hit on an archive is answered as the plain, restored path; our own files never show', async () => {
    makeSession('s-find', Date.now())
    await archiveTranscripts([root], OLD)
    const hits = [path.join(proj, 's-find.jsonl.gz'), path.join(proj, 's-find' + MANIFEST_SUFFIX), path.join(proj, 's-find.jsonl')]
    expect(await plainFindResults(hits, 's-find.jsonl')).toEqual([path.join(proj, 's-find.jsonl')])
    expect(exists('s-find.jsonl')).toBe(true)
  })
})
