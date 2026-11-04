/**
 * The host side of `wait_for` (src/providers/host-exec-wait.ts, host-exec-wait-v1): the check a
 * host's daemon runs next to a job's log, its port and its files. Output is cut into lines on
 * bytes (a line ends at \n or \r; a line split across reads is one line; the unfinished last one
 * counts only once the job ended, or with `partial` once it went quiet), each line is tested on
 * its first 64 K characters and a longer one is reported, and the lines are tested in the
 * killable matcher (host-exec-matcher.ts). A port counts on any local address, a file look that
 * does not answer is named, and the wait ends at a match, a stop, the job's end (after its whole
 * output was tested) or its bound. The core's exec.read and exec.run are in
 * host-exec-wait-core.test.ts.
 *
 * MACHINE SAFETY: every path is a temp dir; the listeners bind a free port on this machine's own
 * addresses; the only processes are the matcher (this test runtime).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  DENIED_GIVE_UP_MS, END_GRACE_MS, LINE_TEST_MAX, WAIT_CHECK_MS, createLineSplitter, createWaitCheck, localAddresses, parseWaitFor, probeFile, probePort,
  resolveWaitFile, waitBefore, waitUntil, type LineSplitter, type ScanEdge, type WaitFor,
} from '../../src/providers/host-exec-wait.js'
import { createMatcher, type Matcher, type MatchResult } from '../../src/providers/host-exec-matcher.js'
import { testMatcherStart } from '../helpers/wait-matcher.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-wait-')))
const matcher = createMatcher(testMatcherStart(), spawn)
afterAll(() => {
  matcher.close()
  if (root.includes('walnut-host-exec-wait-')) fs.rmSync(root, { recursive: true, force: true })
})

function patternOf(output: string) {
  const p = parseWaitFor({ output })
  if (!p.ok || !p.pattern) throw new Error(`expected ${output} to be accepted`)
  return p.pattern
}

/** Push text, then take: the texts of the lines ready to test as lines (not a skip, not a peek). */
function feed(s: LineSplitter, text: string, edge: ScanEdge = 'more', partial = false): string[] {
  s.push(Buffer.from(text))
  return s.take(edge, partial).filter((l) => !l.skip && !l.peek).map((l) => l.text)
}

