import { describe, expect, it } from 'vitest'
import { archiveHistoryOnce, historyArchiveAllowed, historyCompressDays, type ArchiveConn } from '../../src/core/transcript-archive-sweep.js'

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
})
