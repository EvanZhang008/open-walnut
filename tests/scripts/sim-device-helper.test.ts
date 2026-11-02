/**
 * scripts/lib/sim-device.sh, the one place a script gets its iOS simulator, run for
 * real against a FAKE simulator queue that prints the real queue's output shapes
 * (ACQUIRED / BOOTED / MAESTRO, BUSY, QUEUED, ACQUIRE FAILED). Nothing here starts a
 * simulator or touches a real lease: the fake keeps its lease in a temp dir, and
 * xcrun / xcodebuild / xcodegen are stubs first on PATH.
 *
 * Also run-ui-tests.sh on a lent simulator: the queue's acquire IS its lease, so the
 * run takes exactly one (a second would find its own lease busy and wait on itself
 * for an hour), and a misconfigured run is refused before it queues for anything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard-core.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const HELPER = path.join(REPO, 'scripts/lib/sim-device.sh')
const RUN_UI = path.join(REPO, 'ios-native/tests/ui/run-ui-tests.sh')
const LANE_UDID = 'b0b0b0b0-0000-4000-8000-00000000000b'
const OTHER = '00000000-1111-2222-3333-444444444444'

let dir: string
let calls: string
let queue: string
let stubs: string

/**
 * The fake queue. FAKEQ_MODE picks the answer to acquire; may/taken/release behave
 * like the real script's (a live holder makes may BUSY; release only for the holder).
 */
function writeFakeQueue() {
  queue = path.join(dir, 'queue.sh')
  fs.writeFileSync(queue, `#!/bin/bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls.log"
L="$D/lock-\${SIM_LANE:-a}"
case "$1" in
  may)
    if [ -d "$L" ] && kill -0 "$(cat "$L/pid")" 2>/dev/null; then echo "BUSY lease held by pid $(cat "$L/pid")"; exit 1; fi
    echo "MAY $2" ;;
  taken) echo "TURN TAKEN by $2" ;;
  acquire)
    n=$2; hp=$PPID; [ "\${3:-}" = --pid ] && hp=$4
    case "\${FAKEQ_MODE:-ok}" in
      busy) echo "BUSY lease held by pid 4242"; exit 1 ;;
      queued) echo "QUEUED: someone-else is next"; exit 1 ;;
      failed) echo "ACQUIRE FAILED: simulator ${LANE_UDID.toUpperCase()} did not boot (exit 142)"; exit 4 ;;
    esac
    mkdir "$L" || { echo "BUSY lease held by pid $(cat "$L/pid")"; exit 1; }
    echo "$hp" > "$L/pid"
    echo "ACQUIRED lane \${SIM_LANE:-a} for $n (holder pid $hp)"
    case "\${FAKEQ_MODE:-ok}" in
      ok) echo "BOOTED lane \${SIM_LANE:-a} simulator ${LANE_UDID} (3s)"
          echo "MAESTRO lane \${SIM_LANE:-a}: use sim-maestro.sh (one Maestro run at a time across lanes b and c)" ;;
      junk) echo "BOOTED lane \${SIM_LANE:-a} simulator booted (3s)" ;;
      wronglane) echo "BOOTED lane z simulator ${LANE_UDID} (3s)" ;;
      noboot) ;;
    esac
    exit 0 ;;
  release)
    hp=$PPID; [ "\${2:-}" = --pid ] && hp=$3
    [ -d "$L" ] || { echo "FREE nothing to release"; exit 0; }
    [ "$(cat "$L/pid")" = "$hp" ] || { echo "REFUSED lease belongs to pid $(cat "$L/pid"), not $hp"; exit 1; }
    rm -rf "$L"; echo "RELEASED lane \${SIM_LANE:-a}" ;;
esac
`, { mode: 0o755 })
}

function writeStubs() {
  stubs = path.join(dir, 'bin')
  fs.mkdirSync(stubs)
  for (const [name, body] of [
    ['xcrun', 'echo "xcrun $*" >> "$STUB_LOG"; exit 1'],
    ['xcodebuild', 'echo "xcodebuild $*" >> "$STUB_LOG"; exit 1'],
    ['xcodegen', 'echo "xcodegen $*" >> "$STUB_LOG"; exit 0'],
    ['simctl', 'echo "simctl $*" >> "$STUB_LOG"; exit 1'],
  ] as const) fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
}

