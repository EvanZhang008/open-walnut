/**
 * walnut-trigger, the store: the triggers this host holds for each Walnut (armed and draining),
 * their files (triggers.json per Walnut, one state file per trigger), and how a fire or a check
 * reaches the Walnut's sockets. The runs (daemon-trigger-runs.ts), the set (daemon-trigger-set.ts)
 * and the other commands (daemon-trigger-commands.ts) act on this store.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts); its walnut-scope fold,
 * its Demo quiesce and its offline host read the maps here too. The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PendingFire, TriggerCheckedEvent, TriggerDef, TriggerHostState } from './trigger-check-core.js'
import { checksToResend, settleChecksOnWire, type CheckOnWire, type CheckWireView } from './trigger-unsent-checks.js'
import { DaemonSessionGate } from './daemon-cron-runtime.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { DaemonEnv, DaemonLog, DaemonSendEvent, HostTriggerJudge } from './daemon-module-deps.js'

/** The runtime's socket as the triggers see it: the Walnut it configured triggers for. */
export interface TriggerSocket { data?: { triggerScope?: string; readThroughAt?: number } }

export interface ArmedTrigger {
  /** The Walnut whose set holds it ('' = a push that named none). */
  home: string
  def: TriggerDef
  state: TriggerHostState
  nextRunAtMs: number
  running: boolean
  /**
   * When each pending fire was last put on the wire, by seq. In-memory only: a
   * restarted daemon has no marks and re-sends every pending fire once, which is
   * exactly what at-least-once wants.
   */
  fireSentAt: Map<number, number>
  /** Each kept check report on the wire, by its time (trigger-unsent-checks.ts). In-memory only, as fireSentAt. */
  checksOnWire?: Map<number, CheckOnWire>
  /** When this daemon armed it: fires left from before give the server a fresh grace. */
  armedAtMs: number
}

/**
 * `push`: the hash the server named with the set it last pushed (triggers-probe-v1) and that set
 * as it came, kept on disk. A probe with that name configures it again from the copy, checked by
 * this daemon's own rules as a push would be, so a reconnect or a restart or update of either
 * side sends no set (90 to 350 KB a connection, 2026-11-13).
 */
export interface TriggerScope { configured: TriggerDef[]; hash: string | null; inherited?: boolean; push?: { hash: string; raw: unknown[] } }

export interface DaemonTriggerStoreDeps<W extends TriggerSocket> {
  /** The trigger logic this area runs on (daemon-module-deps.ts HostTriggerJudge), passed in by the runtime. */
  judge: HostTriggerJudge
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  HOME_DIR: string
  /** A service set's runtime: the set and the state live in its state dir. */
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  /** The production daemon dir: the state is kept under HOME, which a reboot keeps. */
  IS_PROD_DAEMON_DIR: boolean
  /** Each Walnut's own dir under the runtime's (one set per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  /** The runtime's sockets, and which are a Walnut server's (a fire goes only to those). */
  wsClients: ReadonlySet<W>
  isServerClient: (ws: W) => boolean
  sendEvent: DaemonSendEvent<W>
  logMsg: DaemonLog
}

