/**
 * Demo reset against real sign-in processes (src/commands/demo-sign-ins.ts).
 *
 * A Demo sign-in Terminal runs a script the Mac app writes (desktop/ClaudeSignInBridge.swift):
 * it claims a record of its own pid and ps start time in the generation's `accepting/` dir
 * with noclobber, then execs the sign-in CLI under that same pid. Reset renames `accepting/`
 * to `closed/` and refuses to clear while any recorded process is alive.
 *
 * Here the script runs for real: its record lines are read from the Swift source (only its
 * known interpolations are filled in), and it execs a stand-in node script instead of the CLI.
 * The stand-in exits when its stdin ends, and on its own after 10 s. Nothing is signalled; the
 * HOME is a scratch dir and the OS account is mocked to one. No real CLI, Terminal or UI.
 *
 * The second block is a source ratchet: every clear of a Demo generation closes admission first,
 * and the native script claims its record before it execs and never makes the admission dir.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'

const account = vi.hoisted(() => ({ homedir: '' }))
vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: account.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
// Its sign-in children run with HOME = the Demo home, which the process sweep (tested on its own) refuses by design.
vi.mock('../../src/commands/demo-residual-processes.js', () => ({ assertNoDemoResidualProcesses: async () => {}, assertResidualReportClean: () => {}, sweepDemoResidualProcesses: async () => ({ supported: true, complete: true, matched: 0, unknown: 0, why: { envHidden: 0, cwdUnreadable: 0, unreadable: 0, raced: 0 } }) }))

import { clearDemoHome, demoPaths, prepareDemoHome, type DemoPaths } from '../../src/commands/demo-home.js'
import { closeDemoSignIns, demoSignInDirectories } from '../../src/commands/demo-sign-ins.js'
import { demoProcessGone, demoProcessStart } from '../../src/commands/demo-process.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const BRIDGE = path.join(repoRoot, 'desktop/ClaudeSignInBridge.swift')
const DEMO_APP = path.join(repoRoot, 'desktop/DemoApp.swift')

// --- The Swift record lines, as the shell will see them -------------------------------

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Decodes a Swift string literal body; an interpolation not in `values` throws, so nothing unknown runs. */
function decodeSwift(text: string, values: Record<string, string>): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') { out += text[i]; continue }
    const next = text[++i]
    if (next === '\\') out += '\\'
    else if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === '"') out += '"'
    else if (next === "'") out += "'"
    else if (next === '(') {
      let depth = 1
      let j = i + 1
      for (; j < text.length && depth; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')') depth--
      }
      const expr = text.slice(i + 1, j - 1)
      if (!(expr in values)) throw new Error(`Unexpected Swift interpolation \\(${expr})`)
      out += values[expr]
      i = j - 1
    } else throw new Error(`Unexpected Swift escape \\${next}`)
  }
  return out
}

function swiftSource(): string {
  return fs.readFileSync(BRIDGE, 'utf8')
}

function notTakingSignIns(swift = swiftSource()): string {
  const literal = /static let notTakingSignIns = "((?:[^"\\]|\\.)*)"/.exec(swift)?.[1]
  if (literal === undefined) throw new Error('notTakingSignIns not found in ClaudeSignInBridge.swift')
  return decodeSwift(literal, {})
}

/** The raw multi-line literal demoRecordLines returns, indentation stripped the way Swift does. */
function recordLinesLiteral(swift = swiftSource()): string {
  const fn = swift.indexOf('static func demoRecordLines(')
  if (fn < 0) throw new Error('demoRecordLines not found in ClaudeSignInBridge.swift')
  const open = swift.indexOf('"""\n', fn)
  const close = swift.indexOf('"""', open + 4)
  if (open < 0 || close < 0) throw new Error('demoRecordLines does not return a multi-line literal')
  const lines = swift.slice(open + 4, close).split('\n')
  const indent = lines.pop()!
  if (!/^[ \t]*$/.test(indent)) throw new Error('demoRecordLines literal does not close on its own line')
  return lines.map(line => (line.startsWith(indent) ? line.slice(indent.length) : line.trim() === '' ? '' : line)).join('\n')
}

