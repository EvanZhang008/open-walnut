/**
 * scripts/ios-fleet-test.sh, run for real (bash) against a fake `walnut` that answers
 * the fleet ops it calls: which Mac it picks, what it sends, how it follows the run,
 * what it brings back. 2026-11-03, the user: "so both of the mac now can u a place to
 * run the ios test": a task on a Linux devbox builds and tests the iOS app on a Mac of
 * the fleet, and one of those Macs is someone else's computer in use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'

const SCRIPT = path.resolve(__dirname, '../../scripts/ios-fleet-test.sh')
const REMOTE = path.resolve(__dirname, '../../ios-native/tests/fleet/remote-run.sh')
let dir = ''
let repo = ''
let taskDir = ''

interface Mac {
  host: string; label?: string; tags?: string[]; connected?: boolean; loadPerCpu?: number | null
  result?: { exit: number; state: string; xcode?: string; runtime?: string }
  /** The fetch of out.tgz fails this many times first (a dropped answer from a loaded Mac), with this error. */
  fetchFails?: number; fetchError?: string
  /** The Mac's daemon was replaced after the first read: it no longer holds the job (unknown_job). */
  jobGone?: boolean
  /** The job's log file there never gets a result line. */
  logNoResult?: boolean
}

/** A fake `walnut tools call <op> @args.json`: answers from scenario.json, logs every call. */
function fakeWalnut(macs: Mac[], outTgz: string): string {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ macs, outTgz }))
  fs.writeFileSync(path.join(bin, 'walnut'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(dir)}
const { macs, outTgz } = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))
const [, , tools, call, op, argRef] = process.argv
const args = JSON.parse(fs.readFileSync(argRef.slice(1), 'utf8'))
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ op, args }) + '\\n')
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0) }
const mac = (h) => macs.find((m) => m.host === h)
if (op === 'host_list') out({ hosts: macs.map((m) => ({ host: m.host, label: m.label || m.host, capabilities: { tags: m.tags || ['macos', 'ios'] }, connection: { connected: m.connected !== false } })) })
if (op === 'host_load') out({ hosts: macs.map((m) => ({ host: m.host, known: m.loadPerCpu != null, loadPerCpu: m.loadPerCpu })) })
if (op === 'host_copy') {
  if (args.from_host && args.from.endsWith('.log')) {
    // The job's log file in the task's folder there: the whole run, result line last.
    const r = mac(args.from_host).result || { exit: 0, state: 'passed' }
    const body = 'remote-run: simulator X\\napp log noise\\n' + (mac(args.from_host).logNoResult ? '' : '** TEST SUCCEEDED **\\nFLEET_RESULT ' + JSON.stringify({ exit: r.exit, state: r.state, out: '/r/out.tgz', bytes: 99, udid: 'U', xcode: '', runtime: '' }) + '\\n')
    fs.writeFileSync(args.to, body); out({ outcome: 'Copied back.' })
  }
  if (args.from_host) {
    const m = mac(args.from_host), n = path.join(dir, 'fetch-fails')
    const failed = fs.existsSync(n) ? Number(fs.readFileSync(n, 'utf8')) : 0
    if (failed < (m.fetchFails || 0)) { fs.writeFileSync(n, String(failed + 1)); process.stderr.write('walnut: ' + (m.fetchError || 'hub_timeout: primary server timed out')); process.exit(1) }
    fs.copyFileSync(outTgz, args.to); out({ outcome: 'Copied back.' })
  }
  // What was sent, for the test to read.
  fs.copyFileSync(args.from, path.join(dir, 'sent-' + args.to_host + '.tgz'))
  // A big file: the copy answers running first, host_copy_result has the end.
  out({ running: true, copyId: 'hc-' + args.to_host })
}
if (op === 'host_copy_result') out({ running: false, outcome: 'Copied to ' + args.copy_id })
if (op === 'host_exec') out(args.background ? { jobId: 'hx-' + args.host, running: true } : { exitCode: 0, running: false })
if (op === 'host_exec_read') {
  const m = mac(args.host)
  const r = m.result || { exit: 0, state: 'passed' }
  const tail = '** TEST ' + (r.exit ? 'FAILED' : 'SUCCEEDED') + ' **\\nFLEET_RESULT ' + JSON.stringify({ exit: r.exit, state: r.state, out: '/r/out.tgz', bytes: r.state === 'busy' ? 0 : 99, udid: 'U', xcode: r.xcode || '', runtime: r.runtime || '' }) + '\\n'
  // The run ends while 2 more chunks of its log are still unread.
  if (args.offset === 0) out({ output: 'remote-run: simulator X\\n', nextOffset: 24, outputBytes: 24, running: true })
  if (m.jobGone) { process.stderr.write('walnut: unknown_job: no job ' + args.job_id + ' on this host (finished jobs are kept for an hour; the log file stays)'); process.exit(1) }
  if (args.offset === 24) out({ output: 'app log noise\\n', nextOffset: 38, outputBytes: 38 + tail.length, running: false })
  out({ output: tail, nextOffset: 38 + tail.length, outputBytes: 38 + tail.length, running: false })
}
process.stderr.write('walnut: unknown op ' + op); process.exit(2)
`, { mode: 0o755 })
  return bin
}

function git(...a: string[]): void {
  const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

function run(args: string[], bin: string) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: repo, encoding: 'utf8',
    env: { HOME: dir, PATH: guardedPath([bin], process.env.PATH ?? '/usr/bin:/bin'), WALNUT_TASK_DIR: taskDir, IOS_FLEET_RETRY_SECS: '0', IOS_FLEET_LOG_POLL_SECS: '0' },
  })
  const calls = fs.existsSync(path.join(dir, 'calls.jsonl'))
    ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: string; args: Record<string, unknown> })
    : []
  return { ...r, calls }
}

/** The out.tgz a finished run leaves on the Mac: a summary and a video. */
function outTgz(): string {
  const src = path.join(dir, 'remote')
  fs.mkdirSync(path.join(src, 'out'), { recursive: true })
  fs.writeFileSync(path.join(src, 'out/summary.json'), JSON.stringify({ result: 'Passed', passedTests: 41, failedTests: 0, skippedTests: 2, totalTestCount: 43 }))
  fs.writeFileSync(path.join(src, 'out/run.mp4'), 'mp4')
  const f = path.join(dir, 'out.tgz')
  spawnSync('tar', ['-czf', f, '-C', src, 'out'])
  return f
}

const listTgz = (f: string) => spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ios-fleet-')))
  repo = path.join(dir, 'repo')
  taskDir = path.join(dir, 'tasks', 'task-1')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.mkdirSync(path.join(repo, 'ios-native/Walnut'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'scripts/lib'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.gitignore'), 'DerivedData/\n')
  fs.writeFileSync(path.join(repo, 'ios-native/Walnut/App.swift'), 'struct App {}\n')
  fs.writeFileSync(path.join(repo, 'scripts/lib/sim-device.sh'), '# helper\n')
  fs.writeFileSync(path.join(repo, 'src/server.ts'), 'export {}\n')
  // Repo files an iOS test reads through #filePath go along; others do not.
  fs.mkdirSync(path.join(repo, 'src/core'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'tests/fixtures/thing'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'ios-native/WalnutTests'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src/core/types.ts'), 'export {}\n')
  fs.writeFileSync(path.join(repo, 'tests/fixtures/thing/a.json'), '{}\n')
  fs.writeFileSync(path.join(repo, 'tests/fixtures/other.json'), '{}\n')
  fs.writeFileSync(path.join(repo, 'ios-native/WalnutTests/RepoTests.swift'),
    'let a = root.appendingPathComponent("tests/fixtures/thing")\nlet b = "src/core/types.ts"\nlet c = "src/missing.ts"\n')
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base')
  // Uncommitted work goes too; build output git ignores does not.
  fs.writeFileSync(path.join(repo, 'ios-native/Walnut/New.swift'), 'struct New {}\n')
  fs.mkdirSync(path.join(repo, 'ios-native/DerivedData'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'ios-native/DerivedData/big.o'), 'x')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('ios-fleet-test.sh', () => {
  it('picks the least loaded iOS Mac, sends the iOS sources, follows the run and brings the results back', () => {
    const bin = fakeWalnut([
      { host: 'mac-busy', loadPerCpu: 4.2 },
      { host: 'mac-mini', loadPerCpu: 0.3 },
      { host: 'laptop', loadPerCpu: 0.1, connected: false },
      { host: 'devbox', loadPerCpu: 0.05, tags: ['linux'] },
      { host: 'mac-two', loadPerCpu: 0.5 },
    ], outTgz())
    const r = run(['--video', 'unit', '--', '-only-testing:WalnutTests/BoardTests'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('not using mac-busy (mac-busy): load 4.2 per CPU, over 0.75')
    expect(r.stderr).toContain('using mac-mini (mac-mini): load 0.3 per CPU')
    // The send came back running; the script waited for its end before starting the run.
    const ops = r.calls.map((c) => c.op)
    expect(ops.indexOf('host_copy_result')).toBeGreaterThan(ops.indexOf('host_copy'))
    expect(ops.indexOf('host_copy_result')).toBeLessThan(ops.indexOf('host_exec'))
    expect(r.calls.find((c) => c.op === 'host_copy_result')!.args).toEqual({ copy_id: 'hc-mac-mini', wait_ms: 60000 })
    expect(r.stderr).toContain('Copied to hc-mac-mini')
    // The sources: ios-native, the shared helpers and the repo files its tests name, the new
    // file included; no build output, no other server code.
    expect(listTgz(path.join(dir, 'sent-mac-mini.tgz'))).toEqual([
      'ios-native/Walnut/App.swift', 'ios-native/Walnut/New.swift', 'ios-native/WalnutTests/RepoTests.swift',
      'scripts/lib/sim-device.sh', 'src/core/types.ts', 'tests/fixtures/thing/a.json',
    ])
    const start = r.calls.find((c) => c.op === 'host_exec' && c.args.background)!
    expect(start.args.host).toBe('mac-mini')
    const line = (start.args.argv as string[])[2]
    expect(line).toContain('.local/state/open-walnut/tasks/task-1/ios-fleet/')
    expect(line).toMatch(/remote-run\.sh" "\$D" unit --video --max-load 0\.75 -- -only-testing:WalnutTests\/BoardTests/)
    // Followed from the start to the end, then fetched and unpacked into the task directory.
    expect(r.calls.filter((c) => c.op === 'host_exec_read').map((c) => c.args.offset)).toEqual([0, 24, 38])
    // The terminal gets the lines that matter; the whole log is run.log.
    expect(r.stdout).toContain('** TEST SUCCEEDED **')
    expect(r.stdout).toContain('remote-run: simulator X')
    expect(r.stdout).not.toContain('app log noise')
    const fetch = r.calls.find((c) => c.op === 'host_copy' && c.args.from_host)!
    expect(fetch.args.from_host).toBe('mac-mini')
    const runDir = path.dirname(String(fetch.args.to))
    expect(fs.readFileSync(path.join(runDir, 'out/run.mp4'), 'utf8')).toBe('mp4')
    expect(fs.readFileSync(path.join(runDir, 'run.log'), 'utf8')).toMatch(/simulator X\napp log noise\n\*\* TEST SUCCEEDED \*\*\nFLEET_RESULT /)
    expect(r.stderr).toContain('Passed: 41 passed, 0 failed, 2 skipped of 43')
    expect(r.stderr).toContain(`(video: ${runDir}/out/run.mp4)`)
    // The run's folder on the Mac is removed; this task's build products stay for the next run.
    const clean = r.calls.filter((c) => c.op === 'host_exec' && !c.args.background).at(-1)!
    expect((clean.args.argv as string[])[2]).toMatch(/^rm -rf "\$HOME\/\.local\/state\/open-walnut\/tasks\/task-1\/ios-fleet\/[^"]+"$/)
    expect(r.calls.map((c) => c.op)).not.toContain('task_send')
  })

  it('a Mac that turns out busy hands the run to the next one; a failed run keeps its exit code', () => {
    const bin = fakeWalnut([
      { host: 'mac-mini', loadPerCpu: 0.1, result: { exit: 75, state: 'busy' } },
      { host: 'mac-two', loadPerCpu: 0.2, result: { exit: 65, state: 'failed' } },
    ], outTgz())
    const r = run(['ui'], bin)
    expect(r.status).toBe(65)
    expect(r.stderr).toContain('mac-mini is busy; trying the next Mac')
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-mini', 'mac-two'])
    // Nothing is fetched from the busy one.
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host).map((c) => c.args.from_host)).toEqual(['mac-two'])
  })

  it('a fetch Walnut drops under load is asked again; the results arrive and the Mac is cleaned', () => {
    // 2026-11-03: the Mac ran at load 106, host_copy of the 44 MB out.tgz answered hub_timeout,
    // and the run's folder on the other Mac was removed with the results still in it.
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, fetchFails: 2, result: { exit: 0, state: 'passed', xcode: '26.2', runtime: 'iOS 26.2' } }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('host_copy: Walnut did not answer (hub_timeout); asking again in 0 s')
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host)).toHaveLength(3)
    expect(r.stderr).toContain('ran with Xcode 26.2 and iOS 26.2 on mac-mini')
    expect(r.stderr).toContain('Passed: 41 passed')
    const clean = r.calls.filter((c) => c.op === 'host_exec' && !c.args.background)
    expect(clean).toHaveLength(1)
    expect((clean[0].args.argv as string[])[2]).toMatch(/^rm -rf /)
  })

  // 2026-11-03: a passed run's fetch met the server's restart ("server not running") and the
  // script stopped with exit 74; the same call by hand a few seconds later worked.
  it.each([
    'Walnut server not running at http://127.0.0.1:3456',
    'Walnut daemon socket unreachable at /tmp/open-walnut/agent-gateway.sock: connect ENOENT',
  ])('a deploy restarting Walnut as the results come back is asked again, not given up: %s', (why) => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, fetchFails: 3, fetchError: why, result: { exit: 0, state: 'passed' } }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host)).toHaveLength(4)
    expect(r.stderr).toContain('Passed: 41 passed')
  })

  it('--video with unit says what the video will show; the scratch files are gone at the end', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, result: { exit: 0, state: 'passed' } }], outTgz())
    const r = run(['--video', 'unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('--video with unit records the app idle')
    const runs = fs.readdirSync(path.join(taskDir, 'ios-fleet')).filter((n) => n !== 'DerivedData')
    for (const n of runs) expect(fs.existsSync(path.join(taskDir, 'ios-fleet', n, '.read-err'))).toBe(false)
  })

  it('results that never come back stay on the Mac, with the call that fetches them', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, fetchFails: 99, result: { exit: 0, state: 'passed' } }], outTgz())
    const r = run(['unit'], bin)
    // A pass whose results are not here is not a pass for the caller.
    expect(r.status).toBe(74)
    expect(r.stderr).toContain('the run ended with exit 0 on mac-mini, but its results are still there')
    expect(r.stderr).not.toContain('results: ')
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host)).toHaveLength(9)
    // The line it prints fetches AND unpacks, so a hand-run of it leaves the run as the script would.
    expect(r.stderr).toMatch(/out\.tgz"\}' && tar -xzf '[^']+\/out\.tgz' -C '[^']+'/)
    expect(r.stderr).toMatch(/could not bring the results back from mac-mini; they stay there until fetched: walnut tools call host_copy '\{"from_host": "mac-mini", "from": "~\/\.local\/state\/open-walnut\/tasks\/task-1\/ios-fleet\/[^"]+\/out\.tgz"/)
    // Nothing removed on the Mac.
    expect(r.calls.filter((c) => c.op === 'host_exec' && !c.args.background)).toHaveLength(0)
    // An older remote-run.sh names no versions, and the line is left out.
    expect(r.stderr).not.toContain('ran with')
  })

  it('a Mac whose daemon was replaced no longer holds the job: the rest is read from the job\'s log file there', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.3, jobGone: true }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('mac-mini no longer holds job hx-mac-mini')
    const logCopy = r.calls.find((c) => c.op === 'host_copy' && String(c.args.from).endsWith('.log'))
    expect(logCopy?.args).toMatchObject({ from_host: 'mac-mini', from: '~/.local/state/open-walnut/tasks/task-1/host-exec/hx-mac-mini.log' })
    // The bytes already read are not taken twice; the results still come back.
    const log = fs.readFileSync(path.join(String(fs.readdirSync(path.join(taskDir, 'ios-fleet')).map((d) => path.join(taskDir, 'ios-fleet', d))[0]), 'run.log'), 'utf8')
    expect(log.match(/remote-run: simulator X/g)).toHaveLength(1)
    expect(log).toContain('FLEET_RESULT ')
    expect(r.calls.some((c) => c.op === 'host_copy' && String(c.args.from).endsWith('/out.tgz'))).toBe(true)
  })

  it('a job log that never gets a result line ends the wait with the file\'s place there', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.3, jobGone: true, logNoResult: true }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('left no result line in its log; it is ~/.local/state/open-walnut/tasks/task-1/host-exec/hx-mac-mini.log there')
    // It gave up after the log stopped growing, not on the first look.
    expect(r.calls.filter((c) => c.op === 'host_copy' && String(c.args.from).endsWith('.log')).length).toBeGreaterThan(5)
  })

  it('a refusal that is not a dropped answer is not asked again', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, fetchFails: 99, fetchError: 'Walnut API error (409): may_prompt', result: { exit: 0, state: 'passed' } }], outTgz())
    const r = run(['unit'], bin)
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host)).toHaveLength(1)
    expect(r.stderr).toContain('may_prompt')
    expect(r.calls.filter((c) => c.op === 'host_exec' && !c.args.background)).toHaveLength(0)
  })

  it('no Mac can take it: says why and exits 75 without sending anything', () => {
    const bin = fakeWalnut([{ host: 'mac-busy', loadPerCpu: 2 }, { host: 'devbox', tags: ['linux'], loadPerCpu: 0 }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('no iOS Mac can take a run now')
    expect(r.calls.map((c) => c.op)).not.toContain('host_copy')
  })

  it('--host names the Mac: no picking, and it is used even when busy elsewhere', () => {
    const bin = fakeWalnut([{ host: 'mac-two', loadPerCpu: 0.2 }], outTgz())
    const r = run(['--host', 'mac-two', 'build'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.map((c) => c.op)).not.toContain('host_list')
    expect(r.calls.find((c) => c.op === 'host_exec')!.args.host).toBe('mac-two')
  })

  it('on the real checkout, the repo files the iOS tests read are all in what is sent', () => {
    // The iOS tests of this repo: every repo-root file they name exists, so the scan finds it.
    const root = path.resolve(__dirname, '../..')
    const r = spawnSync('bash', ['-c', `ROOT=${JSON.stringify(root)}; eval "$(sed -n '/^repo_refs() {/,/^}/p' ${JSON.stringify(SCRIPT)})"; repo_refs`], { encoding: 'utf8' })
    const refs = r.stdout.trim().split('\n')
    expect(refs).toEqual(expect.arrayContaining(['src/core/types.ts', 'tests/fixtures/ask-list', 'tests/fixtures/inbox-parity']))
  })

  it('refuses before any call when it is not run from a task, or run has no command', () => {
    const bin = fakeWalnut([], outTgz())
    const r = spawnSync('bash', [SCRIPT, 'unit'], { cwd: repo, encoding: 'utf8', env: { HOME: dir, PATH: guardedPath([bin], process.env.PATH ?? '/usr/bin:/bin') } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('WALNUT_TASK_DIR is not set')
    expect(run(['run'], bin).status).toBe(64)
    expect(fs.existsSync(path.join(dir, 'calls.jsonl'))).toBe(false)
  })
})

describe('remote-run.sh (the Mac half)', () => {
  // Only the refusals are checkable off a Mac; the build itself ran on a real Mac (ios-native/README.md).
  it.skipIf(process.platform === 'darwin')('a machine without Xcode refuses with 69 and still ends with the result line the caller reads', () => {
    const runDir = path.join(dir, 'run')
    const r = spawnSync('bash', [REMOTE, runDir, 'unit'], { encoding: 'utf8', env: { HOME: dir, PATH: guardedPath([], '/usr/bin:/bin'), WALNUT_SIM_UDID: 'THEIRS' } })
    expect(r.status).toBe(69)
    expect(r.stderr).toContain('no full Xcode on this Mac')
    const last = r.stdout.trim().split('\n').pop() ?? ''
    expect(last.startsWith('FLEET_RESULT ')).toBe(true)
    expect(JSON.parse(last.slice('FLEET_RESULT '.length))).toMatchObject({ exit: 69, state: 'missing', bytes: 0, udid: '' })
    // Nothing of a lock or a simulator was touched.
    expect(fs.existsSync(path.join(dir, 'Library'))).toBe(false)
  })

  it('an unknown option is refused before anything runs', () => {
    const r = spawnSync('bash', [REMOTE, path.join(dir, 'run'), 'unit', '--bogus'], { encoding: 'utf8', env: { HOME: dir, PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(r.status).toBe(64)
    expect(fs.existsSync(path.join(dir, 'run'))).toBe(false)
  })
})
