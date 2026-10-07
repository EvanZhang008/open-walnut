/**
 * Leader book: which Walnut server leads this host's work, per Walnut
 * (docs/plan/walnut-control-plane.md).
 *
 * Two servers can lead a Walnut: its primary (the Mac, over the trusted SSH
 * socket) and, while the primary is away, its cloud companion (over the bridge).
 * The book keeps, per Walnut (keyed by its data dir, `home`, as the offline host
 * is):
 *   - who leads now (`holder`) and the lead's number (`epoch`);
 *   - whether the user lets the companion lead at all (`backup`, pushed by the
 *     primary with `leader.configure`);
 *   - when this host last heard the primary (any frame or pong on a socket
 *     tagged with that home), which is what makes this host a witness.
 *
 * The rules, all decided here:
 *   - the primary always gets the lead back (`primaryClaim`); taking it from the
 *     companion raises the epoch;
 *   - the companion gets it only with a higher epoch than this host holds, only
 *     when the user allowed it, and only once THIS host has not heard the
 *     primary for `takeoverMs` (a sleeping Mac keeps its sockets open, so the
 *     test is silence, not a closed socket);
 *   - a companion command that carries an old epoch, or arrives while the
 *     primary leads, is refused (`fence`).
 *
 * How the daemon twins get it: daemon-standalone.ts imports createLeaderBook;
 * daemon-source.ts inlines `createLeaderBook.toString()` through
 * `__CREATE_LEADER_BOOK__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export type LeaderHolder = 'primary' | 'backup'

export interface LeaderRecord {
  v: 1
  home: string
  /** The primary's own id (its instance id); the companion names the Walnut by it. */
  walnutId: string
  /** The user lets the cloud companion lead while the primary is away. */
  backup: boolean
  epoch: number
  holder: LeaderHolder
  /** When the current holder took the lead. */
  since: number
}

export interface LeaderWitness {
  walnutId: string
  epoch: number
  holder: LeaderHolder
  /** A primary socket of this Walnut is open and was heard within takeoverMs. */
  primaryConnected: boolean
  primaryHeardAgoMs: number
}

export type LeaderRefusal = { ok: false; code: 'unknown_walnut' | 'not_enabled' | 'stale_epoch' | 'primary_alive' | 'not_leader'; message: string; epoch?: number }

export interface LeaderBookDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory for leader-<key>.json. */
  dir: string
  now: () => number
  /** Short stable file key for a home (homes are paths). */
  keyOf: (home: string) => string
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** How long this host must not have heard a primary before the companion may lead. */
  takeoverMs: number
  /** When this daemon started: a primary never heard since then was last heard then, at best. */
  bootAt: number
}

