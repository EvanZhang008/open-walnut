/**
 * One host link's part in service sets (the experiment host_service_sets): what the host named,
 * the first look and install (service-set-provision.ts), and the move of this Walnut's sessions
 * from another Walnut's shared daemon to its own set (service-set-move.ts), built from the link
 * (daemon-connection.ts gives it SetLinkConn). With the experiment off, nothing here runs: every
 * entry point returns at its first line.
 *
 * Holding reuses the queue a host that is briefly away has (session-lifecycle.md "A message to a
 * host nothing reaches waits for that host"): while held, the link refuses `start` and `send` with
 * its "not connected" words and reads as down (hostLinkDown), so the runner keeps the rows pending,
 * and every other command that starts work there waits (service-set-hold.ts); the release asks the
 * runner to deliver the rows, to whatever the link reaches then.
 *
 * A host whose move is done stays this Walnut's set for this leader whatever the experiment says
 * later (review round 1, B7): its lines keep naming the Walnut and SSH keeps dialling the set's
 * runtime dir, so the other Walnut's default service is never updated from here; the experiment
 * gates only new moves.
 */
import { log } from '../logging/index.js'
import { hostServiceSets, hostServiceSetsWanted, linkStanding, markServiceSetMoved, movedToSet, recordServiceSetFrom, type HostSetRecord, type LinkStanding, type SetAsk } from './service-set-leader.js'
import { moveOnce, moveReconnectMs, runMove, serviceSetMoves, settleMove, type MoveDeps, type MoveOutcome, type MoveSession, type StopResult } from './service-set-move.js'
import { dropWalnutScope, moveSessions, openWorkThere, stopFollowerThere, stopProven, type MoveCheckLink } from './service-set-move-checks.js'
import type { SetProvision } from './service-set-provision.js'
import { isServiceSetId } from './service-set.js'
import { shq } from './daemon-net-update-io.js'
import { DAEMON_VERSION_ARGS } from './daemon-service-update.js'

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
  /** A shell line on the host (SSH exec, or the daemon's exec over the host network). */
  run(command: string, timeoutMs?: number): Promise<string>
  /** This build's executable on the host, then the set check and install (service-set-provision.ts). */
  provision(ask: SetAsk): Promise<SetProvision>
  /** Drop the link and dial again; the set the new hello names, or null with no hello within `boundMs`. */
  relink(boundMs: number): Promise<string | null>
  /** Hold (or release) this Walnut's work for this host. */
  setHold(on: boolean): void
  /** Ask the runner to deliver what waited for this host (the reconnect hook). */
  redeliver(): void
  /** This Walnut's data dir and id. */
  home: string
  walnutId(): Promise<string>
  /** A host health notice (Walnut Health), by key; null clears it. */
  notice(key: string, text: string | null): void
}

/** Dependencies a test replaces; the defaults ask the shared daemon and this server (service-set-move-checks.ts). */
export interface SetLinkDeps {
  sessions?(hostKey: string): Promise<MoveSession[]>
  stop?(sessionId: string): Promise<StopResult>
  openWork?(): Promise<string | null>
  dropScope?(): Promise<void>
  stopFollower?(): Promise<void>
  endpointId?(): Promise<string | null>
  now?(): number
  sleep?(ms: number): Promise<void>
  settleMs?: number
  /** How long the host keeps a flipped net route that nobody confirms before it puts it back. */
  revertAfterSeconds?: number
}

/** Provisioning at most this often per link while nothing changes (a status line, maybe an upload). */
const PROVISION_EVERY_MS = 30 * 60_000

/** This machine's walnut-net endpoint id (its local daemon's net status). */
async function localEndpointId(): Promise<string | null> {
  const { link } = await import('../core/hosts/link.js')
  const local = await link('__local__')
  const s = await local.send('net.status', {}, 5_000) as { endpointId?: unknown }
  return typeof s.endpointId === 'string' && /^[0-9a-f]{64}$/.test(s.endpointId) ? s.endpointId : null
}

/**
 * The shell that runs `walnut daemon <words>` with this build's copy in the set's install root (the
 * build its install put there: versions/<sha>/, the first that names `expected`), its JSON answer on
 * stdout; a set with no such copy answers `no_build`.
 */