function env(extra: Record<string, string>): Record<string, string> {
  // Built from scratch: nothing of the runner's own simulator settings leaks in.
  // WALNUT_SIM_LOCK_DIR keeps run-ui-tests.sh's own lane lock out of /tmp, whatever path a case takes.
  return { PATH: guardedPath([stubs], '/usr/bin:/bin'), HOME: dir, STUB_LOG: path.join(dir, 'stubs.log'), WALNUT_SIM_LOCK_DIR: path.join(dir, 'locks'), ...extra }
}

function resolve(extra: Record<string, string>, arg = '') {
  const script = `. ${JSON.stringify(HELPER)}; walnut_sim_resolve ${JSON.stringify(arg)}; rc=$?; printf 'rc=%s dev=%s from=%s\\n' "$rc" "$WALNUT_SIM_DEVICE" "$WALNUT_SIM_FROM"`
  const r = spawnSync('/bin/bash', ['-c', script], { env: env(extra), encoding: 'utf8', timeout: 20_000 })
  return { out: r.stdout, err: r.stderr, calls: readCalls() }
}

function readCalls(): string[] {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-device-helper-'))
  calls = path.join(dir, 'calls.log')
  fs.mkdirSync(path.join(dir, 'locks'))
  writeFakeQueue()
  writeStubs()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('walnut_sim_resolve', () => {
  it('refuses with nothing named, and says how to name one', () => {
    const r = resolve({})
    expect(r.out).toContain('rc=2 dev= from=')
    expect(r.err).toContain('WALNUT_SIM_UDID')
    expect(r.err).toContain('WALNUT_SIM_QUEUE_SCRIPT')
  })

  it('takes an explicit udid, upper-cased; the argument wins over WALNUT_SIM_UDID; no queue call', () => {
    expect(resolve({ WALNUT_SIM_UDID: OTHER, WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b' }).out)
      .toContain(`rc=0 dev=${OTHER} from=WALNUT_SIM_UDID`)
    expect(resolve({ WALNUT_SIM_UDID: OTHER }, LANE_UDID).out).toContain(`rc=0 dev=${LANE_UDID.toUpperCase()} from=argument`)
    expect(readCalls()).toEqual([])
  })

  it.each([['booted'], ['iPhone 16 Pro'], ['12345']])('refuses %s as a device', (bad) => {
    const r = resolve({ WALNUT_SIM_UDID: bad })
    expect(r.out).toContain('rc=2')
    expect(r.err).toContain('is not a simulator UDID')
  })

  it('refuses a protected simulator even when named', () => {
    const r = resolve({ WALNUT_SIM_UDID: OTHER.toLowerCase(), WALNUT_SIM_PROTECTED_UDIDS: `x ${OTHER.toUpperCase()}` })
    expect(r.out).toContain('rc=2')
    expect(r.err).toContain('WALNUT_SIM_PROTECTED_UDIDS')
  })

  it.each([[''], ['a']])('never takes lane a from the queue (SIM_LANE=%j), and never asks it', (lane) => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, ...(lane ? { SIM_LANE: lane } : {}) })
    expect(r.out).toContain('rc=2')
    expect(r.err).toMatch(/lane a is the machine owner's own simulator|SIM_LANE=a is the machine owner's own simulator/)
    expect(r.calls).toEqual([])
  })

  it('takes the UDID from the BOOTED line of a lane b lease, and gives it back under the same pid', () => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b', WALNUT_SIM_QUEUE_NAME: 'probe' })
    expect(r.out).toContain(`rc=0 dev=${LANE_UDID.toUpperCase()} from=queue`)
    expect(r.calls).toHaveLength(2)
    const acquire = r.calls[0]!.match(/^acquire probe --pid (\d+)$/)
    expect(acquire, r.calls.join('\n')).toBeTruthy()
    expect(r.calls[1]).toBe(`release --pid ${acquire![1]}`)
    expect(fs.existsSync(path.join(dir, 'lock-b'))).toBe(false)
  })

  it.each([
    ['busy', 'BUSY lease held by pid 4242', true],
    ['queued', 'QUEUED: someone-else is next', true],
    ['failed', 'ACQUIRE FAILED: simulator', false],
  ])('refuses when the queue answers %s, in the queue\'s own words, and releases nothing', (mode, words, join) => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b', FAKEQ_MODE: mode as string })
    expect(r.out).toContain('rc=2 dev= from=')
    expect(r.err).toContain(words)
    // Joining the queue only helps when someone else holds the lane or is next.
    expect(r.err.includes(' join ')).toBe(join)
    expect(r.calls.filter((c) => c.startsWith('release'))).toEqual([])
  })

  it('gives back and refuses a lease whose BOOTED line names another lane', () => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b', FAKEQ_MODE: 'wronglane' })
    expect(r.out).toContain('rc=2 dev= from=')
    expect(r.err).toContain('booted lane z, not the requested lane b')
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['acquire', 'release'])
    expect(fs.existsSync(path.join(dir, 'lock-b'))).toBe(false)
  })

  it('refuses a lane that is not a lane name, without asking the queue', () => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b;c' })
    expect(r.out).toContain('rc=2')
    expect(r.err).toContain('is not a lane name')
    expect(r.calls).toEqual([])
  })

  it.each([['noboot'], ['junk']])('a lease with no simulator UDID (%s) is given back and refused, never read from other lines', (mode) => {
    const r = resolve({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b', FAKEQ_MODE: mode })
    expect(r.out).toContain('rc=2 dev= from=')
    expect(r.err).toContain('ACQUIRED lane b')
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['acquire', 'release'])
    expect(fs.existsSync(path.join(dir, 'lock-b'))).toBe(false)
  })

  it('gives the lease back when the script is killed by TERM after its own EXIT trap', () => {
    const caller = path.join(dir, 'caller.sh')
    fs.writeFileSync(caller, `#!/bin/bash
. ${JSON.stringify(HELPER)}
walnut_sim_resolve || exit 2
trap 'echo own-cleanup; walnut_sim_release' EXIT
kill -TERM $$
sleep 5
echo not-reached
`)
    const r = spawnSync('/bin/bash', [caller], { env: env({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'c' }), encoding: 'utf8', timeout: 20_000 })
    expect(r.status).toBe(143)
    expect(r.stdout).toContain('own-cleanup')
    expect(r.stdout).not.toContain('not-reached')
    const [acq, rel] = readCalls()
    expect(acq).toMatch(/^acquire caller --pid \d+$/)
    expect(rel).toBe(`release --pid ${acq!.split(' ').pop()}`)
  })
})

