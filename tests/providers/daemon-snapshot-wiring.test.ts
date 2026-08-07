/**
 * C1 daemon snapshot wiring — integration tests
 * (docs/plan/session-snapshot-source-of-truth.md §4).
 *
 * Runs the REAL daemon (the source template produced by getDaemonSource(),
 * spawned via node — the same artifact SSH-deployed to remote hosts, fold
 * functions injected via fn.toString()) in a fully isolated temp dir, and
 * drives it over a real WebSocket. This is the strongest existing precedent
 * (tests/e2e/daemon-lifecycle-e2e.test.ts): the tailer, the coalescer, the
 * reap path, and getState all execute their production code.
 *
 * Scenarios (deliverable E):
 *   1. lines fed through the real tailer update foldState → snapshot event
 *      reaches a subscriber (turn start via appendUserMarker fold hook, turn
 *      settle via result+idle lines) and the final `v` equals the jsonl byte
 *      size (tailer v alignment — off-by-one guard).
 *   2. coalescing: burst of state flips → pushes are ≥50ms apart (coalesce
 *      window) and the final state is correct. The sub-50ms behavior the 100ms
 *      poll can't reach is covered at unit level ("snapshot push plumbing").
 *   3. death push is immediate on reap (dead snapshot ordered BEFORE the
 *      legacy exit event — both emitted synchronously in reapSession).
 *   4. getState includes the assembled snapshot (live session).
 *   5. rebuild-from-disk: unknown-sid getState on a synthetic ~3MB whale file
 *      converges (turnActive correct both ways) and completes < 2s.
 *   6. getDaemonSource() deploy-time validation: no placeholder residue,
 *      injected text parses under strict mode + smoke fold passes (implicit —
 *      getDaemonSource throws otherwise), corrupt injection throws.
 *   7. torn-tail carry: a result line split across two polls still settles the
 *      turn (contract §4 "Feed"; without the carry the complete line is lost
 *      forever behind the `v > foldState.v` guard).
 *   8. push storm: lines that change nothing but `v` produce NO pushes.
 *   9. daemon restart: SIGKILL daemon A mid-turn, daemon B adopts and rebuilds
 *      foldState from the jsonl → turnActive survives.
 *  10. unit level (no daemon): the extracted push plumbing coalesces two pushes
 *      5ms apart into ONE wire push carrying the LATEST state.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR/WALNUT_STREAMS_DIR temp dirs,
 * never /tmp/open-walnut, never port 3456 (the daemon picks a random port);
 * the single spawned daemon + its sleep "CLI" children are killed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource, validateFoldInjection } from '../../src/providers/daemon-source.js'
import { createDaemonCore } from '../../src/providers/daemon-core.js'
import { foldLine, initialFoldState, assembleSnapshot, snapshotDiffers, type SessionSnapshot } from '../../src/providers/daemon-fold.js'

const PROD_DAEMON_DIR = '/tmp/open-walnut'
const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapwire-'))
const STREAMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapwire-streams-'))
if (path.resolve(DAEMON_DIR) === path.resolve(PROD_DAEMON_DIR)) {
  throw new Error('refusing to run against the production daemon dir')
}

let daemonProc: ChildProcess | null = null
let daemonPort = 0
let scriptPath = ''
let rpcId = 1

// ── Line factories (same synthetic shapes as the fold golden set) ──
const jline = (obj: Record<string, unknown>) => JSON.stringify(obj)
const userLine = (text = 'start turn') =>
  jline({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const resultLine = (isError = false) =>
  jline({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, num_turns: 1, result: 'done' })
const stateLine = (state: string) => jline({ type: 'system', subtype: 'session_state_changed', state })
const assistantFlood = () =>
  jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } })

function appendLines(sid: string, lines: string[]): void {
  fs.appendFileSync(path.join(STREAMS_DIR, sid + '.jsonl'), lines.map((l) => l + '\n').join(''))
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`rpc timeout: ${cmd.cmd}`)) }, timeoutMs)
    const onMsg = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', onMsg); resolve(msg) }
      } catch {}
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

interface TimedEvent { msg: Record<string, unknown>; at: number }
/** Record every {ev} frame for a sid, with receive timestamps. */
function recordEvents(ws: WebSocket, sid: string): { events: TimedEvent[]; stop: () => void } {
  const events: TimedEvent[] = []
  const onMsg = (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.ev && msg.sid === sid) events.push({ msg, at: Date.now() })
    } catch {}
  }
  ws.on('message', onMsg)
  return { events, stop: () => ws.off('message', onMsg) }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, step = 25): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return await cond()
}

/** Start a daemon-managed session backed by a harmless long sleep (no real CLI). */
async function startSleepSession(ws: WebSocket, sid: string, message = 'hello'): Promise<number> {
  const res = await rpc(ws, { cmd: 'start', sid, args: ['/bin/sleep', '120'], cwd: os.tmpdir(), message })
  expect(res.ok).toBe(true)
  return res.pid as number
}

function snapshotsOf(events: TimedEvent[]): Array<{ snapshot: SessionSnapshot; at: number }> {
  return events
    .filter((e) => e.msg.ev === 'snapshot')
    .map((e) => ({ snapshot: e.msg.snapshot as SessionSnapshot, at: e.at }))
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapwire-script-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })

  daemonProc = spawn('node', [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR, WALNUT_STREAMS_DIR: STREAMS_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  daemonPort = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    daemonProc!.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(t); resolve(parseInt(m[0], 10)) }
    })
    daemonProc!.on('error', (err) => { clearTimeout(t); reject(err) })
    daemonProc!.on('exit', (code) => { clearTimeout(t); reject(new Error('daemon exited early: ' + code)) })
  })
}, 30_000)

afterAll(async () => {
  // Kill everything we spawned: the daemon (isolated-dir daemons reap their
  // session groups on SIGTERM via shouldReapOnExit) then force-kill fallback.
  if (daemonProc && daemonProc.exitCode === null) {
    daemonProc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { daemonProc!.kill('SIGKILL') } catch {}; resolve() }, 8000)
      daemonProc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  // Belt-and-suspenders: kill any sleep CLI recorded in pgid files.
  try {
    for (const f of fs.readdirSync(STREAMS_DIR)) {
      if (!f.endsWith('.pgid')) continue
      const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10)
      if (pid > 0) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
    }
  } catch {}
  for (const d of [DAEMON_DIR, STREAMS_DIR, path.dirname(scriptPath)]) {
    try { await fsp.rm(d, { recursive: true, force: true }) } catch {}
  }
}, 20_000)

