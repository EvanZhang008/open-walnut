/**
 * The server's half of wait_for (src/core/hosts/host-exec-wait.ts), from the 2026-11-04 review:
 *
 *   - a matched line (or the unfinished one that would match) leaves this server only when the
 *     output filter, run over the line with its neighbours, shows it: inside the output shown, as
 *     before; right after it (the line still being written), with the output before it; anywhere
 *     else it is hidden with a note that says where it is (a private key's body line before the
 *     output shown matched \w{40,} and came back in clear);
 *   - a background run whose deadline falls inside the wait is waited on to its end (the stop at
 *     its deadline and the kill grace), so its answer never says "keeps running" for a job the
 *     host is stopping at that moment; that wait is extended once and bounded;
 *   - wait_ms is how long host_exec waits, timeout_ms only the run's deadline;
 *   - an answer says the hold cut its wait only when the hold did;
 *   - a revoke while a wait reads ends it with a 403 and nothing more of the job.
 *
 * MACHINE SAFETY: pure functions; no process, file or network.
 */
import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// Every read checks the task's grant (host-exec.ts readJob): these waits run under a live one,
// which a test may revoke.
const grant = vi.hoisted(() => ({ live: true }))
vi.mock('../../../src/core/hosts/exec-grants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/hosts/exec-grants.js')>()),
  isHostClosed: () => false,
  findGrant: (taskId: string, host: string) => (grant.live ? { id: 'xg-relay-test', taskId, host, grantedAt: 0, via: 'settings', runs: 0 } : undefined),
}))
import { execWaitWindow, mergeLong, ranOut, shownWait, waitOnJob } from '../../../src/core/hosts/host-exec-wait.js'
import { budgetLeft, type Caller } from '../../../src/core/hosts/host-exec.js'
import { withAnswerBy } from '../../../src/lib/answer-by.js'

const local = { taskId: 'task-1', host: '__local__' } as Caller
const keyBody = () => randomBytes(48).toString('base64')
// Key armour lines built from parts, so the push's leak scan never reads this test as a key.
const armour = (edge: 'BEGIN' | 'END') => `-----${edge} OPENSSH ${'PRIVATE'} KEY-----`

describe('long lines over several reads', () => {
  it('a read that begins on the long line the last one stopped inside counts it once (2026-11-05 code review)', () => {
    // Read 1: two long lines, the second unfinished; read 2 begins on that second one.
    expect(mergeLong(undefined, { lines: 2, at: 100, last: 70_000 })).toEqual({ lines: 2, at: 100, last: 70_000 })
    expect(mergeLong({ lines: 2, at: 100, last: 70_000 }, { lines: 1, at: 70_000, last: 70_000 })).toEqual({ lines: 2, at: 100, last: 70_000 })
    expect(mergeLong({ lines: 2, at: 100, last: 70_000 }, { lines: 2, at: 70_000, last: 140_000 })).toEqual({ lines: 3, at: 100, last: 140_000 })
    // A later long line of its own adds to the count; a daemon that names only the first is read as it did.
    expect(mergeLong({ lines: 1, at: 100, last: 100 }, { lines: 1, at: 90_000, last: 90_000 })).toEqual({ lines: 2, at: 100, last: 90_000 })
    expect(mergeLong({ lines: 1, at: 100 }, { lines: 1, at: 100 })).toEqual({ lines: 1, at: 100, last: 100 })
  })
})