describe('run-ui-tests.sh on a lent simulator', () => {
  function runUi(extra: Record<string, string>) {
    return spawnSync('/bin/bash', [RUN_UI, '-only-testing:WalnutUITests/Nothing'], {
      env: env({ WALNUT_UITEST_DD: path.join(dir, 'dd'), ...extra }),
      encoding: 'utf8',
      timeout: 60_000,
    })
  }

  it('takes exactly one lease, from the queue, and does not wait on itself', () => {
    const started = Date.now()
    const r = runUi({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b' })
    // The stub xcodebuild fails the build: the run got past the lease section at once.
    expect(r.stderr).toContain('build-for-testing failed')
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(r.stdout).toContain(`simulator ${LANE_UDID.toUpperCase()} (from queue)`)
    expect(r.stdout).toContain('simulator lease held (lane b, from the queue)')
    const c = readCalls()
    expect(c.filter((x) => x.startsWith('acquire'))).toHaveLength(1)
    expect(c.filter((x) => x.startsWith('may') || x.startsWith('taken'))).toEqual([])
    // One queue name for everything this run says to the queue.
    expect(c[0]).toMatch(/^acquire inbox-items --pid (\d+)$/)
    expect(c[1]).toBe(`release --pid ${c[0]!.split(' ').pop()}`)
    expect(fs.readFileSync(path.join(dir, 'stubs.log'), 'utf8')).toContain(`id=${LANE_UDID.toUpperCase()}`)
  })

  it('an explicit simulator keeps the lane lock and the may/taken admission, one queue name, no acquire', () => {
    // A stale lock of a dead holder, so the run says where its lock lives.
    const dead = spawnSync('/usr/bin/true').pid!
    const lock = path.join(dir, 'locks', 'walnut-ios-sim-b.lock')
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${dead}\n`)
    const r = runUi({ WALNUT_UITEST_UDID: OTHER.toLowerCase(), WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b' })
    expect(r.stderr).toContain('build-for-testing failed')
    expect(r.stdout).toContain(`reclaiming ${lock} from dead pid ${dead}`)
    expect(r.stdout).toContain(`simulator ${OTHER} (from argument)`)
    // Reclaiming the stale lock goes round the admission loop once more: may, may, taken.
    expect(readCalls()).toEqual(['may inbox-items', 'may inbox-items', 'taken inbox-items'])
    expect(fs.existsSync(lock)).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'stubs.log'), 'utf8')).toContain(`id=${OTHER}`)
  })

  it('inside the heavy-command slot, the lease is taken by the re-run that runs the tests', () => {
    const slot = path.join(dir, 'slot.sh')
    fs.writeFileSync(slot, `#!/bin/bash\necho "slot $*" >> ${JSON.stringify(path.join(dir, 'slot.log'))}\n"$@"\n`)
    const r = runUi({ WALNUT_SIM_QUEUE_SCRIPT: queue, SIM_LANE: 'b', WALNUT_HEAVY_SLOT_SCRIPT: slot })
    expect(r.stderr).toContain('build-for-testing failed')
    const c = readCalls()
    expect(c.filter((x) => x.startsWith('acquire'))).toHaveLength(1)
    expect(c[1]).toBe(`release --pid ${c[0]!.split(' ').pop()}`)
    expect(fs.readFileSync(path.join(dir, 'slot.log'), 'utf8')).toContain('WALNUT_UITEST_HEAVY_HELD=1')
  })

  it.each<[string, Record<string, string>, number]>([
    ['no simulator at all', {}, 2],
    ['the queue without a lane', { WALNUT_SIM_QUEUE_SCRIPT: 'QUEUE' }, 2],
    ['the queue on lane a', { WALNUT_SIM_QUEUE_SCRIPT: 'QUEUE', SIM_LANE: 'a' }, 2],
    ['a name for a udid', { WALNUT_UITEST_UDID: 'iPhone 16 Pro' }, 2],
    ['a gate run on a simulator that is not the gate', { WALNUT_UITEST_UDID: OTHER, WALNUT_UITEST_GATE_UDID: LANE_UDID, WALNUT_UITEST_INBOX_ITEMS: '1' }, 1],
    ['a gate run with no gate simulator', { WALNUT_UITEST_UDID: OTHER, WALNUT_UITEST_INBOX_ITEMS: '1' }, 1],
    ['the queue on a lane it does not lend', { WALNUT_SIM_QUEUE_SCRIPT: 'QUEUE', SIM_LANE: 'z' }, 1],
    ['an explicit simulator on a lane with no lock', { WALNUT_UITEST_UDID: OTHER, SIM_LANE: 'c' }, 1],
    ['a gate run against a non-isolated server', { WALNUT_UITEST_UDID: OTHER, WALNUT_UITEST_GATE_UDID: OTHER.toLowerCase(), WALNUT_UITEST_INBOX_ITEMS: '1' }, 1],
  ])('refuses %s before it queues for the heavy slot or the simulator', (_label, extra, code) => {
    // The slot stub never runs the command: even a missing check could not reach a lease.
    const slot = path.join(dir, 'slot.sh')
    fs.writeFileSync(slot, `#!/bin/bash\necho "slot $*" >> ${JSON.stringify(path.join(dir, 'slot.log'))}\n`)
    const withQueue = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 'QUEUE' ? queue : v]))
    const r = runUi({ WALNUT_HEAVY_SLOT_SCRIPT: slot, ...withQueue })
    expect(r.status, r.stderr).toBe(code)
    expect(fs.existsSync(path.join(dir, 'slot.log'))).toBe(false)
    expect(readCalls()).toEqual([])
    expect(fs.existsSync(path.join(dir, 'stubs.log'))).toBe(false)
  })
})
