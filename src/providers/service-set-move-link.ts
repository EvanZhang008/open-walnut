/**
 * One host link's part in service sets (the experiment host_service_sets): what the host named,
 * the first look and install (service-set-provision.ts), and the move of this Walnut's sessions
 * from another Walnut's shared daemon to its own set (service-set-move.ts), built from the link
 * (daemon-connection.ts gives it SetLinkConn). With the experiment off, nothing here runs: every
 * entry point returns at its first line.
 *
 * Holding reuses the queue a host that is briefly away has (session-lifecycle.md "A message to a
 * host nothing reaches waits for that host"): while held, the link refuses `send` with its "not
 * connected" words and reads as down (hostLinkDown), so the runner keeps the rows pending, and a
 * `start` and every other command that starts work there waits (service-set-hold.ts); the release
 * asks the runner to deliver the rows, to whatever the link reaches then.
 *
 * On a host network link the set has a walnut-net identity of its own: the move first pairs with it
 * over the link as it is (service-set-net-pair.ts), the flip is which endpoint the link dials, and
 * the put-back dials the shared one again (still a member until the move is confirmed).
 *
 * A host whose move is done stays this Walnut's set for this leader whatever the experiment says
 * later (review round 1, B7): its lines keep naming the Walnut and SSH keeps dialling the set's
 * runtime dir, so the other Walnut's default service is never updated from here; the experiment
 * gates only new moves.
 */
import { log } from '../logging/index.js'
import { clearServiceSetMoved, hostServiceSets, hostServiceSetsWanted, linkStanding, markServiceSetMoved, movedNetEndpoint, movedToSet, recordServiceSetFrom, setWordsDue, type HostSetRecord, type LinkStanding, type SetAsk } from './service-set-leader.js'
import { moveOnce, moveReconnectMs, runMove, serviceSetMoves, settleMove, type MoveDeps, type MoveOutcome, type MoveSession, type StopResult } from './service-set-move.js'
import { moveStoreFor } from './service-set-move-store.js'
import { dropWalnutScope, moveBlocker, moveSessions, openWorkThere, stopFollowerThere, stopProven, takeTriggerMemory, type MoveCheckLink, type SeedOutcome, type TriggerMemory } from './service-set-move-checks.js'
import { OwedMemorySeeder } from './service-set-move-seed.js'
import { setCliCommand, type SetProvision } from './service-set-provision.js'
import { isServiceSetId } from './service-set.js'
import { forgetSetNet, leaveSharedNet, pairServiceSetNet, type NetPairDeps } from './service-set-net-pair.js'

/** What the link gives this module. */
export interface SetLinkConn {
  hostKey: string
  /** 'ssh' or 'net' for a host this leader may give a set; null for any other link (this machine, a test server, the cloud box). */
  kind(): 'ssh' | 'net' | null
  readonly connected: boolean
  /** The set the current hello names ('' none). */
  helloSet(): string
  /** A command on the link, past the move's own hold. */
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  hasCapability(cap: string): boolean
  /** Work commands on the link not answered yet (service-set-hold.ts). */
  workUnderWay(): number
  /** True once those are answered, false at `boundMs`. */
  drained(boundMs: number): Promise<boolean>
  /** Host network: the endpoint the host's row names (the machine's walnut-net, the shared daemon's). */
  sharedEndpoint(): string | null
  /** A shell line on the host (SSH exec, or the daemon's exec over the host network). */
  run(command: string, timeoutMs?: number): Promise<string>
  /**
   * This build's executable on the host, then the set check and install (service-set-provision.ts);
   * `refresh`: the set is not moved to yet, so an own set without this build takes it.
   */
  provision(ask: SetAsk, opts?: { refresh?: boolean }): Promise<SetProvision>
  /** Drop the link and dial again; the set the new hello names, or null with no hello within `boundMs`. */
  relink(boundMs: number): Promise<string | null>
  /** Hold (or release) this Walnut's work for this host. */
  setHold(on: boolean): void
  /** Ask the runner to deliver what waited for this host (the reconnect hook). */
  redeliver(): void
  /** Where this connect dialled: SSH the runtime dir it chose, the host network the endpoint; null before a dial. */
  dialled(): string | null
  /** The trigger ids this link last pushed to the daemon it reaches (this Walnut's, for its home). */
  triggerIds(): string[]
  /** This Walnut's offline journal on the daemon the link reaches, drained to empty within `boundMs`; throws when not. */
  drainJournal(boundMs: number): Promise<void>
  /** This Walnut's data dir and id. */
  home: string
  walnutId(): Promise<string>
  /** A host health notice (Walnut Health), by key; null clears it. */
  notice(key: string, text: string | null): void
  /** Push this Walnut's triggers to the daemon the link reaches (a seed that did not finish asks again). */
  pushTriggers?(): void
  /** This connect pushed the triggers (triggerIds() then names every one of them). */
  triggersPushed?(): boolean
}