describe('a matched line and its neighbours', () => {
  it('outside the output shown, it is hidden with where it is; inside it, as the output shows it', async () => {
    const body = keyBody()
    // The answer's output is a later window; the match (a key's body line) is before it.
    const tail = 'filler line\n'.repeat(10)
    const before = await shownWait({ output: tail, offset: 5_000, nextOffset: 5_000 + tail.length }, { output: tail }, { matched: 'output', match: body, matchAt: 40, ms: 5 })
    expect(before.match).toBe('[Walnut hid this line: it is not in the output shown here, so Walnut could not check it with the lines around it; host_exec_read with offset 40 shows it]')
    expect(JSON.stringify(before)).not.toContain(body)
    // An older daemon names no offset: a line the output does not hold is hidden the same way.
    const old = await shownWait({ output: tail }, { output: tail }, { matched: 'output', match: body, ms: 5 })
    expect(old.match).toBe('[Walnut hid this line: it is not in the output shown here, so Walnut could not check it with the lines around it]')
    // Inside the window and harmless: shown, cut to 300 characters.
    const out = `boot\nlistening on :5173 ${'x'.repeat(400)}\n`
    const inside = await shownWait({ output: out, offset: 0, nextOffset: out.length }, { output: out }, { matched: 'output', match: `listening on :5173 ${'x'.repeat(400)}`, matchAt: 5, ms: 5 })
    expect(inside.match).toBe(`listening on :5173 ${'x'.repeat(400)}`.slice(0, 300))
    // Inside a key the output hid: hidden as the output hid it.
    const pem = `${armour('BEGIN')}\n${body}\n${armour('END')}\n`
    const hid = await shownWait({ output: pem, offset: 0, nextOffset: pem.length }, { output: '[hidden]\n[hidden]\n[hidden]\n', redactedLines: 3 }, { matched: 'output', match: body, matchAt: 36, ms: 5 })
    expect(hid.match).toMatch(/^\[Walnut hid this line/)
  })

  it('right after the output shown (the line still being written), it is checked with the lines before it', async () => {
    const body = keyBody()
    const begin = `${armour('BEGIN')}\n`
    const w = await shownWait({ output: begin, offset: 0, nextOffset: begin.length }, { output: '[hidden]\n', redactedLines: 1 }, { matched: null, wouldMatch: body, wouldMatchAt: begin.length, ms: 5 })
    expect(w.wouldMatch).toMatch(/^\[Walnut hid this line/)
    expect(JSON.stringify(w)).not.toContain(body)
    // A prompt after ordinary output is shown.
    const out = 'Building\n'
    const prompt = await shownWait({ output: out, offset: 0, nextOffset: out.length }, { output: out }, { matched: null, wouldMatch: 'Continue? [y/N] ', wouldMatchAt: out.length, ms: 5 })
    expect(prompt.wouldMatch).toBe('Continue? [y/N] ')
  })
})

describe('a matched line outside the output shown, read with the lines around it', () => {
  // 2026-11-04 usability review (claude4 U1): a server's ready line followed by 256 KB of log came
  // back "[Walnut hid this line: it is not in the output shown here ...]", the URL in it one more call away.
  const tail = 'log-line\n'.repeat(10)
  const reply = { output: tail, offset: 300_000, nextOffset: 300_000 + tail.length }
  it('is read from the log around its offset and shown when nothing around it is a credential', async () => {
    const asked: Array<[number, number]> = []
    const around = '1000\nServer ready at http://localhost:19490\nlog-line-1\n'
    const w = await shownWait(reply, { output: tail }, { matched: 'output', match: 'Server ready at http://localhost:19490', matchAt: 3_893, ms: 5 },
      async (offset, max) => { asked.push([offset, max]); return { output: around } })
    expect(w.match).toBe('Server ready at http://localhost:19490')
    // One small read: the lines before it and its own.
    expect(asked).toEqual([[0, 3_893 + 32 * 1024]])
  })

  it('stays hidden when the lines around it make it part of a credential, and when they cannot be read', async () => {
    const body = keyBody()
    const pem = `${armour('BEGIN')}\n${body}\n${armour('END')}\n`
    const key = await shownWait(reply, { output: tail }, { matched: 'output', match: body, matchAt: 100_036, ms: 5 }, async () => ({ output: pem }))
    expect(key.match).toBe('[Walnut hid this line: it may be part of a credential the lines around it hold]')
    expect(JSON.stringify(key)).not.toContain(body)
    const lost = await shownWait(reply, { output: tail }, { matched: 'output', match: 'ready at x', matchAt: 40, ms: 5 }, async () => null)
    expect(lost.match).toBe('[Walnut hid this line: it is not in the output shown here, so Walnut could not check it with the lines around it; host_exec_read with offset 40 shows it]')
  })
})

describe('the server\'s wait on a run at its deadline', () => {
  it('is extended once, and ends within its bound even when the host keeps saying it is stopping the run', async () => {
    // 2026-11-04 review (server-extend): every read at deadlineInMs 0 moved the end 5 s on, so a caller on the Mac never got an answer.
    let reads = 0
    const conn = {
      hasCapability: () => true,
      send: async (_cmd: string, params: Record<string, unknown>) => {
        reads += 1
        await new Promise((r) => setTimeout(r, Math.min(20, Number(params.wait) || 0)))
        return { ok: true, running: true, deadlineInMs: 0, timedOut: true, output: '', offset: 0, nextOffset: 0, waitedFor: { matched: null, ms: params.wait, scanned: 0 } }
      },
    }
    const t0 = Date.now()
    const r = await waitOnJob(conn as never, 'clouddev', local, 'hx-extend-0001', { output: 'ready' }, { since: t0, within: 1_000 })
    expect(r.reply.running).toBe(true)
    expect(Date.now() - t0).toBeLessThan(11_000)
    expect(reads).toBeGreaterThan(1)
  }, 20_000)
})

describe('a read at the host\'s bound', () => {
  it('tells the host when its answer must go, so an answer at that bound gets back before the read gives up: never host_offline', async () => {
    // Code review 6, item 3: a relayed read waited `wait` and gave up 2 s later, while the host's
    // looks could run 1 to 2.3 s past `wait` (a first batch's floor, a matcher that restarted, a
    // last look), so "no match yet" came back as host_offline.
    const relayed = { taskId: 'task-1', host: 'clouddev' } as Caller
    const asked: Array<Record<string, unknown>> = []
    const conn = {
      hasCapability: () => true,
      // A host that takes all it may: to `by`, else 2.3 s past the wait (as one did before `by`).
      send: (_cmd: string, params: Record<string, unknown>, timeoutMs: number) => new Promise((resolve, reject) => {
        asked.push(params)
        const answerIn = typeof params.by === 'number' ? params.by : Number(params.wait) + 2_300
        const reply = setTimeout(() => { clearTimeout(lost); resolve({ ok: true, running: true, output: '', offset: 0, nextOffset: 0, waitedFor: { matched: null, ms: answerIn, scanned: 0 } }) }, answerIn)
        const lost = setTimeout(() => { clearTimeout(reply); reject(new Error('timeout')) }, timeoutMs)
      }),
    }
    // 9 of the 12 s a call through a gateway is held are gone: 3 s left (the relay set its deadline).
    const since = Date.now() - 9_000
    const r = await withAnswerBy(since + 20_000, () => waitOnJob(conn as never, 'clouddev', relayed, 'hx-bound-0001', { output: 'ready' }, { since, within: 1_000 }))
    expect(r.waitedFor).toMatchObject({ matched: null })
    expect(r.waitedFor.error).toBeUndefined()
    expect(asked[0]).toMatchObject({ wait: 1_000, by: expect.any(Number) })
    expect(asked[0]!.by as number).toBeGreaterThanOrEqual(1_000)
    expect(asked[0]!.by as number).toBeLessThanOrEqual(2_100)
  }, 15_000)
})

describe('who is held short', () => {
  it('a call a gateway relayed (it carries the deadline), never one that reached the server itself (2026-11-05 review)', async () => {
    // A session on another host that called the server directly was held 10 s a read as if a gateway stood between.
    const remote = { taskId: 'task-1', host: 'clouddev' } as Caller
    const since = Date.now()
    expect(budgetLeft(remote, since)).toBe(Number.POSITIVE_INFINITY)
    expect(budgetLeft(local, since)).toBe(Number.POSITIVE_INFINITY)
    await withAnswerBy(since + 30_000, async () => {
      expect(budgetLeft(remote, since)).toBeLessThanOrEqual(12_000)
      expect(budgetLeft(remote, since)).toBeGreaterThan(11_000)
      // On the Mac a relayed call is held to its deadline less the way back, not to 12 s.
      expect(budgetLeft(local, since)).toBeGreaterThan(12_000)
      expect(budgetLeft(local, since)).toBeLessThan(30_000)
    })
  })
})

describe('a hold that ended the wait', () => {
  it('only a wait that ran out of time: not a match, a pattern stopped as too slow, or an error', () => {
    // 2026-11-04 usability review (claude4 F1): a tooSlow answer said "Walnut holds a call ... about 1.5 s".
    expect(ranOut({ matched: null, ms: 12_000 })).toBe(true)
    expect(ranOut(undefined)).toBe(true)
    expect(ranOut({ matched: 'output', ms: 5 })).toBe(false)
    expect(ranOut({ matched: null, tooSlow: true, ms: 450 })).toBe(false)
    expect(ranOut({ matched: null, error: 'the pattern matcher stopped', ms: 450 })).toBe(false)
  })
})

describe('how long host_exec waits', () => {
  it('a background run whose deadline falls inside the wait is waited on to its end; else as before', () => {
    const t = Date.now()
    // timeout_ms 5000 with background: within the 2 minute wait, so to its deadline and its stop.
    expect(execWaitWindow(local, t, true, 5_000, undefined)).toBe(5_000 + 3_000 + 2_000)
    // No timeout_ms: a 2 minute wait on a run that may go 2 hours.
    expect(execWaitWindow(local, t, true, 2 * 60 * 60_000, undefined)).toBe(120_000)
    // A deadline past the wait: the wait, the deadline after it.
    expect(execWaitWindow(local, t, true, 30 * 60_000, undefined)).toBe(120_000)
    // A foreground run: its deadline and the kill grace, as before.
    expect(execWaitWindow(local, t, false, 60_000, undefined)).toBe(65_000)
  })

  it('wait_ms is the wait and timeout_ms only the deadline: a short wait on a server kept for an hour', () => {
    // 2026-11-04 usability review (claude4 U2): with background:true, timeout_ms was the wait too.
    const t = Date.now()
    expect(execWaitWindow(local, t, true, 60 * 60_000, 20_000)).toBe(20_000)
    expect(execWaitWindow(local, t, true, 60 * 60_000, 20 * 60_000)).toBe(600_000)
    // A deadline inside the wait: waited on to its stop.
    expect(execWaitWindow(local, t, true, 8_000, 20_000)).toBe(8_000 + 3_000 + 2_000)
    // A foreground run with a wait_ms shorter than its deadline answers then, the run going on.
    expect(execWaitWindow(local, t, false, 60_000, 5_000)).toBe(5_000)
    expect(execWaitWindow(local, t, true, 60 * 60_000, 0)).toBe(0)
  })
})

describe('a coloured matched line', () => {
  // 2026-11-04 review: the line is tested without its colour codes, but was looked for in the output
  // shown with them, so any other hidden line made it "part of a credential".
  it('inside the output shown, is shown when only another line was hidden', async () => {
    const raw = '\u001b[32mServer ready on :5173\u001b[0m\ntoken=ghp_secret\n'
    const answer = { output: '\u001b[32mServer ready on :5173\u001b[0m\n[hidden]\n', redactedLines: 1 }
    const w = await shownWait({ output: raw, offset: 0, nextOffset: raw.length }, answer, { matched: 'output', match: 'Server ready on :5173', matchAt: 0, ms: 5 })
    expect(w.match).toBe('Server ready on :5173')
  })
})

describe('a revoke while a wait reads', () => {
  // 2026-11-04 reviews: a wait that began before a revoke went on returning the job's new lines.
  it('ends the wait with a 403 and shows nothing the read brought back after it', async () => {
    let reads = 0
    const conn = {
      hasCapability: () => true,
      send: async (_cmd: string, params: Record<string, unknown>) => {
        reads += 1
        // The user revokes while the second read waits on the host; that read brings the matched line.
        if (reads === 2) grant.live = false
        const matched = reads === 2
        return { ok: true, running: true, output: matched ? 'after-revoke\n' : '', offset: 0, nextOffset: matched ? 13 : 0,
          waitedFor: matched ? { matched: 'output', match: 'after-revoke', matchAt: 0, ms: 5, scanned: 13 } : { matched: null, ms: 5, scanned: 0 } }
      },
    }
    try {
      const t0 = Date.now()
      const err = await waitOnJob(conn as never, 'clouddev', local, 'hx-revoke-0001', { output: '^after-revoke$' }, { since: t0, within: 2_000 }).catch((e) => e)
      expect(err).toMatchObject({ status: 403, code: 'exec_grant_revoked', data: { jobId: 'hx-revoke-0001' } })
      expect(String(err.message)).toContain('shows nothing more of job hx-revoke-0001')
      expect(String(err.message)).not.toContain('after-revoke')
      // No read goes out once the grant is gone.
      expect(reads).toBe(2)
    } finally {
      grant.live = true
    }
  })
})
