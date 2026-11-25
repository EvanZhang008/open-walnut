/**
 * Real use counts Walnut's own faults apart from the caller's side (src/core/usage-watch/agg.ts).
 *
 * 2026-11-25: a watch failed task_report_set at 21.7% and human_inbox_send at 33.3%, every failure an
 * agent's wrong arguments (a field at the wrong level, a value not in the enum, a misspelt name) or
 * a rule's refusal by design (same_ask, reply_language, user_kind, conflict); host_exec_read's "new
 * error code" trigger_off was team_stop refusing by design. None was a fault of Walnut's.
 *
 * Pinned:
 *   - every failed class says whose it is (OUTCOME_SIDE): only Walnut's own move a failure rate or a
 *     new-code check, and the caller's side is said apart (callerSide, the verdict's "not failures");
 *   - the replay of that watch's task_report_set (23 uses, 5 bad arguments, refusals) passes, and two
 *     server errors still fail it;
 *   - the report's rows and its list name the caller's side apart from `failed`;
 *   - nothing in the real-use code adds the caller's side to Walnut's faults (a source ratchet).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTCOME_SIDE, type OutcomeClass } from '../../../src/core/usage-watch/agg.js'
import { _resetUsageRecorderForTesting, flushUsage, recordOpCall } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { judgeWatch, newWatch } from '../../../src/core/usage-watch/watches.js'
import { runUsageWatchAction } from '../../../src/core/usage-watch/actions.js'

const T0 = Date.parse('2026-11-25T10:00:00Z')
const H = 3_600_000
const ROOT = path.resolve(__dirname, '../../..')
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-side-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

function calls(op: string, cls: Exclude<OutcomeClass, 'ok'> | 'ok', n: number, code?: string, at = T0 + H): void {
  for (let i = 0; i < n; i++) recordOpCall({ op, client: 'mcp', cls, ...(code ? { code } : {}), size: 200, overLimit: false, ms: 20, now: at + i })
}

/** Five hours recorded, the watch judged at their end. */
function judge(op: string) {
  for (let m = 0; m < 5 * 60; m++) flushUsage(T0 + m * 60_000)
  const w = newWatch({ taskId: 't1', targets: [`op:${op}`], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })
  return judgeWatch(w, T0 + 5 * H)
}

describe('Walnut\'s own faults, apart from the caller\'s side', () => {
  it('every failed class says whose it is, and only Walnut\'s own fail a watch', () => {
    for (const [cls, side] of Object.entries(OUTCOME_SIDE) as Array<[Exclude<OutcomeClass, 'ok'>, string]>) {
      const op = `t_${cls}`
      calls(op, 'ok', 20)
      calls(op, cls, 3, `c_${cls}`)
      const v = judge(op)
      const r = v.results[0]!
      if (side === 'own') {
        expect(v.state, cls).toBe('failed')
        expect(r.notes.join('; '), cls).toContain('failures 13% over 5%')
        expect(r.newCodes, cls).toEqual([`c_${cls}`])
      } else {
        expect(v.state, cls).toBe('passed')
        expect(r.failPct, cls).toBe(0)
        expect(r.newCodes, cls).toBeUndefined()
      }
      if (side === 'caller') {
        expect(r.callerSide, cls).toMatchObject({ calls: 3, pct: 13, newCodes: [`c_${cls}`] })
        expect(v.summary, cls).toContain('(not failures: 3 ')
      } else {
        expect(r.callerSide, cls).toBeUndefined()
      }
    }
  })

  it('the watch that failed task_report_set on agents\' wrong arguments passes, and server errors still fail it', () => {
    calls('task_report_set', 'ok', 15)
    calls('task_report_set', 'bad_args', 3, 'invalid_args')
    calls('task_report_set', 'bad_args', 2, 'bad_request')
    calls('task_report_set', 'refused', 1, 'reply_language')
    calls('task_report_set', 'refused', 1, 'same_ask')
    calls('task_report_set', 'refused', 1, 'user_kind')
    const v = judge('task_report_set')
    expect(v.state).toBe('passed')
    expect(v.summary).toContain('op:task_report_set: 23 uses (not failures: 5 with bad arguments, 3 refused by design, 34.8% of uses; new codes ')
    calls('task_report_set', 'error', 2, 'http_500', T0 + 2 * H)
    const after = judge('task_report_set')
    expect(after.state).toBe('failed')
    expect(after.summary).toContain('failures 8% over 5%; new error code: http_500')
  })

  it('the report names the caller\'s side apart from what failed', async () => {
    calls('human_inbox_send', 'ok', 4)
    calls('human_inbox_send', 'bad_args', 2, 'invalid_args')
    calls('task_get', 'ok', 10)
    calls('task_get', 'error', 1, 'thrown')
    flushUsage(T0 + H + 60_000)
    const ctx = { callerTask: 't1', taskInfo: async (id: string) => ({ id, title: id, complete: false }), now: T0 + 2 * H }
    const rep = await runUsageWatchAction({ action: 'report', range: '24h' }, ctx) as { rows: Array<Record<string, unknown>>; caller_side: Array<Record<string, unknown>> }
    const row = (name: string) => rep.rows.find((r) => r.name === name)!
    expect(row('human_inbox_send')).toMatchObject({ failed: 0, caller_side: 2, bad_args: 2 })
    expect(row('task_get')).toMatchObject({ failed: 1, caller_side: 0 })
    // The tool's own problem ranks first; the caller's side has its own list.
    expect(rep.rows[0]!.name).toBe('task_get')
    expect(rep.caller_side).toEqual([{ name: 'human_inbox_send', calls: 6, bad_args: 2, refused: 0, pct: 33.3 }])
  })

  // A new way to judge or rank failures that adds the caller's side to Walnut's faults fails here:
  // use ownFaults and callerSide (agg.ts), never a sum of the fields.
  it('nothing in the real-use code adds the caller\'s side to Walnut\'s faults', () => {
    const MIX = /\b(?:errors|timeouts)\b[^;\n,]{0,40}\+[^;\n,]{0,40}\b(?:badArgs|refused)\b|\b(?:badArgs|refused)\b[^;\n,]{0,40}\+[^;\n,]{0,40}\b(?:errors|timeouts)\b/
    const ALL_FAILS = /\.fails\b/
    const dirs = ['src/core/usage-watch', 'src/core/health-monitor', 'web/src/components/settings/sections', 'web/src/api']
    const hits: string[] = []
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) {
        if (!/\.tsx?$/.test(f) || f === 'agg.ts') continue
        const rel = `${d}/${f}`
        fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
          if (MIX.test(line)) hits.push(`${rel}:${i + 1} adds the caller's side to the faults`)
          // The report copies the raw count of every failed call into its row; nothing judges by it.
          if (ALL_FAILS.test(line) && rel !== 'src/core/usage-watch/report.ts') hits.push(`${rel}:${i + 1} reads every failed call as one count`)
        })
      }
    }
    expect(hits).toEqual([])
  })
})
