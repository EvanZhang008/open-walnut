/**
 * The wait on a log (src/providers/host-exec-wait.ts) at its edges, each from the 2026-11-04 code
 * review of wait_for (repro scripts probe1, probe5, probe7):
 *
 *   - a dense job: a look that holds a backlog reads no more of the log, and the look that clears
 *     it must judge the job's end against the log's size now, not an older one (else the last
 *     lines are never tested and the answer says no match, or a line still being written then is
 *     taken for the job's last line);
 *   - a wait of 0 ms (or one with little time left) still tests the output already in the log,
 *     as a port or file look still gets PROBE_FLOOR_MS; a matcher that is not started yet too;
 *   - a log with no line end, megabytes of it, is read at a walk: a look that tests nothing waits
 *     a check interval before the next, so the daemon's loop is not kept busy skipping bytes.
 *
 * MACHINE SAFETY: every path is a temp dir; the only processes are the matchers (this runtime).
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createWaitCheck, parseWaitFor, waitUntil, type WaitLook } from '../../src/providers/host-exec-wait.js'
import { createMatcher, type Matcher, type MatchResult } from '../../src/providers/host-exec-matcher.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-wait-edges-')))
const matcher = createMatcher(testMatcherStart(), spawn)
afterAll(() => {
  matcher.close()
  if (root.includes('walnut-host-exec-wait-edges-')) fs.rmSync(root, { recursive: true, force: true })
})

const running = { ended: () => false, onEnd: () => () => {} }
const placeOf = (logFile: string) => ({ logFile, cwd: root, home: root, taskDir: null, from: 0 })
function waitOf(raw: Record<string, unknown>) {
  const p = parseWaitFor(raw)
  if (!p.ok) throw new Error(p.error)
  return p
}
/** Many short lines (more than one take holds), then `last` with no line end. */
const dense = (last: string) => Array.from({ length: 80_000 }, (_, i) => `l${i}`).join('\n') + `\n${last}`
/** `m` that notes how many lines each ask carries. */
function counting(m: Matcher, sizes: number[]): Matcher {
  return {
    ask: (p, lines) => { sizes.push(lines.length); return m.ask(p, lines) },
    test: (p, lines) => { sizes.push(lines.length); return m.test(p, lines) },
    get pid() { return m.pid },
    get warm() { return m.warm },
    close: () => m.close(),
  }
}