describe('createLineSplitter', () => {
  it('gives each whole line once, with where it starts and where the next begins; a line split across pushes is one', () => {
    const s = createLineSplitter(10)
    expect(feed(s, 'starting\nvite v5\n  listening')).toEqual(['starting', 'vite v5'])
    expect(feed(s, ' on :5173\nmore')).toEqual(['  listening on :5173'])
    s.push(Buffer.from('\n'))
    const at = 10 + 'starting\nvite v5\n  listening on :5173\n'.length
    expect(s.take('more', false)).toEqual([{ text: 'more', cut: false, start: at, end: at + 5 }])
  })

  it('a line still being written counts only once the job ended, or with partial once it went quiet', () => {
    // 2026-11-04 real-use review: `printf RES; sleep 3; printf "ULT\n"` matched /^RES$/.
    let now = 1_000
    const s = createLineSplitter(0, { now: () => now })
    expect(feed(s, 'RES', 'now')).toEqual([])
    now += 10 * WAIT_CHECK_MS
    expect(feed(s, '', 'now')).toEqual([])
    expect(feed(s, 'ULT\n', 'now')).toEqual(['RESULT'])
    // partial: a prompt with no newline, once it has not grown for a check.
    const p = createLineSplitter(0, { now: () => now })
    expect(feed(p, 'Password: ', 'now', true)).toEqual([])
    now += WAIT_CHECK_MS - 1
    expect(feed(p, '', 'now', true)).toEqual([])
    now += 1
    expect(feed(p, '', 'now', true)).toEqual(['Password: '])
    expect(feed(p, '', 'now', true)).toEqual([]) // tested once while it does not change
    // With more output already written after it, never; once the job ended, at once.
    const d = createLineSplitter(0, { now: () => now })
    expect(feed(d, 'last words', 'more', true)).toEqual([])
    expect(feed(d, '', 'done')).toEqual(['last words'])
    // Without partial, a quiet unfinished line still comes once, as a peek: tested only to say it would match.
    const q = createLineSplitter(0, { now: () => now })
    q.push(Buffer.from('Continue? '))
    expect(q.take('now', false)).toEqual([])
    now += WAIT_CHECK_MS
    expect(q.take('now', false)).toEqual([{ text: 'Continue? ', cut: false, start: 0, end: null, upTo: 10, peek: true }])
    expect(q.take('now', false)).toEqual([])
    // A peek is no test: at the job's end the same line is tested as a line (review of this change).
    expect(q.take('done', false)).toEqual([{ text: 'Continue? ', cut: false, start: 0, end: null, upTo: 10 }])
    expect(q.take('done', false)).toEqual([])
  })

  it('a carriage return ends a line at once, as a terminal shows it, and a CRLF split in two is one end', () => {
    // 2026-11-04 real-use review: `printf "Downloading 50%\r"; sleep 3` matched /50%$/ only after 3 s,
    // when the next byte came, though the help says a line ends at \r.
    const s = createLineSplitter()
    expect(feed(s, '[1/3] a\r[2/3] b\r')).toEqual(['[1/3] a', '[2/3] b'])
    expect(feed(s, '\n[3/3] c\r\n')).toEqual(['[3/3] c'])
    const blank = createLineSplitter()
    expect(feed(blank, 'a\r')).toEqual(['a'])
    // The \n of that CRLF ends nothing more: no empty line, and its byte is counted as passed.
    blank.push(Buffer.from('\nb\n'))
    expect(blank.take('more', false)).toEqual([
      { text: '', cut: false, start: 2, end: 3, skip: true },
      { text: 'b', cut: false, start: 3, end: 5 },
    ])
    // A CRLF whole at the end of a push: the next \n is an empty line of its own, not the CRLF's.
    const crlf = createLineSplitter()
    expect(feed(crlf, 'a\r\n')).toEqual(['a'])
    expect(feed(crlf, '\nb\n')).toEqual(['', 'b'])
    // A split right after the \r: the next splitter (a later wait from there) knows the \n may still come.
    const later = createLineSplitter(2, { afterCR: true })
    expect(feed(later, '\nnext\n')).toEqual(['next'])
    expect(feed(createLineSplitter(2), '\nnext\n')).toEqual(['', 'next'])
  })

  it('tests a long line on its first 64 K characters once, skips the rest, and counts it', () => {
    const s = createLineSplitter(100)
    const head = feed(s, 'x'.repeat(LINE_TEST_MAX * 2))
    expect(head).toHaveLength(1)
    expect(head[0]).toHaveLength(LINE_TEST_MAX)
    expect(feed(s, 'needle, still the same line')).toEqual([])
    const rest = (s.push(Buffer.from(' end\nnext line\n')), s.take('more', false))
    expect(rest[0]).toMatchObject({ skip: true, end: 100 + LINE_TEST_MAX * 2 + 'needle, still the same line end\n'.length })
    expect(rest.slice(1).map((l) => l.text)).toEqual(['next line'])
    expect(s.long).toEqual({ lines: 1, at: 100, last: 100 })
    // A whole line that is long: cut, and counted.
    const w = createLineSplitter()
    w.push(Buffer.from(`${'y'.repeat(LINE_TEST_MAX + 10)}\nok\n`))
    expect(w.take('more', false).map((l) => [l.text.length, l.cut])).toEqual([[LINE_TEST_MAX, true], [2, false]])
    expect(w.long).toEqual({ lines: 1, at: 0, last: 0 })
  })

  it('takes about maxChars of text at a time', () => {
    // 2026-11-04 review: pending lines were capped by count only, 4096 lines of up to 64 K each.
    const s = createLineSplitter()
    s.push(Buffer.from(`${'a'.repeat(1_000)}\n`.repeat(10)))
    const some = s.take('more', false, Number.POSITIVE_INFINITY, 2_500)
    expect(some).toHaveLength(3)
    expect(s.backlog).toBe(true)
    expect(s.take('more', false)).toHaveLength(7)
  })

  it('decodes only the bytes a long line\'s first 64 K characters take', () => {
    // 2026-11-04 review: a cut line was a slice of a 256 KB decoded string, which kept all of it alive.
    const decoded: number[] = []
    const toString = Buffer.prototype.toString
    const spy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args: Parameters<Buffer['toString']>) {
      decoded.push(this.length)
      return toString.apply(this, args)
    })
    try {
      const w = createLineSplitter()
      w.push(Buffer.from(`${'x'.repeat(300_000)}\n`))
      const [line] = w.take('more', false)
      expect(line).toMatchObject({ cut: true })
      expect(line!.text).toHaveLength(LINE_TEST_MAX)
    } finally {
      spy.mockRestore()
    }
    expect(Math.max(...decoded)).toBe(LINE_TEST_MAX)
    // Characters of two, three and four bytes (test data, escaped): cut on a whole character, at 64 K string units.
    for (const ch of ['\u00e9', '\u2713', '\u{1F600}']) {
      const m = createLineSplitter()
      m.push(Buffer.from(`${ch.repeat(LINE_TEST_MAX)}x\n`))
      const [l] = m.take('more', false)
      expect(l).toMatchObject({ cut: true })
      expect(l!.text).toBe(ch.repeat(LINE_TEST_MAX / ch.length))
    }
  })

  it('never cuts a character in two, and `midLine` drops the part of a line it starts inside', () => {
    // Test data: a check mark (escaped), its last byte still to come.
    const mark = Buffer.from('ok \u2713')
    const s = createLineSplitter()
    s.push(mark.subarray(0, mark.length - 1))
    expect(s.take('done', false).map((l) => l.text)).toEqual(['ok '])
    s.push(mark.subarray(mark.length - 1))
    expect(s.take('done', false).map((l) => l.text)).toEqual(['ok \u2713'])
    const mid = createLineSplitter(500, { midLine: true })
    expect(feed(mid, 'tail of a line\nwhole\n')).toEqual(['whole'])
  })
})

describe('resolveWaitFile', () => {
  const place = { cwd: '/w/repo', home: '/h', taskDir: '/t/task-1' }
  it.each([
    ['dist/a.js', '/w/repo/dist/a.js'], ['/abs/x', '/abs/x'], ['~', '/h'], ['~/x/y', '/h/x/y'],
    ['$WALNUT_TASK_DIR/out.txt', '/t/task-1/out.txt'], ['${WALNUT_TASK_DIR}/out.txt', '/t/task-1/out.txt'], ['../up', '/w/up'],
  ])('%s is %s', (file, want) => {
    expect(resolveWaitFile(file, place)).toBe(want)
  })
})

