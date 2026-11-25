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
 *   - a watch that ended Unknown is judged again at its own check time; one still Unknown stays so;
 *   - a 14-day watch over nightly sleep passes once the ledger has forgotten its first week: the hours
 *     keep their sleep (2026-11-25 review);
 *   - the server's pass that judges them again: once a start, only the last week, its own row id, and
 *     a lead told the Unknown hears the new verdict.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetUsageRecorderForTesting, flushUsage, recordOpCall } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { getWatch, judgeWatch, newWatch, putWatch, recordedShare, rejudgeUnknown } from '../../../src/core/usage-watch/watches.js'
import { readSlept } from '../../../src/core/usage-watch/store.js'
import { rejudgeUnknownWatches, routeDeps, stopRealUse } from '../../../src/core/usage-watch/runtime.js'
import { __resetSleepLedgerForTest, noteSleepSinceLastLook, sleptBetween as sleptReal } from '../../../src/lib/sleep-ledger.js'

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
    // The hours kept it too: about 252 minutes (the day is lived a minute at a time), as the ledger saw.
    const kept = [...readSlept(Math.floor(START / 3_600_000) * 3_600_000).values()].reduce((a, b) => a + b, 0)
    expect(Math.abs(kept - 252)).toBeLessThanOrEqual(2)
    const v = judgeWatch(watch(), END)
    expect(v.state).toBe('passed')
  })

  it('a 14-day watch over nightly sleep passes when the ledger has forgotten its first week', () => {
    const from = START
    const to = START + 14 * 24 * 60 * MIN
    for (let t = from; t < to; t += MIN) {
      // Eight hours asleep every night, from 06:00 UTC.
      const sleeping = new Date(t).getUTCHours() >= 6 && new Date(t).getUTCHours() < 14
      clock.wall = t
      if (!sleeping) clock.mono += MIN
      noteSleepSinceLastLook()
      if (!sleeping) flushUsage(t)
    }
    expect(recordedShare(from, to)).toBeGreaterThan(0.99)
    // The ledger alone forgot the first week (a week is all it keeps): the hours still hold it.
    const ledgerWeek = (a: number, b: number) => (a < to - 7 * 24 * 60 * MIN ? 0 : sleptReal(a, b))
    expect(recordedShare(from, to, ledgerWeek)).toBeGreaterThan(0.99)
  }, 60_000)

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

  it('the server judges them again once a start, the last week only, on a row of their own, and a lead told the Unknown hears it', async () => {
    liveTheDay()
    const told: Array<{ to: string; text: string; rowId: string }> = []
    const saved = { ...routeDeps }
    Object.assign(routeDeps, {
      enabled: async () => true,
      taskInfo: async (id: string) => ({ id, title: 'shipped it', complete: true }),
      leadOf: async () => ({ id: 'lead-1', title: 'Walnut VP' }),
      deliver: async (to: string, text: string, rowId: string) => { told.push({ to, text, rowId }); return { ok: true } },
    })
    try {
      const recent = { ...watch(), state: 'unknown' as const, checkedAt: END + MIN, told: 'lead-1' }
      putWatch(recent)
      const old = { ...watch(), state: 'unknown' as const, checkedAt: END - 8 * 24 * 60 * MIN }
      putWatch(old)
      await rejudgeUnknownWatches(END + 2 * MIN)
      expect(getWatch(recent.id)).toMatchObject({ state: 'passed', checkedAt: END + MIN, told: 'lead-1' })
      expect(getWatch(old.id)?.state).toBe('unknown')
      expect(told).toEqual([{ to: 'lead-1', rowId: `${recent.id}-rejudged`, text: expect.stringContaining('Judged again (it had read Unknown') }])
      // Once a start: a second pass judges nothing.
      putWatch({ ...recent, state: 'unknown' })
      await rejudgeUnknownWatches(END + 3 * MIN)
      expect(getWatch(recent.id)?.state).toBe('unknown')
    } finally {
      Object.assign(routeDeps, saved)
      stopRealUse()
    }
  })
})