export function createLeaderBook(deps: LeaderBookDeps) {
  const { fs, path } = deps
  const records = new Map<string, LeaderRecord>()
  const heard = new Map<string, number>()
  const WALNUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

  function file(home: string): string {
    return path.join(deps.dir, `leader-${deps.keyOf(home)}.json`)
  }

  function persist(rec: LeaderRecord): void {
    try {
      fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
      const target = file(rec.home)
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
      fs.renameSync(tmp, target)
    } catch (err) {
      deps.log('warn', 'leader book: persist failed', { home: rec.home, error: (err as Error).message })
    }
  }

  function load(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    for (const name of names) {
      if (!name.startsWith('leader-') || !name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(deps.dir, name), 'utf8')) as LeaderRecord
        if (rec && rec.v === 1 && typeof rec.home === 'string' && typeof rec.walnutId === 'string' && typeof rec.epoch === 'number') {
          records.set(rec.home, rec)
        }
      } catch { /* a torn file is rewritten by the next configure */ }
    }
  }

  function byWalnut(walnutId: string): LeaderRecord | undefined {
    for (const rec of records.values()) if (rec.walnutId === walnutId) return rec
    return undefined
  }

  function primaryAgeMs(home: string): number {
    return Math.max(0, deps.now() - (heard.get(home) ?? deps.bootAt))
  }

  /** The primary of `home` said something (a frame, a ping, a pong). */
  function noteHeard(home: string | undefined): void {
    if (home) heard.set(home, deps.now())
  }

  /**
   * The primary describes its Walnut. A first configure starts at epoch 1 with
   * the primary leading; later ones only change the backup permission. The
   * reply tells the primary whether the companion holds the lead, so it can
   * take the record back before it claims.
   */
  function configure(input: { home: string; walnutId: string; backup: boolean }): LeaderRecord {
    if (!input || typeof input.home !== 'string' || !input.home) throw new Error('leader.configure: missing home')
    if (typeof input.walnutId !== 'string' || !WALNUT_ID_RE.test(input.walnutId)) throw new Error('leader.configure: bad walnutId')
    const prev = records.get(input.home)
    const rec: LeaderRecord = prev
      ? { ...prev, walnutId: input.walnutId, backup: input.backup === true }
      : { v: 1, home: input.home, walnutId: input.walnutId, backup: input.backup === true, epoch: 1, holder: 'primary', since: deps.now() }
    records.set(input.home, rec)
    noteHeard(input.home)
    if (!prev || prev.backup !== rec.backup || prev.walnutId !== rec.walnutId) persist(rec)
    return rec
  }

  /** The primary takes (or keeps) the lead. From the companion, the epoch moves on. */
  function primaryClaim(home: string): LeaderRecord | null {
    const rec = records.get(home)
    if (!rec) return null
    noteHeard(home)
    if (rec.holder === 'primary') return rec
    const next: LeaderRecord = { ...rec, holder: 'primary', epoch: rec.epoch + 1, since: deps.now() }
    records.set(home, next)
    persist(next)
    deps.log('info', 'leader: the primary took the lead back', { home, epoch: next.epoch, backupLedMs: deps.now() - rec.since })
    return next
  }

  /** What this host can tell the companion: only Walnuts that let it lead. */
  function witness(isConnected: (home: string) => boolean): LeaderWitness[] {
    const out: LeaderWitness[] = []
    for (const rec of records.values()) {
      if (!rec.backup) continue
      const age = primaryAgeMs(rec.home)
      out.push({
        walnutId: rec.walnutId,
        epoch: rec.epoch,
        holder: rec.holder,
        primaryConnected: isConnected(rec.home) && age < deps.takeoverMs,
        primaryHeardAgoMs: age,
      })
    }
    return out
  }

  /** The companion asks for the lead of `walnutId` at `epoch`. */
  function backupClaim(walnutId: unknown, epoch: unknown): { ok: true; record: LeaderRecord } | LeaderRefusal {
    const rec = typeof walnutId === 'string' ? byWalnut(walnutId) : undefined
    if (!rec) return { ok: false, code: 'unknown_walnut', message: 'this host does not know that Walnut' }
    if (!rec.backup) return { ok: false, code: 'not_enabled', message: 'the user has not let the cloud companion lead this Walnut' }
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch <= rec.epoch) {
      return { ok: false, code: 'stale_epoch', message: `epoch must be above ${rec.epoch}`, epoch: rec.epoch }
    }
    const age = primaryAgeMs(rec.home)
    if (age < deps.takeoverMs) {
      return { ok: false, code: 'primary_alive', message: `this host heard the primary ${Math.round(age / 1000)}s ago`, epoch: rec.epoch }
    }
    const next: LeaderRecord = { ...rec, holder: 'backup', epoch, since: deps.now() }
    records.set(rec.home, next)
    persist(next)
    deps.log('info', 'leader: the cloud companion leads', { home: rec.home, epoch, primarySilentMs: age })
    return { ok: true, record: next }
  }

  /** A companion command for `walnutId` is honoured only from the current lead. */
  function fence(walnutId: unknown, epoch: unknown): { ok: true; home: string; epoch: number } | LeaderRefusal {
    const rec = typeof walnutId === 'string' ? byWalnut(walnutId) : undefined
    if (!rec) return { ok: false, code: 'unknown_walnut', message: 'this host does not know that Walnut' }
    if (rec.holder !== 'backup') return { ok: false, code: 'not_leader', message: 'the primary leads this Walnut', epoch: rec.epoch }
    if (epoch !== rec.epoch) return { ok: false, code: 'stale_epoch', message: `the current epoch is ${rec.epoch}`, epoch: rec.epoch }
    return { ok: true, home: rec.home, epoch: rec.epoch }
  }

  /** The companion's lead of `home`, when it holds one. */
  function backupLead(home: string | undefined): { walnutId: string; epoch: number } | null {
    const rec = home ? records.get(home) : undefined
    return rec && rec.holder === 'backup' && rec.backup ? { walnutId: rec.walnutId, epoch: rec.epoch } : null
  }

  load()

  return {
    configure, primaryClaim, witness, backupClaim, fence, backupLead, noteHeard, primaryAgeMs,
    recordOf: (home: string) => records.get(home) ?? null,
  }
}

export type LeaderBook = ReturnType<typeof createLeaderBook>
