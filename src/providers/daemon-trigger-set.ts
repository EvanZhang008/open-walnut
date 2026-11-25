/**
 * walnut-trigger, the set: what each Walnut armed here (triggers.configure, with its probe and
 * delta forms), the set read back at boot, the holds a session made here while its Walnut was
 * away, and the unnamed copy an older daemon left, which the first named push takes over.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts) over the trigger store
 * and runs (daemon-trigger-store.ts, daemon-trigger-runs.ts); its dispatcher calls
 * cmdTriggersConfigure, its boot loadTriggersAtBoot, its offline host triggerHoldsChanged. The code
 * is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { TriggerHold, createOfflineHostCore } from './offline-host-core.js'
import type { TriggerDef, TriggerHostState } from './trigger-check-core.js'
import type { ClockReport } from './trigger-clock-core.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { ArmedTrigger, TriggerSocket, createDaemonTriggerStore } from './daemon-trigger-store.js'
import type { createDaemonTriggerRuns } from './daemon-trigger-runs.js'
import type { DaemonLog, DaemonReplies, DaemonSendEvent, HostTriggerJudge } from './daemon-module-deps.js'

export interface DaemonTriggerSetDeps<W extends TriggerSocket> extends DaemonReplies<W> {
  /** The trigger logic this area runs on (daemon-module-deps.ts HostTriggerJudge), passed in by the runtime. */
  judge: HostTriggerJudge
  triggerStore: ReturnType<typeof createDaemonTriggerStore<W>>
  triggerRuns: ReturnType<typeof createDaemonTriggerRuns>
  /** The pauses, resumes and deletes a session made here while its Walnut was away. */
  offlineHost: Pick<ReturnType<typeof createOfflineHostCore>, 'applyTriggerHolds' | 'triggerHoldsByHome'>
  /** Each Walnut's own dir under the runtime's (one set per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  sendEvent: DaemonSendEvent<W>
  logMsg: DaemonLog
}

export function createDaemonTriggerSet<W extends TriggerSocket>(deps: DaemonTriggerSetDeps<W>) {
  const { triggerStore, triggerRuns, offlineHost, walnutScope, gatewayClientHomes, sendEvent, logMsg, sendOk, sendError } = deps
  const { triggersSetHash, validateTriggerDef, validateTriggerSet, applyTriggersDelta } = deps.judge
  const { TRIGGERS_BASE_DIR, TRIGGERS_FILE, TRIGGER_STATE_DIR, TRIGGER_TICK_MS, armedTriggers, drainingTriggers, triggerScopes, triggersConfigureGate, triggerKey, heldTrigger, fireHolders, triggerScopeOf, triggerStatePath, mtimeOf, readTriggerState, persistTriggerState, pruneTriggerStateFiles, persistTriggersFile, sendTriggerFire, sendCheck, canonicalTriggerDef, triggerOwnerOf } = triggerStore
  const { newArmedTrigger, armClock } = triggerRuns

  // A newly armed trigger waits before its first run: configure arrives in a burst
  // at connect, and a boot-time stampede would run every check against a host that
  // is still reconciling sessions.
  const TRIGGER_FIRST_RUN_DELAY_MS = 5_000
  const TRIGGER_BOOT_RUN_DELAY_MS = 15_000

  /**
   * One Walnut's triggers.json read at boot; `home` is '' for the legacy file. `skip`:
   * ids another copy of the set runs instead (loadTriggersAtBoot), left out here.
   */
  function loadTriggerScope(home: string, file: string, raw: unknown, now: number, skip: ReadonlySet<string> = new Set()): void {
    const parsedFile = raw as { version?: unknown; triggers?: unknown; draining?: unknown; scoped?: unknown; push?: { hash?: unknown; raw?: unknown } }
    if (!parsedFile || parsedFile.version !== 1 || !Array.isArray(parsedFile.triggers)) {
      logMsg('warn', 'triggers file ignored: unexpected shape', { file })
      return
    }
    const defs: TriggerDef[] = []
    for (const entry of parsedFile.triggers) {
      const parsed = validateTriggerDef(entry)
      if (!parsed.ok) {
        logMsg('warn', 'trigger dropped at boot', { error: parsed.error })
        continue
      }
      if (skip.has(parsed.def.id)) continue
      defs.push(parsed.def)
    }
    if (skip.size) logMsg('info', 'triggers held by a newer copy of the set left out', { scope: walnutScope.label(home), ids: [...skip] })
    const scope = triggerScopeOf(home)
    scope.configured = defs
    if (!home && parsedFile.scoped !== 1) scope.inherited = true
    // A pause made here while the server was away holds across a restart too.
    for (const def of effectiveTriggerDefs(home, defs)) {
      // Leave a tick's headroom: even the minimum cadence checks within one interval at boot.
      const delay = def.check ? Math.min(TRIGGER_BOOT_RUN_DELAY_MS, def.everyMs - TRIGGER_TICK_MS) : TRIGGER_BOOT_RUN_DELAY_MS
      armedTriggers.set(triggerKey(home, def.id), newArmedTrigger(home, def, readTriggerState(home, def.id, now), now + delay, now))
    }
    // Released clocks with fires still unacked go on replaying them.
    for (const rawDef of Array.isArray(parsedFile.draining) ? parsedFile.draining : []) {
      const parsed = validateTriggerDef(rawDef)
      if (!parsed.ok || skip.has(parsed.def.id) || armedTriggers.has(triggerKey(home, parsed.def.id))) continue
      const state = readTriggerState(home, parsed.def.id, now)
      if (state.pendingFires.length > 0) drainingTriggers.set(triggerKey(home, parsed.def.id), drainingEntry(home, parsed.def, state, now))
    }
    scope.hash = triggersSetHash(defs)
    const push = parsedFile.push
    if (push && typeof push.hash === 'string' && Array.isArray(push.raw)) scope.push = { hash: push.hash, raw: push.raw }
    logMsg('info', 'triggers loaded from disk', {
      scope: walnutScope.label(home), count: defs.length, draining: fireHolders(home).length - armedOf(home).length,
      hash: scope.hash, ...(scope.inherited ? { inherited: true } : {}),
    })
  }

  /** Every Walnut's set: the legacy file, then each named one. */
  function loadTriggersAtBoot(): void {
    const now = Date.now()
    const named: Array<{ home: string; file: string; raw: unknown; at: number; ids: Set<string> }> = []
    for (const [key, dir] of walnutScope.scopeDirs(fs, TRIGGERS_BASE_DIR)) {
      const file = path.join(dir, 'triggers.json')
      let raw: unknown
      try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { continue }
      const home = (raw as { home?: unknown } | null)?.home
      if (typeof home !== 'string' || !home || walnutScope.keyOf(home) !== key) {
        logMsg('warn', 'triggers file ignored: its home does not match its dir', { file })
        continue
      }
      named.push({ home, file, raw, at: mtimeOf(file) ?? 0, ids: triggerIdsIn(raw) })
    }
    // Known before the unnamed set arms, so it never takes a named Walnut's offline holds.
    for (const n of named) triggerScopeOf(n.home)
    let raw: unknown
    let legacy = true
    try { raw = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf-8')) } catch { legacy = false }
    // After a downgrade and an upgrade again, an unmarked set the older daemon wrote and
    // a named one from before may both hold a trigger: it runs once, from the newer file.
    const inherited = legacy && (raw as { scoped?: unknown } | null)?.scoped !== 1
    const legacyAt = mtimeOf(TRIGGERS_FILE) ?? 0
    const legacyIds = inherited ? triggerIdsIn(raw) : new Set<string>()
    const legacySkip = new Set<string>()
    for (const n of named) {
      for (const tid of n.ids) if (legacyIds.has(tid) && n.at >= legacyAt) legacySkip.add(tid)
    }
    if (legacy) loadTriggerScope('', TRIGGERS_FILE, raw, now, legacySkip)
    for (const n of named) {
      const skip = new Set([...n.ids].filter((tid) => legacyIds.has(tid) && n.at < legacyAt))
      loadTriggerScope(n.home, n.file, n.raw, now, skip)
    }
    // Nothing on disk (a fresh daemon): no dir yet either.
    if (triggerScopes.size === 0) return
    try { fs.mkdirSync(TRIGGER_STATE_DIR, { recursive: true, mode: 0o700 }) } catch {}
    pruneTriggerStateFiles(now)
  }

  /** The trigger ids a triggers.json names, armed or draining. */
  function triggerIdsIn(raw: unknown): Set<string> {
    const file = raw as { triggers?: unknown; draining?: unknown } | null
    const out = new Set<string>()
    for (const list of [file?.triggers, file?.draining]) {
      for (const def of Array.isArray(list) ? list : []) {
        const tid = (def as { id?: unknown } | null)?.id
        if (typeof tid === 'string') out.add(tid)
      }
    }
    return out
  }

  /** The armed (not draining) entries of one Walnut. */
  function armedOf(home: string): ArmedTrigger[] {
    return [...armedTriggers.values()].filter((e) => e.home === home)
  }

  /**
   * The server's set with what a session changed here while its Walnut was away
   * and the server has not taken yet (offline-host-core.ts applyTriggerHolds: a pause,
   * resume, delete, create or change made here). A named Walnut takes only its own
   * holds; the unnamed set takes those of every Walnut that has no set of its own here.
   */
  function effectiveTriggerDefs(home: string, defs: TriggerDef[]): TriggerDef[] {
    return offlineHost.applyTriggerHolds(triggerHoldsFor(home), defs, validateTriggerDef)
  }

  function triggerHoldsFor(home: string): Map<string, TriggerHold> {
    const byHome = offlineHost.triggerHoldsByHome()
    if (home) return byHome.get(home) ?? new Map()
    const out = new Map<string, TriggerHold>()
    for (const [h, holds] of byHome) {
      if (h && triggerScopes.has(h)) continue
      for (const [tid, hold] of holds) out.set(tid, hold)
    }
    return out
  }

  /**
   * Arm exactly `defs` for one Walnut. Disarming forgets the trigger but KEEPS its
   * state file: a disable-then-enable (or a push that briefly carries an empty set)
   * must not destroy the dedup set, the script's cursor or an unacked fire. Stale
   * files age out instead. Another Walnut's triggers are never touched.
   */
  function armTriggerSet(home: string, defs: TriggerDef[], now: number): ClockReport[] {
    const ids = new Set(defs.map((def) => def.id))
    const released: ClockReport[] = []
    const drainingBefore = drainingTriggers.size
    for (const [key, entry] of [...armedTriggers]) {
      if (entry.home !== home || ids.has(entry.def.id)) continue
      armedTriggers.delete(key)
      if (entry.def.clock) released.push(releaseClock(entry.def.id, entry))
    }
    let drainingChanged = drainingTriggers.size !== drainingBefore
    for (const def of defs) {
      const key = triggerKey(home, def.id)
      const existing = armedTriggers.get(key)
      // A trigger that stays keeps its state file, its cursor and its schedule;
      // only the definition is refreshed. A clock the server started over (a new
      // fromMs) starts from that slot; a def that changed kind is armed anew.
      if (existing && !!existing.def.clock === !!def.clock) {
        existing.def = def
        if (def.clock) armClock(existing, now, TRIGGER_FIRST_RUN_DELAY_MS)
        continue
      }
      // Handed back before its fires drained: those fires stay with it.
      const draining = drainingTriggers.get(key)
      if (draining) { drainingTriggers.delete(key); drainingChanged = true }
      const state = draining ? draining.state : readTriggerState(home, def.id, now)
      // A deliberate re-arm gets a fresh error budget, as the server's resume does. Boot preserves it.
      state.consecutiveErrors = 0
      armedTriggers.set(key, newArmedTrigger(home, def, state, now + TRIGGER_FIRST_RUN_DELAY_MS, now, !!draining))
    }
    if (drainingChanged) persistTriggersFile(home)
    return released
  }

  /** A released clock that still has fires to replay: no slot runs. */
  function drainingEntry(home: string, def: TriggerDef, state: TriggerHostState, now: number): ArmedTrigger {
    return { home, def, state, nextRunAtMs: Number.POSITIVE_INFINITY, running: false, fireSentAt: new Map(), armedAtMs: now }
  }

  /** Where a clock stands, for the configure reply. */
  function clockReportOf(tid: string, entry: ArmedTrigger): ClockReport {
    const clock = entry.state.clock
    return { id: tid, fromMs: clock?.fromMs ?? entry.def.clock!.fromMs, ...(clock?.nextRunAtMs !== undefined ? { nextRunAtMs: clock.nextRunAtMs } : {}) }
  }

  function clockReports(home: string): ClockReport[] {
    const out: ClockReport[] = []
    for (const entry of armedOf(home)) {
      if (entry.def.clock) out.push(clockReportOf(entry.def.id, entry))
    }
    return out
  }

  /**
   * The server took this clock back: say where it stood. Its fires nobody acked
   * stay (the draining set) and go on replaying until the server has recorded each.
   */
  function releaseClock(tid: string, entry: ArmedTrigger): ClockReport {
    const pending = entry.state.pendingFires.length
    if (pending > 0) {
      entry.nextRunAtMs = Number.POSITIVE_INFINITY
      drainingTriggers.set(triggerKey(entry.home, tid), entry)
    }
    logMsg('info', 'clock routine released', { id: tid, pending })
    return { ...clockReportOf(tid, entry), ...(pending > 0 ? { pending } : {}) }
  }

  /** A session paused, resumed or deleted a trigger here: arm every Walnut's set by it now. */
  function triggerHoldsChanged(): void {
    const now = Date.now()
    for (const [home, scope] of triggerScopes) void armTriggerSet(home, effectiveTriggerDefs(home, scope.configured), now)
    logMsg('info', 'triggers rearmed after a change on this host', { armed: armedTriggers.size, scopes: triggerScopes.size })
  }

  /**
   * The first named push after a boot that found the inherited unnamed copy takes
   * its triggers as this Walnut's previous copy (their state, schedule and unacked
   * fires carry over). That copy was ONE Walnut's, the one that pushed last: a trigger
   * that names another Walnut waits for that Walnut's push, and when any does, the
   * ones that name none (a clock the server runs) are not this Walnut's either. The
   * copy and its legacy file go once nothing is left in it. Returns the ids taken.
   */
  function takeInheritedTriggers(home: string): string[] {
    const inherited = triggerScopes.get('')
    if (!home || !inherited?.inherited) return []
    const othersNamed = (def: TriggerDef) => { const owner = triggerOwnerOf(def); return !!owner && owner !== home }
    const anotherWalnut = inherited.configured.some(othersNamed) || fireHolders('').some((e) => othersNamed(e.def))
    const ours = (def: TriggerDef) => { const owner = triggerOwnerOf(def); return owner ? owner === home : !anotherWalnut }
    const taken: string[] = []
    const move = (from: Map<string, ArmedTrigger>, entry: ArmedTrigger) => {
      const tid = entry.def.id
      from.delete(tid)
      const key = triggerKey(home, tid)
      // Both copies hold it (a set pushed before a downgrade, and the one the older
      // daemon kept since): the newer memory wins.
      if (heldTrigger(home, tid)) {
        if ((mtimeOf(triggerStatePath('', tid)) ?? 0) <= (mtimeOf(triggerStatePath(home, tid)) ?? 0)) return
        armedTriggers.delete(key)
        drainingTriggers.delete(key)
      }
      entry.home = home
      entry.state.sharedCopy = true
      from.set(key, entry)
      taken.push(tid)
    }
    for (const map of [armedTriggers, drainingTriggers]) {
      for (const entry of [...map.values()]) {
        if (entry.home !== '' || !ours(entry.def)) continue
        move(map, entry)
      }
    }
    inherited.configured = inherited.configured.filter((def) => !ours(def))
    inherited.hash = triggersSetHash(inherited.configured)
    if (inherited.configured.length === 0 && fireHolders('').length === 0) {
      triggerScopes.delete('')
      try { fs.unlinkSync(TRIGGERS_FILE) } catch {}
    } else {
      persistTriggersFile('')
    }
    logMsg('info', 'triggers: inherited set taken over', { scope: walnutScope.label(home), taken: taken.length, left: inherited.configured.length })
    return taken
  }

  /**
   * Write the memory of triggers just taken over into this Walnut's dir. The unnamed
   * copy stays and is kept current with it: a downgraded daemon reads it there.
   */
  function settleTakenTriggers(home: string, taken: readonly string[]): void {
    for (const tid of taken) {
      const entry = heldTrigger(home, tid)
      if (entry) persistTriggerState(home, tid, entry.state)
    }
  }

  function cmdTriggersConfigure(ws: W, id: number, cmd: Record<string, unknown>) {
    return triggersConfigureGate.run('triggers.configure', () => configureTriggers(ws, id, cmd))
  }

  async function configureTriggers(ws: W, id: number, cmd: Record<string, unknown>) {
    // triggers-probe-v1: the server names the set it would push. Held (this host kept the set it
    // pushed under that name), that set is configured again as if it had come now, with every
    // effect a push has (this socket gets the fires, unacked fires replay), and nothing crosses.
    let probe = cmd.probe === true
    let payload = cmd.config as { version?: unknown; triggers?: unknown } | undefined
    // triggers-delta-v1: only what changed since the set this host holds under `delta.base`
    // (trigger-check-core.ts applyTriggersDelta). Not that set, or not making the set named
    // `pushHash`: `held: false`, and the server sends the whole set.
    const delta = !probe && cmd.delta !== undefined
    if (probe || delta) {
      const asked = walnutScope.resolve(cmd, gatewayClientHomes.get(ws), 'triggers.configure')
      if (!asked.ok) return sendError(ws, id, asked.error)
      const held = triggerScopes.get(asked.home)
      const name = typeof (probe ? cmd.hash : cmd.pushHash) === 'string' ? (probe ? cmd.hash : cmd.pushHash) as string : ''
      if (!name || name.length > 128 || !held || held.inherited || !held.push) return sendOk(ws, id, { held: false })
      // Another link of this daemon pushed this very set already: configured from the copy.
      if (held.push.hash === name) probe = true
      else if (probe || held.push.hash !== (cmd.delta as { base?: unknown } | null)?.base) return sendOk(ws, id, { held: false })
      const made = probe ? held.push.raw : applyTriggersDelta(held.push.raw, cmd.delta, name)
      if (!made) return sendOk(ws, id, { held: false })
      payload = { version: 1, triggers: made }
    }
    if (!payload || typeof payload !== 'object' || payload.version !== 1 || !Array.isArray(payload.triggers)) {
      return sendError(ws, id, 'triggers.configure: invalid config: version must be 1 with a triggers array')
    }
    const resolved = walnutScope.resolve(cmd, gatewayClientHomes.get(ws), 'triggers.configure')
    if (!resolved.ok) return sendError(ws, id, resolved.error)
    const home = resolved.home
    // A def this daemon cannot take is refused alone; the rest of the set is armed.
    const set = validateTriggerSet(payload.triggers)
    const refused = set.refused
    // A def names its Walnut by the home its server has now: it is kept under the first one here.
    const named = set.defs.map(canonicalTriggerDef)
    // A Walnut holds only its own: a def that delivers into or starts a session of
    // another Walnut is not its to arm.
    const defs = !home ? named : named.filter((def) => {
      const owner = triggerOwnerOf(def)
      if (!owner || owner === home) return true
      refused.push({ id: def.id, error: `trigger ${def.id}: it names another Walnut` })
      return false
    })
    if (refused.length) logMsg('warn', 'triggers refused', { refused })

    const now = Date.now()
    const taken = takeInheritedTriggers(home)
    const scope = triggerScopeOf(home)
    // An older server pushing the unnamed set makes the inherited copy its own.
    const claimed = !home && scope.inherited === true
    if (claimed) delete scope.inherited
    const hash = triggersSetHash(defs)
    const changed = hash !== scope.hash
    scope.configured = defs
    const released = armTriggerSet(home, effectiveTriggerDefs(home, defs), now)
    scope.hash = hash
    // The name the server gave this set and the set as it came, kept for its next probe. A held
    // probe answers as this push does, its refusals too (the server keeps those as it would).
    const push = probe ? scope.push
      : typeof cmd.pushHash === 'string' && cmd.pushHash.length > 0 && cmd.pushHash.length <= 128
        ? { hash: cmd.pushHash, raw: payload.triggers as unknown[] } : undefined
    const pushMoved = (push?.hash ?? null) !== (scope.push?.hash ?? null)
    if (push) scope.push = push
    else delete scope.push
    if (changed || claimed || taken.length || pushMoved) persistTriggersFile(home)
    settleTakenTriggers(home, taken)
    // Fires of this Walnut's set go to this socket from now on.
    if (ws.data) ws.data.triggerScope = home
    pruneTriggerStateFiles(now)
    const clocks = clockReports(home)
    // What this home still holds after the push: a set move empties it and waits for 0 and 0.
    const armedCount = armedOf(home).length
    const drainingCount = fireHolders(home).length - armedCount
    logMsg('info', 'triggers configured', {
      scope: walnutScope.label(home), hash, count: defs.length, changed, clocks: clocks.length,
      released: released.map((r) => r.id), draining: drainingCount,
    })
    sendOk(ws, id, { applied: true, changed, count: defs.length, armed: armedCount, draining: drainingCount, clocks, released, ...(probe ? { held: true } : delta ? { delta: true } : {}), ...(refused.length ? { refused } : {}) })

    // At-least-once replay: a fire the server never acked (Mac asleep, tunnel
    // down) is redelivered now that a trusted client is provably here. The server
    // dedups on (id, epoch, seq).
    for (const entry of fireHolders(home)) {
      for (const fire of entry.state.pendingFires) sendTriggerFire(entry, fire, true)
    }
    // A quiet host kept checking too. Only a server that dedups checked replays asks for them.
    if (cmd.replayChecks === true) {
      for (const entry of armedOf(home)) {
        // The checks no server is known to have read go first, oldest first: the record keeps each one,
        // and takes only what is newer than what it holds. Each stays kept until this socket is heard a
        // beat later (trigger-unsent-checks.ts): a Mac that sleeps again right after it connected read none.
        const checked = entry.state.lastCheck
        const sentAt = Date.now()
        for (const c of entry.state.unsentChecks ?? []) {
          if (c.id === entry.def.id && c.atMs !== checked?.atMs) sendCheck(entry, { ...c, replay: true }, sentAt, ws)
        }
        if (entry.def.check && checked?.id === entry.def.id) {
          // A failed offline check gets another chance within this interval, not the outage's backoff.
          if (checked.outcome === 'error' && !entry.running) {
            entry.nextRunAtMs = Math.min(entry.nextRunAtMs, now + Math.min(TRIGGER_FIRST_RUN_DELAY_MS, entry.def.everyMs - TRIGGER_TICK_MS))
          }
          sendCheck(entry, { ...checked, nextRunAtMs: entry.nextRunAtMs, replay: true }, sentAt, ws)
        }
      }
    }
  }

  return { loadTriggersAtBoot, effectiveTriggerDefs, armTriggerSet, triggerHoldsChanged, cmdTriggersConfigure }
}
