/**
 * The mixed-version rehearsal's plugin job and its judging (scripts/release-rehearsal/plugin-job-probe.mjs,
 * mixed-leader-host.mjs judgeAll): what the probe job asks, how two runs' answers compare, and which
 * log lines count as a new error. The rehearsal itself runs real releases and is not run here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BYPASS_REFUSAL, daemonHeads, errorHeads, installProbePlugin, judgeNewLeaderOldHost, judgeNewPair, judgeOldLeader,
  normalizeText, outcomeDiffs, outcomesOf, probeServerSource, readProbeOut, startStatuses,
} from '../../scripts/release-rehearsal/plugin-job-probe.mjs'
import { judgeAll } from '../../scripts/release-rehearsal/mixed-leader-host.mjs'

const REFUSED = `Walnut API error (bad_request): ${BYPASS_REFUSAL}. Change the caller's mode first.`
const capped = [
  { step: 'plain-create', ok: true, result: { id: 'mwqzwnh0-0626' } },
  { step: 'bypass-create', ok: false, code: 'internal', message: REFUSED, taskId: null },
  { step: 'bypass-start', ok: false, code: 'internal', message: REFUSED, taskId: 'mwqzwnh0-0626' },
  { step: 'done' },
]
const vouched = [
  { step: 'plain-create', ok: true, result: { id: 'mwr00001-aaaa' } },
  { step: 'bypass-create', ok: true, result: { id: 'mwr00002-bbbb' } },
  { step: 'bypass-start', ok: true, result: { id: 'mwr00001-aaaa' } },
  { step: 'done' },
]

function run(name: string, leader: string, host: string, records: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    name, leader, host, records, done: records.some((r) => r.step === 'done'), outcomes: outcomesOf(records),
    leaderAlive: true, healthAfter: 200, errorHeads: [], startStatuses: [403, 403], daemonErrorHeads: [], daemonProblems: [], modes: {}, ...extra,
  }
}

describe('the probe plugin', () => {
  it('asks for both bypass starts through walnut.ops.call and records each answer once', () => {
    const src = probeServerSource({ out: '/x/out.jsonl', cwd: '/x/project' })
    for (const call of ["'task_list'", "'task_create'", "mode: 'bypass'", "'task_start'", '"step":"done"']) expect(src).toContain(call)
    expect(src).toContain('walnut.ops.call(name, args)')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-plugin-'))
    try {
      const dir = installProbePlugin(home, { out: '/x/out.jsonl', cwd: '/x/project' })
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ id: 'rehearsal-probe', server: 'dist/server.mjs', jobs: { probe: { kind: 'long-running' } } })
      expect(fs.readFileSync(path.join(dir, 'dist/server.mjs'), 'utf8')).toBe(src)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('reads its out file, skipping a torn line', () => {
    expect(readProbeOut('{"step":"plain-create","ok":true}\n{"step":"by')).toEqual([{ step: 'plain-create', ok: true }])
  })
})

describe('comparing two runs', () => {
  it('normalizes ids, times and numbers out of a message', () => {
    expect(normalizeText('task 4f9c2a1e-1b2c-4d5e-8f90-1234567890ab at 2026-11-21T22:44:35.411Z took 27ms')).toBe('task <uuid> at <time> took <n>ms')
  })

  it('a success compares by its ok alone; a refusal by its code and message', () => {
    expect(outcomeDiffs(outcomesOf(capped), outcomesOf(capped.map((r) => ({ ...r }))))).toEqual([])
    expect(outcomeDiffs(outcomesOf(vouched), outcomesOf(vouched.map((r) => r.step === 'plain-create' ? { ...r, result: { id: 'other' } } : r)))).toEqual([])
    const diffs = outcomeDiffs(outcomesOf(capped), outcomesOf(vouched))
    expect(diffs.map((d) => d.split(':')[0])).toEqual(['bypass-create', 'bypass-start'])
  })

  it("takes a console's error lines, not its warnings, and a daemon's error records", () => {
    const log = [
      '22:44:35 WRN [session] DaemonConnection: gateway relay refused {"relayId":3}',
      '22:44:36 ERR [web] SERVER EXIT: SIGTERM (killed by another process) {"pid":113}',
      '22:44:36 ERR [web] SERVER EXIT: SIGTERM (killed by another process) {"pid":114}',
      'TypeError: cannot read properties of undefined',
    ].join('\n')
    expect(errorHeads(log)).toEqual(['ERR [web] SERVER EXIT: SIGTERM (killed by another process)', 'RAW TypeError: cannot read properties of undefined'])
    const dlog = '{"level":"info","msg":"up"}\n{"level":"error","msg":"bad frame 12"}\nnot json'
    expect(daemonHeads(dlog)).toEqual(['error bad frame <n>'])
    expect(startStatuses('POST /api/v1/tasks/a-1/start → 403 (27ms)\nPOST /api/v1/tasks/b-2/start → 202 (5ms)')).toEqual([403, 202])
  })
})

describe('the verdicts', () => {
  const control = run('old-leader+old-host', 'old', 'old', capped)

  it('A passes when the old leader answers as with its own daemon, and fails on any other answer or new error', () => {
    expect(judgeOldLeader(run('old-leader+new-host', 'old', 'new', capped), control)).toEqual([])
    expect(judgeOldLeader(run('old-leader+new-host', 'old', 'new', vouched), control).join('\n')).toContain('answer differs')
    expect(judgeOldLeader(run('old-leader+new-host', 'old', 'new', capped, { errorHeads: ['ERR [session] relay frame rejected'] }), control).join('\n')).toContain('did not log')
    expect(judgeOldLeader(run('old-leader+new-host', 'old', 'new', capped, { leaderAlive: false }), control)).toContain('the leader process exited')
  })

  it('B passes only when both bypass starts are refused by the ceiling, 403 each', () => {
    const newPair = run('new-leader+new-host', 'new', 'new', vouched, { startStatuses: [202, 202], modes: { 'bypass-create': 'bypass', 'bypass-start': 'bypass' } })
    expect(judgeNewPair(newPair)).toEqual([])
    expect(judgeNewLeaderOldHost(run('new-leader+old-host', 'new', 'old', capped), { oldBaseline: control, newBaseline: newPair })).toEqual([])
    expect(judgeNewLeaderOldHost(run('new-leader+old-host', 'new', 'old', vouched, { startStatuses: [202, 202] }), { oldBaseline: control, newBaseline: newPair }).join('\n'))
      .toContain('not refused by the ceiling')
    expect(judgeNewPair(run('new-leader+new-host', 'new', 'new', vouched, { startStatuses: [202, 202], modes: { 'bypass-create': 'default' } })).join('\n')).toContain('not bypass')
  })

  it('a mixed pairing fails on a daemon error its own release did not log, and on a daemon the leader replaced', () => {
    const newPair = run('new-leader+new-host', 'new', 'new', vouched, { startStatuses: [202, 202], modes: { 'bypass-create': 'bypass', 'bypass-start': 'bypass' } })
    const a = run('old-leader+new-host', 'old', 'new', capped, { daemonErrorHeads: ['error unknown command <n>'] })
    const replaced = run('new-leader+old-host', 'new', 'old', capped, { daemonProblems: ['the leader replaced the pre-started daemon 1 with 2'] })
    const v = judgeAll([control, a, newPair, replaced])
    expect(v['old-leader+old-host'].ok).toBe(true)
    expect(v['new-leader+new-host'].ok).toBe(true)
    expect(v['old-leader+new-host'].problems.join('\n')).toContain("daemon error line its own release's leader did not cause")
    expect(v['new-leader+old-host'].problems.join('\n')).toContain('replaced')
  })
})