async function listen(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((s) => s.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve()) })
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('probePort and probeFile', () => {
  it('a port that accepts a connection on loopback, and one that does not', async () => {
    const s = await listen('127.0.0.1')
    try {
      expect(await probePort(s.port)).toBe(`127.0.0.1:${s.port}`)
    } finally {
      await s.close()
    }
    expect(await probePort(s.port)).toBeNull()
  })

  it('a server bound only to one of this host\'s own addresses counts too', async () => {
    // 2026-11-04 real-use review: `http.server --bind <container address>` served, yet the wait said "not listening".
    const own = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
    if (!own) return // a machine with loopback only has nothing else to bind
    expect(localAddresses()).toContain(own.address)
    const s = await listen(own.address)
    try {
      expect(await probePort(s.port, 500, ['127.0.0.1', '::1'])).toBeNull() // what the loopback-only probe saw
      expect(await probePort(s.port)).toBe(`${own.address}:${s.port}`)
    } finally {
      await s.close()
    }
  })

  it('file looks that answer in time are never "busy", however many run at once', async () => {
    // 2026-11-04 review: the cap counted healthy looks in flight, so a third local file checked at
    // once was "busy", reported as a stuck network mount, and a file that existed read as not seen.
    const slowOk = () => new Promise<void>((r) => setTimeout(r, 50))
    const looks = await Promise.all(['/ok/a', '/ok/b', '/ok/c', '/ok/d'].map((f) => probeFile(f, 1_000, slowOk)))
    expect(looks).toEqual(['yes', 'yes', 'yes', 'yes'])
  })

  it('stuck looks never take the whole thread pool: at most three in flight, and a fourth path waits its deadline, then is "busy"', async () => {
    // Review of this change: counting only looks past their deadline let any number of new paths
    // start a stat on a dead mount within its first second, and four hung stats fill node's pool.
    let answer: () => void = () => {}
    const stuck = new Promise<void>((r) => { answer = r })
    let asked = 0
    const stat = () => { asked++; return stuck }
    const looks = Promise.all(['/dead/a', '/dead/b', '/dead/c'].map((f) => probeFile(f, 2_000, stat)))
    const t0 = Date.now()
    expect(await probeFile('/dead/d', 300, stat)).toBe('busy')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(asked).toBe(3)
    answer()
    expect(await looks).toEqual(['yes', 'yes', 'yes'])
  })

  it('a file look that never answers (a stuck mount) is "unanswered" in time, not asked again while it hangs, and others are "busy"', async () => {
    // 2026-11-04 review: existsSync every 200 ms held the daemon's loop on a stuck NFS or SMB mount.
    let answer: () => void = () => {}
    const stuck = new Promise<void>((r) => { answer = r })
    let asked = 0
    const stat = () => { asked++; return stuck }
    const t0 = Date.now()
    expect(await probeFile('/stuck/a', 100, stat)).toBe('unanswered')
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(await probeFile('/stuck/a', 50, stat)).toBe('unanswered')
    expect(asked).toBe(1)
    expect(await probeFile('/stuck/b', 50, stat)).toBe('unanswered')
    // Two looks hung past their deadline: a third path is not asked while they hang (a timer may
    // fire a millisecond before the wall clock says the deadline passed: give it a few).
    await new Promise((r) => setTimeout(r, 5))
    expect(await probeFile('/stuck/c', 50, stat)).toBe('busy')
    // A wait on a file then names it instead of reading as "not yet".
    const check = createWaitCheck({ file: 'ready.txt' }, null, { logFile: path.join(root, 'none.log'), cwd: root, home: root, taskDir: null, from: 0 }, matcher)
    const w = await waitUntil(check, { ended: () => true, onEnd: () => () => {} }, 1_000)
    expect(w).toMatchObject({ matched: null, unchecked: expect.stringContaining(`could not check \`${path.join(root, 'ready.txt')}\``) })
    expect(asked).toBe(2)
    answer()
    await stuck
    await new Promise((r) => setImmediate(r))
    expect(await probeFile('/stuck/c', 100, async () => {})).toBe('yes')
    expect(await probeFile(path.join(root, 'no-such-file'), 1_000)).toBe('no')
  })
})

/** A check on one log with the shared matcher. */
function checkOn(logFile: string, raw: WaitFor, from = 0, jobId?: string) {
  const p = parseWaitFor(raw)
  if (!p.ok) throw new Error(p.error)
  return createWaitCheck(p.waitFor, p.pattern, { logFile, cwd: root, home: root, taskDir: null, from, ...(jobId ? { jobId } : {}) }, matcher)
}
const running = { ended: () => false, onEnd: () => () => {} }
const ended = { ended: () => true, onEnd: () => () => {} }