export function setCliCommand(set: string, expected: string, words: string): string {
  if (!isServiceSetId(set)) throw new Error('not a service set id')
  const versions = `"$HOME/.open-walnut-host/walnuts/${set}/daemon/versions"`
  return [
    `x=; for f in ${versions}/*/*; do [ -x "$f" ] || continue; [ "$("$f" ${DAEMON_VERSION_ARGS} 2>/dev/null | tail -n 1)" = ${shq(expected)} ] && { x=$f; break; }; done`,
    `[ -n "$x" ] || { echo '{"ok":false,"code":"no_build","message":"this Walnut\\u0027s build is not in its set on the host"}'; exit 0; }`,
    `"$x" walnut daemon ${words} 2>/dev/null || true`,
  ].join('\n')
}

/** `walnut daemon net-route` for this leader's endpoint (net-route.ts on the host). */
export function netRouteCommand(set: string, expected: string, args: string): string {
  return setCliCommand(set, expected, `net-route ${args}`)
}

export class ServiceSetLink {
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking: Promise<void> | null = null
  private provisionedAt = 0
  /** SSH: the set's runtime dir while a move points the link there (before its record says done). */
  private sshOverride: string | null = null
  private standingNow: LinkStanding = 'unknown'
  /** The move holds this host's starts and sends now. */
  private holding = false
  private stopped = false