function recordLines(directory: string, id: string): string {
  return decodeSwift(recordLinesLiteral(), {
    'quote(notTakingSignIns)': shQuote(notTakingSignIns()),
    'quote(directory)': shQuote(directory),
    id,
  })
}

// --- Owned processes ------------------------------------------------------------------

interface Owned {
  child: ChildProcessWithoutNullStreams
  out: string
  err: string
  closed: boolean
  code: Promise<number | null>
}

const owned: Owned[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let base: string
let paths: DemoPaths
let fixtures: string
let scriptDir: string

function start(file: string, args: string[] = []): Owned {
  const child = spawn(file, args, { cwd: base, env: { HOME: paths.home, PATH: guardedPath() }, stdio: 'pipe' })
  const row: Owned = { child, out: '', err: '', closed: false, code: Promise.resolve(null) }
  row.code = new Promise(resolve => child.once('close', code => { row.closed = true; resolve(code) }))
  child.once('error', error => { row.err += String(error) })
  child.stdout.setEncoding('utf8').on('data', (text: string) => { row.out += text })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { row.err += text })
  child.stdin.on('error', () => {})
  owned.push(row)
  return row
}

async function waitFor(row: Owned, pattern: RegExp, ms = 10_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + ms
  for (;;) {
    const match = row.out.match(pattern)
    if (match) return match
    if (row.closed) throw new Error(`process ${row.child.pid} ended before ${pattern}: ${row.out}${row.err}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}: ${row.out}${row.err}`)
    await sleep(20)
  }
}

/** Until the stand-in announced itself (the script exec'd) or the process ended. */
async function settled(row: Owned, ms = 10_000): Promise<'launched' | 'ended'> {
  const deadline = Date.now() + ms
  for (;;) {
    if (/^ready \d+$/m.test(row.out)) return 'launched'
    if (row.closed) return 'ended'
    if (Date.now() > deadline) throw new Error(`process ${row.child.pid} neither launched nor ended: ${row.out}${row.err}`)
    await sleep(20)
  }
}

async function finish(row: Owned): Promise<number | null> {
  row.child.stdin.end()
  return row.code
}

/** The sign-in script as the Mac app writes it, with the CLI exec replaced by the stand-in. */
function writeScript(recordId: string, gated = false): string {
  const file = path.join(scriptDir, `Sign In ${randomUUID()}.command`)
  // A gated script waits for one stdin line first: a Terminal that starts late.
  const gate = gated ? `printf 'waiting\\n'\nIFS= read -r walnut_go || exit 9\n` : ''
  const text = `#!/bin/sh\nexport HOME=${shQuote(paths.home)}\n${gate}`
    + recordLines(demoSignInDirectories(paths).accepting, recordId)
    + `exec ${shQuote(process.execPath)} ${shQuote(path.join(fixtures, 'stand-in.mjs'))}\n`
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o700 })
  return file
}

const STAND_IN = `// Stand-in for the sign-in CLI: stays until its stdin ends, and never past 10 s.
const backstop = setTimeout(() => process.exit(3), 10_000)
const done = () => { clearTimeout(backstop); process.exit(0) }
process.stdin.on('data', () => {})
process.stdin.on('end', done)
process.stdin.on('close', done)
process.stdout.write('ready ' + process.pid + '\\n')
`

const WRITER = `// Opens a new record file, then writes one line of stdin into it when told to.
import fs from 'node:fs'
const backstop = setTimeout(() => process.exit(3), 10_000)
const c = fs.constants
let fd = fs.openSync(process.argv[2], c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600)
process.stdout.write('opened\\n')
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  const match = /^write (.*)\\n/m.exec(buffered)
  if (match && fd !== -1) {
    fs.writeSync(fd, match[1] + '\\n')
    fs.closeSync(fd)
    fd = -1
    process.stdout.write('written\\n')
  }
})
const done = () => { clearTimeout(backstop); process.exit(0) }
process.stdin.on('end', done)
process.stdin.on('close', done)
`