/** Dependencies a test replaces; the defaults ask the shared daemon and this server (service-set-move-checks.ts). */
export interface SetLinkDeps {
  sessions?(hostKey: string): Promise<MoveSession[]>
  stop?(sessionId: string): Promise<StopResult>
  openWork?(): Promise<string | null>
  dropScope?(): Promise<void>
  stopFollower?(): Promise<void>
  /** The triggers' memory: taken from the shared daemon after the drop, handed to the set's before the release. */
  takeMemory?(): Promise<TriggerMemory[]>
  /** Hand memory to the set's daemon: what is still owed (void: none); a throw owes all of it unless it is a refusal for good. */
  seedMemory?(memory: TriggerMemory[]): Promise<SeedOutcome | void>
  drainJournal?(): Promise<void>
  blocker?(): Promise<string | null>
  endpointId?(): Promise<string | null>
  /** This leader's host network side (core/net/net-service-sets.ts): its member list, the relay's list, its own walnut-net. */
  net?: Pick<NetPairDeps, 'list' | 'register' | 'unregister' | 'apply'>
  now?(): number
  sleep?(ms: number): Promise<void>
  settleMs?: number
}

/** Provisioning at most this often per link while nothing changes (a status line, maybe an upload). */
const PROVISION_EVERY_MS = 30 * 60_000
/** The first look again after one that found no set. */
const LOOK_RETRY_FIRST_MS = 60_000
/** How long the move waits for this Walnut's offline journal on the shared daemon to drain. */
const JOURNAL_DRAIN_MS = 60_000

/** This machine's walnut-net endpoint id (its local daemon's net status). */
async function localEndpointId(): Promise<string | null> {
  const { link } = await import('../core/hosts/link.js')
  const local = await link('__local__')
  const s = await local.send('net.status', {}, 5_000) as { endpointId?: unknown }
  return typeof s.endpointId === 'string' && /^[0-9a-f]{64}$/.test(s.endpointId) ? s.endpointId : null
}

/** This leader's host network side, from core/net/net-service-sets.ts (a test gives its own). */
async function netSide(): Promise<Pick<NetPairDeps, 'list' | 'register' | 'unregister' | 'apply'>> {
  const m = await import('../core/net/net-service-sets.js')
  return { list: m.pairingList, register: m.registerSetEndpoint, unregister: m.unregisterSetEndpoint, apply: m.applyServiceSetMembers }
}

export class ServiceSetLink {
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking: Promise<void> | null = null
  private provisionedAt = 0
  /** The wait before the next look after one that found no set (it doubles, up to PROVISION_EVERY_MS). */
  private lookRetryMs = 0
  /** SSH: the set's runtime dir while a move points the link there (before its record says done). */
  private sshOverride: string | null = null
  /** Host network: the set's own endpoint while a move points the link there (before its record says done). */
  private netOverride: string | null = null
  private standingNow: LinkStanding = 'unknown'
  /** The move holds this host's starts and sends now. */
  private holding = false
  private stopped = false
  /** Where the link stands is written one at a time: a moved host's settle, a lost memory's point-back (review L1). */
  private standingChain: Promise<unknown> = Promise.resolve()
  /** Bumped by each point-back of a lost memory: a look begun before it keeps nothing as moved. */
  private pointBacks = 0
  /** A point-back's redial is under way: the hello still names the set, and nothing is kept as moved meanwhile. */
  private pointingBack = false
  /** The move under way on this link (moveOnce), while it runs. */
  private moving: Promise<MoveOutcome> | null = null
  /** What a move cut by a restart still owes the set's daemon, handed over before the first trigger push there. */
  private readonly seeder: OwedMemorySeeder