describe('C1 snapshot wiring — real daemon, real tailer, real WS', () => {
  // ── Scenario 1: tailer feed + marker fold → snapshot events ──
  it('tailer folds appended lines and pushes snapshot events to a subscriber', async () => {
    const ws = await connectWs()
    const sid = `snap-tailer-${Date.now()}`
    try {
      const rec = recordEvents(ws, sid)
      await startSleepSession(ws, sid)

      // Turn start via the appendUserMarker fold hook — the daemon folds the
      // marker immediately (before the tailer sees the bytes).
      const marker = await rpc(ws, { cmd: 'appendUserMarker', sid, message: 'queued turn', messageId: 'qm-test-1' })
      expect(marker.ok).toBe(true)

      await waitFor(() => snapshotsOf(rec.events).some((s) => s.snapshot.turnActive === true), 3000)
      const running = snapshotsOf(rec.events).find((s) => s.snapshot.turnActive === true)
      expect(running, 'expected a turnActive=true snapshot after the user marker').toBeTruthy()
      expect(running!.snapshot.cliState).toBe('running')

      // Turn settle: result + trailing idle through the REAL tailer.
      appendLines(sid, [resultLine(), stateLine('idle')])
      await waitFor(() => {
        const snaps = snapshotsOf(rec.events)
        return snaps.length > 0 && snaps[snaps.length - 1].snapshot.cliState === 'idle'
      }, 3000)
      // Tailer `v` alignment: after the batch settles, the snapshot's v MUST
      // equal the jsonl's byte size exactly. This is the coordinate walnut's
      // v-gate compares against consumedOffset, so an off-by-one here (e.g.
      // dropping the +1 newline byte) silently mis-orders every apply.
      const jsonlSize = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl')).size
      await waitFor(() => (snapshotsOf(rec.events).at(-1)?.snapshot.v ?? 0) === jsonlSize, 3000)

      const last = snapshotsOf(rec.events).at(-1)!.snapshot
      expect(last.cliState).toBe('idle')
      expect(last.turnActive).toBe(false)
      expect(last.lastResult).toMatchObject({ isError: false })
      expect(last.v, 'snapshot.v must equal the jsonl byte size (tailer v alignment)').toBe(jsonlSize)
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 20_000)

  // ── Scenario 2: coalescing ──
  it('coalesces pushes to ≤1 per 50ms window under a burst, final state correct', async () => {
    const ws = await connectWs()
    const sid = `snap-coalesce-${Date.now()}`
    try {
      const rec = recordEvents(ws, sid)
      await startSleepSession(ws, sid)

      // Burst: 20 full turn cycles (user → result → idle) appended over ~200ms.
      // Every cycle flips turnActive, so WITHOUT coalescing each flip could
      // push; with the 50ms window pushes must be spaced apart.
      for (let i = 0; i < 20; i++) {
        appendLines(sid, [userLine(`burst ${i}`), resultLine(), stateLine('idle')])
        await new Promise((r) => setTimeout(r, 10))
      }
      // Let the tailer + coalescer drain fully.
      await waitFor(() => {
        const snaps = snapshotsOf(rec.events)
        return snaps.length > 0 && snaps[snaps.length - 1].snapshot.cliState === 'idle'
      }, 4000)
      await new Promise((r) => setTimeout(r, 300))

      const snaps = snapshotsOf(rec.events)
      expect(snaps.length).toBeGreaterThan(0)
      // ≤1 push per 50ms window: consecutive snapshot events must be ≥50ms
      // apart (35ms floor allows WS delivery jitter).
      for (let i = 1; i < snaps.length; i++) {
        expect(snaps[i].at - snaps[i - 1].at, 'two snapshot pushes landed inside one coalesce window').toBeGreaterThanOrEqual(35)
      }
      // Final state correct: last cycle settled.
      const last = snaps[snaps.length - 1].snapshot
      expect(last.cliState).toBe('idle')
      expect(last.turnActive).toBe(false)
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 20_000)

  // ── Scenario 3: death push immediate ──
  it('pushes a dead snapshot immediately on reap, ordered before the exit event', async () => {
    const ws = await connectWs()
    const sid = `snap-death-${Date.now()}`
    const rec = recordEvents(ws, sid)
    const pid = await startSleepSession(ws, sid)

    // Open a turn so death interrupts something live.
    appendLines(sid, [userLine('doomed turn')])
    await waitFor(() => snapshotsOf(rec.events).some((s) => s.snapshot.turnActive), 3000)

    process.kill(pid, 'SIGKILL')
    await waitFor(() => rec.events.some((e) => e.msg.ev === 'exit'), 6000)

    const deadSnapIdx = rec.events.findIndex((e) => e.msg.ev === 'snapshot' && (e.msg.snapshot as SessionSnapshot).cliState === 'dead')
    const exitIdx = rec.events.findIndex((e) => e.msg.ev === 'exit')
    expect(deadSnapIdx, 'no dead snapshot was pushed on reap').toBeGreaterThan(-1)
    expect(exitIdx).toBeGreaterThan(-1)
    // Immediate = pushed synchronously inside reapSession BEFORE the exit
    // fan-out (which clears the subscriber set) — order proves no coalesce delay.
    expect(deadSnapIdx, 'dead snapshot must be pushed before the exit event').toBeLessThan(exitIdx)
    const dead = rec.events[deadSnapIdx].msg.snapshot as SessionSnapshot
    expect(dead.cliState).toBe('dead')
    rec.stop()
    ws.close()
  }, 20_000)

  // ── Scenario 3b (C18): the death snapshot must include the PRE-EXIT result ──
  // Real shape: the CLI writes its final result + companion idle microseconds
  // before exiting. reapSession sets state='dead' first, and the tailer's poll
  // returns early once state !== 'running' — so those last lines were never
  // folded and the death snapshot (plus every later getState pull) reported
  // turnActive=true for a turn that provably ended on disk. reapSession now
  // drains synchronously before assembling.
  //
  // Here we make the ordering deterministic by appending the result/idle and
  // killing the CLI in the same tick, so the poll cannot have seen them.
  it('drains the pre-exit result+idle into the death snapshot (frozen-fold repro)', async () => {
    const ws = await connectWs()
    const sid = `snap-drain-${Date.now()}`
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const rec = recordEvents(ws, sid)
    const pid = await startSleepSession(ws, sid)
    try {
      // Open a turn and let the tailer catch up to exactly the anchor.
      const anchor = userLine('turn that ends at exit')
      appendLines(sid, [anchor])
      const anchorEnd = fs.statSync(jsonlPath).size
      const caught = await waitFor(async () => {
        const st = await rpc(ws, { cmd: 'getState', sid })
        const s = st.snapshot as SessionSnapshot | undefined
        return !!s && s.v === anchorEnd && s.turnActive === true
      }, 5000)
      expect(caught, 'tailer never reached the anchor').toBe(true)

      // Write the turn-end lines and kill in the SAME tick — no poll in between.
      fs.appendFileSync(jsonlPath, resultLine() + '\n' + stateLine('idle') + '\n')
      const size = fs.statSync(jsonlPath).size
      process.kill(pid, 'SIGKILL')

      await waitFor(() => rec.events.some((e) => e.msg.ev === 'exit'), 8000)
      const deadSnap = rec.events
        .filter((e) => e.msg.ev === 'snapshot')
        .map((e) => e.msg.snapshot as SessionSnapshot)
        .find((s) => s.cliState === 'dead')
      expect(deadSnap, 'no dead snapshot was pushed').toBeTruthy()
      expect(deadSnap!.lastResult,
        'the pre-exit result was never folded — reapSession did not drain the tailer').toMatchObject({ isError: false })
      expect(deadSnap!.turnActive,
        'death snapshot serves a frozen fold: turnActive=true for a turn that ended on disk').toBe(false)
      expect(deadSnap!.v, 'drain must consume every complete byte before assembling').toBe(size)

      // …and the PULL path agrees (it re-assembles the same, now-drained fold).
      const pulled = (await rpc(ws, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(pulled.turnActive).toBe(false)
      expect(pulled.v).toBe(size)
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 30_000)

  // ── Scenario 4: getState carries the snapshot (live session) ──
  it('getState response includes the assembled snapshot for a live session', async () => {
    const ws = await connectWs()
    const sid = `snap-getstate-${Date.now()}`
    try {
      const pid = await startSleepSession(ws, sid)
      appendLines(sid, [userLine('turn for getState')])
      // Let the tailer fold the line.
      await new Promise((r) => setTimeout(r, 400))

      const res = await rpc(ws, { cmd: 'getState', sid })
      expect(res.ok).toBe(true)
      const snap = res.snapshot as SessionSnapshot
      expect(snap, 'getState must include a snapshot field').toBeTruthy()
      expect(snap.cliState).toBe('running')
      expect(snap.turnActive).toBe(true)
      expect(snap.pid).toBe(pid)
      expect(snap.pendingPermission).toBeNull()
      expect(snap.v).toBeGreaterThan(0)
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 20_000)

  // ── Scenario 5: whale rebuild from disk on unknown-sid getState ──
  it('rebuilds foldState from a ~3MB whale file on unknown-sid getState in <2s (turnActive both ways)', async () => {
    const ws = await connectWs()
    try {
      // Settled whale: init + user + ~750 4KB assistant lines + result + idle.
      const settledSid = `snap-whale-settled-${Date.now()}`
      const flood = Array.from({ length: 750 }, assistantFlood)
      appendLines(settledSid, [userLine('whale turn'), ...flood, resultLine(), stateLine('idle')])
      const settledSize = fs.statSync(path.join(STREAMS_DIR, settledSid + '.jsonl')).size
      expect(settledSize).toBeGreaterThan(2.5 * 1024 * 1024)

      const t0 = Date.now()
      const res = await rpc(ws, { cmd: 'getState', sid: settledSid })
      const elapsed = Date.now() - t0
      expect(res.ok).toBe(true)
      expect(res.exists).toBe(true)
      const snap = res.snapshot as SessionSnapshot
      expect(snap.cliState).toBe('dead') // disk-rebuild path: no live process
      expect(snap.turnActive).toBe(false) // result + trailing idle → settled
      expect(snap.v).toBe(settledSize)
      expect(elapsed, `whale rebuild took ${elapsed}ms`).toBeLessThan(2000)

      // Mid-turn whale: same flood but NO result/idle → turnActive stays true.
      const openSid = `snap-whale-open-${Date.now()}`
      appendLines(openSid, [userLine('unfinished whale'), ...flood])
      const res2 = await rpc(ws, { cmd: 'getState', sid: openSid })
      expect(res2.ok).toBe(true)
      const snap2 = res2.snapshot as SessionSnapshot
      expect(snap2.turnActive).toBe(true)
    } finally {
      ws.close()
    }
  }, 20_000)

  // ── Scenario 7: torn-tail carry (contract §4 "Feed") ──
  // A whale tool_result >64KB tears across the 100ms poll boundary in practice.
  // WITHOUT the per-watcher byte carry the tailer folds each fragment as an
  // unparseable line, which advances foldState.v PAST the real line end — the
  // `v > foldState.v` guard then skips the complete line forever and the
  // snapshot is wedged at turnActive=true. It also fanned half a JSON line out
  // to subscribers (pre-existing tear, fixed by the same carry).
  it('holds a torn result line in the carry across polls and still settles the turn', async () => {
    const ws = await connectWs()
    const sid = `snap-torn-${Date.now()}`
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    try {
      const rec = recordEvents(ws, sid)
      await startSleepSession(ws, sid)

      // Turn anchor, complete line.
      const anchor = userLine('turn that will tear')
      appendLines(sid, [anchor])
      const anchorEnd = fs.statSync(jsonlPath).size
      // Wait until the tailer has consumed exactly the anchor.
      const sawAnchor = await waitFor(async () => {
        const st = await rpc(ws, { cmd: 'getState', sid })
        return (st.snapshot as SessionSnapshot)?.v === anchorEnd
      }, 4000)
      expect(sawAnchor, 'tailer never reached the anchor line boundary').toBe(true)

      // Tear the result line: append its first half WITHOUT a newline.
      const result = resultLine()
      const half = Math.floor(result.length / 2)
      fs.appendFileSync(jsonlPath, result.slice(0, half))
      await new Promise((r) => setTimeout(r, 350)) // ≥3 poll ticks

      // The carry MUST be holding the fragment: v is still the last COMPLETE
      // line boundary. (Without the carry it would have advanced past the
      // fragment, poisoning the guard for the real line.)
      const mid = await rpc(ws, { cmd: 'getState', sid })
      expect((mid.snapshot as SessionSnapshot).v,
        'v advanced into a non-newline-terminated fragment — the torn tail was folded').toBe(anchorEnd)
      expect((mid.snapshot as SessionSnapshot).turnActive).toBe(true)

      // Now complete the line and settle the turn.
      fs.appendFileSync(jsonlPath, result.slice(half) + '\n')
      appendLines(sid, [stateLine('idle')])
      const settled = await waitFor(async () => {
        const st = await rpc(ws, { cmd: 'getState', sid })
        return (st.snapshot as SessionSnapshot)?.turnActive === false
      }, 5000)
      const final = (await rpc(ws, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(settled, 'the torn result line was lost — fold never settled the turn').toBe(true)
      expect(final.turnActive).toBe(false)
      expect(final.lastResult).toMatchObject({ isError: false })
      expect(final.v).toBe(fs.statSync(jsonlPath).size)

      // Fan-out tear: every jsonl line delivered to the subscriber must be a
      // complete, parseable JSON line — never a fragment.
      const delivered = rec.events.filter((e) => e.msg.ev === 'jsonl').map((e) => e.msg.line as string)
      expect(delivered.length).toBeGreaterThan(0)
      for (const line of delivered) {
        expect(() => JSON.parse(line), `fanned out a torn fragment: ${line.slice(0, 60)}…`).not.toThrow()
      }
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 30_000)

  // ── Scenario 7b (C3+C7): adopt/attach on a MID-LINE file ──
  // The torn-line wedge reappears at the adopt/attach boundary if the rebuild
  // folds the trailing fragment AND the watcher offset is seeded from a raw
  // stat().size: the rebuild consumes the fragment's first half (advancing
  // foldState.v past the real line end) and the watcher starts mid-line, so when
  // the newline arrives the completed line is fanned/folded from its MIDDLE and
  // the `v > foldState.v` guard drops it — forever. Fixed by (a) never folding
  // the trailing fragment and (b) seeding the watcher from the rebuild's
  // complete-line boundary.
  it('attaches to a mid-line stream file and still sees the completed line exactly once', async () => {
    const ws = await connectWs()
    const sid = `snap-adopt-torn-${Date.now()}`
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    try {
      // A file the daemon has never seen: complete anchor, then HALF a result
      // line (the CLI was mid-write at adopt time). No .pgid → attach-discover
      // treats it as dead, which is fine: the rebuild + boundary are what matter.
      const anchor = userLine('turn torn at adopt')
      const result = resultLine()
      const half = Math.floor(result.length / 2)
      fs.writeFileSync(jsonlPath, anchor + '\n' + result.slice(0, half))
      const anchorEnd = Buffer.byteLength(anchor, 'utf8') + 1

      // Unknown-sid getState rebuilds from disk: the trailing fragment must NOT
      // be folded, so `v` stops at the last complete-line boundary.
      const rebuilt = (await rpc(ws, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(rebuilt.v,
        'rebuild folded the torn trailing fragment — v advanced past the real line end').toBe(anchorEnd)
      expect(rebuilt.turnActive, 'the anchor must still be seen').toBe(true)
      expect(rebuilt.lastResult, 'a torn result must not be counted as a verdict').toBe(null)

      // Complete the line + settle. The SAME disk-rebuild path (still an unknown
      // sid — attach below is what would put it in the map) must now see the
      // whole line: proof it was not half-consumed the first time. This is
      // exactly the byte range a re-reading watcher covers after an adopt.
      fs.appendFileSync(jsonlPath, result.slice(half) + '\n' + stateLine('idle') + '\n')
      const size = fs.statSync(jsonlPath).size
      const converged = (await rpc(ws, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(converged.lastResult,
        'the completed result line was lost at the adopt boundary (torn-line wedge)').toMatchObject({ isError: false })
      expect(converged.turnActive).toBe(false)
      expect(converged.v).toBe(size)

      // Attach now materializes the session from disk. Its watcher offset comes
      // from the SAME rebuild's boundary, so the attach reply's currentOffset is
      // a line boundary and never the mid-line read cursor.
      const rec = recordEvents(ws, sid)
      const attached = await rpc(ws, { cmd: 'attach', sid, fromOffset: 0 })
      expect(attached.ok).toBe(true)
      const live = (await rpc(ws, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(live.v, 'attach-discover seeded the fold from a non-boundary offset').toBe(size)
      expect(live.turnActive).toBe(false)

      // Whatever WAS fanned out must be whole, parseable lines — a mid-line
      // start would have produced an unparseable half.
      const delivered = rec.events.filter((e) => e.msg.ev === 'jsonl').map((e) => e.msg.line as string)
      for (const line of delivered) {
        expect(() => JSON.parse(line), `fanned out a torn fragment: ${line.slice(0, 60)}…`).not.toThrow()
      }
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 30_000)

  // ── Scenario 7c (C14): rename must not swallow a pending coalesced snapshot ──
  // pushSnapshot's 50ms timer holds a generation guard keyed on the OLD sid.
  // After cmdRename's sessions.delete(oldSid)/set(newSid) that guard can never
  // match, so a state change caught inside the window was dropped silently.
  //
  // The case that never self-heals is a state change the tailer CANNOT re-derive
  // from new bytes: a pendingCtrl clear. Every other dropped push is re-emitted
  // by the next tailer batch (which recomputes the same fold and finds it still
  // differs from lastPushedSnapshot), so the damage is one poll of latency. But
  // `waiting` lives only in daemon memory: once setMode auto-allows the pending
  // request, nothing further is written to the stream file, so there is no next
  // batch and no next push — walnut stays on `waiting` until the 30s pull.
  it('flushes a pending pendingCtrl-clear snapshot on rename instead of dropping it', async () => {
    const ws = await connectWs()
    const oldSid = `snap-rename-old-${Date.now()}`
    const newSid = `snap-rename-new-${Date.now()}`
    const jsonlPath = path.join(STREAMS_DIR, oldSid + '.jsonl')
    try {
      const recOld = recordEvents(ws, oldSid)
      const recNew = recordEvents(ws, newSid)
      await startSleepSession(ws, oldSid)

      // Open a turn, then a control_request the daemon will hold as pendingCtrl
      // (mode 'default' does not auto-respond) → snapshot flips to 'waiting'.
      appendLines(oldSid, [userLine('turn needing permission')])
      appendLines(oldSid, [jline({
        type: 'control_request', request_id: 'req-rename-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      })])
      const waiting = await waitFor(
        () => snapshotsOf(recOld.events).at(-1)?.snapshot.cliState === 'waiting', 5000)
      expect(waiting, 'daemon never reported waiting for the control_request').toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      const baseline = snapshotsOf(recOld.events).length

      // setMode bypass auto-allows the pending request → pendingCtrl cleared →
      // pushSnapshot(sid,false) opens the 50ms window. Rename immediately: the
      // re-key lands inside it, so only the flush can save this transition.
      const modeRes = await rpc(ws, { cmd: 'setMode', sid: oldSid, mode: 'bypass' })
      expect(modeRes.ok).toBe(true)
      const renamed = await rpc(ws, { cmd: 'rename', oldSid, newSid })
      expect(renamed.ok).toBe(true)

      // The waiting → running transition must reach the subscriber under EITHER
      // sid (the flush uses the old sid, which is the one walnut's subscribers
      // know at that instant).
      const resolved = await waitFor(() => {
        const all = [...snapshotsOf(recOld.events), ...snapshotsOf(recNew.events)]
        return all.some((s) => s.snapshot.cliState !== 'waiting' && s.snapshot.pendingPermission === null)
      }, 3000)
      expect(resolved,
        'the pendingCtrl-clear snapshot was dropped by the rename re-key (walnut stays on waiting until the 30s pull)').toBe(true)
      expect(snapshotsOf(recOld.events).length + snapshotsOf(recNew.events).length)
        .toBeGreaterThan(baseline)
      recOld.stop(); recNew.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid: newSid }).catch(() => {})
      await rpc(ws, { cmd: 'stop', sid: oldSid }).catch(() => {})
      ws.close()
    }
  }, 30_000)

  // ── Scenario 8: no push storm ──
  // Every streamed line advances `v`, so pushing on each would be a
  // self-inflicted event storm across the tunnel. emitSnapshot's change-compare
  // (snapshotDiffers, which deliberately ignores bare `v` advance) is the only
  // thing preventing it.
  it('does NOT push when lines change nothing but v, and pushes exactly once on a real change', async () => {
    const ws = await connectWs()
    const sid = `snap-storm-${Date.now()}`
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    try {
      const rec = recordEvents(ws, sid)
      await startSleepSession(ws, sid)

      // Settle a turn so we have a stable baseline snapshot (and one push).
      appendLines(sid, [userLine('baseline turn'), resultLine(), stateLine('idle')])
      await waitFor(() => snapshotsOf(rec.events).at(-1)?.snapshot.cliState === 'idle', 4000)
      await new Promise((r) => setTimeout(r, 200))
      const baselineCount = snapshotsOf(rec.events).length
      expect(baselineCount).toBeGreaterThan(0)
      const baselineV = snapshotsOf(rec.events).at(-1)!.snapshot.v

      // 8 batches of assistant text across ~1.2s = ≥8 tailer polls, each
      // calling pushSnapshot. None of these lines changes the assembled
      // snapshot — only `v` moves.
      for (let i = 0; i < 8; i++) {
        appendLines(sid, [assistantFlood(), assistantFlood()])
        await new Promise((r) => setTimeout(r, 150))
      }
      await new Promise((r) => setTimeout(r, 300))
      // The daemon HAS consumed them (v moved) but pushed nothing.
      const afterFlood = await rpc(ws, { cmd: 'getState', sid })
      expect((afterFlood.snapshot as SessionSnapshot).v,
        'tailer never consumed the flood — test would be vacuous').toBeGreaterThan(baselineV)
      expect(snapshotsOf(rec.events).length,
        'snapshot pushed for lines that changed nothing but v (change-compare bypassed)').toBe(baselineCount)

      // A real state change pushes exactly once more.
      appendLines(sid, [stateLine('running')])
      await waitFor(() => snapshotsOf(rec.events).length > baselineCount, 4000)
      await new Promise((r) => setTimeout(r, 300))
      const snaps = snapshotsOf(rec.events)
      expect(snaps.length, 'a real state change must push exactly once').toBe(baselineCount + 1)
      expect(snaps.at(-1)!.snapshot.turnActive).toBe(true)
      expect(snaps.at(-1)!.snapshot.v).toBe(fs.statSync(jsonlPath).size)
      rec.stop()
    } finally {
      await rpc(ws, { cmd: 'stop', sid }).catch(() => {})
      ws.close()
    }
  }, 30_000)
})

// ── Scenario 9: daemon restart rebuilds foldState from the jsonl ──
// A SIGKILLed daemon runs no cleanup, so its successor adopts the still-live
// CLI from sessions.json. Contract §4 "Rebuild": the adopt path must stream the
// whole stream file back through foldLine — otherwise a mid-turn session comes
// back as turnActive=false and walnut projects a running session as idle
// (exactly the class of permanent status mismatch C1 exists to remove).
describe('C1 snapshot wiring — daemon restart (SIGKILL) rebuilds foldState on adopt', () => {
  // Each restart scenario gets its OWN daemon+streams dir pair. Sharing them
  // across scenarios is not safe here: a scenario's successor daemon is still
  // alive when the next one starts, so the next "daemon A" loses the pid-file
  // race and the session is served by the wrong generation — which silently
  // routes around the registry-adopt path these tests exist to exercise.
  const dirs: string[] = []
  function freshDirs(): { daemonDir: string; streamsDir: string } {
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapwire-restart-'))
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapwire-restart-streams-'))
    dirs.push(daemonDir, streamsDir)
    return { daemonDir, streamsDir }
  }
  const spawned: ChildProcess[] = []

  function spawnDaemon(daemonDir: string, streamsDir: string): Promise<{ proc: ChildProcess; port: number }> {
    const proc = spawn('node', [scriptPath, '--start'], {
      env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: streamsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    spawned.push(proc)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
      proc.stdout!.on('data', (chunk: Buffer) => {
        const m = chunk.toString().match(/^\d+$/m)
        if (m) { clearTimeout(t); resolve({ proc, port: parseInt(m[0], 10) }) }
      })
      proc.on('error', (err) => { clearTimeout(t); reject(err) })
      proc.on('exit', (code) => { clearTimeout(t); reject(new Error('daemon exited early: ' + code)) })
    })
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`)
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
      w.once('open', () => { clearTimeout(t); resolve(w) })
      w.once('error', (e) => { clearTimeout(t); reject(e) })
    })
  }

  afterAll(async () => {
    for (const p of spawned) {
      if (p.exitCode === null) {
        p.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {}; resolve() }, 5000)
          p.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
    }
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith('.pgid')) continue
          const pid = parseInt(fs.readFileSync(path.join(d, f), 'utf-8').trim(), 10)
          if (pid > 0) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
        }
      } catch {}
    }
    for (const d of dirs) {
      try { await fsp.rm(d, { recursive: true, force: true }) } catch {}
    }
  }, 20_000)

  it('a mid-turn session adopted by a fresh daemon still reports turnActive=true', async () => {
    const sid = `snap-restart-${Date.now()}`
    const { daemonDir, streamsDir: STREAMS_A } = freshDirs()
    // ── Daemon A: open a turn and leave it open (no result line) ──
    const a = await spawnDaemon(daemonDir, STREAMS_A)
    let wsA = await connect(a.port)
    const startRes = await rpc(wsA, { cmd: 'start', sid, args: ['/bin/sleep', '120'], cwd: os.tmpdir(), message: 'hello' })
    expect(startRes.ok).toBe(true)
    fs.appendFileSync(path.join(STREAMS_A, sid + '.jsonl'), userLine('mid-turn, never finished') + '\n')
    const openBeforeKill = await waitFor(async () => {
      const st = await rpc(wsA, { cmd: 'getState', sid })
      return (st.snapshot as SessionSnapshot)?.turnActive === true
    }, 5000)
    expect(openBeforeKill, 'daemon A never saw the turn open').toBe(true)
    wsA.close()

    // ── Kill daemon A with SIGKILL: no cleanup(), no registry flush beyond the
    // write-ahead one, CLI process group survives (detached). ──
    a.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000)
      a.proc.once('exit', () => { clearTimeout(t); resolve() })
    })

    // ── Daemon B on the SAME dirs: reconcileRegistry adopts the live session ──
    const b = await spawnDaemon(daemonDir, STREAMS_A)
    const wsB = await connect(b.port)
    try {
      const st = await rpc(wsB, { cmd: 'getState', sid })
      expect(st.ok).toBe(true)
      expect(st.exists, 'daemon B did not adopt the session from sessions.json').toBe(true)
      expect(st.alive).toBe(true)
      const snap = st.snapshot as SessionSnapshot
      expect(snap, 'adopted session must carry a snapshot').toBeTruthy()
      expect(snap.turnActive,
        'adopt path did not rebuild foldState from the jsonl — a mid-turn session came back idle').toBe(true)
      expect(snap.cliState).toBe('running')
      expect(snap.v).toBe(fs.statSync(path.join(STREAMS_A, sid + '.jsonl')).size)
    } finally {
      await rpc(wsB, { cmd: 'stop', sid }).catch(() => {})
      wsB.close()
    }
  }, 60_000)

  // C3+C7: same restart, but daemon A dies while the stream file has a TORN tail
  // (the CLI was mid-write). The registry-adopt path must (a) not fold the
  // fragment and (b) seed daemon B's watcher from the rebuild's complete-line
  // boundary — otherwise the completed line is never folded whole and the
  // session is wedged at turnActive=true for the rest of its life.
  it('adopts a session whose stream file is TORN and converges when the line completes', async () => {
    const sid = `snap-restart-torn-${Date.now()}`
    const { daemonDir, streamsDir: STREAMS_A } = freshDirs()
    const jsonlPath = path.join(STREAMS_A, sid + '.jsonl')
    const a = await spawnDaemon(daemonDir, STREAMS_A)
    const wsA = await connect(a.port)
    const startRes = await rpc(wsA, { cmd: 'start', sid, args: ['/bin/sleep', '120'], cwd: os.tmpdir(), message: 'hello' })
    expect(startRes.ok).toBe(true)

    // Open a turn, let daemon A fold the anchor, then tear a result line.
    const anchor = userLine('turn torn across the restart')
    fs.appendFileSync(jsonlPath, anchor + '\n')
    const boundary = fs.statSync(jsonlPath).size
    const sawAnchor = await waitFor(async () => {
      const st = await rpc(wsA, { cmd: 'getState', sid })
      return (st.snapshot as SessionSnapshot)?.v === boundary
    }, 6000)
    expect(sawAnchor, 'daemon A never reached the anchor boundary').toBe(true)
    const result = resultLine()
    const half = Math.floor(result.length / 2)
    fs.appendFileSync(jsonlPath, result.slice(0, half))
    wsA.close()

    a.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000)
      a.proc.once('exit', () => { clearTimeout(t); resolve() })
    })

    const b = await spawnDaemon(daemonDir, STREAMS_A)
    const wsB = await connect(b.port)
    try {
      // Daemon B adopted from sessions.json. Its rebuild must stop at the
      // complete-line boundary — NOT swallow the fragment.
      const adopted = await waitFor(async () => {
        const st = await rpc(wsB, { cmd: 'getState', sid })
        return st.exists === true && !!st.snapshot
      }, 8000)
      expect(adopted, 'daemon B did not adopt the session').toBe(true)
      const snap = (await rpc(wsB, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(snap.v,
        'adopt rebuild folded the torn fragment — v advanced past the real line end').toBe(boundary)
      expect(snap.turnActive).toBe(true)
      expect(snap.lastResult, 'a torn result must not count as a verdict').toBe(null)

      // Attach (what walnut does right after a daemon restart) — this is what
      // starts daemon B's watcher, at the offset the adopt seeded. If that seed
      // were a raw stat().size it would sit MID-LINE, and the completed result
      // would be read from its middle: unparseable, so never folded, and the
      // turn wedges at turnActive=true forever.
      const attached = await rpc(wsB, { cmd: 'attach', sid, fromOffset: boundary })
      expect(attached.ok).toBe(true)
      expect(attached.alive).toBe(true)
      expect(attached.currentOffset,
        'attach handed out a mid-line offset').toBe(boundary)

      // Complete the line + settle. Daemon B's watcher re-reads the torn region
      // from the boundary, so the whole line folds exactly once.
      fs.appendFileSync(jsonlPath, result.slice(half) + '\n' + stateLine('idle') + '\n')
      const settled = await waitFor(async () => {
        const s = (await rpc(wsB, { cmd: 'getState', sid })).snapshot as SessionSnapshot | undefined
        return !!s && s.turnActive === false
      }, 8000)
      const final = (await rpc(wsB, { cmd: 'getState', sid })).snapshot as SessionSnapshot
      expect(settled,
        'the completed result line was lost at the adopt boundary — the torn-line wedge is back').toBe(true)
      expect(final.lastResult,
        'the completed result was read from mid-line (unparseable) — the adopt seed was not a boundary').toMatchObject({ isError: false })
      expect(final.v).toBe(fs.statSync(jsonlPath).size)
    } finally {
      await rpc(wsB, { cmd: 'stop', sid }).catch(() => {})
      wsB.close()
    }
  }, 60_000)
})

// ── Scenario 11: appendUserMarker overlay must not race the CLI ──
// Contract §4 "Feed": the marker is folded at the CURRENT foldState.v with NO v
// advance. Using the post-append file size instead is a real race — the CLI
// appends concurrently, so a line can land between appendFileSync and statSync,
// making that size INFLATED past the raced line. foldState.v would jump over it
// and the tailer's `v > foldState.v` guard would skip that result/idle FOREVER.
// Driven through the real daemon-core handler with an fs whose appendFileSync
// deterministically injects the racing CLI write.
describe('C1 appendUserMarker overlay (real daemon-core, injected CLI race)', () => {
  it('a result line that lands during the marker append is still folded by the tailer', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-marker-race-'))
    try {
      const sid = 'marker-race'
      const jsonlPath = path.join(tmp, sid + '.jsonl')
      const racedResult = resultLine()
      // Pre-existing content the tailer has already folded.
      const init = jline({ type: 'system', subtype: 'init' })
      fs.writeFileSync(jsonlPath, init + '\n')
      const initEnd = fs.statSync(jsonlPath).size

      // fs proxy: after the daemon's marker append lands, the "CLI" appends its
      // result line — i.e. BEFORE the daemon's statSync observes the size.
      let raced = false
      const racingFs = {
        ...fs,
        appendFileSync: ((p: string, data: string) => {
          fs.appendFileSync(p, data)
          if (!raced && String(data).includes('walnut-injected')) {
            raced = true
            fs.appendFileSync(p, racedResult + '\n')
          }
        }) as typeof fs.appendFileSync,
      } as unknown as typeof fs

      const session = {
        pid: 999, pipePath: path.join(tmp, sid + '.pipe'), jsonlPath,
        pgidPath: path.join(tmp, sid + '.pgid'), state: 'running' as const,
        exitCode: null, exitReason: null, exitedAt: null, parented: true,
        startTime: '1', cwd: tmp, args: [], orphanPollTimer: null,
        mode: 'default' as const, pendingCtrl: null,
        foldState: foldLine(initialFoldState(0), init, initEnd),
      }
      const sessions = new Map([[sid, session]])
      const core = createDaemonCore<typeof session>({
        fs: racingFs,
        clock: () => 1_700_000_000_000,
        killFn: () => {},
        readStartTimeFn: () => null,
        killProcessGroupFn: () => true,
        streamsDir: tmp,
        registryFile: path.join(tmp, 'sessions.json'),
        logger: () => {},
        broadcastSessionStateFn: () => {},
        broadcastExitToWatchersFn: () => {},
        sessions,
        createAdoptedSession: () => session,
        // Same overlay the standalone injects (parity-locked).
        foldAppendedLineFn: (s, rawLine) => {
          s.foldState = foldLine(s.foldState, rawLine, s.foldState.v)
        },
      })

      const res = core.handleAppendUserMarker(sid, 'second send', 'qm-race-1')
      expect(res).toMatchObject({ ok: true })
      expect(raced, 'the injected CLI race did not fire — test would be vacuous').toBe(true)
      // The overlay anchored the turn WITHOUT advancing v past unread bytes.
      expect(session.foldState.turnActive).toBe(true)
      expect(session.foldState.v,
        'marker overlay advanced v past bytes the tailer has not read yet').toBe(initEnd)

      // Now replay the tailer over everything after initEnd, guard included.
      const rest = fs.readFileSync(jsonlPath, 'utf-8').slice(initEnd)
      const skipped: string[] = []
      let lineStartV = initEnd
      for (const line of rest.split('\n')) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1
        lineStartV = v
        if (!line.trim()) continue
        if (v > session.foldState.v) session.foldState = foldLine(session.foldState, line, v)
        else skipped.push(line)
      }
      expect(skipped.filter((l) => l.includes('"result"')),
        'the raced result line was skipped by the v guard — marker overlay inflated v').toEqual([])
      // With the result folded, a trailing idle settles the turn.
      const idle = stateLine('idle')
      const idleV = fs.statSync(jsonlPath).size + Buffer.byteLength(idle, 'utf-8') + 1
      session.foldState = foldLine(session.foldState, idle, idleV)
      expect(session.foldState.lastResult).toMatchObject({ isError: false })
      expect(session.foldState.turnActive, 'turn never settled — the result was lost').toBe(false)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
})

// ── Scenario 10: push plumbing at unit level (no daemon, no file IO) ──
// The 100ms tailer poll makes sub-50ms bursts unreachable through the real
// path, so the coalescer's core promise — two pushes inside one window collapse
// into ONE wire frame carrying the LATEST state — is exercised by evaluating the
// template's OWN pushSnapshot/emitSnapshot/snapshotDiffers text with stub deps.
// (The standalone twin's identical shape is locked by the parity suite.)
describe('C1 snapshot push plumbing (template source, stubbed deps)', () => {
  interface FakeWs { readyState: number }
  interface Frame { ev: string; payload: Record<string, unknown> }
  interface Harness {
    pushSnapshot: (sid: string, immediate: boolean) => void
    sessions: Map<string, Record<string, unknown>>
    frames: Frame[]
  }

  /** Extract + evaluate the contiguous snapshot-push block from the template. */
  function loadHarness(): Harness {
    const src = fs.readFileSync(new URL('../../src/providers/daemon-source.ts', import.meta.url), 'utf-8')
    const coalesce = src.match(/const SNAPSHOT_COALESCE_MS = \d+;/)
    expect(coalesce, 'SNAPSHOT_COALESCE_MS declaration not found in the template').toBeTruthy()
    const start = src.indexOf('function assembleSessionSnapshot')
    const end = src.indexOf('// ── Startup reconcile')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    // The block lives inside a JS template literal; anything escaped there would
    // not survive a raw eval. Assert it is escape-free rather than guess.
    expect(block.includes('${'), 'extracted block contains template interpolation').toBe(false)
    expect(block.includes('\\'), 'extracted block contains backslash escapes').toBe(false)
    expect(block).toContain('function pushSnapshot')
    expect(block).toContain('function emitSnapshot')
    // snapshotDiffers is no longer part of this block — it moved into
    // daemon-fold.ts and rides the placeholder injection (C19), so it comes in
    // as a binding here exactly the way the assembled template supplies it.
    expect(block, 'snapshotDiffers must not be re-declared in the template block')
      .not.toContain('function snapshotDiffers')
    expect(block).toContain('snapshotDiffers(prev, snapshot)')

    const frames: Frame[] = []
    const sessions = new Map<string, Record<string, unknown>>()
    const sendEvent = (_ws: FakeWs, ev: string, payload: Record<string, unknown>) => { frames.push({ ev, payload }) }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'sessions', 'sendEvent', 'assembleSnapshot', 'snapshotDiffers', 'SNAPSHOT_COALESCE_MS',
      `${block}\nreturn { pushSnapshot, emitSnapshot };`,
    ) as (
      s: Map<string, Record<string, unknown>>,
      se: typeof sendEvent,
      as: typeof assembleSnapshot,
      sd: typeof snapshotDiffers,
      ms: number,
    ) => { pushSnapshot: (sid: string, immediate: boolean) => void }
    const coalesceMs = parseInt(coalesce![0].match(/\d+/)![0], 10)
    expect(coalesceMs).toBe(50)
    const api = factory(sessions, sendEvent, assembleSnapshot, snapshotDiffers, coalesceMs)
    return { pushSnapshot: api.pushSnapshot, sessions, frames }
  }

  function makeSession(): Record<string, unknown> {
    return {
      foldState: initialFoldState(0),
      pendingCtrl: null,
      state: 'running',
      pid: 4242,
      exitCode: null,
      subscribers: new Set<FakeWs>([{ readyState: 1 }]),
      lastPushedSnapshot: null,
      snapshotTimer: null,
    }
  }

  const fold = (s: Record<string, unknown>, line: string) => {
    const st = s.foldState as ReturnType<typeof initialFoldState>
    s.foldState = foldLine(st, line, st.v + Buffer.byteLength(line, 'utf8') + 1)
  }

  it('coalesces two pushes 5ms apart into ONE frame carrying the LATEST state', async () => {
    const h = loadHarness()
    const sid = 'unit-coalesce'
    const session = makeSession()
    h.sessions.set(sid, session)

    // Push #1: turn open.
    fold(session, userLine('turn one'))
    h.pushSnapshot(sid, false)
    await new Promise((r) => setTimeout(r, 5))
    // Push #2, inside the same 50ms window, with a DIFFERENT state (settled).
    fold(session, resultLine())
    fold(session, stateLine('idle'))
    h.pushSnapshot(sid, false)

    await new Promise((r) => setTimeout(r, 160))
    const pushes = h.frames.filter((f) => f.ev === 'snapshot')
    expect(pushes.length, 'two pushes inside one 50ms window must collapse to a single frame').toBe(1)
    const snap = pushes[0].payload.snapshot as SessionSnapshot
    // Coalescing must deliver the LATEST state, not the state at scheduling time.
    expect(snap.turnActive, 'coalesced frame carried the stale (scheduling-time) state').toBe(false)
    expect(snap.cliState).toBe('idle')
    expect(snap.lastResult).toMatchObject({ isError: false })
  })

  it('immediate=true bypasses the window and cancels a pending coalesce timer', async () => {
    const h = loadHarness()
    const sid = 'unit-immediate'
    const session = makeSession()
    h.sessions.set(sid, session)

    fold(session, userLine('turn one'))
    h.pushSnapshot(sid, false)   // schedules
    session.state = 'dead'
    session.exitCode = 0
    h.pushSnapshot(sid, true)    // death path: must fire NOW and cancel the timer
    let pushes = h.frames.filter((f) => f.ev === 'snapshot')
    expect(pushes.length, 'immediate push did not fire synchronously').toBe(1)
    expect((pushes[0].payload.snapshot as SessionSnapshot).cliState).toBe('dead')

    // The cancelled timer must not fire a duplicate.
    await new Promise((r) => setTimeout(r, 160))
    pushes = h.frames.filter((f) => f.ev === 'snapshot')
    expect(pushes.length, 'the pending coalesce timer was not cancelled').toBe(1)
  })

  it('drops a push whose snapshot differs only by v (no storm)', async () => {
    const h = loadHarness()
    const sid = 'unit-nostorm'
    const session = makeSession()
    h.sessions.set(sid, session)

    fold(session, userLine('turn one'))
    h.pushSnapshot(sid, true)
    expect(h.frames.filter((f) => f.ev === 'snapshot').length).toBe(1)

    // Assistant text only advances v — the assembled snapshot is unchanged.
    for (let i = 0; i < 5; i++) {
      fold(session, assistantFlood())
      h.pushSnapshot(sid, true)
    }
    expect(h.frames.filter((f) => f.ev === 'snapshot').length,
      'v-only advances must not be pushed').toBe(1)

    // A real change pushes again.
    fold(session, resultLine())
    fold(session, stateLine('idle'))
    h.pushSnapshot(sid, true)
    const pushes = h.frames.filter((f) => f.ev === 'snapshot')
    expect(pushes.length).toBe(2)
    expect((pushes[1].payload.snapshot as SessionSnapshot).turnActive).toBe(false)
  })
})

// ── C18: pre-death fold drain (template source, stubbed deps) ──
// The CLI writes its final `result` + companion `idle` microseconds before
// exiting, and the tailer's poll returns early once `state !== 'running'` (which
// reapSession sets FIRST). Without a synchronous drain, the death snapshot — and
// every later getState pull, which just re-assembles the same frozen fold —
// reports turnActive=true for a turn that provably ended on disk.
//
// This runs the TEMPLATE's OWN drainSessionFold/drainFoldRange text against real
// files with stubbed deps, which makes it DETERMINISTIC (the daemon-level
// integration check below can't control the 100ms poll boundary). The standalone
// twin's identical body is locked by the parity suite's normalized byte compare.
describe('C18 pre-death fold drain (template source, real files, stubbed deps)', () => {
  interface DrainApi {
    drainSessionFold: (session: Record<string, unknown>) => void
    drainFoldRange: (session: Record<string, unknown>, from: number, to: number) => number
  }

  function loadDrain(): { api: DrainApi; logs: Array<{ level: string; msg: string }> } {
    const src = fs.readFileSync(new URL('../../src/providers/daemon-source.ts', import.meta.url), 'utf-8')
    const start = src.indexOf('function drainSessionFold')
    const end = src.indexOf('function assembleSessionSnapshot')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block.includes('${'), 'extracted block contains template interpolation').toBe(false)
    expect(block.includes('\\'), 'extracted block contains backslash escapes').toBe(false)
    expect(block).toContain('function drainFoldRange')

    const logs: Array<{ level: string; msg: string }> = []
    const logMsg = (level: string, msg: string) => { logs.push({ level, msg }) }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'fs', 'logMsg', 'foldLine', 'FOLD_REBUILD_CHUNK', 'TAILER_CARRY_MAX',
      `${block}\nreturn { drainSessionFold, drainFoldRange };`,
    ) as (
      f: typeof fs, l: typeof logMsg, fl: typeof foldLine, chunk: number, cap: number,
    ) => DrainApi
    return { api: factory(fs, logMsg, foldLine, 1024 * 1024, 32 * 1024 * 1024), logs }
  }

  it('folds the result + idle the CLI wrote just before exiting (frozen-fold repro)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drain-'))
    try {
      const jsonlPath = path.join(tmp, 'drain.jsonl')
      const anchor = userLine('turn that ends at exit')
      fs.writeFileSync(jsonlPath, anchor + '\n')
      const anchorEnd = fs.statSync(jsonlPath).size

      // The session as reapSession finds it: fold caught up to the anchor, the
      // watcher's published boundary at the same place.
      const session: Record<string, unknown> = {
        jsonlPath,
        offset: anchorEnd,
        watcher: { offset: anchorEnd },
        foldState: foldLine(initialFoldState(0), anchor, anchorEnd),
      }
      expect((session.foldState as ReturnType<typeof initialFoldState>).turnActive).toBe(true)

      // The CLI's dying writes — the tailer never gets a poll for these.
      fs.appendFileSync(jsonlPath, resultLine() + '\n' + stateLine('idle') + '\n')
      const size = fs.statSync(jsonlPath).size

      const { api } = loadDrain()
      api.drainSessionFold(session)

      const folded = session.foldState as ReturnType<typeof initialFoldState>
      expect(folded.turnActive,
        'the drain did not fold the pre-exit result/idle — the death snapshot serves a frozen fold').toBe(false)
      expect(folded.lastResult).toMatchObject({ isError: false })
      expect(folded.v, 'drain must consume every complete byte').toBe(size)
      // The new boundary is re-published so a later pull does not re-read.
      expect(session.offset).toBe(size)
      expect((session.watcher as { offset: number }).offset).toBe(size)

      // Idempotent: a second drain is a no-op (nothing new on disk).
      const before = JSON.parse(JSON.stringify(folded))
      api.drainSessionFold(session)
      expect(session.foldState).toEqual(before)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('leaves a torn trailing fragment unfolded (boundary rule holds in the drain too)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drain-torn-'))
    try {
      const jsonlPath = path.join(tmp, 'drain.jsonl')
      const anchor = userLine('turn torn at exit')
      fs.writeFileSync(jsonlPath, anchor + '\n')
      const anchorEnd = fs.statSync(jsonlPath).size
      const session: Record<string, unknown> = {
        jsonlPath, offset: anchorEnd, watcher: { offset: anchorEnd },
        foldState: foldLine(initialFoldState(0), anchor, anchorEnd),
      }
      // A complete result, then HALF an idle line (the CLI died mid-write).
      const result = resultLine()
      const idle = stateLine('idle')
      fs.appendFileSync(jsonlPath, result + '\n' + idle.slice(0, 12))
      const resultEnd = anchorEnd + Buffer.byteLength(result, 'utf8') + 1

      const { api } = loadDrain()
      api.drainSessionFold(session)

      const folded = session.foldState as ReturnType<typeof initialFoldState>
      expect(folded.lastResult, 'the complete result must fold').toMatchObject({ isError: false })
      expect(folded.v, 'the drain folded the torn fragment — v jumped past the real line end').toBe(resultEnd)
      expect((session.watcher as { offset: number }).offset).toBe(resultEnd)
      // The turn is NOT settled: its companion idle is still torn on disk.
      expect(folded.turnActive).toBe(true)

      // When the idle completes, folding resumes from the boundary and settles.
      fs.appendFileSync(jsonlPath, idle.slice(12) + '\n')
      api.drainSessionFold(session)
      expect((session.foldState as ReturnType<typeof initialFoldState>).turnActive,
        'the completed idle line was lost behind the boundary').toBe(false)
      expect((session.foldState as ReturnType<typeof initialFoldState>).v).toBe(fs.statSync(jsonlPath).size)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('honors the v-monotone guard (already-folded bytes do not fold twice)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drain-guard-'))
    try {
      const jsonlPath = path.join(tmp, 'drain.jsonl')
      const anchor = userLine('anchor')
      const bgStart = jline({ type: 'system', subtype: 'task_started', task_id: 'bg-x' })
      fs.writeFileSync(jsonlPath, anchor + '\n' + bgStart + '\n')
      const size = fs.statSync(jsonlPath).size
      // foldState already at EOF (the tailer DID keep up) — a drain from an older
      // boundary must not re-apply anything.
      let st = foldLine(initialFoldState(0), anchor, Buffer.byteLength(anchor, 'utf8') + 1)
      st = foldLine(st, bgStart, size)
      const session: Record<string, unknown> = {
        jsonlPath, offset: 0, watcher: { offset: 0 }, foldState: st,
      }
      const snapshotBefore = JSON.parse(JSON.stringify(st))
      const { api } = loadDrain()
      api.drainSessionFold(session)
      expect(session.foldState).toEqual(snapshotBefore)
      expect((session.watcher as { offset: number }).offset).toBe(size)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
})

// ── C13: the fold rebuild must cap its carry like the tailer does ──
// A single line larger than the cap can't be assembled. The live tailer
// deliberately DROPS such a line; the rebuild used to re-materialize it via
// repeated Buffer.concat (O(n²) copying) on EVERY rebuild — adopt, attach,
// resume, and every unknown-sid getState pull. The cap + realign is shared now.
// (32MB is impractical to write in a unit test, so the cap is exercised through
// the template's own rebuild text with a small injected cap — the constant
// itself is parity-locked at 32MB.)
describe('C13 fold rebuild carry cap (template source, injected small cap)', () => {
  function loadRebuild(cap: number): {
    rebuild: (p: string) => { state: ReturnType<typeof initialFoldState>; boundary: number }
    logs: Array<{ level: string; msg: string }>
  } {
    const src = fs.readFileSync(new URL('../../src/providers/daemon-source.ts', import.meta.url), 'utf-8')
    const start = src.indexOf('function rebuildFoldStateFromJsonl')
    const end = src.indexOf('// ── C18: synchronous pre-death fold drain ──')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block.includes('${')).toBe(false)
    expect(block.includes('\\')).toBe(false)
    const logs: Array<{ level: string; msg: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'fs', 'logMsg', 'foldLine', 'initialFoldState', 'FOLD_REBUILD_CHUNK', 'TAILER_CARRY_MAX',
      `${block}\nreturn rebuildFoldStateFromJsonl;`,
    ) as (
      f: typeof fs, l: (lvl: string, m: string) => void, fl: typeof foldLine,
      ifs: typeof initialFoldState, chunk: number, c: number,
    ) => (p: string) => { state: ReturnType<typeof initialFoldState>; boundary: number }
    const rebuild = factory(
      fs, (level, msg) => { logs.push({ level, msg }) },
      foldLine, initialFoldState, 4096, cap,
    )
    return { rebuild, logs }
  }

  it('drops an over-cap line, logs it, and realigns so later lines keep their true v', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-rebuild-cap-'))
    try {
      const p = path.join(tmp, 'whale.jsonl')
      const anchor = userLine('turn with a whale line')
      // One 256KB line (over the injected 64KB cap), then the turn-end lines.
      const whale = jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] } })
      const content = anchor + '\n' + whale + '\n' + resultLine() + '\n' + stateLine('idle') + '\n'
      fs.writeFileSync(p, content)

      const { rebuild, logs } = loadRebuild(64 * 1024)
      const out = rebuild(p)
      expect(logs.some((l) => l.msg.includes('fold rebuild carry overflow')),
        'the rebuild did not cap its carry — an over-cap line is re-concatenated (O(n^2))').toBe(true)
      // The dropped whale changes no fold state (it is an assistant text line),
      // and the realign keeps the LATER lines folding correctly.
      expect(out.state.lastResult,
        'realign failed — the lines after the dropped whale were lost').toMatchObject({ isError: false })
      expect(out.state.turnActive).toBe(false)
      // The boundary still equals the true file size (every byte accounted for).
      expect(out.boundary).toBe(Buffer.byteLength(content, 'utf8'))
      expect(out.state.v).toBe(out.boundary)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('an under-cap whale line still folds normally (the cap is not over-eager)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-rebuild-cap2-'))
    try {
      const p = path.join(tmp, 'ok.jsonl')
      // A 32KB result line under a 64KB cap, spanning several 4KB read chunks.
      const bigResult = jline({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'y'.repeat(32 * 1024) })
      const content = userLine('turn') + '\n' + bigResult + '\n' + stateLine('idle') + '\n'
      fs.writeFileSync(p, content)
      const { rebuild, logs } = loadRebuild(64 * 1024)
      const out = rebuild(p)
      expect(logs.filter((l) => l.msg.includes('overflow'))).toEqual([])
      expect(out.state.lastResult).toMatchObject({ isError: false })
      expect(out.state.turnActive).toBe(false)
      expect(out.boundary).toBe(Buffer.byteLength(content, 'utf8'))
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('C1 getDaemonSource deploy-time validation', () => {
  it('assembled template has no fold placeholder residue and parses', () => {
    const src = getDaemonSource()
    for (const ph of ['__FOLD_LINE__', '__INITIAL_FOLD_STATE__', '__ASSEMBLE_SNAPSHOT__', '__DAEMON_VERSION__', '__DAEMON_CAPABILITIES__']) {
      expect(src.includes(ph), `placeholder residue: ${ph}`).toBe(false)
    }
    // The injected daemon must advertise snapshot-v1 in its hello caps
    // (JSON.stringify → double quotes).
    expect(src).toContain('"snapshot-v1"')
    // Injected function text parses under strict mode in a bare scope.
    for (const m of [/const foldLine = (function foldLine[\s\S]*?)\nconst initialFoldState =/]) {
      const hit = src.match(m)
      expect(hit, 'injected foldLine body not found in template').toBeTruthy()
    }
  })

  it('injected functions survive strict reconstruction + smoke fold (validateFoldInjection passes)', () => {
    expect(() => validateFoldInjection([
      ['__FOLD_LINE__', foldLine.toString()],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ])).not.toThrow()
  })

  it('corrupt injection throws (never deploy a corrupt daemon)', () => {
    // Simulates a bundler-mangled toString: a captured module-scope helper.
    const corrupt = 'function foldLine(s, l, v) { return __name(s, "x") }'
    expect(() => validateFoldInjection([
      ['__FOLD_LINE__', corrupt],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ])).toThrow(/corrupt daemon|reconstruction/)

    // Non-function injection throws too.
    expect(() => validateFoldInjection([
      ['__FOLD_LINE__', '42'],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ])).toThrow(/did not evaluate to a function/)

    // Semantically wrong function (parses, but the smoke fold disagrees) throws.
    const wrong = 'function foldLine(s, l, v) { return s }' // never advances v / never folds
    expect(() => validateFoldInjection([
      ['__FOLD_LINE__', wrong],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ])).toThrow(/smoke fold/)
  })
})
