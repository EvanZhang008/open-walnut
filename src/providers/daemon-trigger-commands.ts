/**
 * walnut-trigger, the other commands: triggers.test (one run that touches no state), triggers.run
 * (a run now), triggers.claim and triggers.ack (a server takes and records its fires), and
 * triggers.state.snapshot / triggers.state.seed (a trigger's memory moved between daemons).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts) over the trigger store
 * and runs (daemon-trigger-store.ts, daemon-trigger-runs.ts); its dispatcher calls the commands,
 * its offline host runTriggerTest, its Demo quiesce counts triggerTestsRunning. The code is the
 * runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ackFire, buildCheckStdin, checkErrorOf, claimFires, clampTimeoutSeconds, decideCheck, emptyHostState, markHostDelivered, newItemsOf, parseCheckStdout, runCheckProcess, triggerStateFileName, MIN_EVERY_MS, checkCallerEnv, testCheckCaller, type CheckCaller, type CheckCallers, type TriggerCheckSpec, type TriggerDef, type TriggersTestResult } from './trigger-check-core.js'
import { takeTriggerStateSnapshot } from './trigger-state-snapshot-core.js'
import { seedTriggerState } from './trigger-state-seed-core.js'
import type { ClockHostStart } from './clock-host-start-core.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { ArmedTrigger, TriggerSocket, createDaemonTriggerStore } from './daemon-trigger-store.js'
import type { createDaemonTriggerRuns } from './daemon-trigger-runs.js'
import type { DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonTriggerCommandsDeps<W extends TriggerSocket> extends DaemonReplies<W> {
  triggerStore: ReturnType<typeof createDaemonTriggerStore<W>>
  triggerRuns: ReturnType<typeof createDaemonTriggerRuns>
  /** A stopping Demo starts no test. */
  demoQuiesce: { readonly fenced: boolean }
  /** A test the server asked for a task's session acts for that task (trigger-caller-v1). */
  checkCallers: CheckCallers
  GATEWAY_SOCK_PATH: string
  GATEWAY_SHIM_DIR: string
  /** A routine's run this host started already (clock-host-start-v1). */
  clockHostStart: Pick<ClockHostStart, 'startedRun'>
  /** Each Walnut's own dir under the runtime's (one set per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  /** Refuses (and answers) a command that names a Walnut this socket does not speak for. */
  refuseForeignHome: (ws: W, id: number, cmd: Record<string, unknown>, what: string) => boolean
  logMsg: DaemonLog
}

