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
  /**
   * The journal v2 kinds the primary drains (`leader.configure {drains}`, journal-v2).
   * Absent: an older Mac, so this host writes v1 kinds only for it.
   */
  drains?: string[]
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
  /**
   * Older homes of the book (a daemon of an earlier build kept it in its own dir): read by
   * importLegacy() (the boot migration); a record there that wins is copied here.
   */
  legacyDirs?: string[]
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

  /**
   * Whether a legacy dir or file is this user's own (lstat: never a symlink, this uid, a dir
   * not world writable). On a shared host another user can plant /tmp/open-walnut: a leader
   * record read from it would name the holder of this user's Walnut. Twin of the journal's
   * ownLegacy (offline-journal-core.ts); each factory stays self-contained as text.
   */
  function ownLegacy(p: string, kind: 'dir' | 'file'): boolean {
    try {
      const st = fs.lstatSync(p)
      if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return false
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1
      if (uid >= 0 && st.uid !== uid) return false
      return kind === 'file' || (st.mode & 0o002) === 0
    } catch { return false }
  }

  function loadDir(dir: string, legacy: boolean): void {
    let names: string[] = []
    // The daemon dir holding it too: a planted /tmp/open-walnut is a symlink there, or another user's.
    if (legacy && !(ownLegacy(path.dirname(path.resolve(dir)), 'dir') && ownLegacy(dir, 'dir'))) {
      let exists = false
      try { fs.lstatSync(dir); exists = true } catch { /* none: nothing to read */ }
      if (exists) deps.log('error', 'leader book: a legacy dir is not this user\'s own (a symlink, another owner, or world writable); not read', { dir })
      return
    }
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      if (!name.startsWith('leader-') || !name.endsWith('.json')) continue
      if (legacy && !ownLegacy(path.join(dir, name), 'file')) {
        deps.log('error', 'leader book: a legacy record that is not this user\'s own regular file; not read', { file: path.join(dir, name) })
        continue
      }
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LeaderRecord
        if (rec && rec.v === 1 && typeof rec.home === 'string' && typeof rec.walnutId === 'string' && typeof rec.epoch === 'number') {
          const mine = records.get(rec.home)
          let take: LeaderRecord = rec
          if (legacy && mine) {
            // The epoch never goes back, and the later lead change (`since`) names the holder.
            // A legacy record with a later lead change wins (a companion takeover a downgraded
            // daemon took is newer than this book, even at a lower number), at an epoch past
            // this book's. One with an older lead change never names the holder, even at a
            // higher epoch (this book's record was written after it, by a configure while the
            // legacy file could not be read): this book only raises its epoch past the
            // legacy one. Either way a command at either old epoch is fenced.
            const later = typeof rec.since === 'number' && rec.since > mine.since
            if (later) take = { ...rec, epoch: Math.max(rec.epoch, mine.epoch + 1) }
            else if (rec.epoch > mine.epoch) take = { ...mine, epoch: rec.epoch + 1 }
            else continue
          }
          records.set(rec.home, take)
          if (legacy) {
            persist(take)
            deps.log('info', 'leader book: record taken from an older dir', { home: take.home, epoch: take.epoch, holder: take.holder, from: dir, ...(take !== rec ? { legacyEpoch: rec.epoch } : {}) })
          }
        }
      } catch { /* a torn file is rewritten by the next configure */ }
    }
  }

  /** This dir's book only: building a book never writes (every run of the daemon binary builds one). */
  function load(): void {
    loadDir(deps.dir, false)
  }

  /**
   * The records an older build left in `legacyDirs` (a v1 daemon kept the book in its own
   * DAEMON_DIR; only this user's own dirs and files are read): one that wins is copied into
   * this dir; the legacy file is never changed, and one it cannot read is tried at the next
   * boot. Called by the boot migration only, once daemon.pid names this process.
   */
  function importLegacy(): void {
    for (const dir of deps.legacyDirs ?? []) {
      if (path.resolve(dir) !== path.resolve(deps.dir)) loadDir(dir, true)
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
   * Whether this daemon heard the primary of `home` at all since it started (D14). The
   * follower view counts a primary unheard since boot as not answering, while the
   * companion's takeover keeps the boot grace (`primaryAgeMs` from `bootAt`).
   */
  function heardSinceBoot(home: string): boolean {
    return heard.has(home)
  }

  const KIND_RE = /^[a-z0-9-]{1,40}$/

  /** The v2 kinds a configure names: strings of the kind alphabet, at most 32, sorted. */
  function drainsOf(input: unknown): string[] | undefined {
    if (!Array.isArray(input)) return undefined
    return [...new Set(input.filter((k): k is string => typeof k === 'string' && KIND_RE.test(k)))].slice(0, 32).sort()
  }

  /**
   * The primary describes its Walnut. A first configure starts at epoch 1 with
   * the primary leading; later ones only change the backup permission. The
   * reply tells the primary whether the companion holds the lead, so it can
   * take the record back before it claims.
   */
  function configure(input: { home: string; walnutId: string; backup: boolean; drains?: unknown }): LeaderRecord {
    if (!input || typeof input.home !== 'string' || !input.home) throw new Error('leader.configure: missing home')
    if (typeof input.walnutId !== 'string' || !WALNUT_ID_RE.test(input.walnutId)) throw new Error('leader.configure: bad walnutId')
    const prev = records.get(input.home)
    // A configure without `drains` is an older Mac (or a rollback): it drains v1 kinds only.
    const drains = drainsOf(input.drains)
    const base: LeaderRecord = prev
      ? { ...prev, walnutId: input.walnutId, backup: input.backup === true }
      : { v: 1, home: input.home, walnutId: input.walnutId, backup: input.backup === true, epoch: 1, holder: 'primary', since: deps.now() }
    const { drains: _old, ...rest } = base
    const rec: LeaderRecord = drains ? { ...rest, drains } : rest
    records.set(input.home, rec)
    noteHeard(input.home)
    const drainsChanged = (prev?.drains ?? []).join(',') !== (rec.drains ?? []).join(',') || !!prev?.drains !== !!rec.drains
    if (!prev || prev.backup !== rec.backup || prev.walnutId !== rec.walnutId || drainsChanged) persist(rec)
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

  /** Whether the companion leads any Walnut on this host. */
  function anyBackupLead(): boolean {
    for (const rec of records.values()) if (rec.holder === 'backup' && rec.backup) return true
    return false
  }

  load()

  return {
    configure, primaryClaim, witness, backupClaim, fence, backupLead, anyBackupLead, noteHeard, primaryAgeMs, heardSinceBoot, importLegacy,
    recordOf: (home: string) => records.get(home) ?? null,
    /** The v2 kinds the primary of `home` drains, or null (an older Mac, or none configured). */
    drainsFor: (home: string) => records.get(home)?.drains ?? null,
  }
}

export type LeaderBook = ReturnType<typeof createLeaderBook>
