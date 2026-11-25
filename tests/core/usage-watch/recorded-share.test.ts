/**
 * A watch reads Unknown only for time the server was awake and not recording (watches.ts recordedShare).
 *
 * 2026-11-25: 15 watches in three days ended "Unknown: the server was not recording for more than a tenth
 * of the time". Checked at the source on the Mac: every gap was the Mac asleep (the sleep ledger: 05:12 to
 * 08:37 UTC, and three naps of 47 minutes in all from 18:15 to 19:20), while its 117 restarts since the day
 * before cost 13 minutes, and a restart's own minute is recorded twice (hours read 61 to 64). Asleep, no
 * server runs and no one uses it: those minutes are left out.
 *
 * Pinned, on the real day of uw-78012f21-67d (op:open_items, op:task_send, 24 h from 2026-11-24 21:24):
 *   - with its sleep left out it passes; counted as not recording (as before) it read Unknown;
 *   - a server down three hours while awake still reads Unknown;
 *   - a watch that ended Unknown is judged again at its own check time; one still Unknown stays so.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetUsageRecorderForTesting, flushUsage, recordOpCall } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { judgeWatch, newWatch, recordedShare, rejudgeUnknown } from '../../../src/core/usage-watch/watches.js'
import { __resetSleepLedgerForTest, noteSleepSinceLastLook } from '../../../src/lib/sleep-ledger.js'

const MIN = 60_000
const T = (iso: string) => Date.parse(iso)
const START = T('2026-11-24T21:24:27Z')
const END = START + 24 * 60 * MIN
/** The Mac's sleep that day, as its sleep ledger has it (over ten minutes each). */
const SLEPT: Array<[string, string]> = [
  ['2026-11-25T05:12:29Z', '2026-11-25T08:37:44Z'],
  ['2026-11-25T18:15:25Z', '2026-11-25T18:31:48Z'],
  ['2026-11-25T18:45:29Z', '2026-11-25T19:03:25Z'],
  ['2026-11-25T19:07:25Z', '2026-11-25T19:20:32Z'],
]
let dir = ''
const clock = { wall: START, mono: 0 }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-share-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
  clock.wall = START
  clock.mono = 0
  __resetSleepLedgerForTest({ now: () => clock.wall, monoNow: () => clock.mono })
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  __resetSleepLedgerForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const asleep = (t: number) => SLEPT.some(([a, b]) => t >= T(a) && t < T(b))

/** The day minute by minute: awake, the server records and the tools are used; asleep, nothing runs. */
function liveTheDay(opts: { downFrom?: number; downTo?: number } = {}): void {
  for (let t = START; t < END; t += MIN) {
    const sleeping = asleep(t)
    // The clocks as a machine has them: the monotonic one stands still while it sleeps.
    clock.wall = t
    if (!sleeping) clock.mono += MIN
    noteSleepSinceLastLook()
    if (sleeping || (opts.downFrom !== undefined && t >= opts.downFrom && t < opts.downTo!)) continue
    if (((t - START) / MIN) % 20 === 0) {
      recordOpCall({ op: 'open_items', client: 'mcp', cls: 'ok', size: 300, overLimit: false, ms: 30, now: t })
      recordOpCall({ op: 'task_send', client: 'mcp', cls: 'ok', size: 300, overLimit: false, ms: 40, now: t })
    }
    flushUsage(t)
  }
  clock.wall = END
  clock.mono += MIN
  noteSleepSinceLastLook()
}

const watch = () => newWatch({ taskId: 't1', targets: ['op:open_items', 'op:task_send'], checks: {}, who: 'this task', checkAt: END, createdAt: START })

describe('a watch reads Unknown only for time the server was awake and not recording', () => {
  it('the Mac\'s sleep is no time unrecorded: the day of uw-78012f21-67d passes', () => {
    liveTheDay()
    expect(recordedShare(START, END)).toBeGreaterThan(0.99)
    // As it was counted before: 252 minutes asleep read as not recorded.
    expect(recordedShare(START, END, () => 0)).toBeLessThan(0.9)
    const v = judgeWatch(watch(), END)
    expect(v.state).toBe('passed')
  })

  it('a server down three hours while the machine was awake still reads Unknown', () => {
    liveTheDay({ downFrom: T('2026-11-25T10:00:00Z'), downTo: T('2026-11-25T13:00:00Z') })
    expect(recordedShare(START, END)).toBeLessThan(0.9)
    expect(judgeWatch(watch(), END).summary).toContain('Unknown: the server was not recording')
  })

  it('a watch that ended Unknown is judged again at its own check time; one still Unknown stays so', () => {
    liveTheDay()
    const ended = { ...watch(), state: 'unknown' as const, checkedAt: END + MIN }
    const again = rejudgeUnknown(ended)
    expect(again?.state).toBe('passed')
    expect(rejudgeUnknown({ ...ended, state: 'passed' })).toBeNull()
    expect(rejudgeUnknown({ ...ended, checkedAt: undefined })).toBeNull()
  })

  it('a watch still Unknown when judged again is left as it is', () => {
    liveTheDay({ downFrom: T('2026-11-25T10:00:00Z'), downTo: T('2026-11-25T13:00:00Z') })
    expect(rejudgeUnknown({ ...watch(), state: 'unknown', checkedAt: END + MIN })).toBeNull()
  })
})
