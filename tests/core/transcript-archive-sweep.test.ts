import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { archiveHistoryOnce, firstPassMs, startTranscriptArchiveSweep, historyArchiveAllowed, historyCompressDays, nextPassMs, type ArchiveConn } from '../../src/core/transcript-archive-sweep.js'

function conn(host: string, caps: string[], answer: Record<string, unknown> = { ok: true, sessions: 2, files: 3, bytesBefore: 1000, bytesAfter: 300 }) {
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const c: ArchiveConn = { host, hasCapability: (x) => caps.includes(x), send: async (cmd, args) => { sent.push({ cmd, args }); return answer } }
  return { c, sent }
}

describe('session history archive sweep', () => {
  it('reads the retention days: default 60, 0 off, junk the default', () => {
    expect(historyCompressDays({})).toBe(60)
    expect(historyCompressDays({ session: { history_compress_days: 0 } })).toBe(0)
    expect(historyCompressDays({ session: { history_compress_days: 14.7 } })).toBe(14)
    expect(historyCompressDays({ session: { history_compress_days: -3 } })).toBe(60)
  })

  it('asks each able host whose history usage already read, with the configured days', async () => {
    const a = conn('__local__', ['transcript-archive-v1', 'claude-outside-v1'])
    const b = conn('dev', ['transcript-archive-v1', 'claude-outside-v1'])
    const old = conn('old', [])
    const rows = await archiveHistoryOnce({
      conns: [a.c, b.c, old.c], config: { session: { history_compress_days: 30 } }, usageRead: (c) => c.host === '__local__',
    })
    expect(a.sent).toEqual([{ cmd: 'transcript.archive', args: { olderThanDays: 30, budgetMs: 600_000 } }])
    expect(b.sent).toEqual([])
    expect(rows).toEqual([
      { host: '__local__', sessions: 2, files: 3, bytesBefore: 1000, bytesAfter: 300, failed: 0, partial: false, finalized: 0, freedBytes: 0, aside: 0, conflicts: 0 },
      { host: 'dev', skipped: 'usage-not-read' },
      { host: 'old', skipped: 'no-capability' },
    ])
  })

  it('does nothing when turned off, and reports a refusal or a pass already running', async () => {
    const a = conn('__local__', ['transcript-archive-v1'])
    expect(await archiveHistoryOnce({ conns: [a.c], config: { session: { history_compress_days: 0 } }, usageRead: () => true })).toEqual([])
    expect(a.sent).toEqual([])
    const busy = conn('__local__', ['transcript-archive-v1'], { ok: true, busy: true })
    expect(await archiveHistoryOnce({ conns: [busy.c], config: {}, usageRead: () => true })).toEqual([{ host: '__local__', skipped: 'busy' }])
    const refused = conn('__local__', ['transcript-archive-v1'], { ok: false, error: 'nope' })
    expect(await archiveHistoryOnce({ conns: [refused.c], config: {}, usageRead: () => true })).toEqual([{ host: '__local__', error: 'nope' }])
  })

  it('never runs on an isolated server unless asked', async () => {
    // The test runner itself is an isolated server.
    expect(await historyArchiveAllowed({ ...process.env, WALNUT_HISTORY_ARCHIVE: undefined })).toBe(false)
    expect(await historyArchiveAllowed({ ...process.env, WALNUT_HISTORY_ARCHIVE: '1' })).toBe(true)
    expect(await historyArchiveAllowed({ ...process.env, WALNUT_HISTORY_ARCHIVE: '0' })).toBe(false)
  })
  it('keeps its clock across restarts, so a server restarted every 20 minutes still runs and finishes passes', () => {
    // 2026-11-10: a day of deploys restarted production about every 20 minutes; the first pass waited
    // 20 minutes from each start and the next restart cut it off, so no originals were ever removed.
    const MIN = 60_000
    expect(firstPassMs(null, 0)).toBe(20 * MIN) // nothing kept: as before
    expect(firstPassMs(-5 * MIN, 0)).toBe(3 * MIN) // due while the server was down: soon after the start
    expect(firstPassMs(12 * MIN, 0)).toBe(12 * MIN)
    expect(firstPassMs(99 * 3_600_000, 0)).toBe(6 * 3_600_000) // never later than a whole sweep
    expect(nextPassMs([{ host: 'a', partial: true }])).toBe(30 * MIN)
    expect(nextPassMs([{ host: 'a', skipped: 'busy' }, { host: 'b', partial: true }])).toBe(5 * MIN) // the cut-off pass still runs there
    expect(nextPassMs([{ host: 'a', error: 'connection closed' }])).toBe(30 * MIN)
    expect(nextPassMs([{ host: 'a', aside: 3 }])).toBe(70 * MIN)
    expect(nextPassMs([{ host: 'a', sessions: 0 }])).toBe(6 * 3_600_000)
    // Restarts every 20 minutes: each pass (10 minutes at most) starts 3 minutes after a start and
    // ends before the next one; the due time it writes is honoured by the server after it.
    let due: number | null = null
    let passes = 0
    for (let boot = 0; boot < 12 * 20 * MIN; boot += 20 * MIN) {
      const start = boot + firstPassMs(due, boot)
      due ??= start // the first start keeps its due time at once
      if (start + 10 * MIN <= boot + 20 * MIN) { passes++; due = start + 10 * MIN + nextPassMs([{ host: 'a', partial: true }]) }
    }
    expect(passes).toBeGreaterThanOrEqual(6)
  })
  it('a start with no kept clock writes its due time at once, and a later start keeps it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-archive-due-'))
    const prev = process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS
    delete process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS
    try {
      const dueFile = path.join(dir, 'cache', 'history-archive-due.json')
      const a = startTranscriptArchiveSweep({ dueFile, now: () => 1_000_000 })
      await expect.poll(() => fs.existsSync(dueFile)).toBe(true)
      a.stop()
      expect(JSON.parse(fs.readFileSync(dueFile, 'utf8'))).toEqual({ dueAt: 1_000_000 + 20 * 60_000 })
      const b = startTranscriptArchiveSweep({ dueFile, now: () => 1_000_000 + 19 * 60_000 })
      await new Promise((r) => setImmediate(r))
      b.stop()
      expect(JSON.parse(fs.readFileSync(dueFile, 'utf8'))).toEqual({ dueAt: 1_000_000 + 20 * 60_000 })
    } finally {
      if (prev === undefined) delete process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS; else process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

