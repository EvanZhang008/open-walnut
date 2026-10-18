/**
 * Journal v2: one append-only journal per Walnut on a host, written by the
 * daemon while that Walnut's server is away (docs/plan/walnut-replica-servers-impl.md
 * section 5). The offline host (offline-host-core.ts) is its only caller.
 *
 * Files, all in `deps.dir` (`offline-host` under the host's ONE journal root: ~/.open-walnut/tmp
 * for the host's own daemon, DAEMON_DIR for an isolated one; plan section 5 Location):
 *   journal-<key>.ndjson      a header line, then one JSON record per line, and
 *                             ack lines; append-only (fdatasync per append), rewritten
 *                             only by compaction (tmp + rename)
 *   journal-<key>.state.json  {v:2, journalId, nextSeq, frozen, rows, settledCopies, ...}
 *   journal-<key>.lock        the per-home writer lock (O_EXCL, pid plus start time)
 *   blobs/<sha256>            content-addressed note bodies
 *
 * Rules this file owns:
 *   - a record is `{v:2, seq, opId, rev, at, actor?, kind, supersedes?, ...}`; readers fold by
 *     opId and keep the highest rev, so a coalesced save is a NEW line, never an edit in place;
 *   - a record a drain handed out is frozen until acked: a later save never supersedes it;
 *   - every write runs under the lock after re-reading the file tail, so `nextSeq` comes from
 *     disk and two processes on one dir never reuse a seq or lose a line;
 *   - an old Mac (a drain without `kinds`) is handed only the v1 prefix before the first
 *     record it cannot take, and its `upTo` ack drops only seqs it was handed;
 *   - a v1 journal (`journal-<key>.json`) found at boot is appended as v2 lines (opId
 *     `v1-<record hash>`), then renamed `.migrated` (`.unconverted` when a record, or the
 *     file's shape, cannot be converted); a v1 file is never edited, a migrated record or
 *     request row the Mac acked is remembered, never imported again, and while a file is
 *     left part way the home's new writes are refused (`migrating`) so none lands ahead.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createOfflineJournal;
 * daemon-source.ts inlines `createOfflineJournal.toString()` through
 * `__CREATE_OFFLINE_JOURNAL__`. So the factory body references NOTHING at module
 * scope (globals such as JSON, Buffer, Atomics are fine).
 */

export type JournalActor =
  | { kind: 'session'; sid: string }
  | { kind: 'device'; deviceId: string; name?: string }
  | { kind: 'trigger'; id: string }

/** A pending record as readers see it: the v1 shape plus the v2 bookkeeping. */
export interface JournalRecord {
  v?: 2
  seq: number
  opId?: string
  rev?: number
  at: number
  actor?: JournalActor
  kind: string
  supersedes?: number
  online?: true
  /** The callers' own op ids of the saves this record folded in (a retry of one is a duplicate). */
  saveOpIds?: string[]
  /** The seq a migrated v1 record had in its v1 journal. */
  v1Seq?: number
  /** A coalesce that cancelled the record (a note created, then deleted). */
  dropped?: true
  [key: string]: unknown
}

export type JournalRefusal = { ok: false; code: string; message: string; why?: string; retryAfterMs?: number; detail?: unknown }

export type AppendResult =
  | { ok: true; seq: number; opId: string; rev: number; coalesced?: true; duplicate?: true; dropped?: true }
  | JournalRefusal

export interface JournalStats {
  records: number
  drainable: number
  bytes: number
  blobBytes: number
  oldestAt: number | null
  lastDrainAt: number | null
  lastAckSeq: number | null
}

export interface OfflineJournalDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory of the journals (`offline-host` under the host's one journal root). */
  dir: string
  now: () => number
  randomHex: (bytes: number) => string
  /** Short stable file key for a home (homes are paths). */
  keyOf: (home: string) => string
  /** Hex sha256 of a body (blob names). */
  sha256: (body: Uint8Array) => string
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** This process (the lock names it). Defaults to process.pid. */
  pid?: number
  /** A process's start time token, so a reused pid never holds a lock. Absent: pid liveness alone. */
  startTimeOf?: (pid: number) => string | null
  /** Whether this process owns the daemon dir (daemon.pid names it). Absent: always. */
  isOwner?: () => boolean
  /** fdatasync every append (default true; property tests turn it off for speed). */
  durable?: boolean
  /**
   * Keep each journal's append fd open between appends (the daemons: one long-lived
   * store per dir). Off by default, so a test that drops stores leaks no fds; `close()`
   * releases them.
   */
  keepOpen?: boolean
  /** Unacked records per home (default 1000). */
  maxRecords?: number
  /** Blob bytes per home (default 200 MB). */
  blobBudget?: number
  /**
   * How long a writer waits for the lock before it answers journal_unwritable (default
   * 250 ms). Every wait blocks the daemon's one thread, so a hold that outlasted it is
   * remembered: while that same lock file stays, later calls try once and answer at once
   * instead of waiting again (a new hold, even by the same process, is waited for again).
   */
  lockWaitMs?: number
  /**
   * v1 records were appended after the boot migration (a v1 file it left part way, or one
   * whose Walnut it did not know, finished once a write or a configure named that Walnut):
   * whatever the daemon armed from the journal (the trigger holds) is armed again.
   */
  migrated?: (home: string, records: number) => void
}

/** v1 kinds: every Mac drains these. 'op' is v1 only. */
export const JOURNAL_V1_KINDS = ['row', 'settle', 'delivery', 'settings', 'stop', 'resume', 'op']
/** v2 kinds a new Mac lists in `leader.configure {drains}` (device-actor is a capability, not a kind). */
export const JOURNAL_V2_DRAINS = ['task-fields', 'task-create', 'task-move', 'board', 'note', 'session', 'device-actor', 'device-revoke']

/** Options of one append (a type only: the factory below stays self-contained as text). */
export interface AppendOpts {
  actor?: JournalActor
  /** The writer's op id (a client's x-walnut-op-id): a retry with it is answered, not written. */
  opId?: string
  online?: boolean
  /** Fold a note or task-fields save into the latest pending one (default true). */
  coalesce?: boolean
  /** Count this record against the per-home limit (queued writes). */
  limit?: boolean
  /** Asked only for a save that adds a record (not a coalesce, not a retry): the write budget. */
  admit?: () => JournalRefusal | { ok: false; error: { code: string; message: string; retryAfterMs?: number } } | null
  /** Migration and import only: the record's own time, rev and v1 seq. */
  at?: number
  rev?: number
  v1Seq?: number
}

interface HomeJournal {
  home: string
  key: string
  journalId: string
  /** Pending records (latest rev per opId, not acked, not dropped), by seq. */
  pending: Map<number, JournalRecord>
  /** Bytes of each pending record's line, for the dead-bytes count. */
  lineBytes: Map<number, number>
  /** opId and saveOpId -> the seq of the pending record that carries it. */
  byOp: Map<string, number>
  /** Highest seq ever seen in this journal (lines and the header's floor). */
  maxSeq: number
  /** Handed out by a drain and not acked yet: never superseded. */
  frozen: Set<number>
  rows: Record<string, unknown>
  settledCopies: string[]
  migratedV1: string[]
  /** Op ids of migrated v1 records that were acked (folded or not): a v1 file never brings one back. */
  importedAcked: string[]
  lastDrainAt: number | null
  lastAckSeq: number | null
  /** File identity and the offset read so far (tail re-read). */
  ino: number
  offset: number
  bytes: number
  badLines: string[]
  stateDirty: boolean
  /** state.json as last read or written (ino:size:mtime): unchanged means not re-read. */
  stateSig: string
  /**
   * Whether state.json was read (or found absent) since this journal was built. False after a
   * read error: the next locked call reads it in full before any write, so a write never saves
   * blank rows or acked ids over a state.json it could not read.
   */
  stateLoaded: boolean
  /** The last state.json read error ('' none): logged once, not at every read that retries it. */
  stateError: string
  /** keepOpen: the append fd and the inode it names (reused only while the path names it). */
  fd: number
  fdIno: number
}