function sentinels(): string[] {
  return [path.join(paths.home, 'keep.txt'), path.join(paths.home, '.claude', 'keep.json'), path.join(paths.data, 'keep.txt')]
}

function expectSentinelsKept(): void {
  for (const file of sentinels()) expect(fs.readFileSync(file, 'utf8'), file).toBe('keep')
}

function expectMissing(dir: string): void {
  expect(fs.existsSync(dir), dir).toBe(false)
}

function readRecord(dir: string, name: string): { pid: number; startTime: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
}

beforeEach(async () => {
  // realpath: on macOS the temp dir sits behind the /var symlink, which the Demo path guard refuses.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-sign-in-')))
  account.homedir = path.join(base, 'account')
  fs.mkdirSync(account.homedir)
  paths = demoPaths(path.join(base, 'parent', 'open-walnut-demo'), randomUUID())
  await prepareDemoHome(paths)
  fixtures = path.join(base, 'fixtures')
  fs.mkdirSync(fixtures)
  fs.writeFileSync(path.join(fixtures, 'stand-in.mjs'), STAND_IN)
  fs.writeFileSync(path.join(fixtures, 'writer.mjs'), WRITER)
  scriptDir = path.join(paths.home, '.local', 'state', 'open-walnut', 'sign-in')
  fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 })
  for (const file of sentinels()) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'keep')
  }
})

