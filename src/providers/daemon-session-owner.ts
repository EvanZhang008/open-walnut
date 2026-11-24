/**
 * Who a session on this host belongs to, and what starts it again: the resume records (the last
 * spawn command of each session, host-resume-core.ts), the CLI's content arguments that ride files
 * (cli-argv-files-core.ts), the one CLI per session id (cli-owner-core.ts), and the session's
 * Walnut as its start, the spawn journal or its resume record names it.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; the session code there (start, stop, resume, the trigger and bridge resumes)
 * calls what it returns under the same names. The code is the runtime's as it was; deps carry the
 * runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAsyncStartTimeReader, boundedExecFile, MODE_CLI } from './daemon-core.js'
import { createHostResume } from './host-resume-core.js'
import { createCliOwner } from './cli-owner-core.js'
import { createCliArgvFiles } from './cli-argv-files-core.js'
import type { ChildProcessFns } from './daemon-child-spawn.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { SessionData } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

export interface DaemonSessionOwnerDeps<W extends object> {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  DAEMON_DIR: string
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  IS_PROD_DAEMON_DIR: boolean
  /** Where the session streams live (the argv files beside them). */
  STREAMS_DIR: string
  /** The spawn journal (the CLI owner records sit beside it). */
  SPAWN_JOURNAL: string
  DAEMON_INSTANCE_ID: string
  /** The runtime's execFile (its children get the runtime's env and umask). */
  execFile: ChildProcessFns['execFile']
  /** This process's start time, as the registry records one (daemon-core readStartTime). */
  readStartTime: (pid: number) => string | null
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => unknown
  sessions: Map<string, SessionData<W>>
  /** The spawn journal's ids, read once and again after forgetJournaledSids. */
  journaledIds: () => Set<string>
  /** Read the spawn journal again on the next journaledIds (another daemon may have written it). */
  forgetJournaledSids: () => void
  journaledHome: (sid: string) => string | undefined
  /** The journal's first line per sid: the home that asked, and the Walnut it was for. */
  journaledHomes: ReadonlyMap<string, string>
  journaledWalnuts: ReadonlyMap<string, string>
  walnutOfHome: (home: string) => string
  servedWalnutOf: (home: string) => string | undefined
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The offline host's owners (made further down in the runtime, so asked on use). */
  offlineHost: { ownerOf: (sid: string) => string | undefined }
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  logMsg: DaemonLog
}