describe('the wait on a log, at its edges', () => {
  it('a dense job\'s last lines, written after a look that held a backlog, are tested at its end, never judged against an older size', async () => {
    // probe7: 6000 lines and a half line, then `9 done\nBUILD SUCCESS\n` and the end answered
    // {matched:null, scanned:34890} of 34917 bytes, with nothing untested.
    const log = path.join(root, 'dense-end.log')
    fs.writeFileSync(log, dense('step 9'))
    const p = waitOf({ output: 'BUILD SUCCESS' })
    const check = createWaitCheck(p.waitFor, p.pattern, placeOf(log), matcher)
    let ended = false
    const looked = Object.assign(async (e: boolean, d: number): Promise<WaitLook> => {
      const r = await check(e, d)
      // The job writes the rest and ends right after the first look.
      if (!ended) { fs.appendFileSync(log, '9 done\nBUILD SUCCESS\n'); ended = true }
      return r
    }, { close: check.close })
    const w = await waitUntil(looked, { ended: () => ended, onEnd: () => () => {} }, 10_000)
    expect(w).toMatchObject({ matched: 'output', match: 'BUILD SUCCESS' })
    expect(w.unfinished).toBeUndefined()

    // probe5: the line still being written at the first look is finished before the end; the
    // look that clears the backlog must not take its first half for the job's last line.
    const log5 = path.join(root, 'dense-half.log')
    fs.writeFileSync(log5, dense('listening on port 30'))
    const q = waitOf({ output: 'listening on port \\d+$' })
    const c5 = createWaitCheck(q.waitFor, q.pattern, placeOf(log5), matcher)
    const far = Date.now() + 30_000
    let r = await c5(false, far)
    expect(r.hit).toBeNull()
    fs.appendFileSync(log5, '00\n')
    for (let k = 0; k < 10; k++) {
      r = await c5(true, far)
      if (r.hit || r.settled) break
    }
    c5.close?.()
    // A whole line, with where it starts (the server shows it only as the lines around it allow).
    expect(r.hit).toEqual({ kind: 'output', match: 'listening on port 3000', at: dense('').length })
  }, 30_000)

  it('a wait of 0 ms still tests the output already in the log, on a matcher that runs and on one not started yet', async () => {
    // probe1 and the 2026-11-04 usability review: host_exec_read wait_ms 0 (or 1) with the line in
    // the very answer's output said "Did not see /GET \/ HTTP/ ... its last 60 bytes not tested yet".
    const log = path.join(root, 'now.log')
    fs.writeFileSync(log, 'boot\nserver ready on 3000\nmore\n')
    const p = waitOf({ output: 'ready' })
    await matcher.test(p.pattern!, [{ text: 'warm', cut: false }])
    for (const ms of [0, 0, 1]) {
      const t0 = Date.now()
      const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, placeOf(log), matcher), running, ms)
      expect(w).toMatchObject({ matched: 'output', match: 'server ready on 3000' })
      expect(Date.now() - t0).toBeLessThan(1_500)
    }
    // A matcher with no process yet: it starts, and the first batch still gets its answer.
    const cold = createMatcher(testMatcherStart(), spawn)
    try {
      const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, placeOf(log), cold), running, 0)
      expect(w).toMatchObject({ matched: 'output', match: 'server ready on 3000' })
    } finally {
      cold.close()
    }
    // Nothing matches: still within the bound and a moment, and what was tested is said.
    const none = waitOf({ output: 'never' })
    const t1 = Date.now()
    const w = await waitUntil(createWaitCheck(none.waitFor, none.pattern, placeOf(log), matcher), running, 0)
    expect(w).toMatchObject({ matched: null, scanned: fs.statSync(log).size })
    expect(w.untested).toBeUndefined()
    expect(Date.now() - t1).toBeLessThan(1_500)
  }, 30_000)

  it('a dense log goes to the matcher in large batches: a few asks for 200 000 lines, not one per 256', async () => {
    // 2026-11-04 usability review (claude4 F2): 256 lines a test held the scan near 2.5 MB/s; with
    // `seq 1 8000000` the line was in the log at 2 s and seen only on the third call, at 35 s.
    const log = path.join(root, 'seq.log')
    fs.writeFileSync(log, `${Array.from({ length: 200_000 }, (_, i) => String(i + 1)).join('\n')}\nNEEDLE-FOUND\n`)
    const p = waitOf({ output: '^NEEDLE' })
    const sizes: number[] = []
    const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, placeOf(log), counting(matcher, sizes)), { ended: () => true, onEnd: () => () => {} }, 20_000)
    expect(w).toMatchObject({ matched: 'output', match: 'NEEDLE-FOUND' })
    // 200 001 lines: 782 asks of 256 before.
    expect(sizes.length).toBeLessThanOrEqual(20)
  }, 30_000)

  it('a pattern the matcher cuts at its time slice gets smaller batches, never the same lines again and again', async () => {
    // Stands in for a slow pattern: tests 10 lines an answer.
    const sizes: number[] = []
    const slow: Matcher = {
      ask: (_p, lines) => { sizes.push(lines.length); return { result: Promise.resolve<MatchResult>({ tested: Math.min(10, lines.length), hit: null }), withdraw: () => {} } },
      test: () => Promise.resolve({ tested: 0, hit: null }),
      pid: null,
      warm: true,
      close: () => {},
    }
    const log = path.join(root, 'slow.log')
    fs.writeFileSync(log, `${Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n')}\n`)
    const p = waitOf({ output: 'never' })
    await createWaitCheck(p.waitFor, p.pattern, placeOf(log), slow)(true, Date.now() + 200)
    expect(sizes[0]).toBe(5_000)
    expect(sizes.length).toBeGreaterThan(2)
    expect(Math.max(...sizes.slice(1))).toBeLessThanOrEqual(256)
  })

  it('partial: a line already sitting in the log is quiet since it was written, so the first look tests it; a whole-second mtime may be up to 2 s late', async () => {
    // 2026-11-04 review (partial-zero): the quiet clock started at the splitter's first look.
    const log = path.join(root, 'prompt.log')
    fs.writeFileSync(log, 'Password: ')
    const old = Date.now() / 1000 - 2.5
    fs.utimesSync(log, old, old + 0.137)
    const p = waitOf({ output: '^Password: $', partial: true })
    const r = await createWaitCheck(p.waitFor, p.pattern, placeOf(log), matcher)(false, Date.now())
    expect(r.hit).toMatchObject({ kind: 'output', match: 'Password: ', unfinished: true })
    // A file system that keeps whole seconds: written up to 2 s after that, so not quiet yet.
    const whole = Math.floor(Date.now() / 1000) - 1
    fs.utimesSync(log, whole, whole)
    expect((await createWaitCheck(p.waitFor, p.pattern, placeOf(log), matcher)(false, Date.now())).hit).toBeNull()
  })

  it('a look while a batch waits for the matcher still reads the log\'s size, so what is untested counts what it holds now', async () => {
    // 2026-11-04 review: with a batch pending, the look returned before it read the size.
    const never: Matcher = {
      ask: () => ({ result: new Promise<MatchResult>(() => {}), withdraw: () => {} }),
      test: () => new Promise<MatchResult>(() => {}),
      pid: null, warm: true, close: () => {},
    }
    const log = path.join(root, 'untested.log')
    fs.writeFileSync(log, `${Array.from({ length: 60_000 }, (_, i) => `n${i}`).join('\n')}\n`)
    const p = waitOf({ output: 'never' })
    const check = createWaitCheck(p.waitFor, p.pattern, placeOf(log), never)
    await check(false, Date.now() + 100)
    fs.appendFileSync(log, 'more output\n'.repeat(1_000))
    const r = await check(false, Date.now() + 100)
    expect(r.size).toBe(fs.statSync(log).size)
    check.close?.()
  })

  it('megabytes with no line end are read at a walk: a look that tests nothing waits a check interval before the next', async () => {
    // 2026-11-04 review: looks that only skip a long line read 1 MB each and came back at once
    // (setImmediate), so one job printing no newline kept the daemon's loop busy.
    const log = path.join(root, 'one-line.log')
    fs.writeFileSync(log, 'x'.repeat(24 * 1024 * 1024))
    const p = waitOf({ output: 'never' })
    const check = createWaitCheck(p.waitFor, p.pattern, placeOf(log), matcher)
    let looks = 0
    const counted = Object.assign(async (e: boolean, d: number) => { looks++; return check(e, d) }, { close: check.close })
    const w = await waitUntil(counted, running, 1_000)
    expect(w).toMatchObject({ matched: null, long: { lines: 1, at: 0 } })
    expect(looks).toBeLessThanOrEqual(8)
  }, 30_000)

  it('answers by its hard bound (`by`): a cold matcher\'s first-batch floor and the port look give way to it', async () => {
    // Code review 6, item 3: the floors past the wait (a first batch 250 ms, 1.5 s while the matcher
    // starts, a port or file look 200 ms, a last look) took the answer past the server's read deadline.
    const log = path.join(root, 'bound.log')
    fs.writeFileSync(log, 'line one\nline two\n')
    const p = waitOf({ output: 'never', port: 9 })
    // A matcher still starting, that does not answer.
    const cold: Matcher = { ask: () => ({ result: new Promise<MatchResult>(() => {}), withdraw() {} }), test: () => new Promise<MatchResult>(() => {}), pid: null, warm: false, close() {} }
    const t0 = Date.now()
    const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, placeOf(log), cold), running, 0, 300)
    expect(Date.now() - t0).toBeLessThan(700)
    expect(w).toMatchObject({ matched: null, scanned: 0, untested: 18 })
    // With no bound the same wait gives the starting matcher its floor.
    const t1 = Date.now()
    await waitUntil(createWaitCheck(p.waitFor, p.pattern, placeOf(log), cold), running, 0)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1_400)
  }, 15_000)
})