afterEach(async () => {
  // Only this file's own processes, ended through their stdin; each one also ends itself within 10 s.
  const rows = owned.splice(0)
  await Promise.all(rows.map(async row => {
    if (row.closed) return
    row.child.stdin.end()
    await Promise.race([row.code, sleep(12_000)])
  }))
  if (rows.some(row => !row.closed)) throw new Error('A fixture process did not exit; its files were kept')
  if (paths && fs.existsSync(paths.terminals)) fs.rmSync(paths.terminals, { recursive: true, force: true })
  fs.rmSync(base, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Demo reset with real sign-in processes', () => {
  it('refuses while the recorded sign-in runs, keeps the data, and clears once it exited', async () => {
    const dirs = demoSignInDirectories(paths)
    const id = randomUUID()
    const row = start(writeScript(id))
    const [, readyPid] = await waitFor(row, /^ready (\d+)$/m)
    // exec kept the pid the script recorded for itself.
    expect(Number(readyPid)).toBe(row.child.pid)

    const record = readRecord(dirs.accepting, `${id}.json`)
    expect(record.pid).toBe(row.child.pid)
    // The shell's ps marker is the identity the TypeScript side reads on this platform.
    expect(record.startTime).toBe(await demoProcessStart(row.child.pid!, 'ps'))
    expect(fs.statSync(path.join(dirs.accepting, `${id}.json`)).mode & 0o777).toBe(0o600)
    expect(await demoProcessGone(record)).toBe(false)

    await expect(clearDemoHome(paths)).rejects.toThrow(/still open in Terminal/)
    expectSentinelsKept()
    expectMissing(dirs.accepting)
    expect(fs.readdirSync(dirs.closed)).toEqual([`${id}.json`])
    // Preparing again never reopens admission a refused reset closed.
    await prepareDemoHome(paths)
    expectMissing(dirs.accepting)
    await expect(clearDemoHome(paths)).rejects.toThrow(/still open in Terminal/)

    expect(await finish(row)).toBe(0)
    expect(await demoProcessGone(record)).toBe(true)
    await expect(clearDemoHome(paths)).resolves.toBe(true)
    expectMissing(paths.home)
    expectMissing(paths.data)
  })

  it('captures a record opened just before admission closed: partial, then live, then gone', async () => {
    const dirs = demoSignInDirectories(paths)
    const name = `${randomUUID()}.json`
    const writer = start(process.execPath, [path.join(fixtures, 'writer.mjs'), path.join(dirs.accepting, name)])
    await waitFor(writer, /^opened$/m)

    // The fd was open before the rename, so the empty record moved with the dir and reset fails closed.
    await expect(clearDemoHome(paths)).rejects.toThrow()
    expectSentinelsKept()
    expectMissing(dirs.accepting)
    expect(fs.readFileSync(path.join(dirs.closed, name), 'utf8')).toBe('')

    const identity = { pid: writer.child.pid!, startTime: await demoProcessStart(writer.child.pid!, 'ps') }
    writer.child.stdin.write(`write ${JSON.stringify(identity)}\n`)
    await waitFor(writer, /^written$/m)
    expect(readRecord(dirs.closed, name)).toEqual(identity)
    expectMissing(dirs.accepting)

    await expect(clearDemoHome(paths)).rejects.toThrow(/still open in Terminal/)
    expectSentinelsKept()

    expect(await finish(writer)).toBe(0)
    await expect(clearDemoHome(paths)).resolves.toBe(true)
    expectMissing(paths.data)
  })

  it.each(['admission closed', 'data cleared'] as const)('a sign-in that starts after reset (%s) claims nothing and never execs', async when => {
    const dirs = demoSignInDirectories(paths)
    const row = start(writeScript(randomUUID(), true))
    await waitFor(row, /^waiting$/m)
    if (when === 'admission closed') await closeDemoSignIns(paths)
    else await clearDemoHome(paths)

    row.child.stdin.write('go\n')
    expect(await row.code).toBe(1)
    expect(row.out).toContain(notTakingSignIns())
    expect(row.out).not.toMatch(/^ready/m)
    // The script never makes the admission dir back.
    expectMissing(dirs.accepting)
    if (when === 'admission closed') {
      expect(fs.readdirSync(dirs.closed)).toEqual([])
      expectSentinelsKept()
    } else expectMissing(paths.data)
  })

  it('keeps one record per concurrent attempt, refuses a reused id, and waits for every one', async () => {
    const dirs = demoSignInDirectories(paths)
    const ids = Array.from({ length: 6 }, () => randomUUID())
    const rows = ids.map(id => start(writeScript(id)))
    await Promise.all(rows.map(row => waitFor(row, /^ready \d+$/m)))

    // noclobber: a second script under an id already claimed fails before exec.
    const reused = start(writeScript(ids[0]!))
    expect(await reused.code).toBe(1)
    expect(reused.out).toContain(notTakingSignIns())
    expect(reused.out).not.toMatch(/^ready/m)

    expect(fs.readdirSync(dirs.accepting).sort()).toEqual(ids.map(id => `${id}.json`).sort())
    for (const [index, id] of ids.entries()) {
      const record = readRecord(dirs.accepting, `${id}.json`)
      expect(record.pid).toBe(rows[index]!.child.pid)
      expect(record.startTime).toBe(await demoProcessStart(record.pid, 'ps'))
    }

    await expect(clearDemoHome(paths)).rejects.toThrow(/still open in Terminal/)
    expect(fs.readdirSync(dirs.closed)).toHaveLength(ids.length)
    const last = rows.pop()!
    expect(await Promise.all(rows.map(finish))).toEqual(rows.map(() => 0))
    await expect(clearDemoHome(paths)).rejects.toThrow(/still open in Terminal/)
    expectSentinelsKept()
    expect(fs.readdirSync(dirs.closed)).toHaveLength(ids.length)

    expect(await finish(last)).toBe(0)
    await expect(clearDemoHome(paths)).resolves.toBe(true)
    expectMissing(paths.home)
  })

  it('a reset racing with launches never leaves a launched sign-in untracked', async () => {
    const dirs = demoSignInDirectories(paths)
    const rows = Array.from({ length: 10 }, () => start(writeScript(randomUUID(), true)))
    await Promise.all(rows.map(row => waitFor(row, /^waiting$/m)))

    const half = rows.length / 2
    for (const row of rows.slice(0, half)) row.child.stdin.write('go\n')
    const reset = clearDemoHome(paths).then(() => 'cleared' as const, (error: Error) => error)
    for (const row of rows.slice(half)) row.child.stdin.write('go\n')
    const outcome = await reset
    const states = await Promise.all(rows.map(row => settled(row)))
    const launched = rows.filter((_, index) => states[index] === 'launched')

    for (const row of rows.filter((_, index) => states[index] === 'ended')) {
      expect(await row.code).toBe(1)
      expect(row.out).toContain(notTakingSignIns())
    }
    if (outcome === 'cleared') {
      // Nothing was alive in admission when it was read, so nothing may have launched.
      expect(launched).toEqual([])
      expectMissing(paths.data)
    } else {
      expectSentinelsKept()
      const recorded = fs.readdirSync(dirs.closed).map(name => readRecord(dirs.closed, name).pid).sort((a, b) => a - b)
      expect(recorded).toEqual(launched.map(row => row.child.pid!).sort((a, b) => a - b))
    }
    expectMissing(dirs.accepting)

    expect(await Promise.all(launched.map(finish))).toEqual(launched.map(() => 0))
    await expect(clearDemoHome(paths)).resolves.toBe(true)
    expectMissing(paths.data)
    expectMissing(dirs.accepting)
  })
})

// --- Source ratchet -------------------------------------------------------------------

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.ts') ? [file] : []
  })
}

