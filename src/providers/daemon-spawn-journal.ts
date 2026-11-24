/**
 * The spawn journal: one JSON line per CLI session any Walnut daemon on this host started,
 * under the HOME whose ~/.claude the CLI writes into (the header below says why there). Here:
 * the journal's file and its one-write append, the ids and first homes read from it (cached
 * until forgetJournaledSids), the Walnut a home names (walnutOfHome, with the data dirs of the
 * servers this daemon runs for a leader), whether a session lived here, the spawn record a
 * start appends, and the boot's backfill from the old markers and the streams dir.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; the session owner, the session start, the gateway, the follower code and the
 * cloud bridge read it through what it returns, and Main runs the backfill. The code is the
 * runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { SpawnInfo } from './daemon-session-types.js'
import type { DaemonEnv } from './daemon-module-deps.js'

export interface DaemonSpawnJournalDeps {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  STREAMS_DIR: string
  /** A test server's own daemon (its key), else '' (defined further down, so asked on use). */
  ISOLATED_FOR: () => string
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The servers this daemon runs for a leader (made further down: a lookup before it throws, and answers nothing). */
  hostServers: { walnutOf: (home: string) => string | undefined; dataDirs: () => string[] }
}

export function createDaemonSpawnJournal(deps: DaemonSpawnJournalDeps) {
  const { daemonEnv, HOME_DIR, STREAMS_DIR, ISOLATED_FOR, walnutScope, hostServers } = deps

  // Append-only record of every CLI session ANY Walnut daemon on this host
  // started: one JSON line per session id, under the HOME whose ~/.claude the CLI
  // writes its transcripts into. The external-session scan reads it to tell
  // Walnut's own sessions from outside ones BY ID, so a session whose record lives
  // in another Walnut instance's DB (a dev server, an ephemeral test server whose
  // data dir is gone) is never imported. Anchored to the CLI's HOME, NOT to
  // STREAMS_DIR or DAEMON_DIR: isolated test daemons override those, but their
  // CLIs inherit process.env and keep writing the real ~/.claude.
  //
  // Line: {v, sid, at, kind: new|fork|resume|backfill, parent?, cwd?, home?, task?}
  // (home + task = which Walnut data dir asked, for which task). The id is the
  // CLI's own: the args when they name it (--session-id, --resume), else the init
  // line's session_id. Each line is ONE O_APPEND write of at most 4KB, so
  // concurrent daemons never interleave; readers skip a torn tail. It grows by one
  // line per session ever started (~200 bytes), which is the record itself, so
  // there is nothing to compact. WALNUT_SPAWN_JOURNAL relocates it: the test
  // harness points it at a temp file so mock spawns stay out of the real one.
  // The reader is readSpawnJournal in
  // external-session-scan-core.ts.
  const SPAWN_JOURNAL = daemonEnv.WALNUT_SPAWN_JOURNAL
    || path.join(daemonEnv.HOME || HOME_DIR, '.open-walnut', 'local', 'spawn-journal.jsonl')
  // Before the journal: one empty file per session id (2026-09-23 to 09-26).
  const LEGACY_SPAWN_LEDGER_DIR = path.join(daemonEnv.HOME || HOME_DIR, '.open-walnut', 'tmp', 'spawned-sessions')
  const SPAWN_JOURNAL_LINE_MAX = 4096
  let journaledSids: Set<string> | null = null
  // sid -> the Walnut data dir that asked for its first spawn, from the same
  // lines: the ownership proofs (orphan-stop-v1, owner-home-v1) name the asking
  // Walnut, not just "some Walnut on this host". The FIRST line for a sid decides,
  // the same rule as readSpawnJournal in external-session-scan-core.ts: a first
  // line without a home (a backfilled record) names no Walnut, even when another
  // daemon on the host appended a later line that does. Later spawns of a
  // journaled sid append nothing.
  const journaledHomes = new Map<string, string>()
  // sid -> the Walnut a start from a server's own data dir was for (the `walnut` of its first
  // line: host-server-core.ts walnutOf at the spawn), so it stays that Walnut's after the server's
  // spec is gone. An older daemon reads the line without it, as before.
  const journaledWalnuts = new Map<string, string>()
  // A crashed writer can leave a torn last line with no newline; the first append
  // then starts a fresh line instead of gluing its record onto the torn one.
  let journalTornTail = false

  function isJournalSid(sid: unknown): sid is string {
    return typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid)
  }

  function journaledIds(): Set<string> {
    if (journaledSids) return journaledSids
    const ids = new Set<string>()
    let text = ''
    try { text = fs.readFileSync(SPAWN_JOURNAL, 'utf8') } catch { /* no journal yet */ }
    journalTornTail = text.length > 0 && !text.endsWith('\n')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (isJournalSid(rec?.sid) && !ids.has(rec.sid)) {
          ids.add(rec.sid)
          if (typeof rec.home === 'string' && rec.home) journaledHomes.set(rec.sid, rec.home)
          if (typeof rec.walnut === 'string' && path.isAbsolute(rec.walnut) && rec.walnut.length <= 1024) journaledWalnuts.set(rec.sid, rec.walnut)
        }
      } catch { /* torn tail from a crashed writer */ }
    }
    journaledSids = ids
    return ids
  }

  /** Drop the cached ids: the next journaledIds() reads the file again (another daemon may have appended). */
  function forgetJournaledSids(): void {
    journaledSids = null
  }

  /**
   * The Walnut that first asked this host to spawn `sid`, if recorded: the Walnut its line names
   * (a start from a server's own data dir), else its home by walnutOfHome. The line keeps the home
   * as it asked.
   */
  function journaledHome(sid: string): string | undefined {
    journaledIds()
    const walnut = journaledWalnuts.get(sid)
    if (walnut) return walnutScope.canonical(walnut)
    const home = journaledHomes.get(sid)
    return home ? walnutOfHome(home) : home
  }

  /** The Walnut whose server here runs on data dir `home` (host-server-core.ts walnutOf), or undefined. */
  function servedWalnutOf(home: string): string | undefined {
    // The supervisor is made further down: a lookup during boot before it sees homes as they are.
    try { return hostServers.walnutOf(home) } catch { return undefined }
  }

  /**
   * The data dir of every server this daemon runs for a leader (served-walnuts-core.ts). The host's
   * one Walnut service is among them: hostServers.boot() files its follower spec (server-<key>.json)
   * as the self entry, whose env names the data dir. Its own OPEN_WALNUT_HOME is not asked: the
   * in-process runtime's env has none (local-daemon.ts buildSpawnEnv).
   */
  function serverDataHomes(): string[] {
    // The supervisor is made further down: none before it is.
    try { return hostServers.dataDirs() } catch { return [] }
  }

  /**
   * The Walnut a home names wherever a session's owner is looked up or compared here: by its
   * first home (walnut-scope-core.ts canonical), and the data dir of a server this daemon runs
   * for a leader as that leader's Walnut (host-server-core.ts walnutOf). A host's own server
   * starts its sessions naming its data dir, while its follower link, the leader's link and the
   * slices name the Walnut by its leader's home: without this, after a restart of the service
   * the host could not read its own session's stream.
   */
  function walnutOfHome(home: string): string {
    return walnutScope.canonical(servedWalnutOf(home) ?? home)
  }

  /**
   * The session lived on this host: its stream file is here, or the spawn journal
   * names it. Stream retention (src/core/stream-retention.ts) drops a finished
   * session's stream after a few days and journals the sid first, so the journal
   * stays the proof a resume needs.
   */
  function livedHere(sid: string): boolean {
    if (fs.existsSync(path.join(STREAMS_DIR, sid + '.jsonl'))) return true
    if (!isJournalSid(sid)) return false
    // The server's retention journals a sid itself, after this daemon read the journal.
    if (!journaledIds().has(sid)) forgetJournaledSids()
    return journaledIds().has(sid)
  }

  function appendSpawnJournal(sid: unknown, rec: Record<string, unknown>): void {
    if (!isJournalSid(sid)) return
    const ids = journaledIds()
    if (ids.has(sid)) return
    const at = new Date().toISOString()
    let line = JSON.stringify({ v: 1, sid, at, ...rec }) + '\n'
    let full = true
    if (Buffer.byteLength(line) > SPAWN_JOURNAL_LINE_MAX) { line = JSON.stringify({ v: 1, sid, at, kind: rec.kind }) + '\n'; full = false }
    try {
      fs.mkdirSync(path.dirname(SPAWN_JOURNAL), { recursive: true })
      fs.appendFileSync(SPAWN_JOURNAL, (journalTornTail ? '\n' : '') + line, { mode: 0o600 })
      journalTornTail = false
      ids.add(sid)
      // Remember only what the line on disk says, so a restart reads the same.
      if (full && typeof rec.home === 'string' && rec.home) journaledHomes.set(sid, rec.home)
      if (full && typeof rec.walnut === 'string' && rec.walnut) journaledWalnuts.set(sid, rec.walnut)
    } catch { /* best effort: the scan also consults the streams dir */ }
  }

  function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag)
    return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : undefined
  }

  function spawnInfoFor(args: string[], cwd: string, resume: boolean, origin: unknown): SpawnInfo {
    const fork = args.includes('--fork-session')
    const o = origin && typeof origin === 'object' ? origin as Record<string, unknown> : {}
    const text = (x: unknown, max: number) => (typeof x === 'string' && x && x.length <= max ? x : undefined)
    const home = text(o.home, 1024)
    return {
      kind: fork ? 'fork' : resume ? 'resume' : 'new',
      parent: fork ? argValue(args, '--resume') : undefined,
      cwd,
      home,
      task: text(o.task, 128),
      // A start from a server's own data dir: the Walnut it is for, kept on the journal line.
      walnut: home ? servedWalnutOf(home) : undefined,
    }
  }

  /** The CLI session id the args already name; a fork's own id is only known from init. */
  function namedSessionId(args: string[]): string | undefined {
    if (args.includes('--fork-session')) return undefined
    return argValue(args, '--session-id') ?? argValue(args, '--resume')
  }

  // Fold the per-id marker files (then remove them) and this daemon's streams
  // captures into the journal, so it alone answers for everything already started.
  // The marker dir belongs to the DEFAULT journal only: a relocated journal (a test
  // daemon under the real HOME) must never swallow and delete the real markers.
  function backfillSpawnJournal(): void {
    const list = (dir: string) => { try { return fs.readdirSync(dir) } catch { return [] as string[] } }
    // A test server's isolated daemon leaves the markers to the host's own daemon: it never deletes them.
    const legacy = daemonEnv.WALNUT_SPAWN_JOURNAL || ISOLATED_FOR() ? [] : list(LEGACY_SPAWN_LEDGER_DIR)
    for (const name of legacy) appendSpawnJournal(name, { kind: 'backfill', from: 'ledger' })
    for (const name of list(STREAMS_DIR)) {
      if (name.endsWith('.jsonl')) appendSpawnJournal(name.slice(0, -6), { kind: 'backfill', from: 'streams' })
    }
    const ids = journaledIds()
    if (legacy.length > 0 && legacy.every((name) => !isJournalSid(name) || ids.has(name))) {
      try { fs.rmSync(LEGACY_SPAWN_LEDGER_DIR, { recursive: true, force: true }) } catch { /* retried next start */ }
    }
  }

  return { SPAWN_JOURNAL, journaledHomes, journaledWalnuts, isJournalSid, journaledIds, forgetJournaledSids, journaledHome, servedWalnutOf, serverDataHomes, walnutOfHome, livedHere, appendSpawnJournal, spawnInfoFor, namedSessionId, backfillSpawnJournal }
}