describe('the wait on a log', () => {
  it('reads at most 1 MB per check and finds a match past it; from an offset, only what follows', async () => {
    const logFile = path.join(root, 'big.log')
    fs.writeFileSync(logFile, `${'noise line\n'.repeat(150_000)}server ready\n`)
    const check = checkOn(logFile, { output: 'ready' })
    const first = await check(false)
    expect(first).toMatchObject({ hit: null, settled: false })
    expect(first.scanned).toBeLessThanOrEqual(1024 * 1024)
    expect(await waitUntil(checkOn(logFile, { output: 'ready' }), running, 20_000)).toMatchObject({ matched: 'output', match: 'server ready', scanned: fs.statSync(logFile).size })
    const later = checkOn(logFile, { output: 'ready' }, fs.statSync(logFile).size)
    expect(await later(false)).toMatchObject({ hit: null, settled: true })
    fs.appendFileSync(logFile, 'ready again\n')
    expect((await later(false)).hit).toMatchObject({ kind: 'output', match: 'ready again' })
  }, 30_000)

  it('dense output, over a million empty lines, is tested in turn without piling every line up at once', async () => {
    // 2026-11-04 review: one check took all the lines of 1 MB and spread them into one call, which
    // throws past about 125 000 lines on node and 638 000 on bun, so the line never came.
    const logFile = path.join(root, 'dense.log')
    fs.writeFileSync(logFile, `${'\n'.repeat(1_200_000)}the end\n`)
    expect(await waitUntil(checkOn(logFile, { output: '^the end$' }), ended, 30_000)).toMatchObject({ matched: 'output', match: 'the end', scanned: fs.statSync(logFile).size })
  }, 40_000)

  it('after a match on a line still being written, a wait from `scanned` goes on after it, not at the same line', async () => {
    const logFile = path.join(root, 'resume.log')
    fs.writeFileSync(logFile, 'boot\nPassword: ')
    const first = await waitUntil(checkOn(logFile, { output: 'Password: ', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', scanned: 'boot\nPassword: '.length })
    fs.appendFileSync(logFile, 'hunter\nPassword: again\n')
    // From inside the line it matched: that whole line is tested, and only a match past what was there counts.
    const next = await waitUntil(checkOn(logFile, { output: 'Password: |^hunter$', partial: true }, first.scanned), running, 5_000)
    expect(next).toMatchObject({ matched: 'output', match: 'Password: again' })
    // Any offset inside a line works the same way.
    expect(await waitUntil(checkOn(logFile, { output: '^ot$' }, 2), ended, 2_000)).toMatchObject({ matched: null })
  })

  it('from inside a line, a match that takes in what came after the offset counts, on a line still written or one that ended (2026-11-05 review)', async () => {
    // From offset 10 of `Password: typed`, a wait for /typed/ skipped the rest of the line and missed it.
    const logFile = path.join(root, 'typed.log')
    fs.writeFileSync(logFile, 'Password: ')
    const first = await waitUntil(checkOn(logFile, { output: 'Password:', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', scanned: 10, unfinished: true })
    // Nothing new on the line yet: the same prompt is not seen again.
    expect(await waitUntil(checkOn(logFile, { output: 'Password:', partial: true }, first.scanned), running, 600)).toMatchObject({ matched: null })
    fs.appendFileSync(logFile, 'typed\nAUTH_OK\n')
    expect(await waitUntil(checkOn(logFile, { output: 'typed' }, first.scanned), running, 5_000)).toMatchObject({ matched: 'output', match: 'Password: typed', matchAt: 0 })
    expect(await waitUntil(checkOn(logFile, { output: 'AUTH_OK' }, first.scanned), running, 5_000)).toMatchObject({ matched: 'output', match: 'AUTH_OK' })
    // Only the old part matches: no hit there, the next line is tested.
    expect(await waitUntil(checkOn(logFile, { output: 'Pass|AUTH' }, first.scanned), running, 5_000)).toMatchObject({ matched: 'output', match: 'AUTH_OK' })
    // A finished job: an offset inside `tick 6` tests that line whole.
    const ticks = path.join(root, 'ticks.log')
    fs.writeFileSync(ticks, 'tick 5\ntick 6\ntick 7\n')
    expect(await waitUntil(checkOn(ticks, { output: 'tick 6' }, 9), ended, 2_000)).toMatchObject({ matched: 'output', match: 'tick 6', matchAt: 7 })
    // A match that runs over the offset takes in new output: it counts.
    expect(await waitUntil(checkOn(ticks, { output: 'ck 6' }, 9), ended, 2_000)).toMatchObject({ matched: 'output', match: 'tick 6' })
  })

  it('from inside a line, pieces ended by a \\r before the offset are not tested again (2026-11-05 code review)', async () => {
    // A progress bar before a prompt: the wait from `scanned` matched the same prompt again at once.
    const logFile = path.join(root, 'cr-resume.log')
    fs.writeFileSync(logFile, 'boot\nDownloading 50%\rDownloading 100%\rPassword: ')
    const first = await waitUntil(checkOn(logFile, { output: 'Password:', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', matchAt: 38, scanned: 48 })
    expect(await waitUntil(checkOn(logFile, { output: 'Password:', partial: true }, first.scanned), running, 600)).toMatchObject({ matched: null })
    // A line wholly before the offset: not matched, and `scanned` never goes behind the offset.
    const b2 = path.join(root, 'cr-resume2.log')
    fs.writeFileSync(b2, 'boot\nstep 1 ok\rstep 2 FAILED\rstep 3 ok\n')
    const w = await waitUntil(checkOn(b2, { output: 'FAILED' }, 34), ended, 2_000)
    expect(w).toMatchObject({ matched: null })
    expect(w.scanned).toBeGreaterThanOrEqual(34)
    // The piece the offset falls in still counts its new part.
    expect(await waitUntil(checkOn(b2, { output: 'ok$' }, 34), ended, 2_000)).toMatchObject({ matched: 'output', match: 'step 3 ok' })
  })

  it('from inside a long line, an ordinary pattern answers quickly, and a trailing repeat that runs over the offset counts (2026-11-05 code review)', async () => {
    // A read stopped inside a 12 000 character line of digits; a wait from there for \\d+ came back too slow.
    const logFile = path.join(root, 'long-resume.log')
    fs.writeFileSync(logFile, '1'.repeat(12_000))
    fs.appendFileSync(logFile, `${'2'.repeat(12_000)} DONE 42\n`)
    const t0 = Date.now()
    expect(await waitUntil(checkOn(logFile, { output: '\\d+' }, 12_000), ended, 5_000)).toMatchObject({ matched: 'output', matchAt: 0 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    // `port \\d+` on `listening on port 30`, then `00`: the match takes in the new digits.
    const port = path.join(root, 'port-resume.log')
    fs.writeFileSync(port, 'listening on port 30')
    const first = await waitUntil(checkOn(port, { output: 'port \\d+', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', scanned: 20 })
    fs.appendFileSync(port, '00\n')
    expect(await waitUntil(checkOn(port, { output: 'port \\d+' }, first.scanned), ended, 2_000)).toMatchObject({ matched: 'output', match: 'listening on port 3000' })
  })

  it('from a match, a trailing repeat that may match nothing never matches the same text again; a new line does (2026-11-05 code review 11)', async () => {
    // `Password:.*` matched the prompt, and from `scanned` matched it again once anything was typed.
    const logFile = path.join(root, 'tail-repeat.log')
    fs.writeFileSync(logFile, 'Password: ')
    const first = await waitUntil(checkOn(logFile, { output: 'Password:.*', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', scanned: 10 })
    fs.appendFileSync(logFile, 'typed\n')
    expect(await waitUntil(checkOn(logFile, { output: 'Password:.*', partial: true }, first.scanned), running, 600)).toMatchObject({ matched: null })
    fs.appendFileSync(logFile, 'retry\nPassword: ')
    expect(await waitUntil(checkOn(logFile, { output: 'Password:.*', partial: true }, first.scanned), running, 5_000)).toMatchObject({ matched: 'output', matchAt: 22 })
  })

  it('from deep inside a long line, a pattern whose first match covers the offset, or starts near it, answers quickly (2026-11-05 code review 11)', async () => {
    const letters = path.join(root, 'letters.log')
    fs.writeFileSync(letters, `abc ${'q'.repeat(30_000)} done\n`)
    for (const [output, from] of [['[a-z]\\w*', 20_000], ['\\w.*done', 15_000], ['q+ done', 29_000]] as const) {
      const t0 = Date.now()
      expect(await waitUntil(checkOn(letters, { output }, from), ended, 5_000), output).toMatchObject({ matched: 'output', matchAt: 0 })
      expect(Date.now() - t0, output).toBeLessThan(2_000)
    }
    // A run that ends right at the offset (code review 12: the shape that was slow): every start
    // in it matches up to the offset and no further, so only the ones near the offset are tried.
    const t0 = Date.now()
    expect(await waitUntil(checkOn(letters, { output: 'q+' }, 30_004), ended, 5_000)).toMatchObject({ matched: null })
    expect(Date.now() - t0).toBeLessThan(2_000)
    // Past the line's first match, a match is looked for only from 1 K characters before the offset.
    const far = path.join(root, 'far-start.log')
    fs.writeFileSync(far, `B done B${'x'.repeat(2_000)} done\n`)
    expect(await waitUntil(checkOn(far, { output: 'B\\w* done' }, 7), ended, 2_000)).toMatchObject({ matched: 'output' })
    expect(await waitUntil(checkOn(far, { output: 'B\\w* done' }, 2_008), ended, 2_000)).toMatchObject({ matched: null })
  })

  it('from a partial match, a trailing `.+` is the rest of the line too: the prompt is not matched again (2026-11-05 code review 12)', async () => {
    const logFile = path.join(root, 'tail-plus.log')
    fs.writeFileSync(logFile, 'Password: ')
    for (const output of ['Password:.+', 'Password:.{1,}']) {
      const first = await waitUntil(checkOn(logFile, { output, partial: true }), running, 5_000)
      expect(first, output).toMatchObject({ matched: 'output', scanned: 10 })
    }
    fs.appendFileSync(logFile, 'x')
    for (const output of ['Password:.+', 'Password:.{1,}']) {
      expect(await waitUntil(checkOn(logFile, { output, partial: true }, 10), running, 600), output).toMatchObject({ matched: null })
    }
  })

  it('from inside a \\r piece more than 64 KB past the last newline, the earlier pieces are still not tested again (2026-11-05 code review 11)', async () => {
    const logFile = path.join(root, 'cr-far.log')
    fs.writeFileSync(logFile, `boot\n${`${'p'.repeat(999)}\r`.repeat(80)}Password: `)
    const first = await waitUntil(checkOn(logFile, { output: 'Password:', partial: true }), running, 5_000)
    expect(first).toMatchObject({ matched: 'output', matchAt: 5 + 80_000 })
    expect(await waitUntil(checkOn(logFile, { output: 'Password:|p{999}', partial: true }, first.scanned), running, 600)).toMatchObject({ matched: null })
    // The piece the offset falls in still counts its new part (the bug: the wait started past that piece and missed it).
    fs.appendFileSync(logFile, 'OK done\n')
    expect(await waitUntil(checkOn(logFile, { output: 'OK done' }, first.scanned), ended, 2_000)).toMatchObject({ matched: 'output', match: 'Password: OK done' })
  })

  it('an offset inside a colour code counts from where the visible text is (2026-11-05 code review 11)', async () => {
    const logFile = path.join(root, 'ansi-resume.log')
    fs.writeFileSync(logFile, '\x1b[32mREADY\x1b[0m\n')
    expect(await waitUntil(checkOn(logFile, { output: 'READY' }, 2), ended, 2_000)).toMatchObject({ matched: 'output', match: 'READY', matchAt: 0 })
    // Inside the code after READY: READY ended before it.
    expect(await waitUntil(checkOn(logFile, { output: 'READY' }, 12), ended, 2_000)).toMatchObject({ matched: null })
    // A read that stopped inside a code still being written (code review 12: the shape the old code missed).
    const split = path.join(root, 'ansi-split.log')
    fs.writeFileSync(split, 'ready \x1b[3')
    fs.appendFileSync(split, '2mgo\n')
    expect(await waitUntil(checkOn(split, { output: 'ready go' }, 9), ended, 2_000)).toMatchObject({ matched: 'output', match: 'ready go' })
  })

  it('what a run looked at before it started counts only where the look saw either way (2026-11-05 code review 11)', async () => {
    const place = { cwd: root, home: root, taskDir: null }
    const file = path.join(root, 'before.txt')
    const ask = (port: Awaited<ReturnType<NonNullable<Parameters<typeof waitBefore>[2]>['port']>>, there: Awaited<ReturnType<typeof probeFile>>) =>
      waitBefore({ port: 5173, file }, place, { port: async () => port, file: async () => there })
    expect(await ask({ at: null }, 'no')).toMatchObject({ ok: true, before: { ports: [], files: [], looked: { ports: [5173], files: [file] } } })
    expect(await ask({ at: '127.0.0.1:5173' }, 'yes')).toMatchObject({ ok: true, before: { ports: [5173], files: [file], looked: { ports: [5173], files: [file] } } })
    // Tables not read in time, a file it could not stat: not looked, so a later read never says it came while the job ran.
    expect(await ask({ at: null, unread: true }, 'denied')).toMatchObject({ ok: true, before: { ports: [], files: [], looked: { ports: [], files: [] } } })
    expect(await ask({ at: null }, 'unanswered')).toMatchObject({ ok: true, before: { looked: { ports: [5173], files: [] } } })
  })

  it('a file wait whose path stays closed to the user ends early, saying so; one with a pattern too goes on (2026-11-05 review)', async () => {
    if (process.getuid?.() === 0) return // root reads a closed directory
    const closed = path.join(root, 'closed-dir')
    fs.mkdirSync(closed, { mode: 0o700 })
    fs.chmodSync(closed, 0o000)
    try {
      const t0 = Date.now()
      const w = await waitUntil(checkOn(path.join(root, 'none.log'), { file: path.join(closed, 'out.txt') }), running, 10_000)
      expect(w).toMatchObject({ matched: null, unreachable: true, unchecked: expect.stringContaining('permission denied') })
      expect(Date.now() - t0).toBeLessThan(DENIED_GIVE_UP_MS + 2_000)
      const log = path.join(root, 'closed-and-output.log')
      fs.writeFileSync(log, '')
      const both = await waitUntil(checkOn(log, { file: path.join(closed, 'out.txt'), output: 'never' }), running, DENIED_GIVE_UP_MS + 1_000)
      expect(both.unreachable).toBeUndefined()
    } finally {
      fs.chmodSync(closed, 0o700)
    }
  }, 20_000)

  it('a match on the last line a job wrote waits a moment for its end, so a job printing it as it exits reads as ended (2026-11-05 review)', async () => {
    const logFile = path.join(root, 'exit-race.log')
    fs.writeFileSync(logFile, 'READY now\n')
    let done = false
    let wake: (() => void) | null = null
    const job = { ended: () => done, onEnd: (fn: () => void) => { wake = fn; return () => { wake = null } } }
    setTimeout(() => { done = true; wake?.() }, 30)
    const t0 = Date.now()
    expect(await waitUntil(checkOn(logFile, { output: 'READY' }), job, 5_000)).toMatchObject({ matched: 'output' })
    expect(done).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1_000)
    // More output after the matched line: no wait for an end.
    fs.writeFileSync(logFile, 'READY now\nserving\n')
    const t1 = Date.now()
    const w = await waitUntil(checkOn(logFile, { output: 'READY' }), running, 5_000)
    expect(w).toMatchObject({ matched: 'output' })
    expect(Date.now() - t1).toBeLessThan(END_GRACE_MS)
  })

  it('a strict run\'s own line about its failed step is never matched; a job\'s own line that looks like one is (2026-11-05 reviews)', async () => {
    // wait_for "exit 2" matched `walnut strict: exit 2 [2 0]: cat`, a line the job never printed.
    const logFile = path.join(root, 'strict.log')
    // The line as the run writes it carries its seal (host-exec-strict.ts); the form without one is skipped too.
    fs.writeFileSync(logFile, 'building\nls: /nope: No such file\n\nwalnut strict hx-strict-1 a1b2c3d4e5f6: exit 2 [2 0] line 1: cat\nwalnut strict hx-strict-1: exit 2 [2 0]: cat\n')
    expect(await waitUntil(checkOn(logFile, { output: 'exit 2' }, 0, 'hx-strict-1'), ended, 2_000)).toMatchObject({ matched: null })
    fs.appendFileSync(logFile, 'the job: exit 2 seen\n')
    expect(await waitUntil(checkOn(logFile, { output: 'exit 2' }, 0, 'hx-strict-1'), ended, 2_000)).toMatchObject({ matched: 'output', match: 'the job: exit 2 seen' })
    // Review 12: a job printing that text (or another job's log) was skipped, and its READY never matched.
    const own = path.join(root, 'strict-own.log')
    fs.writeFileSync(own, 'walnut strict: exit 0 [0]: READY\nwalnut strict hx-other-9: exit 1 [1]: READY\n')
    expect(await waitUntil(checkOn(own, { output: 'READY' }, 0, 'hx-strict-1'), ended, 2_000)).toMatchObject({ matched: 'output', match: 'walnut strict: exit 0 [0]: READY' })
  })

  it('a job that ends during the last look at the bound gets one short look more, so its last line counts', async () => {
    let done = false
    let looks = 0
    const t0 = Date.now()
    const w = await waitUntil(async (endedNow, deadline) => {
      looks++
      if (looks === 1) { await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()) + 20)); done = true; return { hit: null, settled: true } }
      return endedNow ? { hit: { kind: 'output' as const, match: 'DONE' }, settled: true } : { hit: null, settled: true }
    }, { ended: () => done, onEnd: () => () => {} }, 300)
    expect(w).toMatchObject({ matched: 'output', match: 'DONE' })
    expect(looks).toBe(2)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('a line of 60 K characters matches at its end; past 64 K it does not, and the answer says the line was cut', async () => {
    // 2026-11-04 real-use review: a 501-character line was tested on its first 500 and the answer said the line never came.
    const logFile = path.join(root, 'long.log')
    fs.writeFileSync(logFile, `${'x'.repeat(60_000)} RESULT=ok\n`)
    expect(await waitUntil(checkOn(logFile, { output: 'RESULT=ok' }), ended, 5_000)).toMatchObject({ matched: 'output' })
    fs.writeFileSync(logFile, `start\n${'x'.repeat(100_000)} RESULT=ok\n`)
    expect(await waitUntil(checkOn(logFile, { output: 'RESULT=ok' }), ended, 5_000)).toMatchObject({ matched: null, long: { lines: 1, at: 6 } })
  })

  it('colour codes are removed before a line is tested, and the match comes back without them', async () => {
    const logFile = path.join(root, 'ansi.log')
    fs.writeFileSync(logFile, '\x1b[32mVITE\x1b[0m ready in \x1b[1m312\x1b[0m ms\n')
    expect(await waitUntil(checkOn(logFile, { output: 'ready in 312 ms' }), ended, 5_000)).toMatchObject({ matched: 'output', match: 'VITE ready in 312 ms' })
  })

  it('only whole lines by default: an unfinished `RES` never matches /^RES$/; with partial a prompt does', async () => {
    const logFile = path.join(root, 'prompt.log')
    fs.writeFileSync(logFile, 'RES')
    expect(await waitUntil(checkOn(logFile, { output: '^RES$' }), running, 3 * WAIT_CHECK_MS)).toMatchObject({ matched: null })
    fs.writeFileSync(logFile, 'Password: ')
    expect(await waitUntil(checkOn(logFile, { output: '^Password: $', partial: true }), running, 5_000)).toMatchObject({ matched: 'output', match: 'Password: ' })
  })

  it('a pattern that runs away on a line ends the wait as too slow, without holding the loop', async () => {
    const logFile = path.join(root, 'slow.log')
    fs.writeFileSync(logFile, `first\n${'a'.repeat(20_000)}\nlast\n`)
    let last = performance.now()
    let gap = 0
    const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t }, 10)
    const w = await waitUntil(checkOn(logFile, { output: 'a.*a.*a.*b' }), running, 10_000).finally(() => clearInterval(tick))
    expect(w).toMatchObject({ matched: null, tooSlow: true })
    // The tested offset stays before the line that ran away (its batch is not counted).
    expect(w.scanned).toBeLessThanOrEqual('first\n'.length)
    expect(w.ms).toBeLessThan(5_000)
    expect(gap).toBeLessThan(200)
  }, 20_000)

  it('waits take turns in the matcher: a wait whose match is at the start answers while another tests a long log', async () => {
    const busyLog = path.join(root, 'busy.log')
    fs.writeFileSync(busyLog, `${'a'.repeat(600)}\n`.repeat(20_000))
    const quickLog = path.join(root, 'quick.log')
    fs.writeFileSync(quickLog, 'boot\nready\n')
    const t0 = Date.now()
    const busy = waitUntil(checkOn(busyLog, { output: 'a.*a.*b' }), running, 4_000)
    await new Promise((r) => setTimeout(r, 300))
    const quick = await waitUntil(checkOn(quickLog, { output: '^ready$' }), running, 4_000)
    expect(quick).toMatchObject({ matched: 'output', match: 'ready' })
    expect(quick.ms).toBeLessThan(1_000)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(await busy).toMatchObject({ matched: null, untested: expect.any(Number) })
  }, 20_000)

  it('waitUntil ends at a hit (a port or file at its first look is `already`), at the job\'s end after one more look, or at its bound', async () => {
    let hitAt = 3
    const none = { hit: null, settled: true }
    expect(await waitUntil(async () => (--hitAt === 0 ? { hit: { kind: 'port' as const, match: 'x' }, settled: true } : none), running, 5_000)).toEqual({ matched: 'port', match: 'x', ms: expect.any(Number) })
    expect(await waitUntil(async () => ({ hit: { kind: 'file' as const, match: '/f' }, settled: true }), running, 5_000)).toMatchObject({ matched: 'file', already: true })
    const t0 = Date.now()
    expect(await waitUntil(async () => none, running, 450)).toMatchObject({ matched: null })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    let wake: () => void = () => {}
    let done = false
    let looks = 0
    const t1 = Date.now()
    setTimeout(() => { done = true; wake() }, 50)
    expect(await waitUntil(async () => { looks++; return none }, { ended: () => done, onEnd: (w) => { wake = w; return () => {} } }, 10_000)).toMatchObject({ matched: null })
    expect(Date.now() - t1).toBeLessThan(1_000)
    expect(looks).toBe(2)
  })

  it('after the job ended the wait tests all of its output, and says how much it could not', async () => {
    const logFile = path.join(root, 'ended.log')
    fs.writeFileSync(logFile, `${'build output line\n'.repeat(180_000)}DONE\n`)
    expect(await waitUntil(checkOn(logFile, { output: '^DONE$' }), ended, 30_000)).toMatchObject({ matched: 'output', match: 'DONE' })
    const short = await waitUntil(checkOn(logFile, { output: '^DONE$' }), ended, 1)
    expect(short).toMatchObject({ matched: null })
    expect(short.untested).toBeGreaterThan(1024 * 1024)
    expect(short.scanned! + short.untested!).toBe(fs.statSync(logFile).size)
  }, 40_000)

  it('a matcher that answers late never holds a wait past its bound: its lines stay untested, one ask covers every look, and it is withdrawn at the end', async () => {
    // 2026-11-04 review: a wait of 500 ms answered after 5 s on a slow matcher (a loaded host), past
    // the read deadline of a caller on another host, which then got 503 host_offline.
    const logFile = path.join(root, 'late.log')
    fs.writeFileSync(logFile, 'boot\nready\n')
    let asked = 0
    let withdrawn = 0
    const late: Matcher = {
      pid: null,
      close() {},
      ask(_pattern, lines) {
        asked++
        const result = new Promise<MatchResult>((r) => setTimeout(() => r({ tested: lines.length, hit: 1 }), 5_000))
        return { result, withdraw: () => { withdrawn++ } }
      },
      test(pattern, lines) { return this.ask(pattern, lines).result },
    }
    const p = parseWaitFor({ output: '^ready$', port: 1 })
    if (!p.ok) throw new Error(p.error)
    const t0 = Date.now()
    const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, { logFile, cwd: root, home: root, taskDir: null, from: 0 }, late), running, 500)
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(w).toMatchObject({ matched: null, scanned: 0, untested: 'boot\nready\n'.length })
    expect(asked).toBe(1)
    expect(withdrawn).toBe(1)
    // The real matcher: a wait on a runaway line that ends at its bound withdraws its batch, and the
    // next wait is answered by the same process, its own answer and not the withdrawn one's.
    const own = createMatcher(testMatcherStart(), spawn)
    try {
      expect(await own.test(patternOf('warm'), [{ text: 'warm', cut: false }])).toMatchObject({ hit: 0 })
      // About 1 to 2 ms a line: seconds of work, far past the bound.
      const slowLog = path.join(root, 'late-slow.log')
      fs.writeFileSync(slowLog, `${'a'.repeat(600)}\n`.repeat(2_000))
      const t1 = Date.now()
      const q = parseWaitFor({ output: 'a.*a.*b' })
      if (!q.ok) throw new Error(q.error)
      const bounded = await waitUntil(createWaitCheck(q.waitFor, q.pattern, { logFile: slowLog, cwd: root, home: root, taskDir: null, from: 0 }, own), running, 300)
      expect(Date.now() - t1).toBeLessThan(1_500)
      expect(bounded).toMatchObject({ matched: null, untested: expect.any(Number) })
      expect(await own.test(patternOf('^second$'), [{ text: 'first', cut: false }, { text: 'second', cut: false }])).toMatchObject({ hit: 1 })
    } finally {
      own.close()
    }
  }, 30_000)

  it('a line with no line end: at the job\'s end a match on it says `unfinished`; while it runs, without partial, the answer says it would match', async () => {
    // 2026-11-04 real-use review: `printf "Continue? [y/N] "; sleep 30` with timeout 8 s answered "Saw
    // /Continue\?/ after 8.0 s", as if the line came at 8 s; it was there at once, and only partial counts it.
    const logFile = path.join(root, 'prompt-end.log')
    fs.writeFileSync(logFile, 'boot\nContinue? [y/N] ')
    expect(await waitUntil(checkOn(logFile, { output: 'Continue\\?' }), ended, 5_000)).toMatchObject({ matched: 'output', match: 'Continue? [y/N] ', unfinished: true })
    const t0 = Date.now()
    const w = await waitUntil(checkOn(logFile, { output: 'Continue\\?' }), running, 1_000)
    expect(w).toMatchObject({ matched: null, wouldMatch: 'Continue? [y/N] ', scanned: 'boot\n'.length })
    expect(Date.now() - t0).toBeLessThan(2_500)
    // A whole line is not `unfinished`; a line still being written that does not match says nothing.
    expect((await waitUntil(checkOn(logFile, { output: '^boot$' }), ended, 5_000)).unfinished).toBeUndefined()
    expect((await waitUntil(checkOn(logFile, { output: 'never' }), running, 600)).wouldMatch).toBeUndefined()
    // One wait across the job's end: the line, quiet while the job ran (peeked), is tested as a line
    // when the job ends, and matches (review of this change: it read "no line matched").
    const across = path.join(root, 'prompt-across.log')
    fs.writeFileSync(across, 'boot\nBuild OK')
    const t2 = Date.now()
    const crossed = await waitUntil(checkOn(across, { output: 'Build OK' }), { ended: () => Date.now() - t2 > 700, onEnd: () => () => {} }, 5_000)
    expect(crossed).toMatchObject({ matched: 'output', match: 'Build OK', unfinished: true })
    // With partial it is a match, as before.
    expect(await waitUntil(checkOn(logFile, { output: 'Continue\\?', partial: true }), running, 5_000)).toMatchObject({ matched: 'output', unfinished: true })
    // A trailing \r ends its line at once: a progress line that stops there matches without waiting for the next byte.
    const bar = path.join(root, 'bar.log')
    fs.writeFileSync(bar, 'Downloading 10%\rDownloading 50%\r')
    const t1 = Date.now()
    expect(await waitUntil(checkOn(bar, { output: '50%$' }), running, 5_000)).toMatchObject({ matched: 'output', match: 'Downloading 50%', scanned: fs.statSync(bar).size })
    expect(Date.now() - t1).toBeLessThan(2_000)
  }, 20_000)

  it('without a matcher an output wait says so at once; a port wait still works', async () => {
    const logFile = path.join(root, 'nomatcher.log')
    fs.writeFileSync(logFile, 'ready\n')
    const p = parseWaitFor({ output: 'ready' })
    if (!p.ok) throw new Error(p.error)
    const w = await waitUntil(createWaitCheck(p.waitFor, p.pattern, { logFile, cwd: root, home: root, taskDir: null, from: 0 }, null), running, 5_000)
    expect(w).toMatchObject({ matched: null, error: 'this host has no pattern matcher' })
    const s = await listen('127.0.0.1')
    try {
      expect(await waitUntil(createWaitCheck({ port: s.port }, null, { logFile, cwd: root, home: root, taskDir: null, from: 0 }, null), running, 5_000)).toMatchObject({ matched: 'port' })
    } finally {
      await s.close()
    }
  })
})
