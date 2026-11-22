/**
 * This host's journal: the one store of its journal dir (offline-journal-core.ts), the
 * offline host that answers and journals on it while a Walnut's leader is away
 * (offline-host-core.ts), the boot migration of what an older daemon left
 * (createJournalMigration), and the minute sweep. Shared by both daemon twins
 * (daemon-source.ts inlines it by `toString()`): one function, every helper inside it,
 * the three factories passed in, types only imported.
 *
 * Building it reads the slices (the offline host's copies) and writes nothing: the binary
 * also runs as the walnut CLI (--status, --stop, a `walnut wait` that lives for hours), so
 * only `migrate()`, once daemon.pid names this process, copies slices and leader records,
 * imports v1 journals, sweeps orphan bodies and starts the minute sweep.
 */
import type { JournalMigration, JournalMigrationDeps, OfflineJournal, OfflineJournalDeps } from './offline-journal-core.js'
import type { OfflineHost, OfflineHostDeps } from './offline-host-core.js'

type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

/** What the offline host needs that is the host journal's own (the rest comes from the runtime). */
type HostJournalOwn = 'fs' | 'path' | 'dir' | 'journal' | 'maxRecords' | 'now' | 'randomHex' | 'keyOf' | 'canonical' | 'log'

export interface HostJournalDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** The one journal dir (`offline-host` under the host's journal root). */
  dir: string
  /** Where an older daemon left v1 journals and slices (JournalMigrationDeps.legacyDirs). */
  legacyDirs: string[]
  /** Pending records per Walnut before a write is refused (offline-host-core.ts OFFLINE_MAX_RECORDS). */
  maxRecords: number
  now: () => number
  randomHex: (bytes: number) => string
  sha256: (body: Uint8Array) => string
  keyOf: (home: string) => string
  canonical: (home: string) => string
  /** A process's start time token, so a reused pid never holds a lock. */
  startTimeOf: (pid: number) => string | null
  /** daemon.pid names this process or none (a zombie predecessor refuses journal writes). */
  isOwner: () => boolean
  /** WALNUT_JOURNAL_DIR given on the production daemon dir: logged, ignored. */
  ignoredTestDir: string | null
  /** The leader book's legacy import (its records live beside the journal). */
  importLegacyLeaders: () => void
  /** What the daemon armed from the journal (the trigger holds) is armed again from it. */
  rearm: () => void
  /** A stopping Demo: the minute sweep would deliver journaled messages past its fence. */
  fenced: () => boolean
  createJournal: (deps: OfflineJournalDeps) => OfflineJournal
  createMigration: (deps: JournalMigrationDeps) => JournalMigration
  createHost: (deps: OfflineHostDeps) => OfflineHost
  /** The offline host's ties to the runtime (its sessions, triggers, leader book, sockets). */
  host: Omit<OfflineHostDeps, HostJournalOwn>
  log: Log
}

export function createHostJournal(deps: HostJournalDeps) {
  const { fs, path, dir } = deps
  const store = deps.createJournal({
    fs, path, dir,
    maxRecords: deps.maxRecords,
    now: deps.now,
    randomHex: deps.randomHex,
    keyOf: deps.keyOf,
    sha256: deps.sha256,
    log: deps.log,
    startTimeOf: deps.startTimeOf,
    isOwner: deps.isOwner,
    // One long-lived store per dir: the append fd stays open between appends.
    keepOpen: true,
    // A v1 file the boot migration left (part way, or of a Walnut it did not know) finished
    // later: arm the trigger holds again, after the write or configure that finished it.
    migrated: () => { setTimeout(() => deps.rearm(), 0) },
  })

  const host = deps.createHost({
    ...deps.host,
    fs, path, dir,
    journal: store,
    maxRecords: deps.maxRecords,
    now: deps.now,
    randomHex: deps.randomHex,
    keyOf: deps.keyOf,
    canonical: deps.canonical,
    log: deps.log,
  })

  // Legacy slices and leader records, then the v1 journals. The journal root is the same in
  // every mode, so there is no v2 journal elsewhere to take.
  const migration = deps.createMigration({
    path,
    journal: store,
    dir,
    legacyDirs: deps.legacyDirs,
    importLegacyLeaders: () => deps.importLegacyLeaders(),
    slicesMoved: () => host.reloadSlices(),
    // The triggers loaded at boot before the migration: a pause or delete made offline under
    // the old daemon (a v1 record) holds from this boot on, not only once the Mac pushes a set.
    recordsMigrated: () => deps.rearm(),
    ignoredTestDir: deps.ignoredTestDir,
    log: deps.log,
  })

  let sweepTimer: ReturnType<typeof setInterval> | null = null

  /** One minute's sweep (replies whose deadline passed), none while a Demo stops. */
  function sweepTick(): void {
    if (deps.fenced()) return
    host.sweep().catch((err: unknown) => deps.log('warn', 'offline host: the minute sweep failed', { error: String(err) }))
  }

  /** The boot migration, then the minute sweep: once daemon.pid names this process, never at load. */
  function migrate(): void {
    migration.boot()
    if (!sweepTimer) {
      sweepTimer = setInterval(sweepTick, 60_000)
      sweepTimer.unref?.()
    }
  }

  return { store, host, migrate, sweepTick }
}

export type HostJournal = ReturnType<typeof createHostJournal>
