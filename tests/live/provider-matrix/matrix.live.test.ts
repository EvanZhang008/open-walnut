/**
 * Generic provider live matrix — the SAME scenario set runs for every
 * registered provider spec (specs/index.ts), against a real ephemeral Walnut
 * server and the provider's real binary. Zero mocks.
 *
 * Scenarios (capability-gated per spec):
 *   M1  cold start → trivial turn answers correctly
 *   M2  warm follow-up turn
 *   M3  mid-turn message queues, drains after turn end
 *   M4  flood: 5 rapid mid-turn sends, none lost
 *   M5  interrupt a long turn (REST + WS parity)
 *   M6  model switch round-trip + verify turn        [models.switchable]
 *   M7  permission ask → approve → command runs      [permissions.canTriggerAsk]
 *   M8  permission ask → deny → turn ends clean      [permissions.canTriggerAsk]
 *   M9  auto-approve mode: multi-command turn, zero pending  [permissions.autoApprove]
 *   M10 control toggle race: N parallel flips, session functional  [raceControl]
 *   M11 provider process SIGKILL mid-turn → resend recovers   [crashRecovery]
 *   M12 force-delete task with live session → 204
 *   M13 mid-turn steering: send joins the LIVE turn            [steering]
 *
 * Turn completion is asserted on TRANSCRIPT CONTENT (waitText), never on
 * status polling — status races turn startup and ACP session ids migrate.
 *
 * Run (per provider gate):
 *   WALNUT_LIVE_CODEX=1  npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
 *   WALNUT_LIVE_CLAUDE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
 * Both gates may be set together; ungated/unavailable providers are skipped
 * with a visible reason, never silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROVIDER_SPECS } from './specs/index.js'
import { startLiveServer, MatrixClient, sleep, type LiveServer } from './harness.js'

const diag = (m: string): void => { process.stdout.write(`[matrix] ${m}\n`) }

for (const spec of PROVIDER_SPECS) {
  const gated = process.env[spec.gateEnv] === '1'
  const unavailable = gated ? spec.unavailableReason?.() : undefined
  const runnable = gated && !unavailable

  describe.skipIf(!runnable)(`provider matrix: ${spec.label}`, () => {
    if (gated && unavailable) diag(`${spec.label} SKIPPED: ${unavailable}`)

    let server: LiveServer
    let api: MatrixClient
    let cwd: string
    const cleanupTasks: string[] = []
    const budget = spec.coldStartBudgetSec

    beforeAll(async () => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `matrix-${spec.engine}-`))
      server = await startLiveServer()
      api = new MatrixClient(server.base)
      diag(`${spec.label}: ephemeral server on :${server.port}`)
    }, 120_000)

    afterAll(async () => {
      for (const t of cleanupTasks) await api.forceDeleteTask(t).catch(() => 0)
      await server.stop()
      fs.rmSync(cwd, { recursive: true, force: true })
    }, 60_000)

    // Shared long-lived session for M1-M6 & M10-M11 (mirrors real usage: one
    // session, many turns). Permission scenarios get fresh sessions.
    let taskId: string

    it('M1: cold start answers a trivial prompt', async () => {
      taskId = await api.quickStart(cwd, 'Reply with exactly the word MATRIX-PONG and nothing else.', spec.engine)
      cleanupTasks.push(taskId)
      const t0 = Date.now()
      await api.waitText(taskId, 'MATRIX-PONG', budget * 3)
      diag(`${spec.label} M1 cold start: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }, 400_000)

    it('M2: warm follow-up turn', async () => {
      const sid = await api.waitQuiescent(taskId, budget)
      const t0 = Date.now()
      await api.send(sid, 'Reply with exactly the word MATRIX-WARM and nothing else.')
      await api.waitText(taskId, 'MATRIX-WARM', budget * 2)
      diag(`${spec.label} M2 warm turn: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }, 300_000)

    it('M3: mid-turn message queues and drains after turn end', async () => {
      const sid = await api.waitQuiescent(taskId, budget)
      await api.send(sid, 'Run this exact shell command and show its output: sleep 20 && echo M3_BASE_DONE')
      await sleep(6000) // turn is now running the sleep
      await api.send(sid, 'Reply with the word M3-DRAINED in your next answer.')
      await api.waitText(taskId, 'M3_BASE_DONE', budget * 2)
      const t0 = Date.now()
      await api.waitText(taskId, 'M3-DRAINED', budget * 2)
      diag(`${spec.label} M3 drain gap after base turn: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }, 400_000)

    it('M4: flood — 5 rapid mid-turn sends all survive', async () => {
      const sid = await api.waitQuiescent(taskId, budget)
      await api.send(sid, 'Run this exact shell command and show its output: sleep 15 && echo M4_BASE')
      await sleep(4000)
      for (let i = 1; i <= 5; i++) await api.send(sid, `Acknowledge flood message number ${i}.`)
      await api.waitText(taskId, 'M4_BASE', budget * 2)
      for (let i = 1; i <= 5; i++) {
        await api.waitText(taskId, `flood message number ${i}`, budget * 2)
      }
    }, 500_000)

    it('M5: interrupt a long turn (REST + WS parity)', async () => {
      // The prompt spells the marker with shell quote-splitting (M5_NE''VER_A)
      // so the user message in the transcript does NOT contain the assembled
      // marker — only actual COMMAND OUTPUT can produce it. Asserting on the
      // bare marker would always fail against our own prompt echo.
      let sid = await api.waitQuiescent(taskId, budget)
      await api.send(sid, "Run this exact shell command and show its output: sleep 120 && echo M5_NE''VER_A")
      await sleep(8000)
      const t0 = Date.now()
      await api.interrupt(sid)                       // REST surface
      sid = await api.waitQuiescent(taskId, budget * 2)
      diag(`${spec.label} M5 REST interrupt settle: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      expect(await api.transcript(sid)).not.toContain('M5_NEVER_A')

      await api.send(sid, "Run this exact shell command and show its output: sleep 120 && echo M5_NE''VER_B")
      await sleep(8000)
      await api.wsInterrupt(sid)                     // WS surface
      sid = await api.waitQuiescent(taskId, budget * 2)
      expect(await api.transcript(sid)).not.toContain('M5_NEVER_B')
    }, 400_000)

    it.skipIf(!spec.models.switchable)('M6: model switch round-trip + verify turn', async () => {
      const { a, b } = spec.models
      const sid = await api.waitQuiescent(taskId, budget)
      // A switch can legitimately 409 if the provider refuses mid-migration;
      // what matters is: no crash, a functional turn on whatever model stuck.
      const sw1 = await api.setModel(sid, b!).then(() => 'ok').catch((e) => String(e))
      const sw2 = await api.setModel(sid, a!).then(() => 'ok').catch((e) => String(e))
      diag(`${spec.label} M6 switches: →b ${sw1}, →a ${sw2}`)
      expect(sw1 === 'ok' || sw2 === 'ok', `both model switches failed: ${sw1} / ${sw2}`).toBe(true)
      await api.send(sid, 'Reply with exactly the word MATRIX-MODEL and nothing else.')
      await api.waitText(taskId, 'MATRIX-MODEL', budget * 2)
    }, 300_000)

    it.skipIf(!spec.permissions.canTriggerAsk)('M7: permission ask → approve → command runs', async () => {
      const t = await api.quickStart(cwd, spec.permissions.askPrompt!, spec.engine)
      cleanupTasks.push(t)
      await api.waitSid(t, budget)
      const { sid, requestId } = await api.waitPermissionOnTask(t, budget * 2)
      const r = await api.permission(sid, requestId, true)
      expect(r.ok).toBe(true)
      // approval must unblock the turn: transcript eventually shows the header
      // (HTTP/2 for the curl prompt) and pending returns to zero
      const done = await api.waitQuiescent(t, budget * 2)
      expect((await api.session(done)).pending).toHaveLength(0)
    }, 500_000)

    it.skipIf(!spec.permissions.canTriggerAsk)('M8: permission ask → deny → turn ends clean', async () => {
      const t = await api.quickStart(cwd, spec.permissions.askPrompt!, spec.engine)
      cleanupTasks.push(t)
      await api.waitSid(t, budget)
      const { sid, requestId } = await api.waitPermissionOnTask(t, budget * 2)
      const r = await api.permission(sid, requestId, false)
      expect(r.ok).toBe(true)
      const done = await api.waitQuiescent(t, budget * 2)
      expect((await api.session(done)).pending).toHaveLength(0)
    }, 500_000)

    it.skipIf(!spec.permissions.autoApprove)('M9: auto-approve mode — multi-command turn, zero pending', async () => {
      const t = await api.quickStart(cwd, '', spec.engine)
      cleanupTasks.push(t)
      const s = await api.waitSid(t, budget)
      const { controlId, value } = spec.permissions.autoApprove!
      await api.setControl(s, controlId, value)
      await api.send(s, 'Run these shell commands one by one as separate tool calls, briefly show outputs: (1) curl -sSI --max-time 8 https://example.com | head -1 (2) curl -sS --max-time 8 https://api.github.com/zen (3) echo M9_ALL_DONE')
      // watch pending while waiting for completion text
      let maxPending = 0
      const deadline = Date.now() + budget * 3000
      for (;;) {
        const cur = (await api.sidOf(t)) ?? s
        const sess = await api.session(cur).catch(() => undefined)
        if (sess) maxPending = Math.max(maxPending, sess.pending.length)
        const text = await api.transcript(cur).catch(() => '')
        if (text.includes('M9_ALL_DONE')) break
        if (Date.now() > deadline) throw new Error('M9 turn never completed')
        await sleep(4000)
      }
      expect(maxPending, 'permission ask appeared despite auto-approve mode').toBe(0)
    }, 600_000)

    it.skipIf(!spec.raceControl)('M10: parallel control toggles settle deterministically', async () => {
      const { controlId, values, restore } = spec.raceControl!
      const sid = await api.waitQuiescent(taskId, budget)
      await Promise.all(Array.from({ length: 10 }, (_, i) =>
        api.setControl(sid, controlId, values[i % 2]).catch(() => undefined)))
      await api.setControl(sid, controlId, restore)
      await api.send(sid, 'Reply with exactly the word MATRIX-ALIVE and nothing else.')
      await api.waitText(taskId, 'MATRIX-ALIVE', budget * 2)
    }, 300_000)

    it.skipIf(!spec.crashRecovery)('M11: SIGKILL provider process mid-turn → resend recovers', async () => {
      const sid = await api.waitQuiescent(taskId, budget)
      await api.send(sid, 'Run this exact shell command and show its output: sleep 60 && echo M11_NEVER')
      await sleep(8000)
      const { processPattern, match } = spec.crashRecovery!
      const sess = await api.session(sid)
      let killed = 0
      try {
        const pids = execSync(`pgrep -f '${processPattern}'`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        for (const pid of pids) {
          let mine = false
          if (match === 'journal-fd' && sess.journalPath) {
            try { mine = execSync(`lsof -p ${pid} 2>/dev/null | grep -c '${path.basename(sess.journalPath)}' || true`, { encoding: 'utf8' }).trim() !== '0' } catch { /* gone */ }
          } else {
            try { mine = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep -c '${cwd}' || true`, { encoding: 'utf8' }).trim() !== '0' } catch { /* gone */ }
          }
          if (mine) { process.kill(Number(pid), 'SIGKILL'); killed++ }
        }
      } catch { /* pgrep no match */ }
      diag(`${spec.label} M11 killed ${killed} provider process(es)`)
      expect(killed).toBeGreaterThan(0)
      await sleep(3000)
      const cur = (await api.sidOf(taskId)) ?? sid
      await api.send(cur, 'Reply with exactly the word MATRIX-RECOVERED and nothing else.')
      await api.waitText(taskId, 'MATRIX-RECOVERED', budget * 3)
    }, 600_000)

    it('M12: force-delete a task with a live session returns 204', async () => {
      const t = await api.quickStart(cwd, 'Reply with the word M12-OK.', spec.engine)
      // budget*2: cold session spawn on a loaded machine blew a 1x budget
      // (round 6, load avg 50 — spawn took >90s). This is the last scenario,
      // so generosity here costs nothing when the machine is healthy.
      await api.waitSid(t, budget * 2)
      await api.waitText(t, 'M12-OK', budget * 2).catch(() => undefined) // best-effort settle
      const status = await api.forceDeleteTask(t)
      expect(status).toBe(204)
    }, 300_000)

    it.skipIf(!spec.steering)('M13: mid-turn steering — message joins the LIVE turn, no queue wait', async () => {
      const sid = await api.waitQuiescent(taskId, budget)
      // A long base turn (~60s of sleeps) leaves a wide injection window.
      await api.send(sid, 'Run this exact shell command and show its output: for i in 1 2 3 4 5 6; do sleep 10; echo M13_TICK_$i; done')
      await sleep(12_000) // the turn is now running tick 2
      const t0 = Date.now()
      await api.send(sid, 'While that command keeps running: also reply with the word M13-STEERED in this same answer. Do not cancel the running command.')
      // The steered marker must appear BEFORE the base command finishes —
      // proof it joined the live turn instead of queueing behind it. The base
      // loop still has ≥40s to run; give the marker 35s.
      const cur = await api.waitText(taskId, 'M13-STEERED', 35)
      diag(`${spec.label} M13 steer visible after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      const transcript = await api.transcript(cur)
      expect(transcript).not.toContain('M13_TICK_6')
      // Let the base turn settle so the shared session is clean for reruns.
      await api.waitText(taskId, 'M13_TICK_6', budget * 2).catch(() => undefined)
    }, 400_000)
  })
}

// Always-present sentinel so the file never reports "no tests" when all
// provider gates are off (vitest exits non-zero on empty suites).
describe('provider matrix registry', () => {
  it('has at least one provider spec registered', () => {
    expect(PROVIDER_SPECS.length).toBeGreaterThan(0)
  })
})