export function createDaemonSessionOwner<W extends object>(deps: DaemonSessionOwnerDeps<W>) {
  const { daemonEnv, HOME_DIR, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, STREAMS_DIR, SPAWN_JOURNAL, DAEMON_INSTANCE_ID, execFile, readStartTime, killProcessGroup, sessions, journaledIds, forgetJournaledSids, journaledHome, journaledHomes, journaledWalnuts, walnutOfHome, servedWalnutOf, walnutScope, offlineHost, setTimeout, logMsg } = deps

  // ── Resume records (host-resume-core.ts) ──
  // The last spawn command of each session, kept so this host can start a stopped
  // one again without a server: a trigger fire no server claimed (resumeForTrigger
  // below), and a bridge resume after this daemon restarted (the registry keeps
  // only RUNNING sessions). Beside the trigger state, so a reboot keeps it.
  // WALNUT_RESUME_RECORD_DIR is for TESTS ONLY.
  const RESUME_RECORD_DIR = SERVICE_MODE && DAEMON_STATE_DIR
    ? path.join(DAEMON_STATE_DIR, 'resume-records')
    : daemonEnv.WALNUT_RESUME_RECORD_DIR || (IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'resume-records') : path.join(DAEMON_DIR, 'resume-records'))
  const hostResume = createHostResume({
    fs, path,
    dir: RESUME_RECORD_DIR,
    now: () => Date.now(),
    log: (level, msg, data) => logMsg(level, msg, data),
    modeCli: MODE_CLI,
  })

  // ── The CLI's content arguments ride files, never its argv (cli-argv-files-core.ts) ──
  // A pattern kill matched the hook text in every CLI's command line (2026-10-31).
  const cliArgvFiles = createCliArgvFiles({
    fs, path, crypto,
    dir: path.join(STREAMS_DIR, 'argv'),
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  // ── One CLI per session id on this host (cli-owner-core.ts) ──
  // Beside the spawn journal, so every daemon that spawns into the same ~/.claude
  // (this one, an ephemeral test server's, a restarted one) reads one set of
  // records, and a test harness that moves the journal moves these with it.
  const cliOwnerStartTime = createAsyncStartTimeReader({
    fs,
    env: daemonEnv,
    execFileFn: (file, args, options, callback) => execFile(file, args, options, (error, stdout) => callback(error, String(stdout ?? ''))),
  })
  const cliOwner = createCliOwner({
    fs, path,
    dir: path.join(path.dirname(SPAWN_JOURNAL), 'cli-owners'),
    configDir: daemonEnv.CLAUDE_CONFIG_DIR || path.join(daemonEnv.HOME || HOME_DIR, '.claude'),
    platform: process.platform,
    self: { pid: process.pid, startTime: readStartTime(process.pid), instance: DAEMON_INSTANCE_ID },
    now: () => Date.now(),
    log: (level, msg, data) => logMsg(level, msg, data),
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
    },
    startTimeOf: (pid) => cliOwnerStartTime(pid),
    // Bounded: answers at the deadline even when ps is stuck in the kernel (2026-10-29).
    exec: (file, args, timeoutMs) => boundedExecFile(
      (f, a, options, callback) => execFile(f, a, options, (error, stdout) => callback(error, String(stdout ?? ''))),
      file, args, { encoding: 'utf-8' as const, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...daemonEnv, LANG: 'C' } },
    ).then(({ error, stdout }) =>
      // Exit 1 is ps naming a pid that is gone; a timeout or a kill is a cut-short table: null.
      !error || (error.code === 1 && !error.killed && !error.signal) ? stdout : null),
    nonce: () => crypto.randomBytes(8).toString('hex'),
  })

  /**
   * A `strict` start (an ephemeral test server's, which runs on a COPY of the real
   * data) may only touch a transcript it started itself: the spawn journal's first
   * line for the sid names the asking Walnut, or the sid was never journaled and
   * this is a new session. Otherwise it would run its copied clocks and queues as
   * turns of the user's real session (2026-10-25).
   */
  function strictStartRefusal(sid: string, cmd: Record<string, unknown>, home: string | undefined, resume: boolean): Error | null {
    if (cmd.strict !== true) return null
    // Another daemon may have journaled it since this one read the journal.
    if (!journaledIds().has(sid)) forgetJournaledSids()
    const owner = journaledHome(sid)
    const journaled = journaledIds().has(sid)
    if (owner ? owner === walnutOfHome(home ?? '') : !journaled && !resume) return null
    const whose = owner ? `the Walnut at ${owner}` : journaled ? 'a Walnut that did not record itself' : 'outside Walnut'
    return Object.assign(new Error(`start: this session was started by ${whose}, not by this test server; a test server does not run a session of another Walnut`), { code: 'SESSION_NOT_OURS', errorKind: 'session_other_walnut' })
  }

  /**
   * Wait for a CLI this daemon stopped to be gone, its whole group (a launcher
   * shim can exit before the binary it started): SIGKILL the group at 3 s, give
   * up at 8 s.
   */
  async function waitForStoppedProcess(pid: number): Promise<boolean> {
    const signalable = (target: number) => { try { process.kill(target, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
    const alive = () => Number.isSafeInteger(pid) && pid > 1 && (signalable(-pid) || signalable(pid))
    const startedAt = Date.now()
    let killed = false
    while (alive()) {
      const waited = Date.now() - startedAt
      if (waited >= 8000) return false
      if (!killed && waited >= 3000) { killed = true; killProcessGroup(pid, 'SIGKILL') }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return true
  }

  /**
   * A session's last spawn: the in-memory record while it holds the command (this
   * daemon spawned or adopted it), else its resume record. The mode is the one
   * that record has now: setMode keeps both current. `home`: the Walnut that
   * asked for its latest spawn, as either one recorded it.
   */
  function spawnRecordOf(sid: string): { args: string[]; cwd: string; mode: string; home?: string } | null {
    const s = sessions.get(sid)
    const rec = s && s.spawnInfo?.home ? null : hostResume.recall(sid)
    if (s && s.args && s.args.length > 0 && s.cwd) return { args: s.args, cwd: s.cwd, mode: s.mode || 'default', home: s.spawnInfo?.home || rec?.home }
    return rec ? { args: rec.args, cwd: rec.cwd, mode: rec.mode || 'default', home: rec.home } : null
  }

  /**
   * The Walnut a session belongs to (its data dir): what its start named, else the
   * spawn journal's or the resume record's. '' when none is recorded (a server older
   * than owner-home-v1). Per-Walnut settings (hooks, turn snapshots) are looked up by it.
   */
  function sessionHomeOf(sid: string): string {
    // The Walnut, by its first home here: a session its server started from a later home is the same Walnut's.
    const spawn = sessions.get(sid)?.spawnInfo
    if (spawn?.walnut) return walnutScope.canonical(spawn.walnut)
    // A respawn from the home the journal's first line named (its spec gone since, so the spawn
    // could not name the Walnut): the journal's Walnut for that home is still the one it was for.
    journaledIds()
    const firstWalnut = journaledWalnuts.get(sid)
    if (spawn?.home && firstWalnut && spawn.home === journaledHomes.get(sid)) return walnutScope.canonical(firstWalnut)
    return walnutOfHome(spawn?.home || journaledHome(sid) || hostResume.recall(sid)?.home || offlineHost.ownerOf(sid) || '')
  }

  /**
   * The home the session's LATEST spawn here named, unmapped: a host server's data dir stays that
   * dir, not its Walnut. The latest, so a session the host took over by a resume spawn stays the
   * host server's after the daemon restarts (the journal keeps the first spawn's home). The
   * companion bridge's gate (bridgeHearsSession, session.permission): a session the host's own
   * server started or took over is operated by that server and its leader's channel only, never by
   * the bridge's direct send, attach, resume or prompt answer.
   */
  function sessionStartHomeOf(sid: string): string {
    return walnutScope.canonical(lastSpawnHomeOf(sid) || offlineHost.ownerOf(sid) || '')
  }

  /** The home of the latest spawn of `sid` here: live, else the resume record, else the journal's first line. */
  function lastSpawnHomeOf(sid: string): string | undefined {
    journaledIds()
    return sessions.get(sid)?.spawnInfo?.home || hostResume.recall(sid)?.home || journaledHomes.get(sid)
  }

  /**
   * A stop asked from a server's own data dir (the host's replica) reaches only a session that
   * server spawned last here: one the Mac started and runs is the Mac's to stop, though the daemon
   * takes the replica for its Walnut everywhere else (walnutOfHome). A session the host took over
   * (its resume spawn named the data dir) is the replica's.
   */
  function servedStopRefusal(sid: string, home: string): { reason: string; detail?: string } | null {
    if (!servedWalnutOf(home)) return null
    const last = lastSpawnHomeOf(sid)
    return last && walnutScope.canonical(last) === walnutScope.canonical(home) ? null : { reason: 'not_owned', detail: 'not_this_server' }
  }

  return { RESUME_RECORD_DIR, hostResume, cliArgvFiles, cliOwner, strictStartRefusal, waitForStoppedProcess, spawnRecordOf, sessionHomeOf, sessionStartHomeOf, lastSpawnHomeOf, servedStopRefusal }
}
