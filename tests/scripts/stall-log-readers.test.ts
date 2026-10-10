/**
 * The two readers of the stall flight recorder's records: `scripts/walnut-logs.sh
 * stalls` (one line per record) and `scripts/stall-profile-summary.mjs` (a kept
 * profile with its stalls). Both are what a person reads when the server froze,
 * so the hold fields the recorder writes must come out under the names the docs
 * use, and a record from before those fields must still read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '../..')

const NEW_HOLD = {
  windowMs: 10_002, mainCpuMs: 1_500, holdCpuMs: 1_480, afterHoldCpuMs: 20, loopIdleMs: 30, holdFromMs: -999, holdToMs: 9_002,
  afterWaitMs: 20_001, afterHoldPauseMs: 3_000, baseCpuShare: 0.05, baseTurnMs: 5, mainSysMs: 3, mainCpuSource: 'thread',
  procCpuMs: 1_502, majorFaults: 0, minorFaults: 10, invCtxSwitches: 4_000, volCtxSwitches: 0, gcMs: 0, gcCount: 0,
  gcMaxMs: 0, gcMajor: 0, gcMajorMs: 0, rssMb: 300, heapUsedMb: 100, heapTotalMb: 150, externalMb: 5, arrayBuffersMb: 1,
  load1: 140, cores: 14, freeMemMb: 900, verdict: 'starved',
}
/** A record from before the span fields (no holdCpuMs, pauses, base rate). */
const OLD_HOLD = {
  windowMs: 4_000, mainCpuMs: 3_800, mainSysMs: 3, mainCpuSource: 'thread', procCpuMs: 3_802, majorFaults: 0, minorFaults: 10,
  invCtxSwitches: 40, volCtxSwitches: 0, gcMs: 0, gcCount: 0, gcMaxMs: 0, gcMajor: 0, rssMb: 300, heapUsedMb: 100,
  heapTotalMb: 150, externalMb: 5, arrayBuffersMb: 1, load1: 10, cores: 14, freeMemMb: 900, verdict: 'cpu',
}
const PROFILE_HOLD = { samples: 40, coverage: 0.97, codeShare: 1, idleShare: 0, gcShare: 0, top: [{ frame: 'marinaBlock /x/marina.ts:10', share: 0.9 }] }
const PROFILE_AFTER = { samples: 12, coverage: 0.8, codeShare: 0.75, idleShare: 0.25, gcShare: 0, top: [{ frame: 'acmeAfter /x/acme.ts:20', share: 0.7 }] }

let dir: string
const profilePath = (name: string): string => path.join(dir, 'stall-profiles', `stall-${name}.cpuprofile`)

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-readers-'))
  fs.mkdirSync(path.join(dir, 'stall-profiles'))
  const record = (min: string, lateByMs: number, hold: object, extra: object, name: string) => JSON.stringify({
    time: `2026-10-09T01:${min}:00.000Z`, level: 'warn', subsystem: 'web', message: 'event-loop stall flight record',
    lateByMs, hold, ...extra, profile: profilePath(name),
  })
  // `stalls 0` reads the newest two log files whatever their date, from the start of time.
  fs.writeFileSync(path.join(dir, 'open-walnut-2026-10-09.log'), [
    record('00', 9_002, NEW_HOLD, { profileHold: PROFILE_HOLD, profileAfter: PROFILE_AFTER }, 'new'),
    record('01', 3_000, OLD_HOLD, {}, 'old'),
  ].join('\n') + '\n')
  // 300 samples 20 ms apart in one code frame, and the meta naming the stall.
  const prof = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: 'marinaBlock', url: 'file:///x/marina.ts', lineNumber: 9, columnNumber: 0 }, children: [] },
    ],
    startTime: 1_000_000, endTime: 1_000_000 + 300 * 20_000, samples: Array(300).fill(2), timeDeltas: Array(300).fill(20_000),
  }
  for (const [name, hold, extra] of [['new', NEW_HOLD, { profileHold: PROFILE_HOLD, profileAfter: PROFILE_AFTER }], ['old', OLD_HOLD, {}]] as const) {
    fs.writeFileSync(profilePath(name), JSON.stringify(prof))
    fs.writeFileSync(profilePath(name).replace(/\.cpuprofile$/, '.json'), JSON.stringify({
      version: 1, pid: 1, node: 'v24', intervalUs: 20_000, window: { startMono: 0, endMono: 6_000 }, offsetUs: 1_000_000,
      stalls: [{ lateByMs: hold.windowMs - 1_000, at: '2026-10-09T01:00:00.000Z', holdStartMono: 100, holdEndMono: 5_000, suspectSection: null, hold, ...extra }],
    }))
  }
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('walnut-logs.sh stalls', () => {
  it('prints every hold field under its name, and "-" for a record from before them', () => {
    const out = execFileSync('bash', [path.join(ROOT, 'scripts/walnut-logs.sh'), 'stalls', '0'], {
      env: { ...process.env, WALNUT_LOG_DIR: dir }, encoding: 'utf8',
    })
    const lines = out.split('\n')
    const fresh = lines.find((l) => l.includes('late=9002ms'))
    expect(fresh).toContain(' starved code=1 sampled=0.97 cpu=1500/10002ms held=1480ms after=20ms afterCode=0.75 waited=30ms pause=20001/3000ms base=0.05/5ms ')
    const old = lines.find((l) => l.includes('late=3000ms'))
    expect(old).toContain(' cpu code=- sampled=- cpu=3800/4000ms held=-ms after=-ms afterCode=- waited=-ms pause=-/-ms base=-/-ms ')
  })
})

describe('stall-profile-summary.mjs', () => {
  const summary = (name: string): string =>
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/stall-profile-summary.mjs'), profilePath(name), '--top', '3'], { encoding: 'utf8' })

  it('writes out the span: the hold, the pauses on both sides, the base rate and the profile after the hold', () => {
    const out = summary('new')
    expect(out).toContain('verdict starved: loop thread cpu 1500 ms (sys 3) of a 10002 ms window, 1480 ms of it in the hold itself'
      + ' (-999 to 9002 ms around the deadline, the loop waiting in poll 30 ms of it) and 20 ms after it, right after a 20001 ms pause,'
      + ' with a 3000 ms pause before the probe (the loop ran 5% of the time before, its largest turn 5 ms); process cpu 1502 ms')
    expect(out).toContain('of 40 samples, 97% of the hold sampled; top marinaBlock /x/marina.ts:10 90%')
    expect(out).toContain('profile after the hold, up to the probe: code 75% of 12 samples, 80% sampled; top acmeAfter /x/acme.ts:20 70%')
  })

  it('reads a record from before the span fields as it always did', () => {
    const out = summary('old')
    expect(out).toContain('verdict cpu: loop thread cpu 3800 ms (sys 3) of a 4000 ms window; process cpu 3802 ms')
    expect(out).not.toContain('in the hold itself')
    expect(out).not.toContain('profile after the hold')
  })
})
