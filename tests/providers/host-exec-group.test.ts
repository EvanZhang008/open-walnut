/**
 * The signals a job's end sends to its process group (src/providers/host-exec-group.ts), from the
 * 2026-11-04 code review (item 5): once the group is empty its number is free, and a new program
 * may lead a group of that number, so
 *
 *   - no SIGTERM goes to a group that ps shows a leader of (the job's leader, its shell, exited:
 *     a leader there is another program's), nor to one ps shows empty;
 *   - the SIGKILL after it goes only while a process the SIGTERM went to (same pid, same start
 *     time) is still in the group;
 *   - ps output this code cannot read (a ps without lstart) means "ps cannot say", never "empty";
 *   - a long listing (megabytes of long command lines, the job's rows last) still finds the job's
 *     members: rows are read as they come, with no cap on the listing (review of this fix).
 *
 * MACHINE SAFETY: no real process is signalled or started: the child, ps and killGroup are fakes,
 * and the group numbers are made up (killGroup only records).
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { memberNames, psRowReader, watchShellEnd, type ShellEnd } from '../../src/providers/host-exec-group.js'

/** A shell that exits at once with its pipes closed. */
function exitedShell(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, { stdout: { destroy() {} }, stderr: { destroy() {} } })
  setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null) })
  return child
}

/** A ps that answers each call with the next text (the last one again after that), in chunks of 64 KB. */
function fakePs(texts: string[]) {
  let n = 0
  return () => {
    const ps = new EventEmitter() as unknown as ChildProcess
    const stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    Object.assign(ps, { stdout })
    const text = texts[Math.min(n, texts.length - 1)]!
    n += 1
    setImmediate(() => {
      for (let i = 0; i < text.length; i += 65_536) stdout.emit('data', text.slice(i, i + 65_536))
      ps.emit('close', 0)
    })
    return ps
  }
}
const parsePs = (text: string, pgid: number) => { const r = psRowReader(pgid); r.push(text); return r.end() }

/** Watch a fake shell of group `pgid` whose group always has a member, stop what it left at once, and give its end and the signals sent. */
async function watched(pgid: number, ps: string[], waitMs: number): Promise<{ end: ShellEnd; sent: string[] }> {
  const sent: string[] = []
  const killGroup = (pid: number, signal: NodeJS.Signals | 0) => { if (signal !== 0) sent.push(`${signal} -${pid}`) }
  const child = exitedShell()
  const end = await new Promise<ShellEnd>((resolve) => {
    const h = watchShellEnd(child, { pgid, line: 'srv & echo started', endGroup: true, killGroup, spawn: fakePs(ps) as never, onEnd: resolve })
    child.once('exit', () => setImmediate(() => h.stopLeft()))
  })
  await new Promise((r) => setTimeout(r, waitMs))
  return { end, sent }
}

const row = (pid: number, pgid: number, start: string, command: string) => `${String(pid).padStart(6)} ${String(pgid).padStart(6)} ${start} ${command}\n`
const PS_SELF = row(77, 77, 'Wed Nov  4 10:00:09 2026', 'ps -A -o pid= -o pgid= -o lstart= -o command=')

