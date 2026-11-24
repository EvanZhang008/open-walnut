/**
 * Every session feature on every connection (the task's requirement: "every feature holds on every
 * connection: the local machine, an ssh host, and the companion (bridge); each has tests"). One
 * matrix, each cell naming the test that proves it over real processes, or why the feature is not
 * offered there (shown to the person, never a silent gap):
 *
 *   local   a session on the leader's own machine: the leader is its host (judge 'here')
 *   ssh     a session a host's own service runs and judges, reached over the leader's daemon link to
 *           that host (the cluster's direct transport stands for the ssh tunnel)
 *   bridge  the same host session from the phone through the companion's listener link, the Mac away
 *
 * Kept honest from the source: every route a leader calls on a host's session side
 * (session-channel/host-routes.ts `op === '...'`), every person's control among the host calls
 * (host-calls.ts: the lifecycle members and the prompt's answer) and every listener call the
 * companion may make (listener-wire.ts LISTENER_CALLS) maps to a feature here; a bridge cell that
 * says "not offered" must not be callable over the listener, and a callable one must have its test.
 * Each test named must exist in its file (a renamed or removed test fails here).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_CALL_ALLOWLIST } from '../../../src/core/session-channel/host-calls.js'
import { LISTENER_CALLS } from '../../../src/core/session-channel/listener-wire.js'
import { HOST_SESSIONS_PATH } from '../../../src/core/session-channel/host-api.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

type Cell = { file: string; test: string } | { notOffered: string }
type Connection = 'local' | 'ssh' | 'bridge'
type Feature = 'start' | 'send' | 'turn-end' | 'interrupt' | 'stop' | 'permission' | 'resume' | 'mode'

const EVERY = 'tests/e2e/host-judged-every-connection-e2e.test.ts'
const C1 = { file: EVERY, test: 'C1 local:' }
const C2 = { file: EVERY, test: 'C2 ssh:' }
const C3 = { file: EVERY, test: 'C3 bridge:' }
const CLUSTER = 'tests/e2e/host-judged-session-cluster-e2e.test.ts'
const LIFECYCLE = 'tests/e2e/host-judged-session-lifecycle-e2e.test.ts'
const PHONE = 'tests/e2e/companion-host-listener-e2e.test.ts'

const MATRIX: Record<Feature, Record<Connection, Cell[]>> = {
  start: {
    local: [C1],
    ssh: [C2, { file: CLUSTER, test: 'S1:' }],
    bridge: [{ file: PHONE, test: 'P5d:' }, { file: PHONE, test: 'P7:' }],
  },
  send: {
    local: [C1],
    ssh: [C2, { file: CLUSTER, test: 'S2:' }],
    bridge: [C3, { file: PHONE, test: 'P3:' }],
  },
  'turn-end': {
    local: [C1],
    ssh: [{ file: CLUSTER, test: 'S1:' }, { file: CLUSTER, test: 'S5b:' }],
    bridge: [{ file: PHONE, test: 'P3:' }, { file: PHONE, test: 'P6:' }],
  },
  interrupt: {
    local: [C1],
    ssh: [C2],
    bridge: [C3, { file: PHONE, test: 'P4:' }],
  },
  stop: {
    local: [C1],
    ssh: [C2, { file: LIFECYCLE, test: 'L5:' }],
    bridge: [C3],
  },
  permission: {
    local: [C1],
    ssh: [C2],
    bridge: [C3, { file: PHONE, test: 'P5:' }],
  },
  resume: {
    local: [C1],
    ssh: [C2],
    bridge: [C3],
  },
  mode: {
    local: [{ file: 'tests/e2e/session-mode-change.test.ts', test: 'REST API returns updated mode after real-time mode change' }],
    ssh: [{ file: LIFECYCLE, test: 'L5:' }],
    bridge: [C3],
  },
}

/** Each route the host's session side serves: the feature it carries, or why it is none of a person's. */
const ROUTE_FEATURE: Record<string, Feature | { none: string }> = {
  start: 'start',
  send: 'send',
  interrupt: 'interrupt',
  call: { none: 'carries the host calls, each mapped below by member' },
  drop: { none: 'the leader\'s delete of rows it removed (L5, L6 in the lifecycle e2e), not a control of a running session' },
}

/** The person's controls among the host calls (the rest are reads and the runner's own bookkeeping). */
const CALL_FEATURE: Record<string, Feature> = {
  'lifecycle.terminateSession': 'stop',
  'lifecycle.changeSessionModeOf': 'mode',
  'session.resolvePermissionRequest': 'permission',
  'acp.resolvePermissionRequest': 'permission',
}

