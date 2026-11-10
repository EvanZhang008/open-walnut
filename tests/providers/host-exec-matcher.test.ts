/**
 * The killable matcher behind wait_for (src/providers/host-exec-matcher.ts): a job's lines are
 * tested against the caller's pattern in a child process, so a pattern that runs away on a line
 * holds that process, never the daemon's loop, and is killed at its CPU limit; the wait it
 * belongs to answers `slow`, and the next wait gets a fresh process. One process serves every
 * wait in the order they asked. A process that does not answer but burns no CPU (a starved
 * machine) is given more time, up to a wall limit.
 *
 * 2026-11-04 review: patterns that passed the static cost check held the daemon's loop 3 to 6 s
 * a line; no in-process limit can stop a RegExp under bun.
 *
 * MACHINE SAFETY: the only processes are this test runtime started as a matcher (and stand-ins
 * that answer `ready` and then nothing or their env, and once a stand-in daemon killed here), each
 * killed by the matcher, by itself, or closed here; the one SIGSTOP goes to a matcher this test
 * started (its pid read from the matcher), and is followed by SIGCONT.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { LINE_LIMIT_MS, WITHDRAWN, createMatcher, cpuOfPid, endsPast, linesOut, matcherEnv, psTime, stripAnsi, type Matcher } from '../../src/providers/host-exec-matcher.js'
import { parseWaitFor, type LinePattern } from '../../src/providers/host-exec-pattern.js'
import { measureLoopHold } from '../helpers/loop-hold.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'

function patternOf(output: string): LinePattern {
  const p = parseWaitFor({ output })
  if (!p.ok || !p.pattern) throw new Error(`expected ${output} to be accepted`)
  return p.pattern
}
const line = (text: string, cut = false) => ({ text, cut })

const open: Matcher[] = []
function matcher(opts: Parameters<typeof createMatcher>[2] = {}, start = testMatcherStart()): Matcher {
  const m = createMatcher(start, spawn, opts)
  open.push(m)
  return m
}
afterEach(() => { for (const m of open.splice(0)) m.close() })

describe('the matcher process', () => {
  it('answers the first matching line, with colour codes removed, and how many it tested', async () => {
    const m = matcher()
    // 2026-11-04 real-use review: Vite colours its ready line, and `ready in 312 ms` never matched it.
    const r = await m.test(patternOf('ready in \\d+ ms'), [line('vite v5'), line('\x1b[32mVITE\x1b[0m ready in \x1b[1m312\x1b[0m ms'), line('after')])
    expect(r).toEqual({ tested: 2, hit: 1, text: 'VITE ready in 312 ms' })
    expect(await m.test(patternOf('nothing here'), [line('a'), line('b')])).toEqual({ tested: 2, hit: null })
    // A line cut at the cap is tested with the cut variant: `$` never holds at the cut.
    expect(await m.test(patternOf('ready$'), [line('ready', true)])).toEqual({ tested: 1, hit: null })
    expect(await m.test(patternOf('ready$'), [line('ready')])).toMatchObject({ hit: 0 })
    expect(m.pid).toEqual(expect.any(Number))
  })

  it('stops a line that runs past the limit, without holding this loop, and the next wait gets a new process', async () => {
    const m = matcher()
    const first = await m.test(patternOf('ok'), [line('ok')])
    expect(first).toMatchObject({ hit: 0 })
    const pid = m.pid
    // Accepted by the static check (no repeated group), but cubic on a long line of a's.
    const slow = patternOf('a.*a.*a.*b')
    const t0 = Date.now()
    // Judged on the loop thread's own CPU: a loaded machine stretches a wall-clock gap by itself.
    const { value, holdMs } = await measureLoopHold(() => m.test(slow, [line('a'.repeat(20_000))]))
    expect(value).toEqual({ slow: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LINE_LIMIT_MS * 0.8)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(holdMs).toBeLessThan(200)
    expect(m.pid).toBeNull()
    // The process is gone; the next test starts another.
    expect(await m.test(patternOf('again'), [line('once again')])).toMatchObject({ hit: 0 })
    expect(m.pid).not.toBe(pid)
  }, 20_000)

  it('serves the waits in the order they asked: one that asks again goes behind the others', async () => {
    const m = matcher()
    const order: string[] = []
    const p = patternOf('never')
    const lines = Array.from({ length: 50 }, (_, i) => line(`line ${i}`))
    const a1 = m.test(p, lines).then(() => { order.push('a1'); return m.test(p, lines).then(() => order.push('a2')) })
    const b1 = m.test(p, lines).then(() => order.push('b1'))
    const c1 = m.test(p, lines).then(() => order.push('c1'))
    await Promise.all([a1, b1, c1])
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2'])
  })

  it('a batch ends after about 20 ms of testing, so a long batch answers in pieces', async () => {
    const m = matcher()
    // About 1 to 2 ms a line: a 2000-line batch is answered after a part of it.
    const r = await m.test(patternOf('a.*a.*b'), Array.from({ length: 2_000 }, () => line('a'.repeat(600))))
    expect(r).toMatchObject({ hit: null })
    expect('tested' in r && r.tested).toBeGreaterThan(0)
    expect('tested' in r && r.tested).toBeLessThan(2_000)
  })

  it('a silent process that burns no CPU (a starved machine) is not "too slow": it is stopped only at the wall limit', async () => {
    // A stand-in that says ready and then never answers.
    const mute = { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({ t: "ready", cpu: 0 }) + "\\n"); setInterval(() => {}, 1000)'] }
    const m = matcher({ lineLimitMs: 100, silentMaxMs: 1_200, cpuOf: async () => 0 }, mute)
    const t0 = Date.now()
    const r = await m.test(patternOf('x'), [line('x')])
    expect(r).toEqual({ error: expect.stringMatching(/did not answer for 1 s .*could not be checked/) })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_100)
    // 2026-11-04 review: where the CPU could not be read (a `ps` past its timeout on a loaded Mac),
    // the wall clock called the line too slow after 8 times the limit. With no reading, never slow:
    // timed again until the silence limit, then "could not check".
    const n = matcher({ lineLimitMs: 100, silentMaxMs: 1_500, cpuOf: async () => null }, mute)
    const t1 = Date.now()
    expect(await n.test(patternOf('x'), [line('x')])).toEqual({ error: expect.stringMatching(/did not answer for \d s .*could not be checked/) })
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1_400)
  }, 20_000)

  it('a real matcher stopped (SIGSTOP) with no CPU reading is "could not check", never "too slow"; a running one reports its own CPU', async () => {
    const m = matcher({ lineLimitMs: 100, silentMaxMs: 1_500, cpuOf: async () => null })
    expect(await m.test(patternOf('warm'), [line('warm')])).toMatchObject({ hit: 0 })
    const pid = m.pid!
    const pending = m.test(patternOf('a.*a.*a.*b'), [line('a'.repeat(20_000))])
    process.kill(pid, 'SIGSTOP')
    try {
      expect(await pending).toEqual({ error: expect.stringContaining('could not be checked') })
    } finally {
      try { process.kill(pid, 'SIGCONT') } catch { /* killed by the matcher */ }
    }
    // Running, the same line is too slow with no OS reading at all (else it would end as "could not
    // check" at the silence limit): its watch thread said how much CPU it burned.
    expect(await m.test(patternOf('a.*a.*a.*b'), [line('a'.repeat(20_000))])).toEqual({ slow: true })
  }, 20_000)

  it('a withdrawn ask answers at once: one still queued is never tested, one in flight frees the matcher only for the next ask, which gets its own answer', async () => {
    const m = matcher()
    expect(await m.test(patternOf('warm'), [line('warm')])).toMatchObject({ hit: 0 })
    const first = m.ask(patternOf('^x$'), [line('x')])
    const queued = m.ask(patternOf('^q$'), [line('q')])
    queued.withdraw()
    first.withdraw()
    expect(await first.result).toEqual({ error: WITHDRAWN })
    expect(await queued.result).toEqual({ error: WITHDRAWN })
    // The answer to the withdrawn one is never taken for this one's.
    expect(await m.test(patternOf('^y$'), [line('n'), line('y')])).toEqual({ tested: 2, hit: 1, text: 'y' })
    // Withdrawing after the answer changes nothing.
    const done = m.ask(patternOf('^z$'), [line('z')])
    expect(await done.result).toMatchObject({ hit: 0 })
    done.withdraw()
    expect(await done.result).toMatchObject({ hit: 0 })
  })

  it('the matcher gets the daemon\'s OPEN_WALNUT_HOME and WALNUT_RUNTIME_DIR, so a compiled walnut file run as one unpacks where the daemon does', async () => {
    // 2026-11-04 review: the matcher's env held PATH, HOME and TMPDIR only, so `walnut --wait-matcher`
    // unpacked its runtime under ~/.open-walnut and pruned old trees there, past runtime-tree.ts's guard.
    // A stand-in that answers each test with the two values it was started with.
    const echo = { command: process.execPath, args: ['-e', `
      process.stdout.write(JSON.stringify({ t: 'ready', cpu: 0 }) + '\\n')
      process.stdin.on('data', (d) => { const m = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ t: 'result', id: m.id, tested: 1, hit: 0, text: [process.env.OPEN_WALNUT_HOME, process.env.WALNUT_RUNTIME_DIR].join('|'), cpu: 0 }) + '\\n') })
    `] }
    const saved = { home: process.env.OPEN_WALNUT_HOME, rt: process.env.WALNUT_RUNTIME_DIR }
    process.env.OPEN_WALNUT_HOME = '/tmp/walnut-matcher-env-home'
    process.env.WALNUT_RUNTIME_DIR = '/tmp/walnut-matcher-env-rt'
    try {
      expect(await matcher({}, echo).test(patternOf('x'), [line('x')])).toMatchObject({ text: '/tmp/walnut-matcher-env-home|/tmp/walnut-matcher-env-rt' })
    } finally {
      if (saved.home === undefined) delete process.env.OPEN_WALNUT_HOME; else process.env.OPEN_WALNUT_HOME = saved.home
      if (saved.rt === undefined) delete process.env.WALNUT_RUNTIME_DIR; else process.env.WALNUT_RUNTIME_DIR = saved.rt
    }
    expect(matcherEnv({ PATH: '/p', HOME: '/h', OPEN_WALNUT_HOME: '/data/w', WALNUT_RUNTIME_DIR: '/stage/rt', SECRET: 'x' }))
      .toEqual({ PATH: '/p', HOME: '/h', OPEN_WALNUT_HOME: '/data/w', WALNUT_RUNTIME_DIR: '/stage/rt' })
  })

  it('a process that cannot start answers every queued wait with that, and one that dies mid-test answers its wait', async () => {
    const m = matcher({}, { command: '/nonexistent/walnut-matcher', args: [] })
    expect(await m.test(patternOf('x'), [line('x')])).toEqual({ error: expect.stringContaining('did not start') })
    const live = matcher()
    expect(await live.test(patternOf('x'), [line('x')])).toMatchObject({ hit: 0 })
    const pending = live.test(patternOf('a.*a.*a.*b'), [line('a'.repeat(20_000))])
    await new Promise((r) => setTimeout(r, 50))
    process.kill(live.pid!, 'SIGKILL')
    expect(await pending).toEqual({ error: expect.stringContaining('the pattern matcher stopped (signal SIGKILL)') })
    expect(await live.test(patternOf('y'), [line('y')])).toMatchObject({ hit: 0 })
  }, 20_000)

  it('keeps the patterns it compiled for many waits, and a pattern it dropped is compiled again', async () => {
    // 2026-11-04 review: the process dropped its oldest pattern after 64 and the daemon never sent it again.
    const m = matcher()
    const first = patternOf('^first \\d+$')
    expect(await m.test(first, [line('first 1')])).toMatchObject({ hit: 0 })
    for (let i = 0; i < 70; i++) expect(await m.test(patternOf(`^other ${i}$`), [line(`other ${i}`)])).toMatchObject({ hit: 0 })
    expect(await m.test(first, [line('first 2')])).toMatchObject({ hit: 0 })
  }, 30_000)

  it('ends itself when the daemon that started it is gone, even in a runaway line', async () => {
    // 2026-11-04 review: a matcher left in a runaway line by a daemon that died burned a core under init.
    const file = path.resolve(__dirname, '../../src/providers/host-exec-matcher.ts')
    const daemon = spawn(process.execPath, ['-e', `
      const { createMatcher } = require(${JSON.stringify(file)})
      const { spawn } = require('node:child_process')
      const m = createMatcher(${JSON.stringify(testMatcherStart())}, spawn, { lineLimitMs: 60_000, silentMaxMs: 120_000 })
      void m.test({ source: 'a.*a.*a.*b', flags: '', cut: 'a.*a.*a.*b' }, [{ text: 'a'.repeat(20000), cut: false }])
      setTimeout(() => process.stdout.write(String(m.pid) + '\\n'), 1000)
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = await new Promise<number>((resolve) => daemon.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
    expect(pid).toBeGreaterThan(1)
    process.kill(daemon.pid!, 'SIGKILL')
    await vi.waitFor(() => {
      let alive = true
      try { process.kill(pid, 0) } catch { alive = false }
      expect(alive).toBe(false)
    }, { timeout: 15_000, interval: 100 })
  }, 40_000)

  it('close ends the process and answers what was still queued', async () => {
    const m = matcher()
    const a = m.test(patternOf('a.*a.*a.*b'), [line('a'.repeat(20_000))])
    const b = m.test(patternOf('x'), [line('x')])
    await new Promise((r) => setTimeout(r, 50))
    m.close()
    expect(await a).toEqual({ error: 'the pattern matcher was closed' })
    expect(await b).toEqual({ error: 'the pattern matcher was closed' })
    expect(m.pid).toBeNull()
  })
})

describe('the test a batch rides in', () => {
  // 2026-11-04 usability review (claude4 F2): a pair per line, 256 lines a test, scanned about
  // 2.5 MB/s, so a 63 MB log took three calls. A batch is now one joined string and the indexes
  // of its cut lines; a matcher that does not say it reads that still gets the pairs.
  const P = patternOf('ready$')

  it('is the lines joined with their cut indexes, or the pairs for an older matcher', () => {
    expect(linesOut([line('a'), line('ready', true), line('')], true)).toEqual({ text: 'a\nready\n', cuts: [1], n: 3 })
    expect(linesOut([line('a'), line('ready', true)], false)).toEqual({ lines: [['a', 0], ['ready', 1]] })
  })

  it('the matcher reads both: the joined form, cut lines included, and the pairs an older daemon sends', async () => {
    const start = testMatcherStart()
    const proc = spawn(start.command, start.args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const said: Array<Record<string, unknown>> = []
    let buf = ''
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (d: string) => { buf += d; for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) { said.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1) } })
    const heard = async (n: number) => { for (let i = 0; i < 300 && said.length < n; i++) await new Promise((r) => setTimeout(r, 50)); return said[n - 1] }
    try {
      expect(await heard(1)).toMatchObject({ t: 'ready', v: 3 })
      proc.stdin!.write(`${JSON.stringify({ t: 'test', id: 1, ...P, ...linesOut([line('x'), line('ready', true), line('ready')], true) })}\n`)
      expect(await heard(2)).toMatchObject({ t: 'result', id: 1, tested: 3, hit: 2 })
      proc.stdin!.write(`${JSON.stringify({ t: 'test', id: 2, ...P, ...linesOut([line('ready', true), line('ready')], false) })}\n`)
      expect(await heard(3)).toMatchObject({ t: 'result', id: 2, tested: 2, hit: 1 })
      // A test whose count does not match what it carries is answered so, never tested as other lines.
      proc.stdin!.write(`${JSON.stringify({ t: 'test', id: 3, ...P, text: 'a\nb', cuts: [], n: 3 })}\n`)
      expect(await heard(4)).toMatchObject({ t: 'result', id: 3, error: expect.stringContaining('got 2 lines where 3 were sent') })
    } finally {
      proc.kill('SIGKILL')
    }
  }, 30_000)

  it('the daemon sends the joined form only to a matcher that says it reads it', async () => {
    const keysOf = (v: string) => ({ command: process.execPath, args: ['-e', `
      process.stdout.write(JSON.stringify({ t: 'ready', ${v} cpu: 0 }) + '\\n')
      process.stdin.on('data', (d) => { const m = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ t: 'result', id: m.id, tested: 1, hit: 0, text: Object.keys(m).join(','), cpu: 0 }) + '\\n') })
    `] })
    expect(await matcher({}, keysOf('')).test(patternOf('x'), [line('x')])).toMatchObject({ text: 't,id,source,flags,cut,lines' })
    expect(await matcher({}, keysOf('v: 2,')).test(patternOf('x'), [line('x')])).toMatchObject({ text: 't,id,source,flags,cut,text,cuts,n' })
  }, 20_000)

  it('a resumed line rides with `after` to a matcher that reads it (v 3), and as the lookahead pattern to one that does not', async () => {
    // 2026-11-05 review: the lookahead alone cost the old matches times the new characters.
    const sent = (v: string) => ({ command: process.execPath, args: ['-e', `
      process.stdout.write(JSON.stringify({ t: 'ready', ${v} cpu: 0 }) + '\\n')
      process.stdin.on('data', (d) => { const m = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ t: 'result', id: m.id, tested: 1, hit: 0, text: JSON.stringify({ after: m.after, source: m.source }), cpu: 0 }) + '\\n') })
    `] })
    const resume = { after: 4, fallback: { source: '(?:x)(?=tail)', flags: 's', cut: '(?:x)(?=tail)' } }
    const v3 = await matcher({}, sent('v: 3,')).ask(patternOf('x'), [line('abc x')], resume).result
    expect(JSON.parse((v3 as { text: string }).text)).toEqual({ after: 4, source: 'x' })
    const v2 = await matcher({}, sent('v: 2,')).ask(patternOf('x'), [line('abc x')], resume).result
    expect(JSON.parse((v2 as { text: string }).text)).toEqual({ source: '(?:x)(?=tail)' })
  }, 20_000)

  it('the matcher counts a match on a resumed line only when it ends past `after`, at the cost of one search a match', async () => {
    const start = testMatcherStart()
    const proc = spawn(start.command, start.args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const said: Array<Record<string, unknown>> = []
    let buf = ''
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (d: string) => { buf += d; for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) { said.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1) } })
    const heard = async (n: number) => { for (let i = 0; i < 300 && said.length < n; i++) await new Promise((r) => setTimeout(r, 50)); return said[n - 1] }
    try {
      await heard(1)
      const ask = (id: number, output: string, text: string, after: number) => proc.stdin!.write(`${JSON.stringify({ t: 'test', id, ...patternOf(output), ...linesOut([line(text)], true), after })}\n`)
      ask(1, 'Password:', 'Password: ', 10)
      expect(await heard(2)).toMatchObject({ id: 1, hit: null })
      ask(2, 'Password:|typed', 'Password: typed', 10)
      expect(await heard(3)).toMatchObject({ id: 2, hit: 0 })
      // 20 000 old characters that each match, then 20 000 new: answered, not stopped as slow.
      const t0 = Date.now()
      ask(3, 'a', 'a'.repeat(20_000) + 'b'.repeat(19_999) + 'a', 20_000)
      expect(await heard(4)).toMatchObject({ id: 3, hit: 0 })
      expect(Date.now() - t0).toBeLessThan(2_000)
    } finally {
      proc.kill('SIGKILL')
    }
  }, 30_000)
})

describe('endsPast', () => {
  const g = (src: string, flags = 'g') => new RegExp(src, flags)
  it('a match from any start counts when it ends past `after`; the greedy end of each start is the one judged', () => {
    expect(endsPast(g('port \\d+'), 'listening on port 3000', 20)).toBe(true)
    expect(endsPast(g('port \\d'), 'listening on port 3000', 20)).toBe(false)
    expect(endsPast(g('a'), 'aaab', 3)).toBe(false)
    expect(endsPast(g('a'), 'aaaba', 3)).toBe(true)
    expect(endsPast(g('^x'), 'xyz', 0)).toBe(true)
    expect(endsPast(g('^x'), 'xyz', 1)).toBe(false)
    // A zero-length match past the end of the old part counts; one inside it does not.
    expect(endsPast(g('$'), 'abc', 2)).toBe(true)
    expect(endsPast(g('(?=b)'), 'ab', 1)).toBe(false)
    // Unicode mode steps over a character of two units whole.
    expect(endsPast(g('\\u{1F600}x', 'gu'), '\u{1F600}\u{1F600}x', 2)).toBe(true)
  })
})

describe('helpers', () => {
  it.each([
    ['0:00.25', 250], ['01:02.50', 62_500], ['1:00:00', 3_600_000], ['2-01:00:00', 2 * 86_400_000 + 3_600_000], ['junk', null],
  ])('ps cputime %s is %s ms', (text, ms) => {
    expect(psTime(text)).toBe(ms)
  })

  it('reads a live process\'s CPU time, from /proc and from ps, and none for a pid that is gone', async () => {
    expect(await cpuOfPid(process.pid)).toEqual(expect.any(Number))
    expect(await cpuOfPid(2 ** 22 + 12_345)).toBeNull()
    // The ps path a Mac takes.
    expect(await cpuOfPid(process.pid, 'darwin')).toEqual(expect.any(Number))
    expect(await cpuOfPid(2 ** 22 + 12_345, 'darwin')).toBeNull()
  })

  it.runIf(process.platform === 'linux')('reads /proc without the thread pool: a pool held by stuck file looks still gets a CPU reading', async () => {
    // 2026-11-04 review: the read of /proc waited on the thread pool with no deadline; with the
    // pool held (stat on a dead mount, an old node with no watch-thread CPU) the matcher's timer
    // never fired again and every output wait answered untested until a restart.
    const held = vi.spyOn(fs.promises, 'readFile').mockImplementation(() => new Promise(() => {}))
    try {
      const cpu = await Promise.race([cpuOfPid(process.pid), new Promise((r) => setTimeout(() => r('no answer in 2 s'), 2_000))])
      expect(cpu).toEqual(expect.any(Number))
    } finally {
      held.mockRestore()
    }
  })

  it.each([
    ['\x1b[1;32mok\x1b[0m', 'ok'], ['\x1b]0;title\x07after', 'after'], ['\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\', 'link'], ['plain', 'plain'], ['\x1b[2K\x1b[1Gdone', 'done'],
  ])('stripAnsi(%j) is %j', (raw, want) => {
    expect(stripAnsi(raw)).toBe(want)
  })
})