export function createOfflineJournal(deps: OfflineJournalDeps) {
  const { fs, path } = deps
  const V1_KINDS = ['row', 'settle', 'delivery', 'settings', 'stop', 'resume', 'op']
  const MAX_RECORDS = deps.maxRecords ?? 1000
  const BLOB_BUDGET = deps.blobBudget ?? 200 * 1024 * 1024
  const BLOB_CHUNK = 2 * 1024 * 1024
  const COMPACT_BYTES = 4 * 1024 * 1024
  /** Taken record ids remembered after their ack (a v1 journal holds at most 1,000). */
  const IMPORTED_ACKED_KEEP = 5_000
  const LOCK_WAIT_MS = deps.lockWaitMs ?? 250
  /** What a released lock file says (written before its unlink). */
  const LOCK_FREE = 'free'
  /** How old a free mark must be before a judge removes it (its holder's unlink never came). */
  const LOCK_FREE_STALE_MS = 1_000
  /** A hold of a lock that outlasted LOCK_WAIT_MS (its file and token), and until when later calls do not wait for that hold. */
  const wedged = new Map<string, { token: string; until: number }>()
  const DURABLE = deps.durable !== false
  const KEEP_OPEN = deps.keepOpen === true
  const PID = deps.pid ?? process.pid
  const journals = new Map<string, HomeJournal>()
  let selfStart: string | null | undefined
  let tornDropped = 0
  let dirReady = false
  /**
   * fdatasync per append, as a flag on the open: O_DSYNC makes each write complete as
   * fdatasync does, on every platform the daemon runs on. A separate fdatasync call is
   * the fallback: on macOS, node's runs F_FULLFSYNC (a drive cache flush, about 4 ms)
   * while bun's does not, so the two twins would pay different prices for one rule.
   */
  const DSYNC = DURABLE && fs.constants && fs.constants.O_DSYNC ? fs.constants.O_DSYNC : 0
  const APPEND_FLAGS = DSYNC ? fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | DSYNC : 'a'
  const WRITE_FLAGS = DSYNC ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | DSYNC : 'w'
  /** A foreign lock holder's start time, read at most every 10 s (macOS reads it with ps). */
  const startSeen = new Map<number, { at: number; start: string | null }>

  function refuse(code: string, message: string, extra?: { why?: string; retryAfterMs?: number; detail?: unknown }): JournalRefusal {
    return { ok: false, code, message, ...(extra ?? {}) }
  }

  function fileOf(key: string, ext: 'ndjson' | 'state.json' | 'lock'): string {
    return path.join(deps.dir, `journal-${key}.${ext}`)
  }

  function blobDir(): string { return path.join(deps.dir, 'blobs') }

  function ensureDir(): void {
    if (dirReady) return
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    dirReady = true
  }

  /** Block this thread for `ms` (a runtime without Atomics.wait spins for the same bound). */
  function sleep(ms: number): void {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return } catch { /* no Atomics.wait here */ }
    const end = Date.now() + ms
    while (Date.now() < end) { /* bounded spin */ }
  }

  function ownToken(): string {
    if (selfStart === undefined) {
      try { selfStart = deps.startTimeOf ? deps.startTimeOf(PID) : null } catch { selfStart = null }
    }
    return `${PID} ${selfStart ?? '-'}`
  }

  function pidAlive(pid: number): boolean {
    if (!(pid > 0)) return false
    try { process.kill(pid, 0); return true } catch (err) { return (err as { code?: string }).code === 'EPERM' }
  }

  /**
   * Remove a lock judged stale, only while the path still names the hold judged: the same
   * inode AND the same content (each hold writes its own nonce, because ext4 hands a freed
   * inode to the next file at once). The stale file is renamed to a name of this process
   * first, so between two judges of one dead holder, the second never removes the lock the
   * first then took. A live lock renamed by mistake is linked back at once (its holder's
   * release finds it in place).
   */
  function breakStaleLock(file: string, ino: number, raw: string): boolean {
    const aside = `${file}.stale-${PID}-${deps.randomHex(4)}`
    try { fs.renameSync(file, aside) } catch (err) { return (err as { code?: string }).code === 'ENOENT' /* another judge took it */ }
    let same = false
    try { same = fs.statSync(aside).ino === ino && fs.readFileSync(aside, 'utf8').trim() === raw } catch { same = false }
    if (!same) {
      try { fs.linkSync(aside, file) } catch { /* a new holder took the path: its lock stands */ }
    }
    try { fs.unlinkSync(aside) } catch { /* gone */ }
    return same
  }

  /** A lock whose writer is gone (or whose pid now names another process) is free. */
  function staleLock(file: string, raw: string): boolean {
    // A holder is releasing it: marked free, its unlink comes next. Broken at once, the
    // holder's unlink could remove the lock this judge then takes (two writers, one seq).
    // Free only once the mark is older than a release takes (its holder died before the
    // unlink, or a judge put the file back while its holder released).
    if (raw === LOCK_FREE) {
      try { return Date.now() - fs.statSync(file).mtimeMs > LOCK_FREE_STALE_MS } catch { return true }
    }
    const [pidText, start] = raw.split(' ')
    const pid = Number(pidText)
    if (!raw || !(pid > 0)) {
      // Torn between create and write: free once it is clearly not mid-write.
      try { return Date.now() - fs.statSync(file).mtimeMs > 5_000 } catch { return true }
    }
    if (!pidAlive(pid)) return true
    if (pid === PID) return start !== (ownToken().split(' ')[1])
    if (start && start !== '-' && deps.startTimeOf) {
      // A reused pid: asked only of a lock held over a second (a live writer holds it
      // for a millisecond), and at most every 10 s per pid (macOS answers with ps).
      let old = false
      try { old = Date.now() - fs.statSync(file).mtimeMs > 1_000 } catch { return true }
      if (!old) return false
      let seen = startSeen.get(pid)
      if (!seen || Date.now() - seen.at > 10_000) {
        let now: string | null = null
        try { now = deps.startTimeOf(pid) } catch { now = null }
        seen = { at: Date.now(), start: now }
        startSeen.set(pid, seen)
      }
      if (seen.start && seen.start !== start) return true
    }
    return false
  }

  /** Take the per-home writer lock; the returned function releases it. Throws a refusal. */
  function lock(key: string, home?: string): () => void {
    const file = fileOf(key, 'lock')
    // This hold's own nonce after the pid and start time (older daemons read the first two).
    const token = `${ownToken()} ${deps.randomHex(6)}`
    // Real time, not deps.now(): a test clock that stands still must not wait forever.
    const deadline = Date.now() + LOCK_WAIT_MS
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600)
        try { fs.writeSync(fd, token) } catch (err) {
          try { fs.closeSync(fd) } catch { /* closed */ }
          try { fs.unlinkSync(file) } catch { /* gone */ }
          throw err
        }
        wedged.delete(key)
        // The fd stays open while the lock is held. At release the file is marked free first
        // (a judge that moved it aside and puts it back finds it free, never wedged), then
        // the path is removed only while it still names this file (a lock judged stale and
        // removed is not ours, and the path may already name the next holder's).
        return () => {
          try {
            const mine = fs.fstatSync(fd).ino
            try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, LOCK_FREE, 0) } catch { /* unlinked below */ }
            if (fs.statSync(file).ino === mine) fs.unlinkSync(file)
          } catch { /* gone already */ } finally {
            try { fs.closeSync(fd) } catch { /* closed */ }
          }
        }
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'ENOENT' && attempt === 0) { dirReady = false; ensureDir(); continue }
        if (code !== 'EEXIST') {
          const no = unwritable(err)
          throw { ...no, message: `journal lock: ${(err as Error).message}` }
        }
        // The file judged is named by its inode, read BEFORE the judgement: only that file is removed.
        let judged = 0
        let raw = ''
        try { judged = fs.statSync(file).ino } catch { continue /* released meanwhile */ }
        try { raw = fs.readFileSync(file, 'utf8').trim() } catch (err) {
          if ((err as { code?: string }).code === 'ENOENT') continue
          // Unreadable: judged as torn, and never removed (the aside cannot be read either).
          raw = ''
        }
        // Not removed (a live lock put back, or a dir that refuses the rename): wait as for a live holder.
        if (staleLock(file, raw) && breakStaleLock(file, judged, raw)) {
          // Section 13 observability: who held it (the token's pid and start time).
          deps.log('warn', 'journal lock', { home: home ?? null, key, owner: raw.split(' ').slice(0, 2).join(' '), outcome: 'stale-broken' })
          continue
        }
        // One hold of the lock: its file (a new hold is a new file) and the holder's token.
        let holder = ''
        try {
          const st = fs.statSync(file)
          holder = `${st.ino}:${st.mtimeMs}:${fs.readFileSync(file, 'utf8').trim()}`
        } catch { /* released meanwhile */ }
        const known = wedged.get(key)
        const stuck = !!holder && !!known && known.token === holder && Date.now() < known.until
        if (stuck || Date.now() > deadline) {
          if (holder && !stuck) {
            wedged.set(key, { token: holder, until: Date.now() + 10_000 })
            deps.log('warn', 'journal lock', { home: home ?? null, key, owner: raw.split(' ').slice(0, 2).join(' '), outcome: 'refused', waitedMs: LOCK_WAIT_MS })
          }
          throw refuse('journal_unwritable', 'another process holds this journal', { why: 'locked' })
        }
        sleep(2)
      }
    }
  }

  // ── the file, folded ──

  function blank(home: string, key: string): HomeJournal {
    return {
      home, key, journalId: '', pending: new Map(), lineBytes: new Map(), byOp: new Map(), maxSeq: 0,
      frozen: new Set(), rows: {}, settledCopies: [], migratedV1: [], importedAcked: [], lastDrainAt: null, lastAckSeq: null,
      ino: 0, offset: 0, bytes: 0, badLines: [], stateDirty: false, stateSig: '', stateLoaded: false, stateError: '', fd: -1, fdIno: 0,
    }
  }

  /** Close a kept append fd (the file was replaced, set aside, or the store closes). */
  function dropFd(j: HomeJournal): void {
    if (j.fd >= 0) { try { fs.closeSync(j.fd) } catch { /* closed */ } }
    j.fd = -1
    j.fdIno = 0
  }

  function dropPending(j: HomeJournal, seq: number): JournalRecord | undefined {
    const rec = j.pending.get(seq)
    if (!rec) return undefined
    j.pending.delete(seq)
    j.lineBytes.delete(seq)
    for (const id of [rec.opId, ...((rec.saveOpIds as string[] | undefined) ?? [])]) {
      if (id && j.byOp.get(id) === seq) j.byOp.delete(id)
    }
    return rec
  }

  /** Apply one complete line to the fold. */
  function foldLine(j: HomeJournal, line: string, bytes: number): void {
    if (!line.trim()) return
    let rec: JournalRecord & { h?: number; ack?: unknown; home?: unknown; journalId?: unknown; nextSeq?: unknown }
    try { rec = JSON.parse(line) } catch { j.badLines.push(line); deps.log('warn', 'journal: unreadable line kept aside', { home: j.home, bytes }); return }
    if (!rec || typeof rec !== 'object') { j.badLines.push(line); return }
    if (rec.h === 1) {
      if (typeof rec.home === 'string' && rec.home) j.home = rec.home
      if (typeof rec.journalId === 'string' && !j.journalId) j.journalId = rec.journalId
      if (typeof rec.nextSeq === 'number' && rec.nextSeq - 1 > j.maxSeq) j.maxSeq = rec.nextSeq - 1
      return
    }
    if (Array.isArray(rec.ack)) {
      for (const s of rec.ack) {
        if (typeof s !== 'number') continue
        dropPending(j, s)
        j.frozen.delete(s)
        j.lastAckSeq = Math.max(j.lastAckSeq ?? 0, s)
      }
      return
    }
    if (typeof rec.seq !== 'number' || typeof rec.kind !== 'string') { j.badLines.push(line); return }
    foldRecord(j, rec, bytes)
  }

  /** A record line into the fold: highest rev per opId, a frozen record never replaced. */
  function foldRecord(j: HomeJournal, rec: JournalRecord, bytes: number): void {
    if (rec.seq > j.maxSeq) j.maxSeq = rec.seq
    const opId = typeof rec.opId === 'string' ? rec.opId : ''
    const prevSeq = opId ? j.byOp.get(opId) : undefined
    if (prevSeq !== undefined && prevSeq !== rec.seq) {
      const prev = j.pending.get(prevSeq)
      if (prev && (prev.rev ?? 1) > (rec.rev ?? 1)) return
      if (prev && !j.frozen.has(prevSeq)) dropPending(j, prevSeq)
    }
    if (typeof rec.supersedes === 'number' && rec.supersedes !== prevSeq && !j.frozen.has(rec.supersedes)) dropPending(j, rec.supersedes)
    if (rec.dropped) return
    j.pending.set(rec.seq, rec)
    j.lineBytes.set(rec.seq, bytes)
    if (opId) j.byOp.set(opId, rec.seq)
    for (const id of (rec.saveOpIds as string[] | undefined) ?? []) j.byOp.set(id, rec.seq)
  }

  function resetFold(j: HomeJournal): void {
    j.pending.clear(); j.lineBytes.clear(); j.byOp.clear(); j.badLines = []
    j.offset = 0; j.bytes = 0; j.ino = 0
  }

  /**
   * Read what was appended since the last read (any process). A file another process
   * compacted (new inode, or shorter) is read again from the start. Under the lock a torn
   * last line (a crash mid-write: no caller was told it was saved) is cut off; outside
   * it, an unfinished line may be another writer's and is left alone.
   */
  function readTail(j: HomeJournal, locked: boolean): void {
    const file = fileOf(j.key, 'ndjson')
    let st: import('node:fs').Stats
    try { st = fs.statSync(file) } catch {
      if (j.ino) resetFold(j)
      return
    }
    if (st.ino !== j.ino || st.size < j.offset) {
      const floor = j.maxSeq
      resetFold(j)
      j.maxSeq = floor
      j.ino = st.ino
    }
    if (st.size === j.offset) return
    const len = st.size - j.offset
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try {
      let got = 0
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, j.offset + got)
        if (n <= 0) break
        got += n
      }
    } finally { fs.closeSync(fd) }
    const end = buf.lastIndexOf(10)
    if (end >= 0) {
      let start = 0
      while (start <= end) {
        const nl = buf.indexOf(10, start)
        const bytes = nl - start + 1
        foldLine(j, buf.toString('utf8', start, nl), bytes)
        start = nl + 1
      }
      j.offset += end + 1
    }
    if (end + 1 < len && locked) {
      try { fs.truncateSync(file, j.offset) } catch (err) { throw refuse('journal_unwritable', `journal: torn line not cut: ${(err as Error).message}`, { why: 'io' }) }
      tornDropped++
      deps.log('warn', 'journal: torn last line dropped', { home: j.home, journalKey: j.key, bytes: len - end - 1 })
    }
    j.bytes = j.offset
  }

  // ── state.json: frozen seqs, request rows, settled copies ──

  interface StateFile { v: 2; home?: string; journalId?: string; nextSeq?: number; frozen?: number[]; rows?: Record<string, unknown>; settledCopies?: string[]; migratedV1?: string[]; importedAcked?: string[]; lastDrainAt?: number | null; lastAckSeq?: number | null }

  /**
   * state.json, or null only when there is none (ENOENT). Any other failure (EACCES, EMFILE,
   * EIO, bytes that are not a v2 state) throws journal_unwritable: a caller that went on with
   * a blank state would save it over the rows and acked ids the file holds.
   */
  function readState(key: string): StateFile | null {
    let raw: string
    try { raw = fs.readFileSync(fileOf(key, 'state.json'), 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw refuse('journal_unwritable', `this host could not read its journal state: ${(err as Error).message}`, { why: 'state_unreadable' })
    }
    let s: StateFile | null = null
    try { s = JSON.parse(raw) as StateFile } catch { /* named below */ }
    if (!s || typeof s !== 'object' || s.v !== 2) {
      throw refuse('journal_unwritable', 'this host could not read its journal state: state.json is not a v2 state', { why: 'state_unreadable' })
    }
    return s
  }

  /**
   * Fold what another process persisted (frozen seqs, migrations) into memory. `full` also
   * takes the request rows and settled copies; what this process added to them before its
   * first read (a read that failed) is kept beside them.
   */
  function mergeState(j: HomeJournal, s: StateFile | null, full: boolean): void {
    if (!s) return
    if (!j.journalId && typeof s.journalId === 'string') j.journalId = s.journalId
    if (typeof s.nextSeq === 'number' && s.nextSeq - 1 > j.maxSeq) j.maxSeq = s.nextSeq - 1
    for (const seq of s.frozen ?? []) if (typeof seq === 'number' && j.pending.has(seq)) j.frozen.add(seq)
    for (const id of s.migratedV1 ?? []) if (j.migratedV1.indexOf(id) === -1) j.migratedV1.push(id)
    if (Array.isArray(s.importedAcked)) {
      const have = new Set(j.importedAcked)
      for (const id of s.importedAcked) if (typeof id === 'string' && !have.has(id)) { j.importedAcked.push(id); have.add(id) }
    }
    if (typeof s.lastDrainAt === 'number') j.lastDrainAt = Math.max(j.lastDrainAt ?? 0, s.lastDrainAt)
    if (typeof s.lastAckSeq === 'number') j.lastAckSeq = Math.max(j.lastAckSeq ?? 0, s.lastAckSeq)
    if (full) {
      const rows = s.rows && typeof s.rows === 'object' ? s.rows : {}
      const copies = Array.isArray(s.settledCopies) ? s.settledCopies.filter((x) => typeof x === 'string') : []
      // The live objects stay (the offline host holds them): the file's entries go in first.
      const mine = { ...j.rows }
      for (const k of Object.keys(j.rows)) delete j.rows[k]
      Object.assign(j.rows, rows, mine)
      for (const id of copies) if (j.settledCopies.indexOf(id) === -1) j.settledCopies.push(id)
    }
  }

  function writeFileDurable(target: string, body: string): void {
    const tmp = `${target}.${PID}.tmp`
    const fd = fs.openSync(tmp, WRITE_FLAGS, 0o600)
    try {
      fs.writeSync(fd, body)
      if (DURABLE && !DSYNC) syncFd(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, target)
  }

  function syncFd(fd: number): void {
    try { fs.fdatasyncSync(fd) } catch { try { fs.fsyncSync(fd) } catch { /* best effort */ } }
  }

  function writeState(j: HomeJournal): void {
    for (const seq of [...j.frozen]) if (!j.pending.has(seq)) j.frozen.delete(seq)
    const body: StateFile = {
      v: 2, home: j.home, journalId: j.journalId, nextSeq: j.maxSeq + 1, frozen: [...j.frozen].sort((a, b) => a - b),
      rows: j.rows, settledCopies: j.settledCopies, migratedV1: j.migratedV1.slice(-200),
      importedAcked: j.importedAcked.slice(-IMPORTED_ACKED_KEEP),
      lastDrainAt: j.lastDrainAt, lastAckSeq: j.lastAckSeq,
    }
    // Never a blank state over a file this process could not read (locked() reads it first).
    if (!j.stateLoaded) throw refuse('journal_unwritable', 'this host could not read its journal state', { why: 'state_unreadable' })
    writeFileDurable(fileOf(j.key, 'state.json'), JSON.stringify(body))
    // Under the lock: no other process wrote between the rename and this stat. A stat that
    // fails leaves the signature unset, so the next locked call reads the file again.
    try { j.stateSig = stateSigOf(j.key) } catch { j.stateSig = '' }
    j.stateDirty = false
  }

  /** The journal of `home`, read from disk the first time it is asked for. */
  function journalOf(home: string): HomeJournal {
    let j = journals.get(home)
    if (j) return j
    j = blank(home, deps.keyOf(home))
    try { readTail(j, false) } catch { /* unreadable now: read again under the lock */ }
    loadState(j)
    journals.set(home, j)
    return j
  }

  /**
   * Read state.json in full into a journal that has not read it yet (stateLoaded false).
   * A read that fails leaves the signature unset and stateLoaded false (answered by the
   * next locked call); with `strict` it throws journal_unwritable instead of returning.
   */
  function loadState(j: HomeJournal, strict = false): void {
    try {
      // The signature first: a write after it is read again under the lock.
      const sig = stateSigOf(j.key)
      mergeState(j, readState(j.key), true)
      j.stateSig = sig
      j.stateLoaded = true
      j.stateError = ''
      // A new journal's id, only once its state is known (an unread state.json may name one).
      if (!j.journalId) j.journalId = deps.randomHex(8)
    } catch (err) {
      j.stateSig = ''
      const error = (err as Error).message
      if (error !== j.stateError) deps.log('error', 'journal: state.json not read; every write of this Walnut is refused until it reads', { home: j.home, error })
      j.stateError = error
      if (strict) throw isRefusal(err) ? err : unwritable(err)
    }
  }

  /** Run `fn` under the home's lock with the file tail and the state re-read. */
  function locked<T>(home: string, fn: (j: HomeJournal) => T): T {
    const j = journalOf(home)
    ensureDir()
    const release = lock(j.key, j.home)
    try {
      readTail(j, true)
      // A state.json not read yet is read in full, or nothing runs (a refusal for this home).
      if (!j.stateLoaded) loadState(j, true)
      else {
        // Another process's frozen seqs and migrations: read only when its state.json changed.
        const sig = stateSigOf(j.key)
        if (sig !== j.stateSig) {
          mergeState(j, readState(j.key), false)
          j.stateSig = sig
        }
      }
      return fn(j)
    } finally { release() }
  }

  /** state.json's identity (ino:size:mtime), '' when there is none; any other stat error throws. */
  function stateSigOf(key: string): string {
    let st: import('node:fs').Stats
    try { st = fs.statSync(fileOf(key, 'state.json')) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw refuse('journal_unwritable', `this host could not read its journal state: ${(err as Error).message}`, { why: 'state_unreadable' })
    }
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  }

  /** Append one line (a record, an ack, a header). Throws a refusal when the disk refuses. */
  function writeLine(j: HomeJournal, line: Record<string, unknown>): number {
    const file = fileOf(j.key, 'ndjson')
    const fresh = j.offset === 0
    const own = JSON.stringify(line)
    const text = (fresh && line.h !== 1 ? JSON.stringify({ v: 2, h: 1, home: j.home, journalId: j.journalId, nextSeq: j.maxSeq + 1 }) + '\n' : '') + own + '\n'
    const buf = Buffer.from(text, 'utf8')
    // A kept fd is used only while it names the file at the path: readTail stat'ed the
    // path under this lock, so a file another process compacted or set aside reopens.
    if (j.fd >= 0 && (!j.ino || j.fdIno !== j.ino)) dropFd(j)
    const kept = j.fd >= 0
    let fd = j.fd
    if (!kept) {
      try { fd = fs.openSync(file, APPEND_FLAGS, 0o600) } catch (err) { throw unwritable(err) }
    }
    try {
      let put = 0
      while (put < buf.length) put += fs.writeSync(fd, buf, put, buf.length - put)
      if (DURABLE && !DSYNC) syncFd(fd)
      if (!kept && (fresh || KEEP_OPEN)) {
        const ino = fs.fstatSync(fd).ino
        if (fresh) j.ino = ino
        if (KEEP_OPEN) { j.fd = fd; j.fdIno = ino }
      }
    } catch (err) {
      // What reached the disk of this line is a torn tail: the next locked read cuts it.
      if (j.fd === fd) { j.fd = -1; j.fdIno = 0 }
      try { fs.closeSync(fd) } catch { /* closed */ }
      throw unwritable(err)
    }
    if (j.fd !== fd) { try { fs.closeSync(fd) } catch { /* closed */ } }
    j.offset += buf.length
    j.bytes = j.offset
    return Buffer.byteLength(own, 'utf8') + 1
  }

  function unwritable(err: unknown): JournalRefusal {
    const code = (err as { code?: string }).code
    const why = code === 'ENOSPC' || code === 'EDQUOT' ? 'disk_full' : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'permission' : 'io'
    return refuse('journal_unwritable', `this host could not save the change: ${(err as Error).message}`, { why })
  }

  // ── append, dedupe, coalesce ──

  function isRefusal(x: unknown): x is JournalRefusal {
    return !!x && typeof x === 'object' && (x as JournalRefusal).ok === false && typeof (x as JournalRefusal).code === 'string'
  }

  function mintOpId(): string { return `op-${deps.randomHex(8)}` }

  function actorKey(a: JournalActor | undefined): string {
    if (!a) return ''
    if (a.kind === 'session') return `s:${a.sid}`
    if (a.kind === 'device') return `d:${a.deviceId}`
    return `t:${a.id}`
  }

  /** What a record is about, for coalescing and its order rule. */
  function subjectsOf(r: Record<string, unknown>): string[] {
    if (r.kind === 'note' && typeof r.path === 'string') return [`note:${r.path}`]
    if ((r.kind === 'task-fields' || r.kind === 'task-create' || r.kind === 'task-move') && typeof r.taskId === 'string') return [`task:${r.taskId}`]
    if (r.kind === 'op' && r.args && typeof (r.args as Record<string, unknown>).id === 'string') return [`task:${(r.args as Record<string, unknown>).id}`]
    return []
  }

  /** `at`: the field's own write time once a fold merged writes made at different times. */
  type Fields = Record<string, { base: unknown; value: unknown; at?: number }>

  /** The note mode after a later save onto a pending one (section 5 mode table). */
  function foldMode(first: string, later: string): string {
    if (first === 'create' && later === 'delete') return 'drop'
    if (first === 'create') return 'create'
    if (later === 'delete') return 'delete'
    if (first === 'delete') return 'put'
    return 'put'
  }

  type Coalesce =
    | { kind: 'none' }
    | { kind: 'fold'; target: JournalRecord; body: Record<string, unknown> }
    | { kind: 'frozen'; body: Record<string, unknown> }

  /**
   * A later save of the same note, or of the same task's fields by the same actor, folds
   * into the latest pending record of that subject, but only when no later record touches
   * the subject (replay order stays append order). A frozen target is never superseded:
   * the save becomes a new record whose base is the frozen record's result.
   */
  function coalesceInto(j: HomeJournal, body: Record<string, unknown>, actor: JournalActor | undefined, at: number): Coalesce {
    const subject = subjectsOf(body)[0]
    if (!subject || (body.kind !== 'note' && body.kind !== 'task-fields')) return { kind: 'none' }
    let last: JournalRecord | undefined
    for (const seq of [...j.pending.keys()].sort((a, b) => b - a)) {
      const r = j.pending.get(seq)!
      if (subjectsOf(r).indexOf(subject) !== -1) { last = r; break }
    }
    if (!last || last.kind !== body.kind || actorKey(last.actor) !== actorKey(actor)) return { kind: 'none' }
    if (body.kind === 'task-fields' && last.op !== body.op) return { kind: 'none' }
    const frozen = j.frozen.has(last.seq)
    if (body.kind === 'task-fields') {
      const prev = (last.fields ?? {}) as Fields
      const next = (body.fields ?? {}) as Fields
      if (frozen) {
        const fields: Fields = {}
        for (const k of Object.keys(next)) fields[k] = k in prev ? { base: prev[k].value, value: next[k].value } : next[k]
        return { kind: 'frozen', body: { ...body, fields } }
      }
      // Each field keeps the time it was written: the folded record's `at` is the latest
      // write, and an earlier field judged by it would beat a Mac edit made after it.
      const fields: Fields = {}
      for (const k of Object.keys(prev)) fields[k] = { ...prev[k], at: typeof prev[k].at === 'number' ? prev[k].at : last.at }
      for (const k of Object.keys(next)) fields[k] = k in prev ? { base: prev[k].base, value: next[k].value, at } : { ...next[k], at }
      return { kind: 'fold', target: last, body: { ...body, fields } }
    }
    const later = String(body.mode ?? 'put')
    if (frozen) {
      const gone = last.mode === 'delete'
      const mode = gone ? (later === 'put' ? 'create' : later) : (later === 'create' ? 'put' : later)
      return {
        kind: 'frozen',
        body: { ...body, mode, baseHash: gone ? null : (last.oursHash ?? null), baseBlob: gone ? null : (last.oursBlob ?? null) },
      }
    }
    const mode = foldMode(String(last.mode ?? 'put'), later)
    if (mode === 'drop') return { kind: 'fold', target: last, body: { kind: 'note', path: body.path, dropped: true } }
    return {
      kind: 'fold', target: last,
      body: {
        ...body, mode, noteId: body.noteId ?? last.noteId,
        baseHash: last.baseHash ?? null, baseBlob: last.baseBlob ?? null,
        oursBlob: mode === 'delete' ? null : (body.oursBlob ?? null), oursHash: mode === 'delete' ? null : (body.oursHash ?? null),
      },
    }
  }

  function admitted(no: ReturnType<NonNullable<AppendOpts['admit']>>): JournalRefusal | null {
    if (!no) return null
    if ('error' in no) return refuse(no.error.code, no.error.message, no.error.retryAfterMs !== undefined ? { retryAfterMs: no.error.retryAfterMs } : undefined)
    return no
  }

  /**
   * Save one record for `home`. Answers the refusal instead of throwing: a full disk or a
   * lost lock is `journal_unwritable`, and nothing written before is touched.
   */
  function append(home: string, body: Record<string, unknown>, opts: AppendOpts = {}): AppendResult {
    const notOwner = ownerRefusal() ?? migratingRefusal(home, opts)
    if (notOwner) return notOwner
    try {
      return locked(home, (j) => {
        if (opts.opId) {
          const seq = j.byOp.get(opts.opId)
          const first = seq !== undefined ? j.pending.get(seq) : undefined
          if (first) return { ok: true as const, seq: first.seq, opId: String(first.opId), rev: first.rev ?? 1, duplicate: true as const }
        }
        const actor = opts.actor
        const at = opts.at ?? deps.now()
        const c = opts.coalesce === false || opts.online ? { kind: 'none' as const } : coalesceInto(j, body, actor, at)
        const seq = j.maxSeq + 1
        let line: JournalRecord
        if (c.kind === 'fold') {
          const saves = [...((c.target.saveOpIds as string[] | undefined) ?? []), ...(opts.opId ? [opts.opId] : [])].slice(-50)
          line = {
            v: 2, seq, opId: String(c.target.opId), rev: (c.target.rev ?? 1) + 1, at,
            ...(actor ? { actor } : {}), ...c.body, kind: String(c.body.kind), supersedes: c.target.seq,
            ...(saves.length ? { saveOpIds: saves } : {}),
            // A fold into a migrated v1 record stays one: its ack is remembered (importedAcked).
            ...(c.target.v1Seq !== undefined ? { v1Seq: c.target.v1Seq } : {}),
          }
        } else {
          const denied = admitted(opts.admit ? opts.admit() : null)
          if (denied) return denied
          if (opts.limit && j.pending.size >= MAX_RECORDS) {
            return refuse('queue_full', `this host already holds ${MAX_RECORDS} records for the Walnut server; wait for it to reconnect`)
          }
          const own = c.kind === 'frozen' ? c.body : body
          line = {
            v: 2, seq, opId: opts.opId ?? mintOpId(), rev: opts.rev ?? 1, at,
            ...(actor ? { actor } : {}), ...own, kind: String(own.kind),
            ...(opts.online ? { online: true as const } : {}),
            ...(opts.v1Seq !== undefined ? { v1Seq: opts.v1Seq } : {}),
          }
        }
        const bytes = writeLine(j, line as unknown as Record<string, unknown>)
        const replaced = c.kind === 'fold' ? j.pending.get(c.target.seq) : undefined
        foldRecord(j, line, bytes)
        // The line is saved: a state.json that cannot be written now is written at the next
        // locked write (stateDirty stays set), never answered as a failed save.
        if (j.stateDirty) {
          try { writeState(j) } catch (err) {
            deps.log('warn', 'journal: state not saved after a saved record; written at the next write', { home: j.home, seq: line.seq, error: (err as Error).message })
          }
        }
        // A body only the folded record named is freed under the blob lock once the home's
        // lock is released (the first base stays with the new line).
        if (replaced) releaseBodies([replaced.baseBlob, replaced.oursBlob])
        // A fold leaves the old line dead: saves that coalesce (exempt from the write budget)
        // must not grow the file while the Mac is away, so they compact as acks do.
        if (c.kind === 'fold') compactQuietly(j)
        return {
          ok: true as const, seq: line.seq, opId: String(line.opId), rev: line.rev ?? 1,
          ...(c.kind === 'fold' ? { coalesced: true as const } : {}), ...(line.dropped ? { dropped: true as const } : {}),
        }
      })
    } catch (err) {
      if (isRefusal(err)) return err
      return unwritable(err)
    }
  }

  // ── drain and ack ──

  /** What a drain may hand out: v1 kinds plus the Mac's kinds; an old Mac only the v1 prefix. */
  function drainable(j: HomeJournal, kinds: string[] | null | undefined): JournalRecord[] {
    const ordered = [...j.pending.values()].sort((a, b) => a.seq - b.seq)
    if (!Array.isArray(kinds)) {
      const out: JournalRecord[] = []
      for (const r of ordered) {
        if (V1_KINDS.indexOf(r.kind) === -1) break
        out.push(r)
      }
      return out
    }
    return ordered.filter((r) => V1_KINDS.indexOf(r.kind) !== -1 || kinds.indexOf(r.kind) !== -1)
  }

  /**
   * Hand the server its next batch. The kinds filter runs before the batch cut, so parked
   * records at the head never starve the rest. Every record handed out is frozen until
   * acked (persisted before the answer), so a redrain after a crash sees the same content.
   */
  function drain(home: string, opts: { kinds?: string[] | null; batch?: number } = {}): { records: JournalRecord[]; more: boolean; now: number; error?: string; why?: string } {
    const batchSize = opts.batch ?? 200
    const pick = (j: HomeJournal) => {
      const all = drainable(j, opts.kinds)
      return { all, batch: all.slice(0, batchSize) }
    }
    let out: { all: JournalRecord[]; batch: JournalRecord[] }
    const notOwner = ownerRefusal()
    if (notOwner) return { records: [], more: false, now: deps.now(), error: notOwner.message, why: notOwner.why }
    try {
      out = locked(home, (j) => {
        const p = pick(j)
        if (p.batch.length) {
          for (const r of p.batch) j.frozen.add(r.seq)
          j.lastDrainAt = deps.now()
          writeState(j)
        }
        return p
      })
    } catch (err) {
      // Never hand out a batch whose freeze is not on disk: its ack could not be saved
      // either, and an older Mac would apply the same records again on its next round.
      const no = isRefusal(err) ? err : unwritable(err)
      deps.log('warn', 'journal: drain refused, the journal could not be frozen', { home, error: no.message, why: no.why })
      return { records: [], more: false, now: deps.now(), error: no.message, why: no.why }
    }
    return { records: out.batch.map((r) => JSON.parse(JSON.stringify(r)) as JournalRecord), more: out.all.length > out.batch.length, now: deps.now() }
  }

  /** A daemon whose dir daemon.pid no longer names refuses every write (a newer daemon runs there). */
  function ownerRefusal(): JournalRefusal | null {
    if (!deps.isOwner || deps.isOwner()) return null
    return refuse('journal_unwritable', 'this daemon no longer owns its directory (a newer daemon runs there)', { why: 'not_owner' })
  }

  /**
   * The server applied (or gave up on) these seqs. `seqs` names them exactly (journal-v2);
   * an old Mac's `upTo` drops only seqs a drain handed it. A seq never handed out is kept.
   */
  function ack(home: string, req: { seqs?: unknown; upTo?: unknown }): { remaining: number; acked: JournalRecord[]; ignored: number[]; error?: string } {
    const notOwner = ownerRefusal()
    if (notOwner) return { remaining: journalOf(home).pending.size, acked: [], ignored: [], error: notOwner.message }
    let out: { remaining: number; acked: JournalRecord[]; ignored: number[] }
    try {
      out = locked(home, (j) => {
        let names: number[] = []
        let ignored: number[] = []
        if (Array.isArray(req.seqs)) {
          const asked = req.seqs.filter((n): n is number => typeof n === 'number')
          names = asked.filter((n) => j.frozen.has(n) && j.pending.has(n))
          ignored = asked.filter((n) => names.indexOf(n) === -1)
        } else if (typeof req.upTo === 'number') {
          const upTo = req.upTo
          names = [...j.frozen].filter((s) => s <= upTo && j.pending.has(s))
        }
        const acked: JournalRecord[] = []
        if (names.length) {
          // A record that came from a v1 journal (folded or not: its opId stays v1-...) is
          // remembered BEFORE its ack line: a v1 file an older instance writes again later,
          // or one a failed migration kept, never brings it back.
          const taken: string[] = []
          for (const n of names) {
            const r = j.pending.get(n)
            const fromV1 = !!r && typeof r.opId === 'string' && (r.v1Seq !== undefined || r.opId.indexOf('v1-') === 0)
            if (fromV1 && j.importedAcked.indexOf(r!.opId as string) === -1) taken.push(r!.opId as string)
          }
          if (taken.length) {
            j.importedAcked.push(...taken)
            if (j.importedAcked.length > IMPORTED_ACKED_KEEP) j.importedAcked = j.importedAcked.slice(-IMPORTED_ACKED_KEEP)
            writeState(j)
          }
          writeLine(j, { v: 2, ack: names, at: deps.now() })
          for (const s of names) {
            const r = dropPending(j, s)
            j.frozen.delete(s)
            if (r) acked.push(r)
            j.lastAckSeq = Math.max(j.lastAckSeq ?? 0, s)
          }
          // The ack line is saved: the state follows at the next write when it fails now.
          j.stateDirty = true
          try { writeState(j) } catch (err) {
            deps.log('warn', 'journal: state not saved after a saved ack; written at the next write', { home: j.home, error: (err as Error).message })
          }
          compactQuietly(j)
          const shas: unknown[] = []
          for (const r of acked) shas.push(r.baseBlob, r.oursBlob)
          releaseBodies(shas)
        }
        return { remaining: j.pending.size, acked, ignored }
      })
    } catch (err) {
      const error = isRefusal(err) ? err.message : (err as Error).message
      deps.log('error', 'journal: ack not saved', { home, error })
      return { remaining: journalOf(home).pending.size, acked: [], ignored: [], error }
    }
    // Outside the home's lock (the blob lock is always taken first): the freed bodies, then
    // at most every 10 minutes the bodies a crash left without a record.
    freeReleased()
    try { sweepBlobs() } catch { /* a later ack sweeps */ }
    return out
  }

  function liveBytes(j: HomeJournal): number {
    let n = 0
    for (const b of j.lineBytes.values()) n += b
    return n
  }

  /** Compaction after a write that is already saved: a failure is logged, never answered. */
  function compactQuietly(j: HomeJournal): void {
    try { maybeCompact(j) } catch (err) {
      deps.log('warn', 'journal: compaction failed; the file is rewritten at a later write', { home: j.home, error: (err as Error).message })
    }
  }

  /** Rewrite the unacked tail (tmp + rename) once dead lines are half the file or 4 MB. */
  function maybeCompact(j: HomeJournal, force = false): boolean {
    const dead = j.bytes - liveBytes(j)
    if (!force && !(dead > 0 && (dead * 2 > j.bytes || dead > COMPACT_BYTES))) return false
    const file = fileOf(j.key, 'ndjson')
    if (j.badLines.length) {
      // An unreadable line is kept aside, never dropped by a rewrite.
      try { fs.appendFileSync(path.join(deps.dir, `journal-${j.key}.unreadable.ndjson`), j.badLines.join('\n') + '\n', { mode: 0o600 }) } catch (err) {
        deps.log('error', 'journal: compaction skipped, an unreadable line could not be kept aside', { home: j.home, error: (err as Error).message })
        return false
      }
    }
    const recs = [...j.pending.values()].sort((a, b) => a.seq - b.seq)
    const header = JSON.stringify({ v: 2, h: 1, home: j.home, journalId: j.journalId, nextSeq: j.maxSeq + 1 }) + '\n'
    const lines = recs.map((r) => JSON.stringify(r) + '\n')
    writeFileDurable(file, header + lines.join(''))
    dropFd(j)
    j.lineBytes.clear()
    recs.forEach((r, i) => j.lineBytes.set(r.seq, Buffer.byteLength(lines[i], 'utf8')))
    j.badLines = []
    const st = fs.statSync(file)
    j.ino = st.ino
    j.offset = st.size
    j.bytes = st.size
    deps.log('info', 'journal: compacted', { home: j.home, records: recs.length, deadBytes: dead, bytes: st.size })
    return true
  }

  // ── blobs: content-addressed note bodies ──

  const blobSizes = new Map<string, number>()
  const SHA_RE = /^[0-9a-f]{64}$/

  function blobSize(sha: string): number {
    const known = blobSizes.get(sha)
    if (known !== undefined) return known
    let n = 0
    try { n = fs.statSync(path.join(blobDir(), sha)).size } catch { n = 0 }
    blobSizes.set(sha, n)
    return n
  }

  function blobsOf(j: HomeJournal): Set<string> {
    const out = new Set<string>()
    for (const r of j.pending.values()) {
      for (const sha of [r.baseBlob, r.oursBlob]) if (typeof sha === 'string' && SHA_RE.test(sha)) out.add(sha)
    }
    return out
  }

  function blobBytes(j: HomeJournal): number {
    let n = 0
    for (const sha of blobsOf(j)) n += blobSize(sha)
    return n
  }

  /** Store a body under its sha256; refused past the home's blob budget. */
  function putBlob(home: string, body: Uint8Array): { ok: true; sha: string } | JournalRefusal {
    const sha = deps.sha256(body)
    const target = path.join(blobDir(), sha)
    try {
      if (fs.existsSync(target)) {
        // A body saved again is young again: the orphan sweep never takes it before its record.
        try { const t = new Date(); fs.utimesSync(target, t, t) } catch { /* swept meanwhile: written below */ }
        if (fs.existsSync(target)) return { ok: true, sha }
      }
      const j = journalOf(home)
      if (blobBytes(j) + body.length > BLOB_BUDGET) {
        return refuse('queue_full', `this host already holds ${BLOB_BUDGET} bytes of note bodies for the Walnut server`, { why: 'blobs' })
      }
      fs.mkdirSync(blobDir(), { recursive: true, mode: 0o700 })
      const tmp = `${target}.${PID}.tmp`
      const fd = fs.openSync(tmp, WRITE_FLAGS, 0o600)
      try {
        let put = 0
        while (put < body.length) put += fs.writeSync(fd, body, put, body.length - put)
        if (DURABLE && !DSYNC) syncFd(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, target)
      blobSizes.set(sha, body.length)
      return { ok: true, sha }
    } catch (err) {
      return unwritable(err)
    }
  }

  /** At most 2 MB of a blob from `offset`, base64 (within the WS frame and read limits). */
  function readBlob(sha: unknown, offset: unknown): { ok: true; sha: string; offset: number; size: number; data: string; done: boolean } | JournalRefusal {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) return refuse('bad_request', 'offline.blob needs a sha256')
    const at = typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : 0
    const file = path.join(blobDir(), sha)
    try {
      const size = fs.statSync(file).size
      const len = Math.max(0, Math.min(BLOB_CHUNK, size - at))
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(file, 'r')
      try {
        let got = 0
        while (got < len) { const n = fs.readSync(fd, buf, got, len - got, at + got); if (n <= 0) break; got += n }
      } finally { fs.closeSync(fd) }
      return { ok: true, sha, offset: at, size, data: buf.toString('base64'), done: at + len >= size }
    } catch {
      return refuse('not_found', 'this host does not hold that body')
    }
  }

  /** Bodies a fold or an ack released: freed under the blob lock once no record names them. */
  const released = new Set<string>()
  /** The dir's blob lock (`journal-blobs.lock`): never a home key (those are 16 hex). */
  const BLOB_LOCK = 'blobs'
  let blobLockHeld = false

  function releaseBodies(shas: unknown[]): void {
    for (const sha of shas) if (typeof sha === 'string' && SHA_RE.test(sha)) released.add(sha)
  }

  /**
   * Run `fn` under the dir's blob lock, always taken BEFORE a home's lock, never inside
   * one. A note save holds it from its first body to its record, so no process removes a
   * body between its write and the record that names it (no age guard needed).
   */
  function withBlobLock<T>(fn: () => T): T {
    if (blobLockHeld) return fn()
    ensureDir()
    const release = lock(BLOB_LOCK)
    blobLockHeld = true
    try { return fn() } finally { blobLockHeld = false; release() }
  }

  /**
   * Every body a pending record of any journal in this dir names, read again from disk
   * (other processes append too). Null when a v2 journal here names no Walnut: its records
   * could name a body, so nothing may be removed.
   */
  function referencedBodies(): Set<string> | null {
    load()
    let dirNames: string[] = []
    try { dirNames = fs.readdirSync(deps.dir) } catch { return null }
    const keys = new Set([...journals.values()].map((j) => j.key))
    for (const name of dirNames) {
      const m = /^journal-([^.]+)\.ndjson$/.exec(name)
      if (m && !keys.has(m[1])) return null
    }
    const used = new Set<string>()
    for (const j of journals.values()) {
      try { readTail(j, false) } catch { return null }
      for (const sha of blobsOf(j)) used.add(sha)
    }
    return used
  }

  /** Free the released bodies no record names; when the blob lock is busy, at the next save, ack or sweep. */
  function freeReleased(): void {
    if (!released.size || ownerRefusal()) return
    try {
      withBlobLock(() => {
        const used = referencedBodies()
        if (!used) return
        for (const sha of [...released]) {
          released.delete(sha)
          if (used.has(sha)) continue
          try { fs.unlinkSync(path.join(blobDir(), sha)) } catch { /* gone already */ }
          blobSizes.delete(sha)
        }
      })
    } catch { /* kept in released */ }
  }

  const ORPHAN_BLOB_MS = 60 * 60_000
  let lastSweep = 0

  /**
   * Remove bodies no pending record of any journal in this dir names and nobody wrote for
   * an hour (what a crash between a body and its record left). Under the blob lock, only
   * in the process that owns the dir, skipped whole when a journal here names no Walnut.
   * At most every 10 minutes unless forced (the boot migration forces it).
   */
  function sweepBlobs(force = false): number {
    if (ownerRefusal()) return 0
    if (!force && Date.now() - lastSweep < 10 * 60_000) return 0
    lastSweep = Date.now()
    try { return withBlobLock(sweepLocked) } catch { return 0 }
  }

  function sweepLocked(): number {
    let names: string[] = []
    try { names = fs.readdirSync(blobDir()) } catch { return 0 }
    const used = referencedBodies()
    if (!used) return 0
    let removed = 0
    for (const name of names) {
      const sha = name.slice(0, 64)
      if (!SHA_RE.test(sha) || used.has(sha) || (name.length > 64 && !name.endsWith('.tmp'))) continue
      const file = path.join(blobDir(), name)
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < ORPHAN_BLOB_MS) continue
        fs.unlinkSync(file)
        if (name === sha) blobSizes.delete(sha)
        removed++
      } catch { /* gone already */ }
    }
    if (removed) deps.log('info', 'journal: note bodies no record names were removed', { removed })
    return removed
  }

  /**
   * A note save: bodies become blobs, then one record that coalesces by path (section 5),
   * all under the blob lock. Whatever the save leaves unnamed (the body a fold replaced,
   * a refused or folded-away save's own bodies) is freed before the lock is released.
   */
  function appendNote(
    home: string,
    note: { path: string; noteId?: string; mode: 'put' | 'create' | 'delete'; baseHash?: string | null; base?: Uint8Array | null; ours?: Uint8Array | null; oursHash?: string | null },
    opts: AppendOpts = {},
  ): AppendResult {
    if (!note || typeof note.path !== 'string' || !note.path || ['put', 'create', 'delete'].indexOf(note.mode) === -1) {
      return refuse('bad_request', 'a note save needs a path and a mode')
    }
    const notOwner = ownerRefusal() ?? migratingRefusal(home, opts)
    if (notOwner) return notOwner
    try {
      return withBlobLock(() => {
        const written: string[] = []
        const done = (res: AppendResult): AppendResult => { releaseBodies(written); freeReleased(); return res }
        let baseBlob: string | null = null
        let oursBlob: string | null = null
        if (note.base) { const b = putBlob(home, note.base); if (!b.ok) return done(b); baseBlob = b.sha; written.push(b.sha) }
        if (note.ours && note.mode !== 'delete') { const o = putBlob(home, note.ours); if (!o.ok) return done(o); oursBlob = o.sha; written.push(o.sha) }
        return done(append(home, {
          kind: 'note', path: note.path, ...(note.noteId ? { noteId: note.noteId } : {}), mode: note.mode,
          baseHash: note.baseHash ?? null, baseBlob, oursBlob, oursHash: note.mode === 'delete' ? null : (note.oursHash ?? null),
        }, { ...opts, coalesce: opts.coalesce !== false, limit: opts.limit !== false }))
      })
    } catch (err) {
      if (isRefusal(err)) return err
      return unwritable(err)
    }
  }

  // ── reads for the offline host and the follower ──

  function records(home: string): JournalRecord[] {
    const j = journals.get(home)
    return j ? [...j.pending.values()].sort((a, b) => a.seq - b.seq) : []
  }

  /**
   * Pending records past `sinceSeq` (the replica's overlay), read from disk first. An
   * overlay kept by `sinceSeq` also needs what LEFT: `liveSeqs` is every pending seq (an
   * entry not in it was acked, or folded away), and a `journalId` it has not seen means
   * the journal started over (its seqs restart), so the overlay is read again from 0.
   */
  function pending(home: string, sinceSeq = 0): { records: JournalRecord[]; blobs: string[]; nextSeq: number; journalId: string; liveSeqs: number[] } {
    const j = journalOf(home)
    try { readTail(j, false) } catch { /* memory answers */ }
    const all = records(home)
    const recs = all.filter((r) => r.seq > sinceSeq)
    const blobs = new Set<string>()
    for (const r of recs) for (const sha of [r.baseBlob, r.oursBlob]) if (typeof sha === 'string') blobs.add(sha)
    return {
      records: recs.map((r) => JSON.parse(JSON.stringify(r)) as JournalRecord), blobs: [...blobs], nextSeq: j.maxSeq + 1,
      journalId: j.journalId, liveSeqs: all.map((r) => r.seq),
    }
  }

  /** The pending record that carries `opId` (its own, or a save folded into it), read from disk first. */
  function byOpId(home: string, opId: string): JournalRecord | undefined {
    const j = journalOf(home)
    try { readTail(j, false) } catch { /* memory answers */ }
    const seq = j.byOp.get(opId)
    const r = seq !== undefined ? j.pending.get(seq) : undefined
    return r ? JSON.parse(JSON.stringify(r)) as JournalRecord : undefined
  }

  function drainableCount(home: string, kinds: string[] | null | undefined): number {
    const j = journals.get(home)
    return j ? drainable(j, kinds).length : 0
  }

  function drainableRecords(home: string, kinds: string[] | null | undefined): JournalRecord[] {
    const j = journals.get(home)
    return j ? drainable(j, kinds) : []
  }

  function stats(home: string, kinds: string[] | null | undefined): JournalStats & { unreadableLines: number; tornDropped: number } {
    const j = journals.get(home)
    if (!j) return { records: 0, drainable: 0, bytes: 0, blobBytes: 0, oldestAt: null, lastDrainAt: null, lastAckSeq: null, unreadableLines: 0, tornDropped }
    let oldest: number | null = null
    for (const r of j.pending.values()) if (oldest === null || r.at < oldest) oldest = r.at
    return {
      records: j.pending.size, drainable: drainable(j, kinds).length, bytes: j.bytes, blobBytes: blobBytes(j),
      oldestAt: oldest, lastDrainAt: j.lastDrainAt, lastAckSeq: j.lastAckSeq, unreadableLines: j.badLines.length, tornDropped,
    }
  }

  /** The request rows and settled copies the offline host keeps beside its records (live object). */
  function state(home: string): { rows: Record<string, unknown>; settledCopies: string[] } {
    const j = journalOf(home)
    // A first read that failed is tried again here (read only); a write reads it under the lock.
    if (!j.stateLoaded) loadState(j)
    return j
  }

  /** Save the rows and settled copies now (they also ride every append). */
  function persist(home: string): void {
    const notOwner = ownerRefusal()
    if (notOwner) { deps.log('warn', 'offline host: persist refused', { home, why: notOwner.why }); return }
    try { locked(home, (j) => writeState(j)) } catch (err) {
      deps.log('warn', 'offline host: persist failed', { home, error: isRefusal(err) ? err.message : (err as Error).message })
    }
  }

  function markDirty(home: string): void { journalOf(home).stateDirty = true }

  // ── load, migration ──

  function readHead(file: string): Record<string, unknown> | null {
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        const nl = buf.indexOf(10)
        return JSON.parse(buf.toString('utf8', 0, nl >= 0 && nl < n ? nl : n)) as Record<string, unknown>
      } finally { fs.closeSync(fd) }
    } catch { return null }
  }

  function jsonFile(file: string): Record<string, unknown> | null {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return null }
  }

  /**
   * Whether a dir or a file an older daemon left is this user's own: lstat (a symlink is
   * never followed), a real dir or a regular file, owned by this uid, a dir not world
   * writable. On a shared host another user can plant /tmp/open-walnut (the server then
   * picks the home fallback, remote-daemon-dir.ts): a record, slice or Walnut name read
   * from a file that is not this user's would reach the Mac as this user's write. Group
   * write passes (a umask 002 host gives each user a group); a file another member of the
   * group planted is still not this uid's. Answers false on any error: the file waits.
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

  /**
   * The legacy dirs that are this user's own, and so is the daemon dir holding each (a
   * planted /tmp/open-walnut is a symlink there, or another user's: its offline-host would
   * pass alone). One that is not is logged and never read.
   */
  function ownSources(sources: string[]): string[] {
    const out: string[] = []
    for (const dir of [...new Set(sources)]) {
      if (path.resolve(dir) === path.resolve(deps.dir)) continue
      if (ownLegacy(path.dirname(path.resolve(dir)), 'dir') && ownLegacy(dir, 'dir')) { out.push(dir); continue }
      let exists = false
      try { fs.lstatSync(dir); exists = true } catch { /* none: nothing to read */ }
      if (exists) deps.log('error', 'journal migration: a legacy dir is not this user\'s own (a symlink, another owner, or world writable); not read', { dir })
    }
    return out
  }

  /** A JSON file in a legacy dir, read only when it is this user's own regular file. */
  function legacyJson(file: string): Record<string, unknown> | null {
    return ownLegacy(file, 'file') ? jsonFile(file) : null
  }

  /**
   * The Walnut a file key belongs to, from what this host keeps beside it. A v2 journal is
   * read only in this dir: in a legacy dir only slices and leader records name the Walnut.
   */
  function homeOfKey(key: string, dirs: string[], hint?: (key: string) => string | undefined): string | undefined {
    const ok = (h: unknown): h is string => typeof h === 'string' && !!h && deps.keyOf(h) === key
    const hinted = hint?.(key)
    if (ok(hinted)) return hinted
    for (const d of [deps.dir, ...dirs]) {
      if (path.resolve(d) === path.resolve(deps.dir)) {
        const head = readHead(path.join(d, `journal-${key}.ndjson`))
        if (head && head.h === 1 && ok(head.home)) return head.home
        const st = jsonFile(path.join(d, `journal-${key}.state.json`))
        if (st && ok(st.home)) return st.home
      }
      // A legacy dir names the Walnut only through files this user owns.
      const read = path.resolve(d) === path.resolve(deps.dir) ? jsonFile : legacyJson
      const slice = read(path.join(d, `slice-${key}.json`))
      if (slice && ok(slice.home)) return slice.home
      const lead = read(path.join(d, '..', 'leader', `leader-${key}.json`))
      if (lead && ok(lead.home)) return lead.home
    }
    return undefined
  }

  /** Every journal on disk, with or without a slice beside it. */
  function load(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    for (const name of names) {
      const m = /^journal-([^.]+)\.(ndjson|state\.json)$/.exec(name)
      if (!m || [...journals.values()].some((j) => j.key === m[1])) continue
      const home = homeOfKey(m[1], [])
      if (!home) { deps.log('warn', 'journal: a journal names no Walnut; kept as is', { file: name }); continue }
      journalOf(home)
    }
  }

  /** Copy slices a legacy dir holds that this dir lacks or holds older (never removes one). */
  function migrateSlices(sources: string[]): number {
    let n = 0
    for (const dir of ownSources(sources)) {
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names) {
        if (!/^slice-[^.]+\.json$/.test(name)) continue
        const src = legacyJson(path.join(dir, name))
        if (!src || typeof src.home !== 'string') continue
        const mine = jsonFile(path.join(deps.dir, name))
        if (mine && Number(mine.asOf ?? 0) >= Number(src.asOf ?? 0)) continue
        try { ensureDir(); writeFileDurable(path.join(deps.dir, name), JSON.stringify(src)); n++ } catch (err) {
          deps.log('warn', 'journal migration: slice not copied', { file: name, error: (err as Error).message })
        }
      }
    }
    return n
  }

  /**
   * Every v1 journal (`journal-<key>.json`) that holds records, in any of `sources` (and this
   * dir), is appended as v2 lines with opId `v1-<hash of the record>` (so a crash
   * mid-migration, a failed rename, or the same records in a file rewritten later never
   * import a record twice: pending ones by the dedupe, acked ones by `importedAcked`), then
   * renamed `.migrated`. Runs at every boot: a downgraded daemon writes v1 again. A record
   * that cannot be converted is never dropped: its file is renamed `.unconverted`, untouched.
   */
  function migrateV1(sources: string[], hint?: (key: string) => string | undefined): { files: number; records: number; unconverted: number; kept: number } {
    const out = { files: 0, records: 0, unconverted: 0, kept: 0 }
    const found: Array<{ file: string; key: string; oldest: number; i: number }> = []
    sources = ownSources(sources)
    for (const dir of [deps.dir, ...sources]) {
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names) {
        const m = /^journal-([^.]+)\.json(?:\.migrating-\d+-[0-9a-f]+)?$/.exec(name)
        if (!m) continue
        const file = path.join(dir, name)
        // Never read, never renamed: a v1 daemon of this user wrote its own regular files.
        if (dir !== deps.dir && !ownLegacy(file, 'file')) {
          out.kept++
          deps.log('error', 'journal migration: a v1 journal that is not this user\'s own regular file; not read', { file })
          continue
        }
        found.push({ file, key: m[1], oldest: oldestAt(file), i: found.length })
      }
    }
    // Two dirs can hold v1 files of one Walnut (a home fallback daemon and /tmp/open-walnut,
    // each used while the server picked it): the older file's records go first, never dir order.
    const first = new Map<string, number>()
    for (const f of found) if (!first.has(f.key)) first.set(f.key, f.i)
    found.sort((a, b) => first.get(a.key)! - first.get(b.key)! || a.oldest - b.oldest || a.i - b.i)
    for (const f of found) migrateOne(f.file, f.key, sources, hint, out)
    return out
  }

  /** The time of a v1 file's oldest record (Infinity when it cannot be read: it keeps its place last). */
  function oldestAt(file: string): number {
    try {
      const v1 = JSON.parse(fs.readFileSync(file, 'utf8')) as { records?: unknown }
      let min = Infinity
      for (const r of Array.isArray(v1?.records) ? v1.records : []) {
        const at = (r as { at?: unknown } | null)?.at
        if (typeof at === 'number' && at < min) min = at
      }
      return min
    } catch { return Infinity }
  }

  /**
   * v1 files a migration left part way (readable, of a known Walnut, not finished: a state
   * read, an append or the state save failed), per home. Until each is finished, a new write
   * for that home is refused (`journal_unwritable`, why `migrating`): appended ahead of the
   * rest of that file, it would reach the Mac before older records (a settings or stop has
   * no base check). The refusal tries the file again first, at most every MIGRATE_RETRY_MS.
   */
  const MIGRATE_RETRY_MS = 2000
  const migrating = new Map<string, { files: Map<string, { key: string; sources: string[]; hint?: (key: string) => string | undefined }>; lastTry: number }>()
  /** v1 files of a key no slice or leader record named at boot: file -> the legacy dirs it was read with. */
  const unknownHome = new Map<string, Map<string, string[]>>()

  /** A claimed v1 file (`<file>.migrating-<ms>-<hex>`): taken as it is, never claimed again. */
  const CLAIM_RE = /\.migrating-\d+-[0-9a-f]+$/

  /**
   * Claim a v1 file before its records are appended: renamed to `<file>.migrating-<ms>-<hex>`, so a v1
   * daemon still running (it writes by tmp + rename) puts any later record in a NEW
   * `journal-<key>.json`, which a retry or the next boot takes, never into the file this
   * migration sets aside (WP8 review: a record written between the read and the rename was
   * renamed into `.migrated` unread). The claim is read again, so a write that landed between
   * the first read and the claim is migrated too. A claim a crash left is found at boot and taken.
   */
  function claimV1(file: string): string {
    if (CLAIM_RE.test(file)) return file
    const claim = `${file}.migrating-${deps.now()}-${deps.randomHex(4)}`
    fs.renameSync(file, claim)
    return claim
  }

  /**
   * A migration that stopped part way puts its claim back under the v1 name, never over a
   * file a v1 daemon wrote there since (a hard link fails when the name exists): then the
   * claim stays, and the next boot takes both (their records dedupe by v1 op id).
   */
  function unclaim(claim: string, file: string): void {
    if (claim === file || CLAIM_RE.test(file)) return
    try { fs.linkSync(claim, file) } catch { return }
    try { fs.unlinkSync(claim) } catch { /* the link stands: the next boot reads the v1 name */ }
  }

  function migrateOne(file: string, key: string, sources: string[], hint: ((key: string) => string | undefined) | undefined, out: { files: number; records: number; unconverted: number; kept: number }): void {
    const home = homeOfKey(key, sources, hint)
    let raw = ''
    let v1: unknown = null
    try {
      // A legacy file is read only while it is this user's own regular file (a retry too).
      if (path.resolve(path.dirname(file)) !== path.resolve(deps.dir) && !ownLegacy(file, 'file')) {
        fs.lstatSync(file) // gone: ENOENT below, like a file read as gone
        throw Object.assign(new Error('not this user\'s own regular file'), { code: 'ENOTOWN' })
      }
      raw = fs.readFileSync(file, 'utf8'); v1 = JSON.parse(raw)
    } catch (err) {
      out.kept++
      deps.log('error', 'journal migration: v1 journal unreadable; kept as is', { file, error: (err as Error).message })
      if (home && (err as { code?: string }).code === 'ENOENT') leftPart(home, file, null)
      return
    }
    if (!home) {
      out.kept++
      // Kept in a list: the first configure or write that names a Walnut of this key finishes it.
      const files = unknownHome.get(key) ?? new Map<string, string[]>()
      files.set(file, sources)
      unknownHome.set(key, files)
      deps.log('error', 'journal migration: the Walnut of a v1 journal is unknown; kept until a configure or a write names it', { file })
      return
    }
    unknownHome.get(key)?.delete(file)
    if (migrateFile(home, file, raw, v1, out)) { out.files++; leftPart(home, file, null) } else { out.kept++; leftPart(home, file, { key, sources, hint }) }
  }

  function leftPart(home: string, file: string, entry: { key: string; sources: string[]; hint?: (key: string) => string | undefined } | null): void {
    const m = migrating.get(home)
    if (entry) {
      if (m) m.files.set(file, entry)
      else migrating.set(home, { files: new Map([[file, entry]]), lastTry: deps.now() })
      return
    }
    if (!m) return
    m.files.delete(file)
    if (m.files.size === 0) migrating.delete(home)
  }

  /** `home` is named now (a configure, a write): its v1 files of unknown Walnut wait like files left part way, tried at once. */
  function claimUnknown(home: string): void {
    const key = deps.keyOf(home)
    const files = unknownHome.get(key)
    if (!files) return
    unknownHome.delete(key)
    const hint = (k: string) => (k === key ? home : undefined)
    for (const [file, sources] of files) leftPart(home, file, { key, sources, hint })
    const m = migrating.get(home)
    if (m) m.lastTry = -Infinity
  }

  /** Try the files a migration left for `home` again (at most every MIGRATE_RETRY_MS); whether any is still left. */
  function retryMigrating(home: string): boolean {
    const m = migrating.get(home)
    if (!m) return false
    if (deps.now() - m.lastTry >= MIGRATE_RETRY_MS) {
      m.lastTry = deps.now()
      const out = { files: 0, records: 0, unconverted: 0, kept: 0 }
      for (const [file, e] of [...m.files]) migrateOne(file, e.key, e.sources, e.hint, out)
      if (out.files || out.records) deps.log('info', 'journal migration: a v1 journal left part way is finished', { home, ...out })
      if (out.records > 0 && deps.migrated) {
        try { deps.migrated(home, out.records) } catch (err) { deps.log('warn', 'journal migration: re-arm after a late migration failed', { error: (err as Error).message }) }
      }
    }
    return migrating.has(home)
  }

  /** A write for a home whose v1 file a migration left part way: try that file again, else refuse. */
  function migratingRefusal(home: string, opts: AppendOpts): JournalRefusal | null {
    if (opts.v1Seq !== undefined) return null
    claimUnknown(home)
    if (!retryMigrating(home)) return null
    return refuse('journal_unwritable', 'this host is still moving the journal an older daemon left for this Walnut into v2', { why: 'migrating' })
  }

  /** JSON with sorted keys: the same record always gives the same text. */
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
    }
    return JSON.stringify(v) ?? 'null'
  }

  /**
   * A migrated v1 record's op id, from the record itself (seq, time, kind, body): the
   * same record in a file rewritten later (an older instance still running, a kept file)
   * gets the same id, so it is found pending (append's dedupe) or acked (`importedAcked`).
   */
  function v1OpId(rec: Record<string, unknown>): string {
    const { v: _v, ...own } = rec
    return `v1-${deps.sha256(Buffer.from(canonical(own), 'utf8')).slice(0, 16)}`
  }

  /** Rename a v1 file aside (never over an earlier one): `.migrated` or `.unconverted`. */
  function setAside(file: string, suffix: '.migrated' | '.unconverted', home: string): string {
    let target = `${file.replace(CLAIM_RE, '')}${suffix}`
    if (fs.existsSync(target)) target = `${target}.${deps.now()}`
    try { fs.renameSync(file, target) } catch (err) {
      deps.log('warn', 'journal migration: v1 journal not renamed', { home, file, error: (err as Error).message })
    }
    return target
  }

  function migrateFile(home: string, file: string, raw: string, parsed: unknown, out: { records: number; unconverted: number }): boolean {
    const j = journalOf(home)
    // The migrated files and acked ids as another process (the Mac's drain) last saved them.
    // A state.json that cannot be read now keeps the v1 file as it is, for a later boot.
    try { locked(home, () => undefined) } catch (err) {
      deps.log('error', 'journal migration: v1 journal kept, the journal state could not be read', { home, file, error: isRefusal(err) ? err.message : (err as Error).message })
      return false
    }
    let claim = file
    try { claim = claimV1(file) } catch (err) {
      // v1 replaces its file by rename, so its name never goes missing: gone means taken already.
      if ((err as { code?: string }).code === 'ENOENT') return true
      deps.log('error', 'journal migration: v1 journal kept, it could not be claimed', { home, file, error: (err as Error).message })
      return false
    }
    try {
      const now = fs.readFileSync(claim, 'utf8')
      if (now !== raw) { raw = now; parsed = JSON.parse(now) }
    } catch (err) {
      deps.log('error', 'journal migration: v1 journal kept, its claim could not be read', { home, file, claim, error: (err as Error).message })
      unclaim(claim, file)
      return false
    }
    // Every file a v1 daemon wrote is an object with a records list. Anything else is not
    // a journal this code can read: set aside whole (bytes untouched, rows not merged, its
    // id not remembered), never labelled migrated.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { records?: unknown }).records)) {
      out.unconverted++
      const target = setAside(claim, '.unconverted', home)
      deps.log('error', 'journal migration: v1 journal has no records list; set aside untouched', { home, file, renamedTo: target })
      return true
    }
    const v1 = parsed as { records: unknown[]; rows?: unknown; settledCopies?: unknown }
    const fileId = deps.sha256(Buffer.from(raw, 'utf8')).slice(0, 16)
    const records = v1.records
    let bad = 0
    if (j.migratedV1.indexOf(fileId) === -1) {
      const acked = new Set(j.importedAcked)
      // Request rows the Mac already took: their `row` record in this file was acked, and no
      // later one is pending (the ack dropped the row; a rewritten v1 file must not bring it back).
      const rowOf = (rec: Record<string, unknown>): string | undefined => {
        const row = rec.kind === 'row' ? rec.row as { id?: unknown } | null : null
        return row && typeof row === 'object' && typeof row.id === 'string' ? row.id : undefined
      }
      const takenRows = new Set<string>()
      const owedRows = new Set<string>()
      for (const item of records) {
        const rec = item as Record<string, unknown> | null
        if (!rec || typeof rec !== 'object' || typeof rec.seq !== 'number' || typeof rec.kind !== 'string') { bad++; continue }
        const opId = v1OpId(rec)
        const rowId = rowOf(rec)
        if (rowId) (acked.has(opId) ? takenRows : owedRows).add(rowId)
        if (acked.has(opId)) continue
        const { seq, at, online, v: _v, ...body } = rec
        const actor: JournalActor | undefined = rec.kind === 'op' && typeof rec.callerSid === 'string' ? { kind: 'session', sid: rec.callerSid } : undefined
        const r = append(home, body, {
          opId, at: typeof at === 'number' ? at : deps.now(), v1Seq: seq as number,
          online: online === true, coalesce: false, ...(actor ? { actor } : {}),
        })
        if (!r.ok) {
          deps.log('error', 'journal migration: v1 journal kept, a record could not be saved', { home, file, seq, error: r.message })
          unclaim(claim, file)
          return false
        }
        if (!r.duplicate) out.records++
      }
      // The request rows and settled copies the old daemon kept beside its records, and the
      // file's id, saved under the lock before the rename.
      const rows = v1.rows && typeof v1.rows === 'object' ? v1.rows as Record<string, unknown> : {}
      try {
        locked(home, (jj) => {
          for (const [id, row] of Object.entries(rows)) {
            if (!(id in jj.rows) && !(takenRows.has(id) && !owedRows.has(id))) jj.rows[id] = row
          }
          for (const id of Array.isArray(v1.settledCopies) ? v1.settledCopies : []) {
            if (typeof id === 'string' && jj.settledCopies.indexOf(id) === -1) jj.settledCopies.push(id)
          }
          if (jj.migratedV1.indexOf(fileId) === -1) jj.migratedV1.push(fileId)
          writeState(jj)
        })
      } catch (err) {
        deps.log('error', 'journal migration: v1 journal kept, its state could not be saved', { home, file, error: isRefusal(err) ? err.message : (err as Error).message })
        unclaim(claim, file)
        return false
      }
    }
    out.unconverted += bad
    // A failed rename is logged: its records are in v2 and its id is remembered, so a later
    // boot skips it.
    const target = setAside(claim, bad ? '.unconverted' : '.migrated', home)
    deps.log(bad ? 'error' : 'info', 'journal migration: v1 journal moved into v2', { home, file, fileId, records: records.length - bad, unconverted: bad, renamedTo: target })
    return true
  }

  function compact(home: string): boolean {
    try { return locked(home, (j) => maybeCompact(j, true)) } catch { return false }
  }

  /** Release every kept append fd (keepOpen); the store stays usable and reopens on demand. */
  function close(): void {
    for (const j of journals.values()) dropFd(j)
  }

  // Building a store reads and writes nothing (every run of the daemon binary builds one,
  // the walnut CLI and --status included): the dir's journals are read at the first call,
  // and only the boot migration (createJournalMigration) copies, imports or sweeps.
  let loaded = false
  function on<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
    return (...a: A) => {
      if (!loaded) { loaded = true; load() }
      return fn(...a)
    }
  }

  return {
    append: on(append), appendNote: on(appendNote), drain: on(drain), ack: on(ack), records: on(records), pending: on(pending),
    drainableCount: on(drainableCount), drainableRecords: on(drainableRecords), stats: on(stats), state: on(state), persist: on(persist),
    markDirty: on(markDirty), readBlob, migrateV1: on(migrateV1), migrateSlices: on(migrateSlices),
    /** A whole note body by its sha256 (the offline host's read overlay, WP11), or null. */
    blobBody: (sha: unknown): Buffer | null => {
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) return null
      try { return fs.readFileSync(path.join(blobDir(), sha)) } catch { return null }
    },
    compact: on(compact), close, byOpId: on(byOpId), sweepBlobs: on(sweepBlobs),
    /** A body stored on its own (no record names it yet: the hour-old orphan sweep may take it). */
    putBlob: on((home: string, body: Uint8Array): { ok: true; sha: string } | JournalRefusal => {
      try { return withBlobLock(() => putBlob(home, body)) } catch (err) { return isRefusal(err) ? err : unwritable(err) }
    }),
    homes: on(() => [...journals.keys()]),
    /** A configure named `home`: its journal is loaded, and a v1 file waiting for its Walnut is moved now. */
    adopt: on((home: string) => { journalOf(home); claimUnknown(home); retryMigrating(home) }),
    journalIdOf: on((home: string) => journalOf(home).journalId),
    /** Read what other processes appended (tests, and the follower's reads). */
    refresh: on((home: string) => { try { readTail(journalOf(home), false) } catch { /* memory answers */ } }),
  }
}