/** The lifecycle members that are no person's control: the leader's checks its session command gate asks the host (session-command-gate.ts). */
const NOT_A_CONTROL: Record<string, string> = {
  'lifecycle.readSessionSupervision': 'a read of the cron supervision state, asked by the leader instead of the daemon',
  'lifecycle.lineAlreadyRan': 'a resend\'s check of a line\'s fate, asked by the leader instead of the daemon',
  'lifecycle.cancelPendingStart': 'an unconfirmed start\'s cancel, the leader\'s own retry step',
  'lifecycle.sendFolderWaiting': 'the leader\'s ask, after it made a released workspace again, that the host send the lines it parked for the gone folder (folder-gone.ts)',
  'lifecycle.readParkedRows': 'a read of the rows the host keeps parked, listed in the leader\'s queue view (host-queue-rows.ts)',
  'lifecycle.sendQueuedRowNow': 'a queued row\'s Retry or Send now on the host that keeps it (host-queue-rows.ts), not a control of a running session',
  'lifecycle.discardQueuedRow': 'a queued row\'s Discard on the host that keeps it (host-queue-rows.ts), as the route `drop` is for the leader\'s rows',
  'lifecycle.takeCompletionStop': 'the leader\'s stop of a completed task\'s session, decided by the completion and carried out by the host (host-judged-complete.ts), not a control a person calls',
  'lifecycle.completionSummaryDone': 'the leader\'s word that a completed task\'s last turn is summarized, so its host may stop the session (host-judged-complete.ts), not a control a person calls',
}

const testsOf = (file: string): string[] => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  return [...src.matchAll(/\bit\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!.replace(/\\'/g, '\''))
}

describe('every session feature on every connection', () => {
  it('each cell names a test that exists, or why the feature is not offered there', () => {
    const missing: string[] = []
    for (const [feature, row] of Object.entries(MATRIX)) {
      for (const [conn, cells] of Object.entries(row)) {
        expect(cells.length, `${feature} over ${conn}: no cell`).toBeGreaterThan(0)
        for (const cell of cells) {
          if ('notOffered' in cell) { expect(cell.notOffered.length).toBeGreaterThan(20); continue }
          if (!fs.existsSync(path.join(ROOT, cell.file))) { missing.push(`${feature}/${conn}: no file ${cell.file}`); continue }
          if (!testsOf(cell.file).some((t) => t.includes(cell.test))) missing.push(`${feature}/${conn}: no test "${cell.test}" in ${cell.file}`)
        }
      }
    }
    expect(missing).toEqual([])
    // The local machine and an ssh host offer every feature: no "not offered" there.
    for (const [feature, row] of Object.entries(MATRIX)) {
      for (const conn of ['local', 'ssh'] as const) expect(row[conn].some((c) => 'notOffered' in c), `${feature} over ${conn}`).toBe(false)
    }
  })

  it('every route of a host\'s session side is mapped', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/session-channel/host-routes.ts'), 'utf8')
    const ops = [...new Set([...src.matchAll(/\bop === '([\w-]+)'/g)].map((m) => m[1]!))].sort()
    expect(ops).toEqual(Object.keys(ROUTE_FEATURE).sort())
  })

  it('every person\'s control among the host calls is a feature of the matrix', () => {
    const controls = [
      ...HOST_CALL_ALLOWLIST.lifecycle.map((m) => `lifecycle.${m}`),
      ...(['session', 'acp'] as const).flatMap((t) => (HOST_CALL_ALLOWLIST[t] as readonly string[]).filter((m) => m === 'resolvePermissionRequest').map((m) => `${t}.${m}`)),
    ].filter((c) => !(c in NOT_A_CONTROL)).sort()
    expect(controls).toEqual(Object.keys(CALL_FEATURE).sort())
    // Each one listed as no control is still a host call (a removed one leaves the list).
    for (const c of Object.keys(NOT_A_CONTROL)) expect(HOST_CALL_ALLOWLIST.lifecycle as readonly string[], c).toContain(c.slice('lifecycle.'.length))
  })

  it('the bridge offers exactly the features its listener calls carry', () => {
    const callable = new Set<Feature>()
    for (const [p, members] of Object.entries(LISTENER_CALLS)) {
      const op = p.slice(HOST_SESSIONS_PATH.length + 1)
      const f = ROUTE_FEATURE[op]
      if (typeof f === 'string') callable.add(f)
      for (const m of members ?? []) {
        const viaCall = CALL_FEATURE[`session.${m}`] ?? CALL_FEATURE[`lifecycle.${m}`]
        expect(viaCall, `listener call ${p} ${m} maps to no feature`).toBeTruthy()
        callable.add(viaCall!)
      }
    }
    // A send to a stopped session resumes it: the send carries the resume.
    if (callable.has('send')) callable.add('resume')
    const notOffered = (Object.keys(MATRIX) as Feature[]).filter((f) => MATRIX[f].bridge.some((c) => 'notOffered' in c))
    for (const f of notOffered) expect(callable.has(f), `${f} is callable over the listener: its bridge cell needs its test`).toBe(false)
    // start and turn-end ride the host's own journal and the stream, never a listener call.
    for (const f of (Object.keys(MATRIX) as Feature[]).filter((x) => !notOffered.includes(x) && x !== 'start' && x !== 'turn-end')) {
      expect(callable.has(f), `${f} has a bridge test but no listener call carries it`).toBe(true)
    }
  })
})
