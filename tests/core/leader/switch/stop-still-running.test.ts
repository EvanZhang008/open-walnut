/**
 * A source job resumed while the old leader's server runs its switch stop finds that server by its pid and its
 * start (source-job.ts stopStillRunning, trial-start/process.ts processStartMark): a pid that is another process now
 * (after a reboot, or pids wrapping) is not it, so a resume never waits on, or refuses for, an unrelated process.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { processStartMark, sameProcess } from '../../../../src/core/trial-start/process.js'
import { stopStillRunning } from '../../../../src/core/leader/switch/source-job.js'

const kids: ChildProcess[] = []
afterEach(() => { for (const k of kids.splice(0)) k.kill('SIGKILL') })
const sleeper = () => { const k = spawn('sleep', ['60'], { stdio: 'ignore' }); kids.push(k); return k.pid! }
const soon = new Date(Date.now() + 60_000).toISOString()
const past = new Date(Date.now() - 10 * 60_000).toISOString()

describe('the server asked for the switch stop, found again by a resumed source job', () => {
  it('is the same process while its pid and start both match', async () => {
    const pid = sleeper()
    const start = await processStartMark(pid)
    expect(start).toMatch(/\S/)
    expect(await sameProcess({ pid, start })).toBe(true)
    expect(await stopStillRunning({ pid, start }, { now: Date.now(), commitDeadline: past })).toBe(true)
  })

  it('a pid that points at an unrelated live process (its start differs) is not it: the resume goes on', async () => {
    const other = sleeper()
    // The record of a server long gone whose pid this sleeper got: the start it noted is another one.
    const record = { pid: other, start: `${await processStartMark(other)}-before-the-reboot` }
    expect(await stopStillRunning(record, { now: Date.now(), commitDeadline: soon })).toBe(false)
    // This very process, recorded with another start: not it either.
    expect(await stopStillRunning({ pid: process.pid, start: 'boot-0:1' }, { now: Date.now(), commitDeadline: soon })).toBe(false)
  })

  it('a pid of nobody is not it; with no start known, its pid only while a stop could still run', async () => {
    const pid = sleeper()
    kids.pop()!.kill('SIGKILL')
    const gone = 2 ** 22 + 12_345
    expect(await stopStillRunning({ pid: gone, start: null }, { now: Date.now(), commitDeadline: soon })).toBe(false)
    const live = sleeper()
    expect(await stopStillRunning({ pid: live, start: null }, { now: Date.now(), commitDeadline: soon })).toBe(true)
    // Past the commit deadline and the time a stop may take: an unrelated live process is not waited on.
    expect(await stopStillRunning({ pid: live, start: null }, { now: Date.now(), commitDeadline: past })).toBe(false)
    expect(pid).toBeGreaterThan(1)
  })
})
