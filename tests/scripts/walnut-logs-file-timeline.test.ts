/**
 * `scripts/walnut-logs.sh file <substr>` — the one command for "who overwrote my
 * file?".
 *
 * Worth a test because it is the tool we reach for DURING an incident, when
 * nobody has time to notice it silently stopped stitching one of its three
 * sources. It joins server read/write/refusal lines (fields at the top level of
 * the JSON) with browser editor lines (fields inside a `args` JSON STRING), which
 * is exactly the kind of asymmetry that rots quietly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT = path.resolve(process.cwd(), 'scripts/walnut-logs.sh')
const TARGET = '/tmp/demo/report.md'

/** Today's LOCAL date, which is how the log FILENAME is dated (timestamps are UTC). */
function localDateStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** An ISO-8601 UTC timestamp `secs` seconds ago — inside any sane window. */
function ago(secs: number): string {
  return new Date(Date.now() - secs * 1000).toISOString()
}

let logDir: string

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-logs-file-'))
})
afterEach(async () => {
  await fs.rm(logDir, { recursive: true, force: true })
})

async function writeLog(lines: unknown[]): Promise<void> {
  await fs.writeFile(
    path.join(logDir, `open-walnut-${localDateStamp()}.log`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  )
}

async function run(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('bash', [SCRIPT, 'file', ...args], {
    env: { ...process.env, WALNUT_LOG_DIR: logDir },
    encoding: 'utf-8',
  })
  return stdout
}

describe('walnut-logs.sh file', () => {
  it('interleaves server reads/writes/refusals with the browser editor lines, in time order', async () => {
    await writeLog([
      // Out of order on purpose: the command must sort, not trust the file.
      { time: ago(20), level: 'info', subsystem: 'web', message: 'file write', path: TARGET, writer: 'live', hashBefore: 'aaaaaaaaaaaa', hashAfter: 'bbbbbbbbbbbb', expectedHash: 'aaaaaaaaaaaa', sizeBefore: 100, sizeAfter: 120 },
      { time: ago(40), level: 'info', subsystem: 'web', message: 'file read', path: TARGET, status: 200, hash: 'aaaaaaaaaaaa', inm: '(none)', size: 100, ms: 3 },
      { time: ago(30), level: 'info', subsystem: 'browser', message: '[file-editor] buffer installed', args: JSON.stringify({ path: TARGET, source: 'read', gen: 1, lockAfter: 'aaaaaaaaaaaa' }) },
      // A different file must not appear.
      { time: ago(35), level: 'info', subsystem: 'web', message: 'file read', path: '/tmp/demo/other.md', status: 200, hash: 'cccccccccccc' },
    ])
    const out = await run('report.md')
    const body = out.split('\n').filter((l) => /read |WRITE|editor/.test(l))
    expect(body).toHaveLength(3)
    expect(body[0]).toContain('<-- read')
    expect(body[1]).toContain('buffer installed')
    expect(body[2]).toContain('--> WRITE')
    expect(out).not.toContain('other.md')
    expect(out).toContain('3 events: 1 reads, 1 writes, 0 refused')
  })

  it('flags a machine write that SHRANK the file, which is the incident signature', async () => {
    await writeLog([
      { time: ago(10), level: 'info', subsystem: 'web', message: 'file write', path: TARGET, writer: 'live', hashBefore: 'aaaaaaaaaaaa', hashAfter: 'bbbbbbbbbbbb', sizeBefore: 40000, sizeAfter: 28896, shrankBy: 11104 },
    ])
    const out = await run('report.md')
    expect(out).toContain('WRITES THAT SHRANK THE FILE')
    expect(out).toContain('shrankBy=11104')
    expect(out).toContain('40000 -> 28896 bytes')
  })

  it('names the refusal reason (a client bug and a healthy race must not read alike)', async () => {
    await writeLog([
      { time: ago(12), level: 'warn', subsystem: 'web', message: 'file write refused', path: TARGET, writer: 'live', reason: 'unlocked-machine-write', expectedHash: '(none)', currentHash: 'bbbbbbbbbbbb', sizeBefore: 40000, attemptedSize: 28896, wouldHaveShrunkBy: 11104 },
      { time: ago(11), level: 'warn', subsystem: 'web', message: 'file write refused', path: TARGET, writer: 'user', reason: 'stale-lock', expectedHash: 'aaaaaaaaaaaa', currentHash: 'bbbbbbbbbbbb' },
    ])
    const out = await run('report.md')
    expect(out).toContain('reason=unlocked-machine-write')
    expect(out).toContain('reason=stale-lock')
    expect(out).toContain('0 reads, 0 writes, 2 refused')
    // A refusal is not a write: it must never be counted as one, or the guard
    // firing would look like the bug it prevents.
    expect(out).not.toContain('WRITES THAT SHRANK THE FILE')
  })

  it('honours the minutes window', async () => {
    await writeLog([
      { time: ago(60 * 60 * 5), level: 'info', subsystem: 'web', message: 'file read', path: TARGET, status: 200, hash: 'old000000000' },
      { time: ago(30), level: 'info', subsystem: 'web', message: 'file read', path: TARGET, status: 200, hash: 'new000000000' },
    ])
    const out = await run('report.md', '10')
    expect(out).toContain('new000000000')
    expect(out).not.toContain('old000000000')
    expect(out).toContain('1 events')
  })
})