  constructor(private readonly c: SetLinkConn, private readonly d: SetLinkDeps = {}, readonly expected: () => string | null = () => null) {}

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
    let { standing, record } = await this.standingFor()
    if (standing === 'default') return
    if (standing === 'own') {
      await settleMove({ set: record!.set, store: this.store(), confirm: () => this.confirmRoute(record!.set), now: this.now })
      await markServiceSetMoved(this.place, record!.set, this.now())
      this.c.notice(this.noticeKey, null)
      return
    }
    // Unknown, or a set of its own while the link reaches another daemon: look (and install) first,
    // once per link and then at most every PROVISION_EVERY_MS (a status line, maybe an upload).
    const look = standing === 'unknown' || this.provisionedAt === 0 || (this.c.kind() === 'ssh' && !record?.runtimeDir)
    if (look && (this.provisionedAt === 0 || this.now() - this.provisionedAt >= PROVISION_EVERY_MS)) {
      this.provisionedAt = Math.max(1, this.now())
      const p = await this.c.provision(ask).finally(() => { this.lookEnded = true })
      if (p.set === null) return
      await recordServiceSetFrom(this.place, `service set: ${p.set || 'default'}`, p.runtimeDir)
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

  private get noticeKey(): string { return `service-set:${this.c.hostKey}` }
  private now = (): number => (this.d.now ?? Date.now)()

  private store(): MoveDeps['store'] {
    return { read: () => serviceSetMoves.read(this.place), write: (r) => serviceSetMoves.write(this.place, r) }
  }

  private async confirmRoute(set: string): Promise<void> {
    if (this.c.kind() !== 'net') return
    const member = await (this.d.endpointId ?? localEndpointId)()
    const expected = this.expected()
    if (!member || !expected) return
    const walnutId = await this.c.walnutId()
    await this.c.run(netRouteCommand(set, expected, `--walnut ${walnutId} --member ${member} --confirm`), 30_000)
  }

  /** The link's part the shared daemon's checks use. */
  private get checkLink(): MoveCheckLink {
    const c = this.c
    return { hostKey: c.hostKey, home: c.home, send: (cmd, p, t) => c.send(cmd, p, t), hasCapability: (x) => c.hasCapability(x), workUnderWay: () => c.workUnderWay(), walnutId: () => c.walnutId() }
  }

  private move(record: HostSetRecord, force: boolean): Promise<MoveOutcome> {
    const set = record.set
    const kind = this.c.kind()!
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }))
    const run = (): Promise<MoveOutcome> => runMove({
      set, link: kind, now: this.now, force, sleep,
      store: this.store(),
      sessions: () => (this.d.sessions ? this.d.sessions(this.c.hostKey) : moveSessions(this.checkLink)),
      openWork: () => (this.d.openWork ?? (() => openWorkThere(this.checkLink)))(),
      stop: (id) => (this.d.stop ?? ((x: string) => stopProven(this.checkLink, x)))(id),
      hold: () => { this.holding = true; this.c.setHold(true) },
      drained: (boundMs) => this.c.drained(boundMs),
      release: () => { this.holding = false; this.c.setHold(false); this.c.redeliver() },
      // Only a daemon that has no followers at all has nothing to stop; any other doubt ends the try (should-fix 7).
      stopFollower: () => (this.d.stopFollower ?? (() => stopFollowerThere(this.checkLink, sleep)))(),
      dropScope: () => (this.d.dropScope ?? (() => dropWalnutScope(this.checkLink)))(),
      // Dialled again, the shared daemon gets this Walnut's follower, triggers and plugin jobs back from
      // the connect's own pushes (they wait for the release, then go there).
      restore: async () => { await this.c.relink(moveReconnectMs()) },
      flip: async () => {
        if (kind === 'ssh') {
          if (!record.runtimeDir) throw new Error('the set\'s runtime dir on the host is not known')
          this.sshOverride = record.runtimeDir
          return
        }
        const member = await (this.d.endpointId ?? localEndpointId)()
        const expected = this.expected()
        if (!member) throw new Error('this machine\'s host network endpoint is not known')
        if (!expected) throw new Error('this server names no daemon build')
        const walnutId = await this.c.walnutId()
        const said = await this.c.run(netRouteCommand(set, expected, `--walnut ${walnutId} --member ${member} --revert-after ${this.d.revertAfterSeconds ?? 120}`), 60_000)
        const reply = parseRouteReply(said)
        if (!reply.ok) throw new Error(`the host did not route this Walnut to its own service: ${reply.message}`)
      },
      unflip: async () => {
        if (kind === 'ssh') { this.sshOverride = null; return }
        const member = await (this.d.endpointId ?? localEndpointId)()
        const expected = this.expected()
        if (!member || !expected) return
        const walnutId = await this.c.walnutId()
        // Over the link that reaches the host now; the host's own revert fires anyway if this one cannot go.
        await this.c.run(netRouteCommand(set, expected, `--walnut ${walnutId} --member ${member} --revert`), 30_000).catch(() => '')
      },
      confirm: async () => {
        // The move's done record is on disk by now (low 11): the SSH dir comes from the host's record from here on.
        await markServiceSetMoved(this.place, set, this.now())
        this.sshOverride = null
        await this.confirmRoute(set)
      },
      reconnect: (boundMs) => this.c.relink(boundMs),
      report: (o) => this.report(o),
    }).finally(() => {
      // Whatever ended the move (a store that would not write included), the host's work is never left held.
      if (this.holding) { this.holding = false; this.c.setHold(false); this.c.redeliver() }
    })
    return moveOnce(this.place, run)
  }

  private report(o: MoveOutcome): void {
    const host = this.c.hostKey
    if (o.result === 'moved') {
      this.standingNow = 'own'
      log.session.info('service set: this Walnut\'s sessions moved to its own service on the host', { host, stopped: o.stopped })
      this.c.notice(this.noticeKey, null)
      return
    }
    if (o.result === 'not_due') return
    log.session.warn('service set: the move to this Walnut\'s own service did not happen', { host, result: o.result, why: o.why, stopped: o.stopped, failures: o.failures })
    const again = o.final
      ? `It failed ${o.failures} times in a row, so Walnut stops trying by itself; the next update of this host tries again.`
      : 'Walnut tries again later.'
    // The next try comes by itself at its time while the link stays up (drill D2: only a new connect looked again).
    if (!o.final && typeof o.nextTryAt === 'number') this.schedule(Math.max(0, o.nextTryAt - this.now()) + 1_000)
    this.c.notice(this.noticeKey, `This Walnut's sessions on ${host} stay on the service another Walnut runs there for now (${o.why}). ${again}`)
  }
}

/** The JSON answer of `walnut daemon net-route`: ok, or why not. */
export function parseRouteReply(said: string): { ok: boolean; message: string } {
  const at = said.indexOf('{')
  try {
    const r = JSON.parse(said.slice(at)) as { ok?: unknown; error?: unknown; message?: unknown; code?: unknown; failure?: { message?: unknown } }
    return { ok: r.ok === true, message: String(r.error ?? r.message ?? r.failure?.message ?? r.code ?? '') }
  } catch {
    return { ok: false, message: said.trim().split('\n').pop()?.slice(0, 200) || 'no answer' }
  }
}
