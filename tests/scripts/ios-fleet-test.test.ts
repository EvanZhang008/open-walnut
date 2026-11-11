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
import { spawn, spawnSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'

const SCRIPT = path.resolve(__dirname, '../../scripts/ios-fleet-test.sh')
const REMOTE = path.resolve(__dirname, '../../ios-native/tests/fleet/remote-run.sh')
let dir = ''
let repo = ''
let taskDir = ''

interface Mac {
  host: string; label?: string; tags?: string[]; connected?: boolean; loadPerCpu?: number | null
  /** host_load's CPU busy share and core count (absent: not reported, as an older daemon). */
  cpuBusy?: number | null; cpus?: number
  /** host_load's runnable threads of our processes and of the others (absent: unknown). */
  ownThreads?: { ours: number; others: number }
  /** Its CPU busy share at each host_load call in turn (the last one repeats). */
  busySeq?: (number | null)[]
  result?: { exit: number; state: string; xcode?: string; runtime?: string }
  /** The fetch of out.tgz fails this many times first (a dropped answer from a loaded Mac), with this error. */
  fetchFails?: number; fetchError?: string
  /** The Mac's daemon was replaced after the first read: it no longer holds the job (unknown_job). */
  jobGone?: boolean
  /** The job's log file there never gets a result line. */
  logNoResult?: boolean
  /** Its load at each host_load call in turn (the last one repeats): a Mac that frees up. */
  loadSeq?: (number | null)[]
  /** The background start fails this many times first, with this error (default: Walnut never took it). */
  startFails?: number; startError?: string
  /** Each run started there in turn ends with these (the last one repeats): busy, then free. */
  resultSeq?: { exit: number; state: string }[]
}

/** A fake `walnut tools call <op> @args.json`: answers from scenario.json, logs every call.
 * `listFails`: host_list drops its answer (hub_timeout) this many times first. */
function fakeWalnut(macs: Mac[], outTgz: string, fleet: { listFails?: number; localIsRemote?: boolean; taskText?: string } = {}): string {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ macs, outTgz, listFails: fleet.listFails || 0, localIsRemote: !!fleet.localIsRemote, taskText: fleet.taskText }))
  fs.writeFileSync(path.join(bin, 'walnut'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(dir)}
const { macs, outTgz, listFails, localIsRemote } = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))
const [, , tools, call, op, argRef] = process.argv
const args = JSON.parse(fs.readFileSync(argRef.slice(1), 'utf8'))
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ op, args }) + '\\n')
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0) }
const mac = (h) => macs.find((m) => m.host === h)
const turn = (name) => { const f = path.join(dir, 'turn-' + name); const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); return n }
if (op === 'host_list' && turn('list') < listFails) { process.stderr.write('walnut: hub_timeout: primary server timed out'); process.exit(1) }
if (op === 'host_list') out({ hosts: macs.map((m) => ({ host: m.host, label: m.label || m.host, capabilities: { tags: m.tags || ['macos', 'ios'] }, connection: { connected: m.connected !== false } })) })
const at = (seq, n) => seq[Math.min(n, seq.length - 1)]
if (op === 'host_load') { const n = turn('load'); out({ hosts: macs.map((m) => { const l = m.loadSeq ? at(m.loadSeq, n) : m.loadPerCpu; const b = m.busySeq ? at(m.busySeq, n) : m.cpuBusy; return { host: m.host, known: l != null, loadPerCpu: l, cpuBusy: b ?? null, cpus: m.cpus, ...(m.ownThreads ? { ownThreads: m.ownThreads } : {}) } }) }) }
if (op === 'host_copy') {
  // As the real op: a copy from or to this computer itself is refused. From a devbox,
  // Walnut's own Mac is another host and the copy goes through (localIsRemote).
  if (!localIsRemote && (args.to_host === '__local__' || args.from_host === '__local__')) { process.stderr.write('walnut: Walnut API error (same_host): Both sides are your own host (__local__)'); process.exit(1) }
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
if (op === 'task_get') out({ task: { title: (JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8')).taskText) || 'iOS board layout', description: '' } })
if (op === 'host_copy_result') out({ running: false, outcome: 'Copied to ' + args.copy_id })
if (op === 'host_exec' && args.background && turn('start-' + args.host) < (mac(args.host).startFails || 0)) {
  process.stderr.write(mac(args.host).startError || 'walnut: hub_unreachable: "host_exec" needs the Walnut server, which is not answering this host right now.\\nwalnut: host_exec did not reach the Walnut server, so nothing ran on ' + args.host + '; call it again once the server answers.'); process.exit(1)
}
if (op === 'host_exec') {
  // An edit to the script while it runs (a commit, the editor), written in place.
  const edit = path.join(dir, 'edit-script')
  if (args.background && fs.existsSync(edit)) {
    const f = fs.readFileSync(edit, 'utf8')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('\\nset -uo pipefail\\n', '\\n# ' + 'an inserted comment that moves every later line '.repeat(8) + '\\nset -uo pipefail\\n'))
  }
  if (args.background) fs.writeFileSync(path.join(dir, 'run-' + args.host), String(turn('runs-' + args.host)))
  // On this computer the run really leaves its results in the task's folder under HOME (the test's dir).
  const home = args.background && args.host === '__local__' && (args.argv[2].split('D="$HOME/')[1] || '').split('"')[0]
  if (home) { fs.mkdirSync(path.join(dir, home), { recursive: true }); fs.copyFileSync(outTgz, path.join(dir, home, 'out.tgz')) }
  out(args.background ? { jobId: 'hx-' + args.host, running: true } : { exitCode: 0, running: false })
}
if (op === 'host_exec_read') {
  const m = mac(args.host)
  const runNo = fs.existsSync(path.join(dir, 'run-' + args.host)) ? Number(fs.readFileSync(path.join(dir, 'run-' + args.host), 'utf8')) : 0
  const r = (m.resultSeq ? at(m.resultSeq, runNo) : m.result) || { exit: 0, state: 'passed' }
  const tail = '** TEST ' + (r.exit ? 'FAILED' : 'SUCCEEDED') + ' **\\nFLEET_RESULT ' + JSON.stringify({ exit: r.exit, state: r.state, out: '/r/out.tgz', bytes: r.state === 'busy' ? 0 : 99, udid: 'U', xcode: r.xcode || '', runtime: r.runtime || '', startedAt: '2026-11-04T05:53:58Z', endedAt: '2026-11-04T06:00:56Z', secs: 418, ...(r.state === 'busy' ? {} : { passed: 41, failed: 0, skipped: 2, xcodeSecs: 397 }) }) + '\\n'
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

function run(args: string[], bin: string, script = SCRIPT, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    cwd: repo, encoding: 'utf8',
    // No wait for a free Mac unless a test asks for one (the script's own default is 30 min).
    env: { HOME: dir, PATH: guardedPath([bin], process.env.PATH ?? '/usr/bin:/bin'), WALNUT_TASK_DIR: taskDir, IOS_FLEET_RETRY_SECS: '0', IOS_FLEET_LOG_POLL_SECS: '0', IOS_FLEET_WAIT_SECS: '0', IOS_FLEET_WAIT_POLL_SECS: '0', ...env },
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
  fs.writeFileSync(path.join(repo, 'ios-native/Walnut/Old.swift'), 'struct Old {}\n')
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base')
  // Uncommitted work goes too; build output git ignores does not.
  fs.writeFileSync(path.join(repo, 'ios-native/Walnut/New.swift'), 'struct New {}\n')
  // A tracked file deleted and not committed yet stays behind, never fails the pack
  // (2026-11-04: tar refused the whole run on one such file).
  fs.rmSync(path.join(repo, 'ios-native/Walnut/Old.swift'))
  fs.mkdirSync(path.join(repo, 'ios-native/DerivedData'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'ios-native/DerivedData/big.o'), 'x')
})
// Every test here runs the script with spawnSync, and back-to-back sync tests never let the
// worker's event loop turn: over a minute of them, vitest's own report to the main process
// timed out ("Timeout calling onTaskUpdate", 2026-11-08). One turn after each test answers it.
afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await new Promise((r) => setTimeout(r, 0))
})

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
    expect(r.stderr).toContain('not using mac-busy (mac-busy): load 4.2 per CPU, over 2 per CPU')
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
    expect(line).toMatch(/remote-run\.sh" "\$D" unit --video --min-idle 25 --max-load 2 -- -only-testing:WalnutTests\/BoardTests/)
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

  // 2026-11-04, the user: iOS tests go to the other Macs; this Walnut's own Mac only when none can.
  it('this Walnut\'s own Mac comes after every other Mac, however idle, and the run says when it falls back to it', () => {
    const bin = fakeWalnut([
      { host: '__local__', loadPerCpu: 0.01 },
      { host: 'mac-two', loadPerCpu: 0.6 },
      { host: 'mac-mini', loadPerCpu: 0.3, result: { exit: 75, state: 'busy' } },
    ], outTgz())
    const r = run(['unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    // mac-mini turns out busy: the next Mac takes it, never this one while another can.
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-mini', 'mac-two'])
    const alone = fakeWalnut([
      { host: '__local__', loadPerCpu: 0.2 },
      { host: 'mac-mini', loadPerCpu: 1.5, cpuBusy: 0.9, cpus: 10 },
      { host: 'laptop', loadPerCpu: 0.1, connected: false },
    ], outTgz())
    const r2 = run(['unit'], alone)
    expect(r2.status, r2.stderr).toBe(0)
    expect(r2.stderr).toContain('not using mac-mini (mac-mini): load 1.5 per CPU, 10% CPU idle (1.0 cores), under 25% idle')
    expect(r2.stderr).toMatch(/using __local__ \(__local__\): load 0\.2 per CPU; no other iOS Mac can take the run/)
    // Run on that Mac itself, host_copy refuses a copy to itself (same_host), and then sources
    // out and results back are copied on this computer (2026-11-04: "could not send the
    // sources to __local__").
    expect(r2.stderr).toContain('Copied on this computer to')
    expect(r2.stderr).not.toContain('same_host')
    expect(r2.calls.filter((c) => c.op === 'host_copy' && (c.args.to_host === '__local__' || c.args.from_host === '__local__'))).toHaveLength(2)
    expect(r2.stderr).toContain('Passed: 41 passed')
  })

  it('a start Walnut never took is asked again; one that may have reached the Mac is not', () => {
    // 2026-11-08: the server was away for a moment, and a run that had waited hours for a
    // calm Mac gave up with "could not start the run".
    const r = run(['unit'], fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.2, startFails: 2 }], outTgz()))
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background)).toHaveLength(3)
    expect(r.stderr).toContain('nothing ran); asking again')
    expect(r.stderr).toContain('Passed: 41 passed')
    fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true })
    for (const f of fs.readdirSync(dir)) if (f.startsWith('turn-')) fs.rmSync(path.join(dir, f))
    const lost = run(['unit'], fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.2, startFails: 1, startError: 'walnut: internal: Walnut API error (503): Walnut lost the Mac while it answered' }], outTgz()))
    expect(lost.status).not.toBe(0)
    expect(lost.calls.filter((c) => c.op === 'host_exec' && c.args.background)).toHaveLength(1)
    expect(lost.stderr).toContain('could not start the run on mac-mini')
  })

  // 2026-11-08: run from a Linux devbox, the shortcut "copied" the sources onto themselves
  // (SameFileError) because Walnut's own Mac is another machine there.
  it('--here-because keeps the run on the named Mac when its simulator queue sends its lane elsewhere', () => {
    // 2026-11-08: the Mac's queue sent lane b to another Mac while runs had to stay here.
    const w = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1 }], outTgz())
    const r = run(['--host', 'mac-mini', '--here-because', "the other Mac is on hold", 'unit'], w)
    expect(r.status, r.stderr).toBe(0)
    const started = r.calls.filter((c) => c.op === 'host_exec' && c.args.background).at(-1)
    expect(started?.args.argv[2].startsWith(String.raw`export SIM_LANE_B_HERE=the\ other\ Mac\ is\ on\ hold ; D="$HOME/`)).toBe(true)
    const plain = run(['--host', 'mac-mini', 'unit'], fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1 }], outTgz()))
    expect(plain.calls.filter((c) => c.op === 'host_exec' && c.args.background).at(-1)?.args.argv[2]).not.toContain('SIM_LANE_B_HERE')
    expect(run(['--here-because', '', 'unit'], w).status).toBe(64)
  })

  it('from another host, Walnut\'s own Mac is reached through host_copy like any Mac', () => {
    const bin = fakeWalnut([{ host: '__local__', loadPerCpu: 0.2 }], outTgz(), { localIsRemote: true })
    const r = run(['unit'], bin)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('Copied on this computer to')
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.to_host === '__local__')).toHaveLength(1)
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.from_host === '__local__').length).toBeGreaterThanOrEqual(1)
    expect(r.stderr).toContain('Passed: 41 passed')
  })

  // 2026-11-07: a unit run (3a2e35ef) waited 110 minutes for this Mac's load to fall under 0.75 per
  // CPU while 30 to 48% of its CPU was idle. 2026-11-08, the Operations VP: free CPU is only an extra
  // condition; at a backstop of 4 a lease booted at load 48 and the load went to 377, so the line is 2.
  // 2026-11-08: a call app and security agents held a Mac's load at 40 to 80 for hours with a third of
  // its CPU idle. host_load reads the whole load, so a Mac over the line with free CPU is tried after
  // the others, and its own check (remote-run.sh) counts only our share of its load.
  it('free CPU picks among the Macs under the load line of 2 per CPU first; one over it with free CPU comes after', () => {
    const macs = [
      { host: 'mac-a', loadPerCpu: 0.2, cpuBusy: 0.7, cpus: 8 },
      { host: 'mac-b', loadPerCpu: 1.8, cpuBusy: 0.55, cpus: 14 },
      { host: 'mac-e', loadPerCpu: 3.4, cpuBusy: 0.2, cpus: 14 },
      { host: 'mac-c', loadPerCpu: 0.1, cpuBusy: 0.8, cpus: 10 },
      { host: 'mac-d', loadPerCpu: 4.5, cpuBusy: 0.1, cpus: 14 },
    ]
    // Each run reads only its own calls (the fake appends to one file in the test's directory).
    const fresh = () => fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true })
    const r = run(['unit'], fakeWalnut(macs, outTgz()))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('using mac-b (mac-b): load 1.8 per CPU, 45% CPU idle (6.3 cores)')
    expect(r.stderr).not.toContain('not using mac-e')
    expect(r.stderr).toContain('not using mac-c (mac-c): load 0.1 per CPU, 20% CPU idle (2.0 cores), under 25% idle')
    expect(r.stderr).not.toContain('not using mac-d')
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-b'])
    // Only Macs over the line: the one with the most free cores, saying why it may still run there.
    fresh()
    const over = macs.filter((m) => m.loadPerCpu > 2)
    const ro = run(['unit'], fakeWalnut(over, outTgz()))
    expect(ro.status, ro.stderr).toBe(0)
    expect(ro.stderr).toContain('using mac-d (mac-d): load 4.5 per CPU, 90% CPU idle (12.6 cores), over 2 per CPU: tried after the others, its own check counts our share of its load')
    // A share in host_load: over the line, our share of the load is judged (mac-d: 4.5 x 1/5 = 0.9),
    // so it counts as under the line and its free cores pick it before mac-b.
    fresh()
    const shared = macs.map((m) => (m.host === 'mac-d' ? { ...m, ownThreads: { ours: 10, others: 40 } } : m))
    const rs = run(['unit'], fakeWalnut(shared, outTgz()))
    expect(rs.status, rs.stderr).toBe(0)
    expect(rs.stderr).toContain('using mac-d (mac-d): load 0.9 per CPU (our share of 4.5), 90% CPU idle (12.6 cores)')
    expect(rs.stderr).not.toContain('tried after the others')
    // Over the ceiling of 6 per CPU the whole load counts, however small our share (2026-11-09: 371
    // on 14 CPUs, 26.5 per CPU, passed as our share while other processes' threads grew with it).
    fresh()
    const peak = [{ host: 'mac-p', loadPerCpu: 26.5, cpuBusy: 0.6, cpus: 14, ownThreads: { ours: 2, others: 98 } }]
    const rp = run(['--wait', '0', 'unit'], fakeWalnut(peak, outTgz()))
    expect(rp.status).toBe(75)
    expect(rp.stderr).toContain('not using mac-p (mac-p): load 26.5 per CPU, 40% CPU idle (5.6 cores), over 6 per CPU, where the whole load counts')
    expect(rp.stderr).not.toContain('our share of 26.5')
    // Over the line with its idle CPU unknown: not tried.
    fresh()
    const ru = run(['--wait', '0', 'unit'], fakeWalnut([{ host: 'mac-u', loadPerCpu: 3, cpus: 14 }], outTgz()))
    expect(ru.status).toBe(75)
    expect(ru.stderr).toContain('not using mac-u (mac-u): load 3 per CPU, over 2 per CPU')
    // --min-idle moves the bar, and the Mac half gets the same bar.
    fresh()
    const r2 = run(['--min-idle', '50', '--wait', '0', 'unit'], fakeWalnut(macs, outTgz()))
    expect(r2.status, r2.stderr).toBe(0)
    expect(r2.stderr).toContain('not using mac-b (mac-b): load 1.8 per CPU, 45% CPU idle (6.3 cores), under 50% idle')
    expect(r2.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-d'])
    expect((r2.calls.find((c) => c.op === 'host_exec' && c.args.background)!.args.argv as string[])[2]).toContain('unit --min-idle 50 --max-load 2 --')
    fresh()
    const r2b = run(['--min-idle', '95', '--wait', '0', 'unit'], fakeWalnut(macs, outTgz()))
    expect(r2b.status).toBe(75)
    fresh()
    const r3 = run(['--min-idle', '10', 'unit'], fakeWalnut(macs, outTgz()))
    expect(r3.status, r3.stderr).toBe(0)
    expect((r3.calls.find((c) => c.op === 'host_exec' && c.args.background)!.args.argv as string[])[2]).toContain('unit --min-idle 10 --max-load 2 --')
    // A bar that is not a number is refused before anything runs.
    for (const bad of [['--min-idle', 'soon'], ['--min-idle', '150'], ['--max-load', 'x']]) {
      fresh()
      const rb = run([...bad, 'unit'], fakeWalnut(macs, outTgz()))
      expect(rb.status, rb.stderr).toBe(64)
      expect(rb.calls.map((c) => c.op)).not.toContain('host_copy')
    }
    // A Mac whose daemon reports no CPU share goes after those that do, by load, and is not refused for it.
    fresh()
    const r4 = run(['unit'], fakeWalnut([{ host: 'mac-old', loadPerCpu: 0.1 }, { host: 'mac-a', loadPerCpu: 2, cpuBusy: 0.5, cpus: 8 }], outTgz()))
    expect(r4.status, r4.stderr).toBe(0)
    expect(r4.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-a'])
  })

  it('an edit to the script while it runs does not change the run (bash reads the whole script first)', () => {
  // 2026-11-04: a commit to this script during a 7-minute run made bash read the rest of
  // the new file from the old offset: "syntax error near unexpected token done", exit 2,
  // after the tests had passed on the Mac.
  const copy = path.join(dir, 'ios-fleet-test.sh')
  fs.copyFileSync(SCRIPT, copy)
  fs.writeFileSync(path.join(dir, 'edit-script'), copy)
  const r = run(['unit'], fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1 }], outTgz()), copy)
  expect(fs.readFileSync(copy, 'utf8'), r.stderr).toContain('an inserted comment')
  expect(r.stderr).not.toMatch(/syntax error|command not found/)
  expect(r.status, r.stderr).toBe(0)
  expect(r.stderr).toContain('results: ')
})

  it('the run says how long it took there, on the UTC clock', () => {
    const r = run(['unit'], fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1 }], outTgz()))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('ios-fleet: took 418 s there, 2026-11-04T05:53:58Z to 2026-11-04T06:00:56Z (xcodebuild 397 s)')
  })

  it('a Mac that turns out busy hands the run to the next one; a failed run keeps its exit code', () => {
    const bin = fakeWalnut([
      { host: 'mac-mini', loadPerCpu: 0.1, result: { exit: 75, state: 'busy' } },
      { host: 'mac-two', loadPerCpu: 0.2, result: { exit: 65, state: 'failed' } },
    ], outTgz())
    const r = run(['ui'], bin)
    expect(r.status).toBe(65)
    expect(r.stderr).toContain('mac-mini is busy (see its BUSY line above); trying the next Mac')
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
    const bin = fakeWalnut([{ host: 'mac-busy', loadPerCpu: 2, cpuBusy: 0.95 }, { host: 'devbox', tags: ['linux'], loadPerCpu: 0 }], outTgz())
    const r = run(['unit'], bin)
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('no iOS Mac can take a run now')
    expect(r.stderr).toContain('try again later, or pass --wait, --min-idle or --max-load')
    expect(r.calls.map((c) => c.op)).not.toContain('host_copy')
  })

  it('every Mac busy: it waits its turn, says so once, and runs on the first Mac that frees up', () => {
    // 2026-11-04: a UI test run failed at once (exit 75) while another task's run held the
    // only free Mac; the Macs are shared, so a run queues instead of racing.
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 2, busySeq: [0.9, 0.85, 0.9, 0.1] }], outTgz())
    const r = run(['ui'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60', IOS_FLEET_WAIT_POLL_SECS: '0' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('no iOS Mac can take a run now (each is busy, offline, or has no simulator runtime); waiting for one (up to 1 min, asking again every 0 s; --wait 0 does not wait)')
    expect(r.stderr.match(/waiting for one/g)).toHaveLength(1)
    // The same reason is not printed again on every check.
    expect(r.stderr.match(/not using mac-mini/g)).toHaveLength(1)
    expect(r.stderr).toMatch(/a Mac is free after \d+ s of waiting/)
    expect(r.calls.filter((c) => c.op === 'host_load').length).toBeGreaterThanOrEqual(4)
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-mini'])
  })

  it('a named Mac busy with another run: the run waits for it and goes there once it is free', () => {
    const bin = fakeWalnut([{ host: 'mac-two', loadPerCpu: 0.2, resultSeq: [{ exit: 75, state: 'busy' }, { exit: 75, state: 'busy' }, { exit: 0, state: 'passed' }] }], outTgz())
    const r = run(['--host', 'mac-two', 'unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('every iOS Mac that could take it is busy; waiting for one')
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-two', 'mac-two', 'mac-two'])
    expect(r.stderr).toContain('results: ')
    // The sources went once; the later tries use what is already there.
    expect(r.calls.filter((c) => c.op === 'host_copy' && c.args.to_host)).toHaveLength(1)
    expect(r.stderr.match(/the sources are already on mac-two from an earlier try/g)).toHaveLength(2)
  })

  it('a Mac that stays busy until the wait ends: its copy of the sources there is removed, and the scratch files here', () => {
    // Before, a busy try went straight to the next one, and the unpacked sources stayed on the
    // Mac (maybe someone else's computer) after the run gave up.
    const bin = fakeWalnut([{ host: 'mac-two', loadPerCpu: 0.2, result: { exit: 75, state: 'busy' } }], outTgz())
    const r = run(['--host', 'mac-two', 'unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '3', IOS_FLEET_WAIT_POLL_SECS: '0.1' })
    expect(r.status).toBe(75)
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).length).toBeGreaterThanOrEqual(2)
    const clean = r.calls.filter((c) => c.op === 'host_exec' && !c.args.background)
    expect(clean).toHaveLength(1)
    expect(clean[0].args.host).toBe('mac-two')
    expect((clean[0].args.argv as string[])[2]).toMatch(/^rm -rf "\$HOME\/\.local\/state\/open-walnut\/tasks\/task-1\/ios-fleet\/\d{8}T\d{6}Z-\d+"$/)
    for (const n of fs.readdirSync(path.join(taskDir, 'ios-fleet'))) {
      expect(fs.existsSync(path.join(taskDir, 'ios-fleet', n, 'src.tgz'))).toBe(false)
      expect(fs.existsSync(path.join(taskDir, 'ios-fleet', n, '.op-args.json'))).toBe(false)
    }
  })

  it('a Mac that said busy goes after one that just became free', () => {
    const bin = fakeWalnut([
      { host: 'mac-a', loadPerCpu: 0.1, result: { exit: 75, state: 'busy' } },
      { host: 'mac-c', loadSeq: [5, 0.3], result: { exit: 0, state: 'passed' } },
    ], outTgz())
    const r = run(['unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.calls.filter((c) => c.op === 'host_exec' && c.args.background).map((c) => c.args.host)).toEqual(['mac-a', 'mac-c'])
  })

  it('a reason that only changes its load figure is not printed again on every check', () => {
    const bin = fakeWalnut([
      { host: 'mac-hot', loadSeq: [4.5, 5, 5.9] }, // under the ceiling of 6, where the reason itself changes
      { host: 'mac-mini', loadPerCpu: 0.1, resultSeq: [{ exit: 75, state: 'busy' }, { exit: 75, state: 'busy' }, { exit: 0, state: 'passed' }] },
    ], outTgz())
    const r = run(['unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr.match(/not using mac-hot/g)).toHaveLength(1)
  })

  it('a fleet read Walnut keeps dropping while the run waits is a round with no Mac, not the end of the run', () => {
    // host_list was asked once with no retry: one hub_timeout ended a long wait with exit 1.
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, result: { exit: 0, state: 'passed' } }], outTgz(), { listFails: 9 })
    const r = run(['unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('could not read the fleet now (hub_timeout); no Mac this round')
    expect(r.calls.filter((c) => c.op === 'host_list')).toHaveLength(10)
  })

  it('no host tagged ios at all: says so at once (69), with nothing to wait for', () => {
    const bin = fakeWalnut([{ host: 'devbox', tags: ['linux'], loadPerCpu: 0 }], outTgz())
    const r = run(['unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '60' })
    expect(r.status).toBe(69)
    expect(r.stderr).toContain('no host in the fleet is tagged ios (host_list); name a Mac with --host')
    expect(r.stderr).not.toContain('waiting for one')
  })

  it('--wait reads whole minutes in base 10 and refuses a number too long', () => {
    // "08" was a bad octal number to bash's arithmetic, and the script died with exit 1.
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 0.1, result: { exit: 0, state: 'passed' } }], outTgz())
    const r = run(['--wait', '08', 'unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '' })
    expect(r.status, r.stderr).toBe(0)
    expect(run(['--wait', '12345', 'unit'], bin).status).toBe(64)
    // The exit code is not part of the message.
    expect(run(['--wait', 'soon', 'unit'], bin).stderr.trim()).toBe('ios-fleet: --wait takes whole minutes')
  })

  it('the wait has an end: none free within --wait exits 75 and says how long it waited', () => {
    const bin = fakeWalnut([{ host: 'mac-mini', loadPerCpu: 3, cpuBusy: 0.95 }], outTgz())
    const r = run(['unit'], bin, SCRIPT, { IOS_FLEET_WAIT_SECS: '1', IOS_FLEET_WAIT_POLL_SECS: '0.2' })
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('none could take it in the 1 s this run waited; try again later, or pass --wait, --min-idle or --max-load')
    expect(r.calls.map((c) => c.op)).not.toContain('host_copy')
    expect(run(['--wait', 'soon', 'unit'], bin).status).toBe(64)
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
    // When it ran, in UTC, and for how long, also on a refusal; no counts without a result bundle.
    const res = JSON.parse(last.slice('FLEET_RESULT '.length)) as Record<string, unknown>
    expect(res.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(res.endedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(res.secs).toBeGreaterThanOrEqual(0)
    expect(res).not.toHaveProperty('passed')
    // Nothing of a lock or a simulator was touched.
    expect(fs.existsSync(path.join(dir, 'Library'))).toBe(false)
  })

  it('every variable the result line reads is set in one place only (no other use of the name)', () => {
    // 2026-11-04: the start time shared its name with the "this run started the simulator" flag,
    // which the run later set to the simulator's UDID, so a passed run reported its UDID as startedAt.
    // The refusal above ends before that line, and a real run needs a Mac, so this reads the script.
    const src = fs.readFileSync(REMOTE, 'utf8')
    const printf = src.split('\n').find((l) => l.includes("printf 'FLEET_RESULT")) ?? ''
    const vars = [...printf.matchAll(/"\$([A-Z_][A-Z0-9_]*)"/g)].map((m) => m[1])
    // Set once at the top and then only by the steps that discover them.
    const discovered = new Set(['UDID', 'XCODE', 'RUNTIME_NAME', 'RUN_DIR'])
    const once = vars.filter((v) => !discovered.has(v))
    expect(once).toEqual(['RUN_AT'])
    for (const v of once) {
      const sets = src.split('\n').filter((l) => !l.trim().startsWith('#') && new RegExp(`(^|[\\s;(])${v}=`).test(l))
      expect(sets, `${v} is set more than once`).toHaveLength(1)
    }
  })

  it('an unknown option is refused before anything runs', () => {
    const r = spawnSync('bash', [REMOTE, path.join(dir, 'run'), 'unit', '--bogus'], { encoding: 'utf8', env: { HOME: dir, PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(r.status).toBe(64)
    expect(fs.existsSync(path.join(dir, 'run'))).toBe(false)
  })
})

describe('mac-share.sh (what the Mac half asks of the Mac before it takes anything)', () => {
  // 2026-11-04: a run that fell back to this Walnut's own Mac made a third simulator there
  // ("Walnut Fleet Test", beside the owner's own and their gate lane), and runs went on while the
  // owner was on a call at a load of 736. A call now makes a Mac busy, and an owner's queue can
  // lend fleet runs a lane so they make no simulator of their own.
  const SHARE = path.resolve(__dirname, '../../ios-native/tests/fleet/mac-share.sh')
  const SIMLIB = path.resolve(__dirname, '../../scripts/lib/sim-device.sh')
  const WATCHDOG = path.resolve(__dirname, '../../ios-native/tests/fleet/watchdog.py')
  const UITESTS = path.resolve(__dirname, '../../ios-native/tests/ui/run-ui-tests.sh')
  const sh = (script: string, input = '', env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `set -uo pipefail; . "${SIMLIB}"; . "${SHARE}"; ${script}`],
      { encoding: 'utf8', input, env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: dir, TMPDIR: dir, ...env } })
  const line = (app: string, age: string, type: string, name: string) =>
    `   pid 4242(${app}): [0x00012a5500018cfb] ${age} ${type} named: "${name}"  `
  const calls = (lines: string[]) => sh('fleet_call_apps', ['Listed by owning process:', ...lines].join('\n') + '\n').stdout.trim()
  // A fake queue: records every call, lends lane b's device unless FAKE_QUEUE says otherwise.
  const fakeQueue = () => {
    const q = path.join(dir, 'queue.sh')
    fs.writeFileSync(q, [
      '#!/bin/bash',
      `echo "$SIM_LANE $*" >> "${path.join(dir, 'queue.calls')}"`,
      'case "$1" in',
      ' acquire)',
      '   case "${FAKE_QUEUE:-}" in',
      '     wait) echo "WAIT a call is on (zoom.us pid 7) (no lease taken; queued at position 1 on lane b)"; exit 1 ;;',
      '     broken) echo "sim-queue: something broke"; exit 3 ;;',
      '   esac',
      '   echo "ACQUIRED lane $SIM_LANE for $2 (holder pid $4)"; echo "BOOTED lane $SIM_LANE simulator a4dd19a8-bf72-4a5a-870a-6c8208c7dd0e (3s)" ;;',
      ' release) echo "RELEASED lane $SIM_LANE" ;;',
      'esac',
    ].join('\n') + '\n')
    return q
  }
  const queueCalls = () => {
    const f = path.join(dir, 'queue.calls')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []
  }

  it('a call app holding the display awake is a call; the same app with a system-sleep hold is not', () => {
    expect(calls([line('zoom.us', '00:12:09', 'PreventUserIdleDisplaySleep', 'Zoom meeting')])).toBe('zoom.us')
    expect(calls([line('zoom.us', '00:12:09', 'PreventUserIdleSystemSleep', 'Zoom')])).toBe('')
  })

  it('updates, video playback and a hold over 12 hours are not calls', () => {
    expect(calls([
      line('zoom.us', '00:01:00', 'NoDisplaySleepAssertion', 'Zoom update download'),
      line('Google Chrome', '00:03:00', 'PreventUserIdleDisplaySleep', 'Video Wake Lock'),
      line('MSTeams', '13:00:00', 'NoDisplaySleepAssertion', 'call'),
      line('caffeinate', '12:12:59', 'PreventUserIdleDisplaySleep', 'caffeinate command-line tool'),
    ])).toBe('')
  })

  it('any process holding a WebRTC call is one; each app is named once', () => {
    expect(calls([
      line('Google Chrome Helper (Renderer)', '00:03:00', 'PreventUserIdleSystemSleep', 'WebRTC has active PeerConnections'),
      line('MSTeams', '00:20:00', 'NoDisplaySleepAssertion', 'call'),
      line('MSTeams', '00:20:01', 'PreventUserIdleDisplaySleep', 'call'),
    ])).toBe('Google Chrome Helper (Renderer), MSTeams')
  })

  it('reading the call state costs no fixed wait: the 5 s bound does not hold the answer', () => {
    const pm = path.join(dir, 'pmset')
    fs.writeFileSync(pm, `#!/bin/bash\nprintf '%s\\n' 'Listed by owning process:' '${line('zoom.us', '00:00:30', 'PreventUserIdleDisplaySleep', 'm')}'\n`)
    fs.chmodSync(pm, 0o755)
    const t0 = Date.now()
    const r = sh('echo "[$(fleet_call_now)]"', '', { FLEET_PMSET: pm })
    expect(r.stdout.trim()).toBe('[zoom.us]')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('an owner lends a lane with two lines (export and quotes allowed); one line, lane a or a missing script is refused', () => {
    const env = path.join(dir, 'fleet.env')
    const q = fakeQueue()
    const lent = () => sh(`fleet_lent_lane "${env}"; echo "rc=$? q=$FLEET_LENT_QUEUE l=$FLEET_LENT_LANE e=$FLEET_LENT_ERROR"`).stdout.trim()
    expect(lent()).toBe('rc=0 q= l= e=')
    fs.writeFileSync(env, `WALNUT_FLEET_SIM_QUEUE_SCRIPT=${q}\nWALNUT_FLEET_SIM_LANE=b\n`)
    expect(lent()).toBe(`rc=0 q=${q} l=b e=`)
    fs.writeFileSync(env, `export WALNUT_FLEET_SIM_QUEUE_SCRIPT="${q}"\n  export WALNUT_FLEET_SIM_LANE='b'  \n`)
    expect(lent()).toBe(`rc=0 q=${q} l=b e=`)
    fs.writeFileSync(env, 'WALNUT_FLEET_SIM_LANE=b\n')
    expect(lent()).toBe(`rc=1 q= l= e=${env} names only one of WALNUT_FLEET_SIM_QUEUE_SCRIPT and WALNUT_FLEET_SIM_LANE`)
    fs.writeFileSync(env, `WALNUT_FLEET_SIM_QUEUE_SCRIPT=${q}\nWALNUT_FLEET_SIM_LANE=a\n`)
    expect(lent()).toContain('rc=1 q= l= e=')
    expect(lent()).toContain('not a (the owner\'s own): a')
    fs.writeFileSync(env, `WALNUT_FLEET_SIM_QUEUE_SCRIPT=${q}.gone\nWALNUT_FLEET_SIM_LANE=b\n`)
    expect(lent()).toContain('is not a file')
  })

  it('a lent lane is named in the lock dir before the queue is asked, and the run\'s exit gives it back', () => {
    const q = fakeQueue()
    const lock = path.join(dir, 'lock'); fs.mkdirSync(lock)
    // The run's own shape: take, set the trap, then leave by a refusal-style exit.
    const r = sh(`FLEET_LENT_QUEUE="${q}"; FLEET_LENT_LANE=b
      fleet_take_lent "20261104T1200 ui" "${lock}"; rc=$?
      trap 'fleet_give_back "${lock}"' EXIT
      echo "pid=$$ rc=$rc device=$WALNUT_SIM_DEVICE lease=$(tr '\\n' ' ' < "${lock}/lease")"; exit 75`)
    expect(r.status).toBe(75)
    const pid = /pid=(\d+)/.exec(r.stdout)?.[1]
    expect(r.stdout).toContain(`rc=0 device=A4DD19A8-BF72-4A5A-870A-6C8208C7DD0E lease=${pid} ${q} b `)
    expect(queueCalls()).toEqual([`b acquire fleet-20261104T1200-ui --pid ${pid}`, `b release --pid ${pid}`])
    expect(fs.existsSync(path.join(lock, 'lease'))).toBe(false)
  })

  it('a queue that lends nothing now is busy (1); a queue that fails is a setup fault (2); neither leaves a lease named', () => {
    const q = fakeQueue()
    const lock = path.join(dir, 'lock'); fs.mkdirSync(lock)
    const take = (mode: string) => sh(`FLEET_LENT_QUEUE="${q}"; FLEET_LENT_LANE=b; fleet_take_lent run1 "${lock}"; echo "rc=$?"`, '', { FAKE_QUEUE: mode })
    let r = take('wait')
    expect(r.stdout.trim()).toBe('rc=1')
    expect(r.stderr).toContain('WAIT a call is on (zoom.us pid 7)')
    expect(r.stderr).toContain('join the queue first')
    expect(fs.existsSync(path.join(lock, 'lease'))).toBe(false)
    r = take('broken')
    expect(r.stdout.trim()).toBe('rc=2')
    expect(r.stderr).toContain('something broke')
    expect(fs.existsSync(path.join(lock, 'lease'))).toBe(false)
  })

  it('the watchdog gives a lent lane back once the run is killed outright, and only then', () => {
    const q = fakeQueue()
    const lock = path.join(dir, 'lock'); fs.mkdirSync(lock)
    const run = spawn('sleep', ['30'], { stdio: 'ignore' })
    const pid = String(run.pid)
    fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`)
    fs.writeFileSync(path.join(lock, 'lease'), `${pid}\n${q}\nb\n`)
    // Alive past the watchdog's max time: it touches nothing.
    let w = spawnSync('python3', [WATCHDOG, pid, lock, '1'], { encoding: 'utf8', timeout: 20000 })
    expect(w.status).toBe(0)
    expect(queueCalls()).toEqual([])
    expect(fs.existsSync(path.join(lock, 'lease'))).toBe(true)
    // Killed with no trap run: the lease goes back and the lock is freed.
    run.kill('SIGKILL')
    w = spawnSync('python3', [WATCHDOG, pid, lock, '60'], { encoding: 'utf8', timeout: 20000 })
    expect(w.status).toBe(0)
    expect(queueCalls()).toEqual([`b release --pid ${pid}`])
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('a lease file naming another pid is left alone by the watchdog', () => {
    const q = fakeQueue()
    const lock = path.join(dir, 'lock'); fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'lease'), `999999\n${q}\nb\n`)
    const w = spawnSync('python3', [WATCHDOG, '999998', lock, '60'], { encoding: 'utf8', timeout: 20000 })
    expect(w.status).toBe(0)
    expect(queueCalls()).toEqual([])
  })

  it('a UI run whose caller holds the simulator takes no lane lock of the machine (lane a is the owner\'s)', () => {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'xcodegen'), '#!/bin/bash\nexit 1\n'); fs.chmodSync(path.join(bin, 'xcodegen'), 0o755)
    const locks = path.join(dir, 'locks'); fs.mkdirSync(locks)
    const ui = (held: string) => spawnSync('bash', [UITESTS], {
      encoding: 'utf8', timeout: 30000,
      env: { PATH: guardedPath([], `${bin}:/usr/bin:/bin`), HOME: dir, TMPDIR: dir,
        WALNUT_SIM_UDID: 'A4DD19A8-BF72-4A5A-870A-6C8208C7DD0E', WALNUT_SIM_LOCK_DIR: locks,
        ...(held ? { WALNUT_UITEST_LEASE_HELD: held } : {}) },
    })
    let r = ui('1')
    expect(r.stdout).toContain('simulator held by the caller (WALNUT_UITEST_LEASE_HELD=1)')
    expect(r.stderr).toContain('xcodegen generate failed')
    expect(fs.readdirSync(locks)).toEqual([])
    // Without it the run takes lane a's lock (and gives it back at its exit), as before.
    r = ui('')
    expect(r.stdout).toContain('simulator lease held')
    expect(r.stdout).not.toContain('held by the caller')
  })

  // 2026-11-08: an iPhone voice recording run went to another person's Mac.
  // 2026-11-11: a board test was refused there because its task quoted the user's "voice" message.
  it('a run is an audio run by the tests it runs, never by the words of its task', () => {
    const macs = [{ host: 'mac-mini', loadPerCpu: 0.3 }]
    const sent = (args: string[], taskText?: string, env: Record<string, string> = {}) => {
      fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true })
      const r = run(args, fakeWalnut(macs, outTgz(), { taskText }), SCRIPT, env)
      expect(r.status, r.stderr).toBe(0)
      // The task's words are never read for it.
      expect(r.calls.some((c) => c.op === 'task_get')).toBe(false)
      // The command line sent to the Mac, without its shell quoting.
      return (r.calls.find((c) => c.op === 'host_exec' && c.args.background)!.args.argv as string[])[2].replace(/\\/g, '')
    }
    const ui = path.join(repo, 'ios-native/WalnutUITests')
    fs.mkdirSync(ui, { recursive: true })
    fs.writeFileSync(path.join(ui, 'VoiceDictationUITests.swift'), 'final class VoiceDictationUITests: XCTestCase {}\n')
    fs.writeFileSync(path.join(ui, 'BoardRingTapUITests.swift'), 'final class BoardRingTapUITests: XCTestCase {}\n')
    const unit = path.join(repo, 'ios-native/WalnutTests')
    // A logic test of voice code names the audio types and starts nothing.
    fs.writeFileSync(path.join(unit, 'VoiceSessionDiagnosisTests.swift'),
      'final class VoiceSessionDiagnosisTests: XCTestCase {\n  // AVAudioRecorder( in a comment starts nothing\n  let code = AVAudioSession.ErrorCode.isBusy\n}\n')

    // The class of the bug: whatever a task says about voice or sound, a run of tests that
    // touch no audio is no audio run.
    const words = [
      'Evan, his words exactly (voice, 11-11): Watching follows the tier tab',
      'iPhone action button: \u6309\u4e00\u4e0b\u8bf4\u4e00\u6bb5\u8bdd',
      '\u8bed\u97f3\u8bc6\u522b\u8d28\u91cf\u4e0b\u964d',
      'microphone, dictation, speech, transcribe, STT, TTS, Siri, audio, speaker, \u9ea6\u514b\u98ce, \u5f55\u97f3, \u58f0\u97f3',
      'Board layout. lane B \u53ea\u5728\u90a3\u53f0\u7684\u58f0\u97f3\u662f\u9759\u97f3\u65f6\u624d\u5f00\u59cb\u8dd1',
    ]
    for (const text of words) {
      expect(sent(['unit'], text), text).not.toContain('--audio')
      expect(sent(['unit', '--', '-only-testing:WalnutTests/RepoTests'], text), text).not.toContain('--audio')
      expect(sent(['ui', '--', '-only-testing:WalnutUITests/BoardRingTapUITests'], text), text).not.toContain('--audio')
      expect(sent(['build'], text), text).not.toContain('--audio')
    }

    // What the run does decides. A UI test of a voice screen opens the microphone in the app.
    expect(sent(['ui', '--', '-only-testing:WalnutUITests/VoiceDictationUITests'], 'Board layout')).toMatch(/ui --audio .*it runs VoiceDictationUITests, a voice test/)
    // The whole UI suite holds it; skipped, it does not.
    expect(sent(['ui'], 'Board layout')).toMatch(/ui --audio .*VoiceDictationUITests/)
    expect(sent(['ui', '--', '-skip-testing:WalnutUITests/VoiceDictationUITests'], 'Board layout')).not.toContain('--audio')
    // A unit test counts only when its source starts audio hardware, whatever its name.
    expect(sent(['unit', '--', '-only-testing:WalnutTests/VoiceSessionDiagnosisTests'], 'Board layout')).not.toContain('--audio')
    fs.writeFileSync(path.join(unit, 'RecorderTests.swift'), 'final class RecorderTests: XCTestCase {\n  func testIt() { _ = try? AVAudioRecorder(url: u, settings: [:]) }\n}\n')
    expect(sent(['unit'], 'Board layout')).toMatch(/unit --audio .*RecorderTests starts audio hardware \(AVAudioRecorder\)/)
    expect(sent(['unit', '--', '-only-testing:WalnutTests/RepoTests'], 'Board layout')).not.toContain('--audio')
    // A command is judged by the tests it names, else by its own words.
    expect(sent(['run', '--', 'xcodebuild', 'test', '-only-testing:WalnutUITests/VoiceDictationUITests'], 'Board layout')).toMatch(/run --audio .*VoiceDictationUITests/)
    expect(sent(['run', '--', 'bash', 'tests/voice/record.sh'], 'Board layout')).toMatch(/run --audio .*its command names "voice"/)
    expect(sent(['run', '--', 'bash', 'tests/passwords/autofill-e2e.sh'], 'voice')).not.toContain('--audio')
    // The caller's own word still wins.
    expect(sent(['--audio', 'records a memo', 'unit'], 'Board layout')).toMatch(/unit --audio records a memo/)
    expect(sent(['unit'], 'Board layout', { SIM_TEST_AUDIO: 'plays a cue' })).toMatch(/unit --audio plays a cue/)

    const src = fs.readFileSync(REMOTE, 'utf8')
    expect(src).toMatch(/if \[ -n "\$AUDIO_WHY" \] && \{ \[ -f "\$HOME\/\.config\/walnut\/no-audio" \]/)
    expect(src).toContain('refuse 75 "BUSY: this run touches voice, the microphone or audio')
    // A run judged no audio run says so to the lent queue, which must not guess from the task's words.
    expect(src).toContain('[ -n "$AUDIO_WHY" ] || export SIM_TEST_NOT_AUDIO=')
    // A Mac on hold, or in its quiet nights (2026-11-08, the user: a computer at home made sound at night).
    expect(src).toContain('for hf in "$HOME/.config/walnut/hold" ${HOLD_DIR:+"$HOLD_DIR/HOLD"}; do')
    expect(src).toContain('22|23|00|01|02|03|04|05|06|07) refuse 75 "BUSY: this Mac runs nothing from 22:00 to 08:00 Pacific')
  })

  it('the Mac half keeps the load line, then memory, then free CPU (fleet_cpu_busy)', () => {
    const busy = (...a: string[]) => sh(`fleet_cpu_busy ${a.map((x) => `'${x}'`).join(' ')}`).stdout.trim()
    // 2026-11-08: load 48 on 14 CPUs with 45% idle waits; free CPU never replaces the load.
    expect(busy('45', '48', '14', '25', '2')).toBe('load 48 on 14 CPUs is over 2 per CPU')
    expect(busy('45', '28', '14', '25', '2', '1 0 0 2000')).toBe('')
    expect(busy('20', '1', '14', '25', '2')).toBe('only 20% of the CPU is idle (2.8 of 14 cores), under 25%')
    // Memory tight by the load watchdog's rule: pressure warn, the compressor at 14 GB, or swap 80% full at 10 GB.
    expect(busy('90', '1', '14', '25', '2', '2 0 0 0')).toBe('memory is tight (pressure level 2, swap 0/0MB, compressor 0MB)')
    expect(busy('90', '1', '14', '25', '2', '1 0 0 14336')).toContain('memory is tight')
    expect(busy('90', '1', '14', '25', '2', '1 900 1000 10240')).toContain('memory is tight')
    expect(busy('90', '1', '14', '25', '2', '1 900 1000 9000')).toBe('')
    // An idle share or a memory reading that could not be read does not block.
    expect(busy('', '10', '14', '25', '2', '')).toBe('')
    expect(sh('fleet_mem').status).toBe(0)
    // The Mac half reads it before it takes anything, with the load line of 2 by default.
    const src = fs.readFileSync(REMOTE, 'utf8')
    expect(src).toContain('WHY=$(fleet_cpu_busy "$(fleet_idle_pct 5)" "$LOAD1" "$CPUS" "$MIN_IDLE" "$MAX_LOAD" "$(fleet_mem)")')
    expect(src).toContain('MIN_IDLE=25; MAX_LOAD=2;')
    expect(src.indexOf('WHY=$(fleet_cpu_busy')).toBeLessThan(src.indexOf('CALL=$(fleet_call_now)'))
  })

  it('a production deploy building on the Mac makes it busy; a record its runner left does not', () => {
    const q = path.join(dir, 'dq')
    fs.mkdirSync(path.join(q, 'runner.lock'), { recursive: true })
    const now = (pid: string) => {
      fs.writeFileSync(path.join(q, 'runner.lock', 'pid'), pid)
      return sh('echo "[$(fleet_deploy_now)]"', '', { WALNUT_DEPLOY_QUEUE_DIR: q }).stdout.trim()
    }
    // The runner: a live process whose command names deploy-committed (as dq_runner_pid reads it).
    const runner = spawn('bash', ['-c', 'sleep 60; : deploy-committed.sh'], { stdio: 'ignore' })
    try {
      expect(now(String(runner.pid))).toBe('[]') // no deploy running: no `current`
      fs.writeFileSync(path.join(q, 'current'), '5f32e967f31b0aa4c8055f045970710ada256f3b 1794257932 /x/logs/a.log\n')
      expect(now(String(runner.pid))).toBe('[5f32e967f31b]')
      // A live process that is not the runner (its pid given to another since): no deploy.
      expect(now(String(process.pid))).toBe('[]')
    } finally { runner.kill() }
    // A runner that is gone, and pids that would signal a group or launchd, count as no deploy.
    const dead = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    for (const p of [dead, '0', '1', '', 'x1']) expect(now(p), `pid ${p}`).toBe('[]')
    const src = fs.readFileSync(REMOTE, 'utf8')
    expect(src).toContain('DEPLOY=$(fleet_deploy_now)')
    expect(src.indexOf('DEPLOY=$(fleet_deploy_now)')).toBeLessThan(src.indexOf('simctl create'))
  })

  it('the Mac half asks before it takes a simulator, and never powers a lent one itself', () => {
    const src = fs.readFileSync(REMOTE, 'utf8')
    const at = (s: string) => src.indexOf(s)
    expect(at('CALL=$(fleet_call_now)')).toBeGreaterThan(0)
    expect(at('fleet_lent_lane "$HOME/.config/walnut/fleet.env"')).toBeGreaterThan(at('CALL=$(fleet_call_now)'))
    expect(at('elif [ -n "$FLEET_LENT_LANE" ]; then')).toBeGreaterThan(at('fleet_lent_lane "$HOME'))
    expect(at('simctl create')).toBeGreaterThan(at('elif [ -n "$FLEET_LENT_LANE" ]; then'))
    expect(src).toContain('if [ -z "$LENT" ] && /usr/bin/xcrun simctl boot "$UDID"')
    expect(src).toContain('ui) WALNUT_UITEST_LEASE_HELD=1 ')
  })
})