export type OfflineJournal = ReturnType<typeof createOfflineJournal>

export interface JournalMigrationDeps {
  path: typeof import('node:path')
  /** The store of this daemon's ONE journal dir. */
  journal: OfflineJournal
  /** That store's dir. */
  dir: string
  /**
   * Where an older daemon left v1 journals and slices (its DAEMON_DIR/offline-host, and for
   * the prod dir's daemon also the home fallback's): only v1 files and slices are read
   * there, never a v2 journal, only this user's own (lstat: dir, its daemon dir, each file),
   * and nothing is written there but the `.migrated` rename.
   */
  legacyDirs: string[]
  /** The leader book's legacy import (leader-core importLegacy). */
  importLegacyLeaders?: () => void
  /** Slices were copied into this dir: the offline host reads them again. */
  slicesMoved?: () => void
  /**
   * v1 records were appended: whatever the daemon armed from the journal before the
   * migration ran (the trigger holds: a pause or delete made under the old daemon) is
   * armed again from it now.
   */
  recordsMigrated?: () => void
  /** WALNUT_JOURNAL_DIR given on the production daemon dir: logged, ignored. */
  ignoredTestDir?: string | null
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

/**
 * The boot migration of the daemon twins (plan WP8, section 5 Location and Migration),
 * shared so both twins run the same rule (daemon-source.ts inlines it by toString). `boot()`
 * runs once daemon.pid names this process, never at module load: slices and leader records
 * from the legacy dirs, every v1 journal into v2, then the orphan body sweep. There is ONE
 * journal root per host in every mode, so no v2 record ever moves between dirs.
 */
export function createJournalMigration(deps: JournalMigrationDeps) {
  function boot(): void {
    let took = 0
    if (deps.ignoredTestDir) {
      deps.log('error', 'journal: WALNUT_JOURNAL_DIR is for tests and is ignored on the production daemon dir', { dir: deps.ignoredTestDir })
    }
    // Slices and the leader book move with their journals (read from this dir from now on).
    try {
      if (deps.journal.migrateSlices(deps.legacyDirs) && deps.slicesMoved) deps.slicesMoved()
    } catch (err) { deps.log('warn', 'journal migration: slices not copied', { error: (err as Error).message }) }
    try { if (deps.importLegacyLeaders) deps.importLegacyLeaders() } catch (err) {
      deps.log('warn', 'journal migration: leader records not copied', { error: (err as Error).message })
    }
    try {
      const r = deps.journal.migrateV1(deps.legacyDirs)
      if (r.files || r.kept) deps.log(r.kept || r.unconverted ? 'warn' : 'info', 'journal migration: done', { ...r, dir: deps.dir, from: deps.legacyDirs })
      took = r.records
    } catch (err) {
      deps.log('error', 'journal migration: failed; the v1 journals are kept as they are', { error: (err as Error).message })
      took = 1 // it may have appended records before it failed
    }
    // A file left part way counts too: its appended records are in the journal now.
    if (took > 0 && deps.recordsMigrated) {
      try { deps.recordsMigrated() } catch (err) { deps.log('warn', 'journal migration: re-arm after the migration failed', { error: (err as Error).message }) }
    }
    try { deps.journal.sweepBlobs(true) } catch { /* the next ack sweeps */ }
  }

  return { boot }
}

export type JournalMigration = ReturnType<typeof createJournalMigration>