export function createDaemonTriggerStore<W extends TriggerSocket>(deps: DaemonTriggerStoreDeps<W>) {
  const { daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, walnutScope, gatewayClientHomes, wsClients, isServerClient, sendEvent, logMsg } = deps
  const { coerceHostState, emptyHostState, triggerStateFileName, TRIGGER_STATE_TTL_MS } = deps.judge

  // ── walnut-trigger: the daemon owns the clock and runs the check ──
  // A trigger is a routine whose `check` is a shell command this host runs on a
  // cadence (docs/plan/walnut-trigger.md). Ownership: daemon = when and whether,
  // server = who and what. The set arrives via triggers.configure and is persisted
  // to triggers.json, so checks keep polling while the server is down or the
  // tunnel flaps; per-trigger dedup/cursor state lives in trigger-state/<id>.json.
  // Fires are at-least-once: each stays in the state's pendingFires until the
  // server sends triggers.ack, and every armed trigger's pending set is replayed
  // after a successful configure (the reconnect path) AND on a slow clock until it
  // is acked. Every fire carries (epoch, seq) — the epoch is minted with the state
  // file, so the server can tell a genuinely new numbering from a replay. Trigger
  // events NEVER go to a bridge client — a fire carries host data and only the
  // trusted SSH-tunneled walnut server may receive it. Who delivers a fire is
  // decided HERE: a server claims each fire it receives (triggers.claim), and a
  // fire no server claimed within the grace whose def names a task with a live
  // session of the same Walnut on this host is written into that session by this
  // daemon (deliverUnclaimedFires), then replayed with `host` set so the server
  // only records it.
  //
  // One set per Walnut (walnut-scope-core.ts): a push names its Walnut (`home`) and
  // replaces only that Walnut's set, its fires go only to that Walnut's sockets, and
  // its files sit under walnuts/<key>/. A push with no home (a server older than the
  // split) is the unnamed scope, kept in the files and with the fan-out it always had.
  const TRIGGERS_BASE_DIR = SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR
  const TRIGGERS_FILE = path.join(TRIGGERS_BASE_DIR, 'triggers.json')
  // Each trigger's memory (the ids it reported, its script's state, its unacked
  // fires) must outlive a reboot, and the production runtime dir does not: macOS
  // empties /tmp at boot. On 2026-10-06 one reboot made a watch re-report all eight
  // items it had already reported, run ten hours early, and restart the week its
  // script was counting. So the production daemon keeps it under HOME, beside the
  // streams (the set itself, triggers.json, is re-pushed by the server at every
  // connect). A service daemon keeps its state dir; an isolated dir (tests,
  // ephemeral servers) keeps it inside itself, so nothing crosses between Walnuts.
  // WALNUT_TRIGGER_STATE_DIR is for TESTS ONLY.
  const PROD_TRIGGER_STATE_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'trigger-state')
  const TRIGGER_STATE_DIR = SERVICE_MODE && DAEMON_STATE_DIR
    ? path.join(DAEMON_STATE_DIR, 'trigger-state')
    : daemonEnv.WALNUT_TRIGGER_STATE_DIR || (IS_PROD_DAEMON_DIR ? PROD_TRIGGER_STATE_DIR : path.join(DAEMON_DIR, 'trigger-state'))
  /** Where a trigger's file may sit from before it moved; read once, then moved. */
  const LEGACY_TRIGGER_STATE_DIRS = [...new Set([
    path.join(DAEMON_DIR, 'trigger-state'),
    ...(IS_PROD_DAEMON_DIR ? [PROD_TRIGGER_STATE_DIR] : []),
  ])].filter((dir) => path.resolve(dir) !== path.resolve(TRIGGER_STATE_DIR))
  const TRIGGER_TICK_MS = 5_000

  /** Keyed by triggerKey(home, id), so two Walnuts may even use one id. */
  const armedTriggers = new Map<string, ArmedTrigger>()
  /**
   * Clocks the server took back while fires of theirs were still unacked. No slot
   * runs, but each fire keeps replaying, answers claims and acks, and may still be
   * delivered here, until the server has recorded it: a run the host delivered is
   * the routine's history, one nobody took is the server's to run. triggers.json
   * keeps them, so a restart goes on replaying.
   */
  const drainingTriggers = new Map<string, ArmedTrigger>()

  /** The map key of a Walnut's trigger: the unnamed scope keeps the plain id it always had. */
  function triggerKey(home: string, id: string): string {
    return home ? home + '\u0000' + id : id
  }

  /** The armed or draining entry of a trigger: what replays, claims, acks and host deliveries act on. */
  function heldTrigger(home: string, id: string): ArmedTrigger | undefined {
    const key = triggerKey(home, id)
    return armedTriggers.get(key) ?? drainingTriggers.get(key)
  }

  /**
   * The entry a Walnut's command is about. The unnamed copy an older daemon left
   * (inherited) still fans its fires out to every server, so any Walnut may claim and
   * ack those, as before; the claim's owner check still guards the delivery.
   */
  function triggerFor(home: string, id: string): ArmedTrigger | undefined {
    return heldTrigger(home, id) ?? (home && triggerScopes.get('')?.inherited ? heldTrigger('', id) : undefined)
  }

  /** Every entry whose fires still go to the server (of one Walnut when `home` is given). */
  function fireHolders(home?: string): ArmedTrigger[] {
    const all = [...armedTriggers.values(), ...drainingTriggers.values()]
    return home === undefined ? all : all.filter((e) => e.home === home)
  }
  /**
   * Seqs this host is writing into a session right now, by triggerKey (claims
   * answer `busy`). Keyed by id, not held on the entry: a configure that re-arms
   * the trigger mid-write must not make its fires claimable.
   */
  const hostDeliveriesInFlight = new Map<string, Set<number>>()
  /**
   * The entries whose check process is running right now. Held apart from the maps:
   * a configure that disarms a trigger mid-check deletes its entry from armedTriggers
   * while the script still runs, and triggers.state.snapshot must still see it.
   * runTrigger adds before the spawn and removes in its finally.
   */
  const triggerChecksRunning = new Set<ArmedTrigger>()
  /**
   * Per Walnut: the set as its server last sent it (or as its triggers.json kept it),
   * and that set's hash. What is armed is this set with the pauses, resumes and
   * deletes a session made here while its Walnut was away (offlineHost.triggerHolds),
   * until the server has taken them. `inherited`: the unnamed copy loaded from a file
   * an older daemon wrote (no `scoped` marker), the one global set of whichever Walnut
   * pushed last; the first named push takes over its triggers (takeInheritedTriggers).
   */
  const triggerScopes = new Map<string, TriggerScope>()
  function triggerScopeOf(home: string): TriggerScope {
    let scope = triggerScopes.get(home)
    if (!scope) { scope = { configured: [], hash: null }; triggerScopes.set(home, scope) }
    return scope
  }

  const triggersConfigureGate = new DaemonSessionGate()

  /** Where a Walnut's trigger memory is kept: the unnamed scope keeps the old dir. */
  function triggerStateDirOf(home: string): string {
    return walnutScope.dirFor(TRIGGER_STATE_DIR, home)
  }

  function triggerStatePath(home: string, id: string): string {
    return path.join(triggerStateDirOf(home), triggerStateFileName(id))
  }

  function mtimeOf(file: string): number | undefined {
    try { return fs.statSync(file).mtimeMs } catch { return undefined }
  }

  /** Another named Walnut already keeps the shared copy of this id. */
  function sharedByAnother(home: string, id: string): boolean {
    for (const map of [armedTriggers, drainingTriggers]) {
      for (const e of map.values()) if (e.home && e.home !== home && e.def.id === id && e.state.sharedCopy) return true
    }
    return false
  }

  function readTriggerState(home: string, id: string, nowMs: number): TriggerHostState {
    const own = triggerStatePath(home, id)
    let mine: TriggerHostState | null = null
    try {
      mine = coerceHostState(JSON.parse(fs.readFileSync(own, 'utf-8')), nowMs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return emptyHostState(nowMs)
    }
    // A trigger this Walnut took over keeps the shared copy too, and a downgraded daemon
    // may have run it there since: the newer of the two is its memory. Only while the
    // unnamed set does not run that trigger itself.
    if (mine?.sharedCopy && home && !heldTrigger('', id)) {
      const shared = path.join(TRIGGER_STATE_DIR, triggerStateFileName(id))
      if ((mtimeOf(shared) ?? 0) > (mtimeOf(own) ?? 0) + 1) {
        try {
          const state = coerceHostState(JSON.parse(fs.readFileSync(shared, 'utf-8')), nowMs)
          state.sharedCopy = true
          persistTriggerState(home, id, state)
          logMsg('info', 'trigger state read back from the shared copy', { id, scope: walnutScope.label(home) })
          return state
        } catch { /* unreadable: keep this Walnut's own */ }
      }
    }
    if (mine) return mine
    // Not here yet: an older daemon wrote it to the shared dir (a named Walnut's first
    // push after a reboot left no set to inherit) or to an older dir, and the upgrade
    // itself must not re-fire everything it had reported. The unnamed scope moves it
    // from an older dir, as it always did; a named Walnut copies it, keeps the shared
    // copy current from now on, and leaves it to a Walnut that already does.
    const from = !home ? LEGACY_TRIGGER_STATE_DIRS
      : heldTrigger('', id) || sharedByAnother(home, id) ? [] : [TRIGGER_STATE_DIR, ...LEGACY_TRIGGER_STATE_DIRS]
    for (const dir of from) {
      const legacy = path.join(dir, triggerStateFileName(id))
      let raw: unknown
      try { raw = JSON.parse(fs.readFileSync(legacy, 'utf-8')) } catch { continue }
      const state = coerceHostState(raw, nowMs)
      if (home) state.sharedCopy = true
      persistTriggerState(home, id, state)
      if (!home && fs.existsSync(own)) {
        try { fs.unlinkSync(legacy) } catch {}
        logMsg('info', 'trigger state moved to its durable dir', { id, from: dir, to: triggerStateDirOf(home) })
      }
      return state
    }
    // A new trigger of a named Walnut keeps the shared copy from its first check too, so a
    // downgraded daemon, which reads only the shared dir, remembers what it reported.
    const fresh = emptyHostState(nowMs)
    if (home && !heldTrigger('', id) && !sharedByAnother(home, id)) fresh.sharedCopy = true
    return fresh
  }

  function persistTriggerState(home: string, id: string, state: TriggerHostState): void {
    const file = triggerStatePath(home, id)
    const tmp = file + '.tmp'
    try {
      fs.mkdirSync(triggerStateDirOf(home), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      // In-memory state stays authoritative for this daemon's life; a persist
      // failure only costs the dedup set across a restart, so it must be visible
      // rather than fatal.
      logMsg('warn', 'trigger state persist failed', { id, scope: walnutScope.label(home), error: (err as Error).message })
      try { fs.unlinkSync(tmp) } catch {}
    }
    // The same memory where an older daemon reads it, for the Walnut that took it over.
    if (!home || !state.sharedCopy || heldTrigger('', id)) return
    const shared = path.join(TRIGGER_STATE_DIR, triggerStateFileName(id))
    try {
      fs.mkdirSync(TRIGGER_STATE_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(shared + '.tmp', JSON.stringify({ ...state, sharedCopy: undefined }), { mode: 0o600 })
      fs.renameSync(shared + '.tmp', shared)
      // Same mtime as this Walnut's own, so only an older daemon's later write reads as newer.
      const at = fs.statSync(file)
      fs.utimesSync(shared, at.atime, at.mtime)
    } catch (err) {
      logMsg('warn', 'trigger shared copy write failed', { id, scope: walnutScope.label(home), error: (err as Error).message })
      try { fs.unlinkSync(shared + '.tmp') } catch {}
    }
  }

  /**
   * Reclaim state files nobody owns. Disarming a trigger deliberately does NOT
   * delete its state: a disable-then-enable (or a foreign push that momentarily
   * carries an empty set) would otherwise destroy the dedup set, the script's
   * cursor and every unacked fire, and the recreated file would restart `seq` at 0.
   * Age is what reclaims the directory instead — a file untouched for the seen TTL
   * belongs to a trigger nobody re-armed, and its dedup set has expired anyway.
   * Each Walnut's dir is swept by what that Walnut holds.
   */
  function pruneTriggerStateFiles(nowMs: number): void {
    const held = new Map<string, Set<string>>()
    for (const e of fireHolders()) {
      const dir = triggerStateDirOf(e.home)
      if (!held.has(dir)) held.set(dir, new Set())
      held.get(dir)!.add(triggerStateFileName(e.def.id))
      // A taken-over trigger's shared copy is held too.
      if (e.home && e.state.sharedCopy) {
        if (!held.has(TRIGGER_STATE_DIR)) held.set(TRIGGER_STATE_DIR, new Set())
        held.get(TRIGGER_STATE_DIR)!.add(triggerStateFileName(e.def.id))
      }
    }
    const dirs = [TRIGGER_STATE_DIR, ...walnutScope.scopeDirs(fs, TRIGGER_STATE_DIR).map(([, dir]) => dir)]
    for (const dir of dirs) {
      let names: string[]
      try { names = fs.readdirSync(dir) } catch { continue }
      const armedFiles = held.get(dir) ?? new Set<string>()
      for (const name of names) {
        if (!name.endsWith('.json') || armedFiles.has(name)) continue
        const file = path.join(dir, name)
        try {
          if (nowMs - fs.statSync(file).mtimeMs <= TRIGGER_STATE_TTL_MS) continue
          fs.unlinkSync(file)
          logMsg('info', 'trigger state pruned: unarmed and stale', { file: name, ...(dir !== TRIGGER_STATE_DIR ? { dir } : {}) })
        } catch { /* raced a write, or already gone */ }
      }
    }
  }

  /** A Walnut's triggers.json: the unnamed scope keeps the legacy file. */
  function triggersFileOf(home: string): string {
    return home ? path.join(walnutScope.dirFor(TRIGGERS_BASE_DIR, home), 'triggers.json') : TRIGGERS_FILE
  }

  /**
   * Write one Walnut's set. A named file carries its home (the dir name is a hash);
   * the unnamed one carries `scoped: 1`, which says an older server wrote it after the
   * split, unless it is still the inherited copy (then it stays unmarked, so a restart
   * still hands it to the first named push).
   */
  function persistTriggersFile(home: string): void {
    const file = triggersFileOf(home)
    const tmp = file + '.tmp'
    const scope = triggerScopes.get(home)
    try {
      if (home) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const draining = fireHolders(home).filter((e) => drainingTriggers.get(triggerKey(home, e.def.id)) === e).map((e) => e.def)
      const mark = home ? { home } : scope?.inherited ? {} : { scoped: 1 }
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...mark, triggers: scope?.configured ?? [], ...(draining.length ? { draining } : {}), ...(scope?.push ? { push: scope.push } : {}) }), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      logMsg('warn', 'triggers persist failed (in-memory only)', { scope: walnutScope.label(home), error: (err as Error).message })
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  /**
   * Whether a server socket speaks for `home`'s triggers: the Walnut it configured
   * them for, else the Walnut it bound. The unnamed scope goes, as it always did, to
   * every server socket that did not configure a named set.
   */
  function triggerClientOf(client: W, home: string): boolean {
    const configured = client.data?.triggerScope
    if (configured !== undefined) return configured === home
    return home ? gatewayClientHomes.get(client) === home : true
  }

  /**
   * Trigger events go to EVERY trusted client of the trigger's Walnut; the bridge
   * never sees one. Fanning out rather than picking the first is what makes a second
   * window (or a server that reconnected while the old socket was still draining) see
   * a fire at all; the server dedups on (id, epoch, seq). The inherited unnamed copy
   * fans out to every server, as the one global set always did, since it may be any
   * Walnut's. Returns whether anyone received it.
   */
  function sendTriggerEvent(home: string, ev: 'trigger.fired' | 'trigger.checked', fields: Record<string, unknown>): boolean {
    return sendTriggerEventTo(home, ev, fields).length > 0
  }

  /** The same, naming the sockets it went on. */
  function sendTriggerEventTo(home: string, ev: 'trigger.fired' | 'trigger.checked', fields: Record<string, unknown>): W[] {
    const everyone = !home && triggerScopes.get('')?.inherited === true
    const to: W[] = []
    for (const client of wsClients) {
      if (isServerClient(client) && (everyone || triggerClientOf(client, home))) {
        sendEvent(client, ev, fields)
        to.push(client)
      }
    }
    return to
  }

  const checkWire: CheckWireView = {
    open: (ws) => wsClients.has(ws as W),
    readThrough: (ws) => (ws as W).data?.readThroughAt,
  }

  /**
   * A check report on the wire: kept until a socket it went on answers a later ping, then dropped
   * (settleChecks); `to` none = no server took it, kept to send again. `ws`: to that socket only (a
   * configure's replay), else to every server of the trigger's Walnut. A report already on other open
   * sockets stays on them too, from this send on.
   */
  function sendCheck(entry: ArmedTrigger, fields: Record<string, unknown> & { atMs: number }, now: number, ws?: W): W[] {
    let to: W[]
    if (ws) { sendEvent(ws, 'trigger.checked', fields); to = [ws] }
    else to = sendTriggerEventTo(entry.home, 'trigger.checked', fields)
    if (!to.length) return to
    const wire = (entry.checksOnWire ??= new Map())
    const before = wire.get(fields.atMs)?.to.filter((s: object) => checkWire.open(s) && !to.includes(s as W)) ?? []
    wire.set(fields.atMs, { sentAt: now, to: [...before, ...to] })
    return to
  }

  /** Drop the kept reports a server read; true when the kept list changed (the caller persists it). */
  function settleChecks(entry: ArmedTrigger): boolean {
    return entry.checksOnWire ? settleChecksOnWire(entry.state, entry.checksOnWire, checkWire) : false
  }

  /** The kept reports on no open socket, oldest first, but the latest (`except`), which goes on its own. */
  function checksToSendAgain(entry: ArmedTrigger, except?: number): TriggerCheckedEvent[] {
    return checksToResend(entry.state, entry.checksOnWire ?? new Map(), checkWire, except)
  }

  /**
   * One fire on the wire. Every send path (fire-time, the configure replay, the
   * periodic replay) goes through here, so (epoch, seq) always travel together and
   * the replay clock is marked in exactly one place. An undelivered fire is left
   * unmarked on purpose: it must go out as soon as a trusted client appears.
   */
  function sendTriggerFire(entry: ArmedTrigger, fire: PendingFire, replay: boolean): boolean {
    // A clock reports its next slot while it holds it; a draining one holds none.
    const next = !entry.def.clock ? entry.nextRunAtMs
      : armedTriggers.get(triggerKey(entry.home, entry.def.id)) === entry ? entry.state.clock?.nextRunAtMs : undefined
    const delivered = sendTriggerEvent(entry.home, 'trigger.fired', {
      id: entry.def.id, epoch: entry.state.epoch, seq: fire.seq, atMs: fire.atMs, items: fire.items,
      ...(fire.input !== undefined ? { input: fire.input } : {}),
      ...(fire.itemsTruncated ? { itemsTruncated: true } : {}),
      durationMs: fire.durationMs, ...(next !== undefined ? { nextRunAtMs: next } : {}),
      ...(fire.host ? { host: fire.host } : {}),
      ...(fire.warnings?.length ? { warnings: fire.warnings } : {}),
      ...(fire.clock ? { clock: fire.clock } : {}),
      ...(replay ? { replay: true } : {}),
    })
    if (delivered) entry.fireSentAt.set(fire.seq, Date.now())
    return delivered
  }

  /** The Walnut a def delivers into or starts a session of, when it names one. */
  /** The def with the Walnut it delivers into or starts for named by its first home here. */
  function canonicalTriggerDef(def: TriggerDef): TriggerDef {
    const deliver = def.deliver?.home ? walnutScope.canonical(def.deliver.home) : ''
    const start = def.start?.home ? walnutScope.canonical(def.start.home) : ''
    if (deliver === (def.deliver?.home ?? '') && start === (def.start?.home ?? '')) return def
    return {
      ...def,
      ...(def.deliver && deliver ? { deliver: { ...def.deliver, home: deliver } } : {}),
      ...(def.start && start ? { start: { ...def.start, home: start } } : {}),
    }
  }

  function triggerOwnerOf(def: TriggerDef): string | undefined {
    const owner = def.deliver?.home ?? def.start?.home
    // A def names its Walnut by the home its server has now: the Walnut is its first home here.
    return owner ? walnutScope.canonical(owner) : owner
  }

  return {
    TRIGGERS_BASE_DIR, TRIGGERS_FILE, TRIGGER_STATE_DIR, TRIGGER_TICK_MS,
    armedTriggers, drainingTriggers, hostDeliveriesInFlight, triggerChecksRunning, triggerScopes, triggersConfigureGate,
    triggerKey, heldTrigger, triggerFor, fireHolders, triggerScopeOf,
    triggerStateDirOf, triggerStatePath, mtimeOf, readTriggerState, persistTriggerState, pruneTriggerStateFiles, persistTriggersFile,
    sendTriggerEvent, sendTriggerFire, sendCheck, settleChecks, checksToSendAgain, canonicalTriggerDef, triggerOwnerOf,
  }
}
