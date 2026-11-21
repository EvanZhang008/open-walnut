/**
 * A loop that reads a host job which can no longer change is told so, once
 * (src/core/hosts/host-exec-stale-reads.ts). 2026-11-21, health alarm log.spike:19jarl4: a session's
 * `until walnut tools call host_exec_read ... | grep -q '"running":false'` never matched the CLI's
 * indented JSON; it read a finished clouddev job every 20 s for an hour, then got 404 unknown_job
 * for half an hour more.
 *
 * Also the class guard: every place that reads a job for a caller reports to the watch, and a new
 * place that reads a job fails here until it is classified.
 *
 * MACHINE SAFETY: no process, file or network; the host and the notice are stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const daemon = vi.hoisted(() => ({ replies: [] as Array<Record<string, unknown>> }))
vi.mock('../../../src/core/hosts/host-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/hosts/host-exec.js')>()),
  callerOf: async () => ({ sid: 'sid-loop', taskId: 'task-loop', taskTitle: 'Loop', host: 'mac-b' }),
  targetHost: async (h: string) => h,
  grantFor: async () => undefined,
  dial: async () => ({}),
  readJob: async () => daemon.replies.shift() ?? { ok: true, running: false, exitCode: 0, output: '', offset: 99, nextOffset: 99 },
  jobAnswer: async (_h: string, jobId: string, reply: Record<string, unknown>) => ({ jobId, ...reply }),
}))

import { STALE_READ_MIN_SPAN_MS, STALE_READ_REPEATS, noteJobRead, resetStaleReadsForTest, staleReadNotice, type JobReadSeen } from '../../../src/core/hosts/host-exec-stale-reads.js'
import { readHostJob } from '../../../src/core/hosts/host-exec-jobs.js'

const told: Array<{ seen: JobReadSeen; repeats: number }> = []
beforeEach(() => {
  told.length = 0
  daemon.replies = []
  resetStaleReadsForTest(async (seen, repeats) => { told.push({ seen, repeats }); return true })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
})
afterEach(() => { resetStaleReadsForTest(); vi.useRealTimers() })
const tick = () => vi.setSystemTime(Date.now() + 20_000)

const job = (over: Partial<JobReadSeen> = {}): JobReadSeen => ({ sid: 's1', taskId: 't1', host: 'clouddev', jobId: 'hx-a', state: 'ended', offset: 99, readTo: 99, exitCode: 0, ...over })

describe('the stale-read watch', () => {
  it('an ended job read the same way again and again: its session is told once', () => {
    for (let i = 0; i < STALE_READ_REPEATS; i++) noteJobRead(job(), 1000 + i * 20_000)
    expect(told).toHaveLength(0)
    noteJobRead(job(), 1000 + STALE_READ_REPEATS * 20_000)
    expect(told).toHaveLength(1)
    expect(told[0].seen).toMatchObject({ sid: 's1', taskId: 't1', jobId: 'hx-a', state: 'ended' })
    for (let i = 0; i < 20; i++) noteJobRead(job(), 200_000 + i)
    expect(told).toHaveLength(1)
  })

  it('the job forgotten after it ended (404 unknown_job) counts as well, still one notice per job', () => {
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job({ state: 'gone', offset: null, readTo: null }), i * 20_000)
    expect(told).toHaveLength(1)
    expect(told[0].seen.state).toBe('gone')
    // Another job of the same task is its own record.
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job({ jobId: 'hx-b' }), i * 20_000)
    expect(told).toHaveLength(2)
  })

  it('paging through an ended job, or reading a running one, is no repeat', () => {
    for (let i = 0; i < 30; i++) noteJobRead(job({ offset: i * 1000, readTo: (i + 1) * 1000 }), i * 20_000)
    for (let i = 0; i < 30; i++) noteJobRead(job({ jobId: 'hx-run', state: 'running', exitCode: null }), i * 20_000)
    expect(told).toHaveLength(0)
    // A running read in between starts the count again.
    for (let i = 0; i < STALE_READ_REPEATS; i++) noteJobRead(job({ jobId: 'hx-c' }), i * 20_000)
    noteJobRead(job({ jobId: 'hx-c', state: 'running' }), 200_000)
    noteJobRead(job({ jobId: 'hx-c' }), 220_000)
    expect(told).toHaveLength(0)
  })

  it('a notice that fails to go out never breaks the read, and is tried again later', async () => {
    let calls = 0
    resetStaleReadsForTest(async () => { calls += 1; if (calls === 1) throw new Error('no session'); return calls > 2 })
    expect(() => { for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job(), i * 20_000) }).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(1)
    // After the failure, as many repeats again (and the span) before the next try; a skipped one (no session) too.
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job(), 200_000 + i * 20_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job(), 400_000 + i * 20_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(3)
    for (let i = 0; i <= STALE_READ_REPEATS * 3; i++) noteJobRead(job(), 600_000 + i * 20_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(3)
  })

  it('a quick burst of re-reads is no loop; a trigger check is never counted', () => {
    for (let i = 0; i < 20; i++) noteJobRead(job(), i * 100)
    expect(told).toHaveLength(0)
    noteJobRead(job(), STALE_READ_MIN_SPAN_MS)
    expect(told).toHaveLength(1)
    for (let i = 0; i < 20; i++) noteJobRead(job({ sid: 'trigger:tr-1', jobId: 'hx-t' }), i * 20_000)
    for (let i = 0; i < 20; i++) noteJobRead(job({ sid: '', jobId: 'hx-t' }), i * 20_000)
    expect(told).toHaveLength(1)
  })

  it('another session of the same task reading the same job is told on its own', () => {
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job(), i * 20_000)
    for (let i = 0; i <= STALE_READ_REPEATS; i++) noteJobRead(job({ sid: 's2' }), i * 20_000)
    expect(told.map((t) => t.seen.sid)).toEqual(['s1', 's2'])
  })

  it('the notice names the job, how it ended, and the trap', () => {
    const ended = staleReadNotice(job(), 5, 100_000, true)
    expect(ended).toContain('hx-a on clouddev')
    expect(ended).toContain('exit 0')
    expect(ended).toContain('"running": false, with a space')
    expect(ended).toContain('stop that loop')
    const gone = staleReadNotice(job({ state: 'gone' }), 5, 3_600_000, true)
    expect(gone).toContain('no longer holds')
    expect(gone).toContain('after it ended')
  })
})

describe('host_exec_read feeds the watch', () => {
  it('the 2026-11-21 loop: an ended job read every 20 s at offset 99, then 404 unknown_job, is told once', async () => {
    for (let i = 0; i <= STALE_READ_REPEATS; i++) { tick(); await readHostJob({ host: 'clouddev', job_id: 'hx-6da9', offset: 99, wait_ms: 10_000 }, 'sid-loop') }
    expect(told).toHaveLength(1)
    expect(told[0].seen).toMatchObject({ sid: 'sid-loop', taskId: 'task-loop', host: 'clouddev', jobId: 'hx-6da9', state: 'ended', offset: 99 })
    daemon.replies = Array.from({ length: 10 }, () => ({ ok: false, code: 'unknown_job', error: 'no job hx-6da9 on this host' }))
    for (let i = 0; i < 10; i++) { tick(); await expect(readHostJob({ host: 'clouddev', job_id: 'hx-6da9', offset: 99 }, 'sid-loop')).rejects.toMatchObject({ status: 404 }) }
    expect(told).toHaveLength(1)
  })

  it('a job only ever answered 404 is told after the repeats', async () => {
    daemon.replies = Array.from({ length: 10 }, () => ({ ok: false, code: 'unknown_job', error: 'no job' }))
    for (let i = 0; i <= STALE_READ_REPEATS; i++) { tick(); await readHostJob({ host: 'clouddev', job_id: 'hx-gone' }, 'sid-loop').catch(() => {}) }
    expect(told).toHaveLength(1)
    expect(told[0].seen.state).toBe('gone')
  })
})

// The class: every caller's read of an existing job reaches the watch. Each file that reads a job
// from a host (readJob / readAgain / waitOnJob) is listed: `reports` files call noteJobRead; the
// others are helpers whose answer goes back through a file that reports, or a run's own first wait.
describe('every way a caller reads a job reports to the watch', () => {
  const READERS: Record<string, 'reports' | string> = {
    'src/core/hosts/host-exec-jobs.ts': 'reports',   // host_exec_read (op and GET /hosts/:host/exec/:jobId)
    'src/core/hosts/host-exec.ts': 'reports',        // sameJob: host_exec again with a job_id; also a new run's first wait (no repeat)
    'src/core/hosts/host-exec-wait.ts': 'helper: waitOnJob and readAgain, whose answers host-exec-jobs.ts and host-exec.ts report',
    'src/providers/host-exec-core.ts': 'the host daemon\'s own waitOnJob inside exec.read: it answers the server\'s read, which the server reports',
  }
  const ROOT = path.resolve(__dirname, '../../..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  it('lists each file that reads a job, and the reporting ones call noteJobRead', () => {
    const found = walk(path.join(ROOT, 'src'))
      .filter((f) => /\b(readJob|readAgain|waitOnJob)\(/.test(fs.readFileSync(f, 'utf8').replace(/\b(export )?(async )?function (readJob|readAgain|waitOnJob)\(/g, '')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort()
    expect(found, 'a new file reads host jobs: classify it in READERS (and call noteJobRead if a caller polls through it)').toEqual(Object.keys(READERS).sort())
    for (const [file, kind] of Object.entries(READERS)) {
      if (kind === 'reports') expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(/noteJobRead\(/)
    }
  })
})