  constructor(private readonly c: SetLinkConn, private readonly d: SetLinkDeps = {}, readonly expected: () => string | null = () => null) {
    this.seeder = new OwedMemorySeeder({
      c, seedMemory: d.seedMemory, checkLink: () => this.checkLink, store: () => this.store(), now: this.now,
      noticeKey: this.noticeKey, pointBack: () => this.pointBack(),
    })
  }

  get place(): string { return `${this.c.kind() ?? 'none'}:${this.c.hostKey}` }

  /** The standing the last check found ('unknown' before any, and with the experiment off). */
  get standing(): LinkStanding { return this.standingNow }

  /**
   * A first look at the host ended on this link (whatever it found). Until then an unknown set holds
   * the host's updates; after it, 'unknown' is an older host or a look that failed, and updates take
   * today's path rather than waiting for good (review round 1, low 15).
   */
  get looked(): boolean { return this.lookEnded }
  private lookEnded = false

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.seeder.stop()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.standingChain.then(fn, fn)
    this.standingChain = p.catch(() => {})
    return p
  }

  /** The link came up: look once it settled. */
  schedule(delayMs = this.d.settleMs ?? 20_000): void {
    if (this.stopped || !this.c.kind()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.check() }, delayMs)
    this.timer.unref?.()
  }

  private async ask(): Promise<SetAsk | null> {
    if (!this.c.kind()) return null
    // A host whose move is done keeps its set with the experiment off (B7).
    if (!(await hostServiceSetsWanted()) && !movedToSet(await hostServiceSets.read(this.place).catch(() => null))) return null
    const walnutId = await this.c.walnutId().catch(() => '')
    return /^[0-9a-f]{16}/.test(walnutId) ? { walnutId, home: this.c.home } : null
  }

  /** The words-to-be for this link's `walnut daemon` lines: null with the experiment off or no set possible here. */
  setAsk(): Promise<SetAsk | null> { return this.ask() }

  /**
   * An update line for the set `set` the link reaches names this Walnut (setWordsDue, the rule of both
   * paths). A standing that cannot be read is 'unknown', as the host network path reads it: never the
   * words with no set named (review round 3, L-H1).
   */
  async wordsDue(set: string): Promise<boolean> {
    const standing = (await this.standingFor().catch(() => null))?.standing ?? 'unknown'
    return setWordsDue(await this.ask().catch(() => null), standing, set)
  }

  /** Where the link stands now, read from the kept record and the current hello. */
  async standingFor(): Promise<{ standing: LinkStanding; record: HostSetRecord | null }> {
    const wanted = !!(await this.ask())
    const record = wanted ? await hostServiceSets.read(this.place).catch(() => null) : null
    const standing = linkStanding(record, this.c.connected ? this.c.helloSet() : null, wanted)
    this.standingNow = standing
    return { standing, record }
  }

  /** SSH: the dir the link dials, when it is this Walnut's set's (null: today's choice). */
  async sshDir(): Promise<{ dir: string; set: string } | null> {
    if (this.c.kind() !== 'ssh' || !(await this.ask())) return null
    const record = await hostServiceSets.read(this.place).catch(() => null)
    if (!record?.set || !record.runtimeDir) return null
    if (this.sshOverride === record.runtimeDir || movedToSet(record)) return { dir: record.runtimeDir, set: record.set }
    // A move done before its host record kept it (an earlier build of this code).
    const move = await serviceSetMoves.read(this.place).catch(() => null)
    return move?.set === record.set && move.phase === 'done' ? { dir: record.runtimeDir, set: record.set } : null
  }

  /** Host network: the endpoint the link dials, when it is this Walnut's set's (null: the host row's). */
  async netEndpoint(): Promise<string | null> {
    if (this.c.kind() !== 'net' || !(await this.ask())) return null
    if (this.netOverride) return this.netOverride
    return movedNetEndpoint(await hostServiceSets.read(this.place).catch(() => null))
  }

  /** This leader's host network side and the set's CLI line on this link: what pairing and its undo use. */
  private async pairDeps(set: string): Promise<NetPairDeps> {
    const expected = this.expected()
    if (!expected) throw new Error('this server names no daemon build')
    const ask = await this.ask()
    if (!ask) throw new Error('this Walnut has no id the host can name a set by')
    return {
      place: this.place, set, ask, shared: this.c.sharedEndpoint(),
      runSetCli: (words, timeoutMs) => this.c.run(setCliCommand(set, expected, words), timeoutMs),
      ...(this.d.net ?? await netSide()),
    }
  }

  /** After a confirmed net move: this leader leaves the shared walnut-net's list (once; tried again at each look). */
  private async leaveShared(set: string): Promise<void> {
    if (this.c.kind() !== 'net') return
    const me = await (this.d.endpointId ?? localEndpointId)().catch(() => null)
    await leaveSharedNet({ ...(await this.pairDeps(set)), me }).catch((err) => {
      log.session.warn('service set: this leader is still on the shared walnut-net\'s list', { host: this.c.hostKey, error: err instanceof Error ? err.message : String(err) })
    })
  }

  /**
   * Leaving the host: its set's endpoint is no member of the companion's, then the host's set record
   * and move go here, so this leader's walnut-net dials it no more (service-set-net-pair.ts). Throws when
   * the companion kept the endpoint (the record stays for the next sync to finish, core/net/net-service-sets.ts).
   */
  async forgetNet(): Promise<void> {
    await forgetSetNet({ place: this.place, ...(this.d.net ?? await netSide()) })
  }

  /**
   * The host leaves this leader for good (Settings > Remove, core/hosts/host-set-leave.ts): this
   * Walnut's own set there is removed while the link still reaches it (leaveServiceSet), bounded by
   * `boundMs` so a Remove never waits longer, then forgotten here and on the companion whatever the
   * host answered. No look or move runs on this link after it.
   */
  async leave(boundMs: number): Promise<{ ok: boolean; why: string }> {
    this.stop()
    // A look or a move under way ends first, bounded to a quarter of the bound, so it does not write
    // the records this forgets after it (review round 3, L-N4).
    if (this.checking) {
      const started = Date.now()
      let t: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.checking, new Promise<void>((r) => { t = setTimeout(r, boundMs / 4); t.unref?.() })]).finally(() => clearTimeout(t))
      boundMs = Math.max(1_000, boundMs - (Date.now() - started))
    }
    const record = await hostServiceSets.read(this.place).catch(() => null)
    const ask = record && isServiceSetId(record.set) ? await this.ask().catch(() => null) : null
    const expected = this.expected()
    let out = { ok: false, why: 'this Walnut has no service set of its own there' }
    if (record && ask && expected && this.c.connected) {
      const { leaveServiceSet } = await import('./service-set-provision.js')
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<{ ok: boolean; why: string }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, why: `the host did not finish removing this Walnut's own service within ${Math.round(boundMs / 1000)} s` }), boundMs)
        timer.unref?.()
      })
      const left = leaveServiceSet({
        set: record.set, ask, now: this.now, sleep: this.sleep, waitMs: Math.min(10_000, boundMs / 4),
        sessions: async () => (await (this.d.sessions ? this.d.sessions(this.c.hostKey) : moveSessions(this.checkLink))).map((s) => ({ inTurn: !!s.busy })),
        stopSessions: () => this.stopAllThere(),
        send: (cmd, params, timeoutMs) => this.c.send(cmd, params, timeoutMs),
        // A link that is down reaches no set (L-H2: the uninstall's own stop of the set's daemon ends it).
        helloSet: () => (this.c.connected ? this.c.helloSet() : ''),
        runSetCli: (words, timeoutMs) => this.c.run(setCliCommand(record.set, expected, words), timeoutMs),
      }).catch((err: unknown) => ({ ok: false, why: err instanceof Error ? err.message : String(err) }))
      out = await Promise.race([left, bound]).finally(() => clearTimeout(timer))
    } else if (record && ask) {
      out = { ok: false, why: 'the host is not reached now: this Walnut\'s own service stays there' }
    }
    await this.forgetNet().catch((err: unknown) => {
      log.session.warn('service set: the cloud companion still lists the set\'s endpoint of a host that left; the next sync tries again', { host: this.c.hostKey, error: err instanceof Error ? err.message : String(err) })
    })
    log.session.info('service set: the host left this Walnut', { host: this.c.hostKey, ok: out.ok, why: out.why })
    return out
  }

  /** A `walnut daemon` line this leader ran named a set (`service set: …`): keep it, and move when it is this Walnut's own. */
  async named(set: string | null, runtimeDir?: string): Promise<void> {
    if (set === null || !(await this.ask())) return
    await recordServiceSetFrom(this.place, `service set: ${set || 'default'}`, runtimeDir)
    if (set && this.c.helloSet() !== set) void this.check(true)
  }

  /** The look after a connect (and after a line named an own set): the set, its install, then the move. */
  check(force = false): Promise<void> {
    this.checking ??= this.checkOnce(force).catch((err) => {
      log.session.warn('service set: the check of this host failed', { host: this.c.hostKey, error: err instanceof Error ? err.message : String(err) })
    }).finally(() => { this.checking = null })
    return this.checking
  }

  private async checkOnce(force: boolean): Promise<void> {
    const ask = await this.ask()
    if (!ask || this.stopped || !this.c.connected) return
    const pointBacks = this.pointBacks
    let { standing, record } = await this.standingFor()
    if (standing === 'default') return
    // A moved host whose set's dir (or endpoint, while still a member of the shared walnut-net) answers
    // with a daemon naming no set: the set is gone there (uninstalled by hand, the box rebuilt). The move
    // is undone here and the link takes today's choice again (review round 2, M6).
    // Only when this connect dialled the set's own place (review round 3, L-M2).
    if (standing === 'shared' && movedToSet(record) && this.dialledSetPlace(record) && (this.c.kind() === 'ssh' || record.netSharedLeftAt === undefined)) {
      log.session.warn('service set: the host\'s set no longer answers at its place; the move is undone here', { host: this.c.hostKey, set: record.set, hello: this.c.helloSet() })
      // What this leader pushed to the daemon that answers there goes before the redial (round 3, S3).
      await (this.d.dropScope ?? (() => dropWalnutScope(this.checkLink)))().catch(() => {})
      await (this.d.stopFollower ?? (() => stopFollowerThere(this.checkLink, this.sleep)))().catch(() => {})
      await this.undoMove()
      void this.c.relink(moveReconnectMs())
      return
    }
    if (standing === 'own') {
      const kept = await this.serial(async () => {
        // A lost memory pointed the link back meanwhile, or does now (beforeTriggerPush): nothing is
        // kept as moved, its notice stays. Where the link stands is read again inside the turn.
        if (this.pointBacks !== pointBacks || this.pointingBack) return false
        const now = await this.standingFor()
        if (now.standing !== 'own' || now.record?.set !== record!.set || !this.c.connected) return false
        await settleMove({ set: record!.set, store: this.store(), confirm: async () => {}, now: this.now })
        await markServiceSetMoved(this.place, record!.set, this.now())
        this.c.notice(this.noticeKey, null)
        return true
      })
      if (kept) await this.leaveShared(record!.set)
      return
    }
    // Unknown, or a set of its own while the link reaches another daemon: look (and install) first,
    // once per link and then at most every PROVISION_EVERY_MS (a status line, maybe an upload).
    const look = standing === 'unknown' || this.provisionedAt === 0 || (this.c.kind() === 'ssh' && !record?.runtimeDir)
    if (look && (this.provisionedAt === 0 || this.now() - this.provisionedAt >= PROVISION_EVERY_MS)) {
      this.provisionedAt = Math.max(1, this.now())
      // A look that threw (the link cut mid-line) is a look that found nothing: looked at again (drill round 3, R3-3).
      const p: SetProvision = await this.c.provision(ask, { refresh: await this.mayRefresh(standing, record) })
        .catch((err: unknown) => ({ set: null, installed: false, ok: false, message: err instanceof Error ? err.message : String(err) }))
        .finally(() => { this.lookEnded = true })
      if (p.set === null) {
        // Nothing known (a look refused or cut, or an older host): looked at again soon, then less
        // often, never left silent for the next 30 min (drill round 2, N1).
        this.lookRetryMs = Math.min(Math.max(LOOK_RETRY_FIRST_MS, this.lookRetryMs * 2), PROVISION_EVERY_MS)
        this.provisionedAt = 0
        log.session.warn('service set: the look at this host found no set; it looks again', { host: this.c.hostKey, why: (p.message ?? '').slice(0, 300), inMs: this.lookRetryMs })
        this.schedule(this.lookRetryMs)
        return
      }
      await recordServiceSetFrom(this.place, `service set: ${p.set || 'default'}`, p.runtimeDir)
      if (p.retryLook) {
        // The set's build is not this build yet and its update did not happen now: no move (it would
        // answer no_build), the look again soon, then less often.
        this.lookRetryMs = Math.min(Math.max(LOOK_RETRY_FIRST_MS, this.lookRetryMs * 2), PROVISION_EVERY_MS)
        const inMs = Math.max(this.lookRetryMs, p.retryInMs ?? 0)
        this.provisionedAt = 0
        log.session.warn('service set: this Walnut\'s own service there has no copy of this build yet; it looks again', { host: this.c.hostKey, why: (p.message ?? '').slice(0, 300), inMs })
        this.c.notice(this.noticeKey, `This Walnut's own service on ${this.c.hostKey} could not take this Walnut's build yet (${(p.message ?? '').slice(0, 300)}); its sessions stay on the service another Walnut runs there, and Walnut tries again.`)
        this.schedule(inMs)
        return
      }
      // The set took this build: the cause of an earlier give-up (no_build) is gone, so the move runs now.
      if (p.refreshed) { this.c.notice(this.noticeKey, null); force = true }
      this.lookRetryMs = 0
      if (!p.ok) {
        this.c.notice(this.noticeKey, `This Walnut's own service on ${this.c.hostKey} could not be installed (${(p.message ?? '').slice(0, 300)}); its sessions stay on the service another Walnut runs there.`)
        return
      }
      ;({ standing, record } = await this.standingFor())
    }
    if (standing !== 'shared' || !record?.set) return
    // The experiment gates new moves only (B7).
    if (!(await hostServiceSetsWanted())) return
    await this.move(record, force)
  }

  /**
   * The look may update this Walnut's own set to this build (service-set-provision.ts refresh) only
   * while nothing of this Walnut can run on it: the link read as reaching the shared daemon (a record
   * that read, a hello naming another daemon), never moved to, and no move flipped or done (a move
   * done before its host record kept it, a restart in the flipped phase). Review round 1, 2.
   */
  private async mayRefresh(standing: LinkStanding, record: HostSetRecord | null): Promise<boolean> {
    if (standing !== 'shared' || !record?.set || movedToSet(record) || this.c.helloSet() === record.set) return false
    const move = await serviceSetMoves.read(this.place).catch(() => undefined)
    if (move === undefined) return false
    return !(move?.set === record.set && (move.phase === 'flipped' || move.phase === 'done'))
  }

  private get noticeKey(): string { return `service-set:${this.c.hostKey}` }
  private now = (): number => (this.d.now ?? Date.now)()
  private sleep = (ms: number): Promise<void> => (this.d.sleep ?? ((x: number) => new Promise<void>((r) => { const t = setTimeout(r, x); t.unref?.() })))(ms)

  /** This connect dialled the set's own place: SSH its runtime dir, the host network its endpoint (review round 3, L-M2). */
  private dialledSetPlace(record: HostSetRecord): boolean {
    const at = this.c.dialled()
    return !!at && at === (this.c.kind() === 'ssh' ? record.runtimeDir : record.netEndpoint)
  }

  /** The move is undone here: the host's record says moved no more, the move's record goes, nothing points the link at the set. */
  private async undoMove(): Promise<void> {
    await clearServiceSetMoved(this.place)
    await moveStoreFor(this.place).write(null).catch(() => {})
    this.sshOverride = null
    this.netOverride = null
    this.provisionedAt = 0
  }

  /**
   * SSH connect: the set's runtime dir `dir` holds neither its service config nor a daemon (review round 3,
   * S3). The link points there no more: a done move is undone (as M6), a move under way is put back by its
   * own flip, which finds no set in the hello. The caller then takes today's dir and deploys nothing there.
   */
  async setGoneAt(dir: string): Promise<void> {
    if (this.sshOverride === dir) this.sshOverride = null
    const record = await hostServiceSets.read(this.place).catch(() => null)
    if (!record?.set || record.runtimeDir !== dir) return
    const move = await serviceSetMoves.read(this.place).catch(() => null)
    if (movedToSet(record) || (move?.set === record.set && move.phase === 'done')) await this.undoMove()
  }

  private store(): MoveDeps['store'] {
    return moveStoreFor(this.place)
  }

  /** Stop each of this Walnut's sessions on the daemon the link reaches, proven (R3-5); why each one not stopped stays. */
  private async stopAllThere(): Promise<string[]> {
    const left: string[] = []
    for (const s of await (this.d.sessions ? this.d.sessions(this.c.hostKey) : moveSessions(this.checkLink))) {
      if (s.blocks) { left.push(s.blocks); continue }
      const r = await (this.d.stop ?? ((x: string) => stopProven(this.checkLink, x)))(s.id)
      if (!r.ok) left.push(r.why ?? `session ${s.id}`)
    }
    return left
  }

  /** The link's part the shared daemon's checks use. */
  private get checkLink(): MoveCheckLink {
    const c = this.c
    return { hostKey: c.hostKey, home: c.home, send: (cmd, p, t) => c.send(cmd, p, t), hasCapability: (x) => c.hasCapability(x), workUnderWay: () => c.workUnderWay(), walnutId: () => c.walnutId() }
  }

  /** Before a connect's first trigger push (DaemonConnection.pushTriggersOnce, `live`: the triggers it pushes): what a move cut by a restart still owes the set. False: push nothing. */
  async beforeTriggerPush(live?: readonly string[]): Promise<boolean> {
    // A move under way carries the memory itself: a push that comes while it holds the host (its
    // flip's reconnect) waits for it to end, then asks like any other, so a carry that did not
    // finish keeps that push off the set too (round 2, S-A). Only a link that reaches a set waits: on
    // the shared daemon nothing is owed, and the move's own journal drain may wait for that push.
    while (this.holding && this.moving && this.c.connected && this.c.helloSet()) await this.moving.catch(() => undefined)
    return this.seeder.beforePush(live ?? null)
  }

  /** The kept copy of owed memory cannot be read: the link goes back to the shared daemon, which still keeps it, for the move to take it again. */
  private async pointBack(): Promise<void> {
    this.pointingBack = true
    await this.serial(async () => {
      this.pointBacks++
      log.session.warn('service set: the triggers\' memory kept for the move cannot be read; the link goes back to the shared daemon', { host: this.c.hostKey })
      this.c.notice(this.noticeKey, `What this Walnut's triggers on ${this.c.hostKey} have already reported was lost in a restart during the move to its own service there, so they were not started there without it. Walnut points ${this.c.hostKey} back at the service another Walnut runs there, which still keeps it, and moves again.`)
      await this.undoMove()
    })
    void this.c.relink(moveReconnectMs()).catch(() => null).finally(() => { this.pointingBack = false })
  }

  private move(record: HostSetRecord, force: boolean): Promise<MoveOutcome> {
    const set = record.set
    const kind = this.c.kind()!
    /** The trigger ids the drop empties, read before it (the link's last push). */
    let ids: string[] = []
    const sleep = this.sleep
    const run = (): Promise<MoveOutcome> => runMove({
      set, link: kind, now: this.now, force, sleep,
      store: this.store(),
      // Host network: the set's own walnut-net is paired first, over this link; not paired, no move.
      ...(kind === 'net' ? { pair: async () => { await pairServiceSetNet(await this.pairDeps(set)) } } : {}),
      sessions: () => (this.d.sessions ? this.d.sessions(this.c.hostKey) : moveSessions(this.checkLink)),
      openWork: () => (this.d.openWork ?? (() => openWorkThere(this.checkLink)))(),
      stop: (id) => (this.d.stop ?? ((x: string) => stopProven(this.checkLink, x)))(id),
      hold: () => { this.holding = true; this.c.setHold(true) },
      drained: (boundMs) => this.c.drained(boundMs),
      release: () => { this.holding = false; this.c.setHold(false); this.c.redeliver() },
      // Only a daemon that has no followers at all has nothing to stop; any other doubt ends the try (should-fix 7).
      stopFollower: () => (this.d.stopFollower ?? (() => stopFollowerThere(this.checkLink, sleep)))(),
      blocker: () => (this.d.blocker ?? (() => moveBlocker(this.checkLink, this.c.triggerIds())))(),
      // The ids are read before the drop (the link's last push); their memory right after it.
      dropScope: async () => {
        ids = this.c.triggerIds()
        await (this.d.dropScope ?? (() => dropWalnutScope(this.checkLink)))()
      },
      takeMemory: () => (this.d.takeMemory ?? (() => takeTriggerMemory(this.checkLink, ids, sleep)))(),
      // Kept memory of a trigger deleted meanwhile is not carried; the ids are known once this connect pushed.
      liveTriggerIds: () => (this.c.triggersPushed?.() ? ids : null),
      drainJournal: () => (this.d.drainJournal ?? (() => this.c.drainJournal(JOURNAL_DRAIN_MS)))(),
      carry: (memory) => this.seeder.seed(memory),
      // Dialled again, the shared daemon gets this Walnut's follower, triggers and plugin jobs back from
      // the connect's own pushes (they wait for the release, then go there).
      restore: async () => { await this.c.relink(moveReconnectMs()) },
      flip: async () => {
        if (kind === 'ssh') {
          if (!record.runtimeDir) throw new Error('the set\'s runtime dir on the host is not known')
          this.sshOverride = record.runtimeDir
          return
        }
        const paired = await hostServiceSets.read(this.place).catch(() => null)
        if (paired?.set !== set || !paired.netEndpoint) throw new Error('the set\'s own walnut-net is not paired')
        this.netOverride = paired.netEndpoint
      },
      unflip: async () => {
        // The shared endpoint is still a member on both sides until the move is confirmed.
        this.sshOverride = null
        this.netOverride = null
      },
      confirm: async () => {
        // The move's done record is on disk by now (low 11): the dir or endpoint comes from the host's record from here on.
        await markServiceSetMoved(this.place, set, this.now())
        this.sshOverride = null
        this.netOverride = null
      },
      // After the release (X1): its net-forget is a command on the link that must never wait for the hold.
      afterMove: () => this.leaveShared(set),
      reconnect: (boundMs) => this.c.relink(boundMs),
      report: (o) => this.report(o),
    }).finally(() => {
      // Whatever ended the move (a store that would not write included), the host's work is never left held.
      if (this.holding) { this.holding = false; this.c.setHold(false); this.c.redeliver() }
    })
    const p = moveOnce(this.place, run)
    this.moving = p
    void p.catch(() => undefined).finally(() => { if (this.moving === p) this.moving = null })
    return p
  }

  private report(o: MoveOutcome): void {
    const host = this.c.hostKey
    if (o.result === 'moved') {
      this.standingNow = 'own'
      log.session.info('service set: this Walnut\'s sessions moved to its own service on the host', { host, stopped: o.stopped })
      this.c.notice(this.noticeKey, null)
      return
    }
    if (o.result === 'not_due') {
      // A reconnect's look found the try not due yet: the timer it replaced is set again for that try (review round 2, M4).
      if (typeof o.nextTryAt === 'number') this.schedule(Math.max(0, o.nextTryAt - this.now()) + 1_000)
      return
    }
    log.session.warn('service set: the move to this Walnut\'s own service did not happen', { host, result: o.result, why: o.why, stopped: o.stopped, failures: o.failures })
    const again = o.final
      ? `It failed ${o.failures} times in a row, so Walnut stops trying by itself; the next update of this host tries again.`
      : 'Walnut tries again later.'
    // The next try comes by itself at its time while the link stays up (drill D2: only a new connect looked again).
    if (!o.final && typeof o.nextTryAt === 'number') this.schedule(Math.max(0, o.nextTryAt - this.now()) + 1_000)
    this.c.notice(this.noticeKey, `This Walnut's sessions on ${host} stay on the service another Walnut runs there for now (${o.why}). ${again}`)
  }
}