/** Named function declarations with their bodies; a body opens with `{` at the end of a line. */
function functions(source: string): Array<{ name: string; body: string }> {
  const found: Array<{ name: string; body: string }> = []
  for (const match of source.matchAll(/function\s+(\w+)\s*\(/g)) {
    let depth = 1
    let i = match.index! + match[0].length
    for (; i < source.length && depth; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    const open = source.indexOf('{\n', i)
    // A body that does not open on the line its parameters close is not this function's.
    if (open < 0 || source.slice(i, open).includes('\n')) continue
    let braces = 0
    let end = open
    for (; end < source.length; end++) {
      if (source[end] === '{') braces++
      else if (source[end] === '}' && --braces === 0) break
    }
    found.push({ name: match[1]!, body: source.slice(open, end + 1) })
  }
  return found
}

describe('Demo sign-in admission source ratchet', () => {
  const sources = walk(path.join(repoRoot, 'src')).map(file => ({ rel: path.relative(repoRoot, file), text: fs.readFileSync(file, 'utf8') }))

  it('every clear of a Demo generation closes sign-in admission before it removes anything', () => {
    const clears: string[] = []
    for (const { rel, text } of sources) {
      if (!/\bDemoPaths\b|\bdemoPaths\(/.test(text)) continue
      for (const fn of functions(text)) {
        // A recursive removal (its own options say so) is what clears a generation; one file removed beside a recursive mkdir is not.
        const removal = fn.body.search(/\b(?:rm|rmSync|rmdir|rmdirSync)\([^;]*?\brecursive\b/)
        if (removal < 0 || !/\.(?:home|data)\b/.test(fn.body)) continue
        clears.push(`${rel}:${fn.name}`)
        const close = fn.body.indexOf('closeDemoSignIns(')
        expect(close, `${rel}:${fn.name} removes Demo data without closing sign-in admission first`).toBeGreaterThanOrEqual(0)
        expect(close, `${rel}:${fn.name} closes sign-in admission after it started removing`).toBeLessThan(removal)
      }
    }
    expect(clears).toContain('src/commands/demo-home.ts:clearDemoHome')
  })

  it('stopping Demo processes closes admission first, and only recovery reopens it, after a stop', () => {
    const server = sources.find(row => row.rel === 'src/commands/demo-server.ts')!.text
    const stop = functions(server).find(fn => fn.name === 'stopDemoProcesses')!
    expect(stop.body.replace(/^\{\s*/, '')).toMatch(/^await closeDemoSignIns\(paths\)/)
    for (const { rel, text } of sources) {
      if (rel === 'src/commands/demo-sign-ins.ts') continue
      for (const match of text.matchAll(/reopenDemoSignIns\(/g)) {
        if (/import\s*\{[^}]*$/.test(text.slice(Math.max(0, match.index! - 200), match.index))) continue
        const before = text.slice(Math.max(0, match.index! - 200), match.index)
        expect(before, `${rel} reopens sign-in admission without first stopping in recovery`)
          .toMatch(/if \(recovering\) \{\s*await stopDemoProcesses\(paths, true\)\s*await\s*$/)
      }
    }
  })

  it('only demo-sign-ins.ts names the admission dirs', () => {
    const naming = sources.filter(row => /['"`]demo-sign-ins['"`]|['"`]accepting['"`]/.test(row.text)).map(row => row.rel)
    expect(naming).toEqual(['src/commands/demo-sign-ins.ts'])
  })

  it('the native script claims its record with noclobber before exec and never makes the admission dir', () => {
    const swift = swiftSource()
    const lines = recordLines('/scratch/accepting', '00000000-0000-0000-0000-000000000000')
    const claim = lines.indexOf('> "$walnut_dir/00000000-0000-0000-0000-000000000000.json"')
    expect(claim).toBeGreaterThan(lines.indexOf('set -C'))
    expect(lines.indexOf('set -C')).toBeGreaterThanOrEqual(0)
    expect(lines).toContain('LC_ALL=C TZ=UTC /bin/ps -o lstart= -p $$')
    expect(lines).toContain('[ ! -h "$walnut_dir" ]')
    expect(lines).not.toMatch(/\bmkdir\b|\bexec\b/)
    // Every step that can fail ends the script before it reaches exec.
    for (const line of lines.split('\n').filter(l => /\$\(|"\$walnut_dir\/|\[ -d/.test(l))) {
      expect(line, line).toMatch(/\|\| walnut_fail$|\) walnut_fail ;; esac$|\| \/usr\/bin\/sed /)
    }
    expect(lines).toMatch(/walnut_fail\(\) \{ printf '%s\\n' '[^']+'; exit 1; \}/)

    // command(): the record lines sit directly before the one exec of the script's own shell.
    const command = functions(swift.replace(/static func command\(/, 'function command(')).find(fn => fn.name === 'command')!
    expect(command.body).toMatch(/let record = demoRecord\.map \{ demoRecordLines\(directory: \$0\.directory, id: \$0\.id\) \}/)
    expect(command.body).toContain('export HOME=\\(quote(home))\\n\\(record)exec /usr/bin/env -i ')

    // The demo branch checks admission before writing or opening anything, and passes its record.
    const handler = swift.slice(swift.indexOf('func userContentController('), swift.indexOf('static func acceptingDirectoryReady('))
    const ready = handler.indexOf('acceptingDirectoryReady(accepting)')
    expect(ready).toBeGreaterThanOrEqual(0)
    for (const later of ['createDirectory(', 'writeNewScript(', 'NSWorkspace.shared.open(']) {
      expect(handler.indexOf(later), later).toBeGreaterThan(ready)
    }
    expect(handler).toMatch(/writeNewScript\(Self\.command\(home: home, configDir: configDir, shell: shell, demoRecord: \(accepting, id\)\), to: script\)/)
    // The only directory the bridge makes is the script dir in HOME.
    expect([...swift.matchAll(/createDirectory\((?:at|atPath): (\w+)/g)].map(m => m[1])).toEqual(['directory'])
    expect(swift).not.toMatch(/\bmkdir\(/)
    const writeNew = swift.slice(swift.indexOf('static func writeNewScript('))
    expect(writeNew).toMatch(/O_CREAT \| O_EXCL \| O_NOFOLLOW/)
  })

  it('the Mac Demo app hands every sign-in bridge the accepting dir demo-sign-ins.ts uses', () => {
    const app = fs.readFileSync(DEMO_APP, 'utf8')
    const layout = path.relative('/r', demoSignInDirectories(demoPaths('/r/open-walnut-demo', 'g')).accepting)
    expect(layout).toBe(path.join('open-walnut-demo', 'data', 'g', 'local', 'demo-sign-ins', 'accepting'))
    expect(app).toContain('appendingPathComponent("data").appendingPathComponent(generation).appendingPathComponent("local/demo-sign-ins/accepting")')
    const bridges = [...app.matchAll(/ClaudeSignInBridge\(([^)]*)\)/g)].map(m => m[1]!)
    expect(bridges.length).toBeGreaterThan(0)
    for (const args of bridges) expect(args, args).toMatch(/demoSignInDirectory: \w+/)
  })
})
