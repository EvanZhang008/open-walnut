/**
 * leader-switch-home-stop-v1 on both daemon twins: the daemon program (daemon-standalone.ts
 * `--service` under bun, over its door) and the runtime inside a server's process
 * (createDaemonRuntime, mode 'service', over runtime.connect()). Both are the same
 * createDaemonRuntime with real CLIs (stand-in scripts) and a real surviving ACP worker (the worker
 * bundle over the mock agent); the work runs in a bun child (fixtures/leader-switch-home-stop.ts)
 * that prints one JSON line, asserted here.
 *
 * Pinned (a leader switch's stop of the machine handing the leader over, docs/reference/leader-switch.md):
 *   - stop {reason: 'leader_switch', stopRequestId, home}: needs its fence and its Walnut, refuses
 *     another Walnut, answers once the process group is gone, turns supervision off under the fence
 *     (a start without it or with another one is refused, with it passes: the rollback's resume);
 *   - a CLI that outlives SIGTERM: an error and it still runs (no force kill);
 *   - an ACP worker that outlives its daemon: the same stop ends it (gone at the answer, its pid row
 *     and pipe gone), a retried stop answers stopped; a tool its graceful shutdown leaves running gets
 *     one SIGTERM to the group;
 *   - start and acpStart in a marked home (switching, handed-over, torn), and a live adopt of a running
 *     CLI there, are refused with
 *     HOME_HANDED_OVER, the home, the state and the machine; `<home>-c` starts as before;
 *   - a new runtime on the same dirs adopts the kept CLI and ACP worker and nothing of the stopped.
 *
 * MACHINE SAFETY: everything lives in a temp root (HOME, the daemon, streams and state dirs, the data
 * home); see the fixture for every signal it sends.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/leader-switch-home-stop.ts')
const BUN = testBun()
const roots: string[] = []
afterAll(() => { for (const r of roots) if (r.includes('lshs-')) fs.rmSync(r, { recursive: true, force: true }) })

function run(shape: 'program' | 'in-process'): Promise<Record<string, unknown>> {
  // Short: the daemon's sockets live under it (a socket path has at most 103 bytes).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lshs-')))
  roots.push(root)
  const env: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin') }
  return new Promise((resolve, reject) => {
    const child = execFile(BUN!, [FIXTURE, root, shape], { env, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const line = String(stdout).trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(line)) } catch { reject(new Error(`${shape}: no result (${error?.message ?? ''})\n${String(stderr).slice(-3000)}`)) }
    })
    child.stdin?.end()
  })
}

const refused = (state: string, to?: string) => ({
  ok: false, errorKind: 'home_handed_over', code: 'HOME_HANDED_OVER', reason: 'home_handed_over', state,
  home: expect.stringMatching(/\/data$/), ...(to ? { to } : {}),
})

describe.skipIf(!BUN)('a leader switch stop of the sessions in a data home, on both daemon twins', () => {
  for (const shape of ['program', 'in-process'] as const) {
    it(`${shape}: ends them for good, refuses starts in a marked home, adopts nothing of them`, async () => {
      const out = await run(shape)
      expect(out.error, String(out.error)).toBeUndefined()
      expect(out.stopError).toBeUndefined()
      expect(out.capability).toBe(true)

      // 1. The stop: its fence and its Walnut, the owner rule, the answer after the group is gone.
      expect(out.unmarkedStart).toEqual({ ok: true })
      expect(out.noFence).toEqual({ ok: false, error: 'stop: leader_switch needs a stopRequestId' })
      expect(out.noHome).toEqual({ ok: false, error: 'stop: leader_switch needs the asking Walnut (home)' })
      expect(out.otherWalnut).toEqual({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' })
      expect(out.aliveAfterRefusals).toBe(true)
      expect(out.stopped).toEqual({ ok: true, stopped: true })
      expect(out.goneAtAnswer).toBe(true)
      // Supervision off (not 'maintenance', which keeps it): no cron tick relaunches the CLI in the old home.
      expect(out.supervision).toMatchObject({ enabled: false, state: 'disabled' })
      expect(out.startNoFence).toEqual({ ok: false, reason: 'session_stopped' })
      expect(out.startOtherFence).toEqual({ ok: false, reason: 'session_stopped' })
      expect(out.reenableOtherFence).toEqual({ ok: false, error: 'cron.supervision: request superseded by a stop' })
      // The rollback's resume carries the stop's fence and starts.
      expect(out.startWithFence).toEqual({ ok: true })
      expect(out.stopAgain).toEqual({ ok: true, stopped: true })
      expect(out.goneAgain).toBe(true)

      // 2. No force kill: a CLI that outlives SIGTERM is an error and still runs.
      expect(out.stubbornReady).toBe(true)
      expect(out.stubborn).toEqual({ ok: false, error: 'stop: process did not exit after SIGTERM; automatic recovery remains disabled' })
      expect(out.stubbornMs).toBeGreaterThanOrEqual(5_000)
      expect(out.stubbornStillAlive).toBe(true)
      expect(out.stubbornEndsOnRelease).toBe(true)

      // 3. A surviving ACP worker: the same stop, its strict stop, nothing left for a next daemon.
      expect(out.acpStart).toEqual({ ok: true })
      expect(out.acpSurvive).toBe(true)
      expect(out.acpOtherWalnut).toEqual({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' })
      expect(out.acpAliveAfterRefusal).toBe(true)
      expect(out.acpStopped).toEqual({ ok: true, stopped: true, kind: 'acp' })
      expect(out.acpGoneAtAnswer).toBe(true)
      expect(out.acpRowGone).toBe(true)
      expect(out.acpSurviveFilesGone).toBe(true)
      expect(out.acpStopAgain).toMatchObject({ ok: true, stopped: true })
      // A tool the graceful shutdown leaves running: one SIGTERM to the group after the wait, then the answer.
      expect(out.acpToolStart).toEqual({ ok: true })
      expect(out.toolRunning).toBe(true)
      expect(out.acpToolStopped).toEqual({ ok: true, stopped: true, kind: 'acp' })
      expect(out.acpToolStopMs).toBeGreaterThanOrEqual(3_000)
      expect(out.acpToolGroupGone).toBe(true)

      // 4. A marked home refuses every start in it or under it, in both states and torn; the neighbour starts.
      expect(out.markedSwitching).toEqual(refused('switching', 'machine-b'))
      expect(out.markedResume).toEqual(refused('switching', 'machine-b'))
      expect(out.markedLiveAdopt).toEqual(refused('switching', 'machine-b'))
      expect(out.liveStillRuns).toBe(true)
      expect(out.liveStop).toEqual({ ok: true, stopped: true })
      expect(out.markedAcp).toEqual(refused('switching', 'machine-b'))
      expect(out.markedHandedOver).toEqual(refused('handed-over', 'machine-b'))
      expect(out.markedHandedOverAcp).toEqual(refused('handed-over', 'machine-b'))
      expect(out.markedTorn).toEqual(refused('handed-over'))
      expect(out.noSessionStarted).toBe(true)
      expect(out.noWorkerStarted).toBe(true)
      expect(out.neighbourStart).toEqual({ ok: true })
      expect(out.neighbourStop).toEqual({ ok: true, stopped: true })

      // 5. A new runtime adopts the kept ones (the control) and nothing of the stopped ones.
      expect(out.keepAcpStart).toEqual({ ok: true })
      expect(out.keptAliveAcrossStop).toBe(true)
      expect(out.adoptedAlive).toEqual(['5e5e5e5e-0000-4000-8000-000000000007'])
      expect(out.stoppedStatus).toEqual({ exists: false })
      expect(out.acpKeptState).toEqual({ ok: true })
      expect(out.acpStoppedState).toEqual({ ok: false, errorKind: 'no_worker' })
      expect(out.acpRowsAfterRestart).toEqual(['5e5e5e5e-0000-4000-8000-000000000014'])
      expect(out.supervisionAfterRestart).toMatchObject({ enabled: false, state: 'disabled' })
      expect(out.keepStop).toEqual({ ok: true, stopped: true })
      expect(out.keepAcpStop).toEqual({ ok: true, stopped: true, kind: 'acp' })
      expect(out.keptGone).toBe(true)
      expect(out.leftover).toEqual([])
    }, 160_000)
  }
})