export function createDaemonTriggerCommands<W extends TriggerSocket>(deps: DaemonTriggerCommandsDeps<W>) {
  const { triggerStore, triggerRuns, demoQuiesce, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, clockHostStart, walnutScope, gatewayClientHomes, refuseForeignHome, logMsg, sendOk, sendError } = deps
  const { TRIGGER_STATE_DIR, armedTriggers, drainingTriggers, hostDeliveriesInFlight, triggerChecksRunning, triggerScopes, triggersConfigureGate, triggerKey, heldTrigger, triggerFor, triggerStateDirOf, triggerStatePath, persistTriggerState, persistTriggersFile, triggerOwnerOf } = triggerStore
  const { checkRunFence, runClock, runTrigger } = triggerRuns

  const TRIGGER_STDOUT_TAIL = 2_000
  /**
   * A test runs arbitrary shell on this host with no state to serialize it, so the
   * only thing standing between an impatient form (or a loop in a script) and a
   * fork bomb is this ceiling.
   */
  const TRIGGER_TEST_MAX_CONCURRENT = 4

  let triggerTestsRunning = 0

  /**
   * Which trigger a command is about. The trigger id rides `triggerId`, never
   * `id`: the frame's `id` is the RPC correlation slot, and a client that puts a
   * string there loses the reply (the caller keys its pending map by number), so
   * a trigger id sent as `id` cannot reach this daemon at all.
   */
  function triggerIdOf(cmd: Record<string, unknown>): string {
    return typeof cmd.triggerId === 'string' ? cmd.triggerId : ''
  }

  /**
   * The Walnut a run, ack, claim or test is about: the home it names, else the one
   * this socket configured triggers for. Null (and refused) when it names a Walnut
   * this socket does not speak for.
   */
  function triggerCommandHome(ws: W, id: number, cmd: Record<string, unknown>, what: string): string | null {
    const bound = gatewayClientHomes.get(ws) ?? (ws.data?.triggerScope || undefined)
    if (walnutScope.foreign(cmd, bound)) {
      sendError(ws, id, `${what}: this socket speaks for another Walnut`)
      return null
    }
    return walnutScope.askedHome(cmd) || ws.data?.triggerScope || ''
  }

  /** Run once and answer; NEVER touch stored state (the form's Test button). */
  async function cmdTriggersTest(ws: W, id: number, cmd: Record<string, unknown>) {
    const home = triggerCommandHome(ws, id, cmd, 'triggers.test')
    if (home === null) return
    try {
      const result = await runTriggerTest(cmd.check, triggerIdOf(cmd) || undefined, home, testCheckCaller(cmd.checkCaller))
      sendOk(ws, id, { result: result as unknown as Record<string, unknown> })
    } catch (err) {
      sendError(ws, id, (err as Error).message)
    }
  }

  /** One test run (triggers.test, and trigger_test while the Walnut is away); rejects with the refusal. */
  async function runTriggerTest(check: unknown, targetId: string | undefined, home = '', checkCaller?: CheckCaller): Promise<TriggersTestResult> {
    const raw = check as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object' || typeof raw.run !== 'string' || !raw.run.trim()) {
      throw new Error('triggers.test: check.run is required')
    }
    const spec: TriggerCheckSpec = {
      run: raw.run,
      ...(typeof raw.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
      timeoutSeconds: clampTimeoutSeconds(raw.timeoutSeconds),
    }
    if (demoQuiesce.fenced) throw new Error('triggers.test: Demo is stopping; no check starts')
    if (triggerTestsRunning >= TRIGGER_TEST_MAX_CONCURRENT) {
      throw new Error(`triggers.test: too many concurrent tests (max ${TRIGGER_TEST_MAX_CONCURRENT})`)
    }
    triggerTestsRunning += 1
    try {
      const now = Date.now()
      const held = targetId ? triggerFor(home, targetId) : undefined
      const entry = held && armedTriggers.get(triggerKey(held.home, held.def.id)) === held ? held : undefined
      const state = entry ? entry.state : emptyHostState(now)
      // A test the server asked for a task's session acts for that task, as the trigger will.
      const caller = checkCaller ? checkCallers.mint(checkCaller) : null
      const proc = await runCheckProcess(spec, buildCheckStdin(state, now), {
        env: {
          WALNUT_TRIGGER_ID: entry ? entry.def.id : (targetId ?? 'trigger-test'),
          WALNUT_TRIGGER_NAME: entry ? entry.def.name : 'trigger test',
          ...(caller ? checkCallerEnv(caller.sid, GATEWAY_SOCK_PATH) : {}),
        },
        templateShimDir: GATEWAY_SHIM_DIR,
        ...checkRunFence(),
      }).finally(() => caller?.release())
      const parsed = parseCheckStdout(proc.stdout)
      const error = checkErrorOf(proc, parsed)
      const output = parsed.ok ? parsed.output : null
      // Synthetic def for the decision: a test never consults the real cadence, and
      // an unarmed check has no limits of its own yet.
      const def: TriggerDef = entry && entry.def.check ? entry.def : { id: targetId ?? 'trigger-test', name: 'trigger test', everyMs: MIN_EVERY_MS, check: spec }
      const result: TriggersTestResult = {
        ok: !error,
        exitCode: proc.exitCode,
        durationMs: proc.durationMs,
        stdoutTail: proc.stdout.slice(-TRIGGER_STDOUT_TAIL),
        stderrTail: proc.stderrTail,
        parsed: output,
        error,
        wouldFire: !!output && decideCheck(def, output, state, now).kind === 'fire',
        newItemCount: output ? newItemsOf(output.items, state).length : 0,
      }
      // A test is a human pressing a button on host data, so it is worth one line:
      // "the check the form showed me was fine" is otherwise unverifiable later.
      logMsg('info', 'trigger test', {
        run: spec.run.slice(0, 200), cwd: spec.cwd, exitCode: proc.exitCode,
        durationMs: proc.durationMs, ok: result.ok,
      })
      return result
    } finally {
      triggerTestsRunning -= 1
    }
  }

  /**
   * Start the run and answer NOW. Awaiting it made a long check fail its own RPC:
   * a 90s check under the caller's 60s deadline reported an error to the user while
   * the fire landed anyway. The outcome travels as trigger.fired / trigger.checked,
   * exactly as it does for a clock-driven run.
   */
  function cmdTriggersRun(ws: W, id: number, cmd: Record<string, unknown>) {
    const home = triggerCommandHome(ws, id, cmd, 'triggers.run')
    if (home === null) return
    const tid = triggerIdOf(cmd)
    const held = tid ? triggerFor(home, tid) : undefined
    const entry = held && armedTriggers.get(triggerKey(held.home, tid)) === held ? held : undefined
    if (!entry) return sendError(ws, id, 'triggers.run: unknown trigger: ' + tid)
    if (entry.def.clock) return sendOk(ws, id, { ran: true, started: true, outcome: runClock(entry, true) })
    if (entry.running) return sendOk(ws, id, { ran: false, reason: 'running' })
    void runTrigger(entry).catch((err) => {
      logMsg('error', 'trigger run threw', { id: entry.def.id, error: (err as Error).message })
    })
    return sendOk(ws, id, { ran: true, started: true })
  }

  /**
   * triggers.state.snapshot (trigger-state-snapshot-v1): the exact host state of ONE
   * trigger its Walnut already disarmed, with no check or fire in flight, read from
   * that Walnut's own state file and never written (trigger-state-snapshot-core.ts
   * holds every rule). Runs behind any configure in flight. Every refusal is an ok
   * reply `{supported: false, reason}`, so a caller that cannot freeze moves on.
   */
  function cmdTriggersStateSnapshot(ws: W, id: number, cmd: Record<string, unknown>) {
    return triggersConfigureGate.run('triggers.configure', async () => {
      const home = walnutScope.askedHome(cmd)
      const reply = takeTriggerStateSnapshot({
        fs,
        nowMs: Date.now(),
        request: {
          askedHome: home,
          triggerId: cmd.triggerId,
          socketTriggerScope: ws.data?.triggerScope,
          socketGatewayHome: gatewayClientHomes.get(ws),
          configuredIds: home && triggerScopes.has(home) ? triggerScopes.get(home)!.configured.map((def) => def.id) : undefined,
          unnamedConfiguredIds: (triggerScopes.get('')?.configured ?? []).map((def) => def.id),
        },
        liveFacts: (h, tid) => {
          const key = triggerKey(h, tid)
          return {
            armed: armedTriggers.has(key),
            draining: drainingTriggers.has(key),
            heldUnnamed: !!heldTrigger('', tid),
            checkRunning: [...triggerChecksRunning].some((e) => e.def.id === tid && (e.home === h || e.home === '')),
            hostDeliveryInFlight: hostDeliveriesInFlight.has(key) || hostDeliveriesInFlight.has(triggerKey('', tid)),
          }
        },
        statePath: (h, tid) => triggerStatePath(h, tid),
        sharedCopyMtimeMs: (tid) => {
          try {
            const st = fs.lstatSync(path.join(TRIGGER_STATE_DIR, triggerStateFileName(tid)))
            return st.isFile() ? st.mtimeMs : undefined
          } catch { return undefined }
        },
      })
      logMsg('info', 'trigger state snapshot', {
        id: typeof cmd.triggerId === 'string' ? cmd.triggerId.slice(0, 200) : '', scope: walnutScope.label(home),
        supported: reply.supported, ...(reply.supported ? { seq: reply.state.seq, seen: reply.seenCount } : { reason: reply.reason }),
      })
      sendOk(ws, id, reply as unknown as Record<string, unknown>)
    })
  }

  /**
   * triggers.state.seed (trigger-state-seed-v1): a snapshot's state, taken on another
   * daemon, written as this Walnut's state file of a trigger this daemon does not hold,
   * never over a file (trigger-state-seed-core.ts holds every rule), so the next
   * configure arms it with that seen set and cursor. Runs behind any configure in
   * flight. Every refusal but a foreign home is an ok reply `{seeded: false, reason}`.
   *
   */
  function cmdTriggersStateSeed(ws: W, id: number, cmd: Record<string, unknown>) {
    if (refuseForeignHome(ws, id, cmd, 'triggers.state.seed')) return
    return triggersConfigureGate.run('triggers.configure', async () => {
      const home = walnutScope.askedHome(cmd)
      const reply = seedTriggerState({
        fs,
        askedHome: home,
        triggerId: cmd.triggerId,
        state: cmd.state,
        digest: cmd.digest,
        liveFacts: (h, tid) => {
          const key = triggerKey(h, tid)
          return {
            configured: !!triggerScopes.get(h)?.configured.some((def) => def.id === tid),
            armed: armedTriggers.has(key),
            draining: drainingTriggers.has(key),
            checkRunning: [...triggerChecksRunning].some((e) => e.def.id === tid && e.home === h),
            hostDeliveryInFlight: hostDeliveriesInFlight.has(key),
          }
        },
        stateDir: (h) => triggerStateDirOf(h),
        statePath: (h, tid) => triggerStatePath(h, tid),
        tempTag: `${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
      })
      logMsg('info', 'trigger state seed', {
        id: typeof cmd.triggerId === 'string' ? cmd.triggerId.slice(0, 200) : '', scope: walnutScope.label(home),
        seeded: reply.seeded, ...(reply.seeded ? { seq: reply.seq, seen: reply.seenCount, ...(reply.already ? { already: true } : {}) } : { reason: reply.reason }),
      })
      sendOk(ws, id, reply as unknown as Record<string, unknown>)
    })
  }

  /**
   * A server takes the fires it just received (trigger-claim-v1). From then on
   * only a server delivers them; this host never does. A fire the host already
   * delivered is answered with that delivery, one it is writing right now with
   * `busy` (the server waits for the replay), and a fire this daemon does not hold
   * with `unknown` (acked, trimmed or disarmed: the server's own dedup decides).
   * A socket of another Walnut cannot take a fire of this one's trigger.
   */
  function cmdTriggersClaim(ws: W, id: number, cmd: Record<string, unknown>) {
    const asked = triggerCommandHome(ws, id, cmd, 'triggers.claim')
    if (asked === null) return
    const tid = triggerIdOf(cmd)
    const seqs = Array.isArray(cmd.seqs) ? (cmd.seqs as unknown[]).filter((s): s is number => typeof s === 'number' && Number.isFinite(s)) : []
    const entry = tid ? triggerFor(asked, tid) : undefined
    const inFlight = hostDeliveriesInFlight.get(triggerKey(entry ? entry.home : asked, tid)) ?? new Set<number>()
    const empty = { claimed: [] as number[], unknown: [] as number[], host: [], busy: [] as number[] }
    if (!entry || (typeof cmd.epoch === 'string' && cmd.epoch !== entry.state.epoch)) {
      return sendOk(ws, id, { ...empty, busy: seqs.filter((s) => inFlight.has(s)), unknown: seqs.filter((s) => !inFlight.has(s)) })
    }
    const home = asked || gatewayClientHomes.get(ws)
    const owner = triggerOwnerOf(entry.def)
    if (owner && home && home !== owner) {
      logMsg('warn', 'trigger claim refused: another Walnut', { id: tid, seqs })
      return sendOk(ws, id, { ...empty, foreign: true })
    }
    const marked = markStartedRuns(entry, seqs)
    const { reply, changed } = claimFires(entry.state, seqs, Date.now(), inFlight)
    if (changed || marked) persistTriggerState(entry.home, tid, entry.state)
    return sendOk(ws, id, reply as unknown as Record<string, unknown>)
  }

  /**
   * Fires of a routine whose run this host started already (clock-host-start-v1) but
   * whose mark a daemon death cut (the records were kept, the state was not): marked
   * now, before a server's claim, so the server records the run instead of starting a
   * second one.
   */
  function markStartedRuns(entry: ArmedTrigger, seqs: readonly number[]): boolean {
    const start = entry.def.start
    if (!start) return false
    let changed = false
    for (const f of entry.state.pendingFires) {
      if (!seqs.includes(f.seq) || f.host || f.claimedAt !== undefined || !f.clock) continue
      const run = clockHostStart.startedRun({ id: entry.def.id, start }, f)
      if (!run) continue
      markHostDelivered(entry.state, { atMs: Date.now(), sessionId: run.sid, messageId: run.messageId, seqs: [f.seq], started: true, taskId: run.taskId })
      logMsg('info', 'routine run started here already: a claim gets it back', { id: entry.def.id, seq: f.seq, sid: run.sid })
      changed = true
    }
    return changed
  }

  function cmdTriggersAck(ws: W, id: number, cmd: Record<string, unknown>) {
    const home = triggerCommandHome(ws, id, cmd, 'triggers.ack')
    if (home === null) return
    const tid = triggerIdOf(cmd)
    const seq = typeof cmd.seq === 'number' ? cmd.seq : NaN
    const entry = tid ? triggerFor(home, tid) : undefined
    if (!entry || !Number.isFinite(seq)) return sendOk(ws, id, { acked: false })
    const acked = ackFire(entry.state, seq)
    if (acked) {
      entry.fireSentAt.delete(seq)
      persistTriggerState(entry.home, tid, entry.state)
      // The last fire of a released clock is recorded: nothing of it is left here.
      const key = triggerKey(entry.home, tid)
      if (drainingTriggers.get(key) === entry && entry.state.pendingFires.length === 0) {
        drainingTriggers.delete(key)
        persistTriggersFile(entry.home)
        logMsg('info', 'clock routine drained', { id: tid })
      }
    }
    return sendOk(ws, id, { acked })
  }

  return {
    cmdTriggersTest, runTriggerTest, cmdTriggersRun, cmdTriggersStateSnapshot, cmdTriggersStateSeed, cmdTriggersClaim, cmdTriggersAck,
    /** Tests running now (the Demo quiesce waits for 0). */
    get triggerTestsRunning() { return triggerTestsRunning },
  }
}