describe('a job\'s group, signalled only while it is still the job\'s', () => {
  it('no SIGTERM to a group whose number another program leads now; a SIGTERM to the job\'s own, and its SIGKILL only while a process it went to is still there', async () => {
    const [foreign, reused, kept] = await Promise.all([
      // The group emptied and a new session leader took its number.
      watched(4242, [PS_SELF + row(4242, 4242, 'Wed Nov  4 10:00:05 2026', '/usr/sbin/otherd')], 200),
      // The job's `sleep` got SIGTERM; by the SIGKILL its pid is another program's, in a group of that number.
      watched(4343, [PS_SELF + row(5001, 4343, 'Wed Nov  4 10:00:00 2026', 'sleep 30'), PS_SELF + row(5001, 4343, 'Wed Nov  4 10:00:07 2026', 'otherd --child')], 4_500),
      // It ignored the SIGTERM: the same process, so the SIGKILL goes.
      watched(4444, [PS_SELF + row(5002, 4444, 'Wed Nov  4 10:00:00 2026', 'sleep 31')], 4_500),
    ])
    expect(foreign.sent).toEqual([])
    expect(foreign.end).toMatchObject({ leftBehind: false, outputCut: false })
    expect(reused.sent).toEqual(['SIGTERM -4343'])
    expect(reused.end).toMatchObject({ leftBehind: true, leftCommands: ['sleep 30'] })
    expect(kept.sent).toEqual(['SIGTERM -4444', 'SIGKILL -4444'])
  }, 15_000)

  it('ps output it cannot read is "cannot say" (the signal goes as before), never "the group is empty"', async () => {
    expect(parsePs('', 4545)).toBeNull()
    // A ps without lstart answers pgid and command only.
    expect(parsePs(' 4545 sleep 30\n', 4545)).toBeNull()
    const blind = await watched(4545, [' 4545 sleep 30\n'], 200)
    expect(blind.sent).toEqual(['SIGTERM -4545'])
    expect(blind.end).toMatchObject({ leftBehind: true })
    expect(blind.end.leftCommands).toBeUndefined()
  }, 10_000)

  it('reads ps rows with their start time, and names members without copies of the job\'s own shell', () => {
    const rows = parsePs(PS_SELF + row(812, 812, 'Mon Oct 28 09:13:25 2024', 'bash -c srv & echo started') + row(813, 812, 'Mon Oct 28 09:13:25 2024', 'srv --port 1'), 812)
    expect(rows).toEqual([
      { pid: 812, pgid: 812, start: 'Mon Oct 28 09:13:25 2024', command: 'bash -c srv & echo started' },
      { pid: 813, pgid: 812, start: 'Mon Oct 28 09:13:25 2024', command: 'srv --port 1' },
    ])
    expect(memberNames(rows!, 'srv & echo started')).toEqual(['srv --port 1'])
  })

  it('a listing of megabytes, its rows up to 112 KB long and the job\'s members last, still finds them and stops them', async () => {
    // Review of this fix: a 4 MB cap on the listing cut the job's rows off, read as "empty", and the `&` child ran on.
    const classpath = row(900, 900, 'Wed Nov  4 09:00:00 2026', `java -cp ${'/opt/lib/x.jar:'.repeat(8_000)} Main`)
    const others = Array.from({ length: 40 }, () => classpath).join('')
    expect(others.length).toBeGreaterThan(4 * 1024 * 1024)
    const rows = parsePs(others + row(6001, 4646, 'Wed Nov  4 10:00:00 2026', 'sleep 33'), 4646)
    expect(rows).toEqual([{ pid: 6001, pgid: 4646, start: 'Wed Nov 4 10:00:00 2026', command: 'sleep 33' }])
    const big = await watched(4646, [others + row(6001, 4646, 'Wed Nov  4 10:00:00 2026', 'sleep 33')], 200)
    expect(big.sent).toEqual(['SIGTERM -4646'])
    expect(big.end).toMatchObject({ leftBehind: true, leftCommands: ['sleep 33'] })
  }, 15_000)

  it('a group that just emptied is not taken for a process outside it while the end of its output is still to be read', async () => {
    // Review of this fix: the drain timer ran before the loop read the pipes' end, after the last
    // member was reaped, and the answer said a process outside the group still ran.
    const t0 = Date.now()
    const sent: string[] = []
    const killGroup = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal !== 0) { sent.push(`${signal} -${pid}`); return }
      // The member ends 2.05 s after the shell; its pipes' end is read 0.1 s later.
      if (Date.now() - t0 > 2_050) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, { stdout: { destroy() {} }, stderr: { destroy() {} } })
    const end = await new Promise<ShellEnd>((resolve) => {
      watchShellEnd(child, { pgid: 4747, line: 'echo hi; srv &', endGroup: true, killGroup, spawn: fakePs([PS_SELF + row(7001, 4747, 'Wed Nov  4 10:00:00 2026', 'srv')]) as never, onEnd: resolve })
      child.emit('exit', 0, null)
      setTimeout(() => child.emit('close', 0, null), 2_150)
    })
    expect(end).toMatchObject({ leftBehind: true, leftCommands: ['srv'], outputCut: false })
    expect(sent).toEqual(['SIGTERM -4747'])
  }, 15_000)
})
