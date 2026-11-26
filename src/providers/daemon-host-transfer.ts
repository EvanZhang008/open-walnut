/**
 * The session daemon's host-local runs and facts: one-shot claude runs ('oneshot-v1'), workspace
 * transfer and uploads ('fs-write-part-v1', 'transfer-v1'), the host's facts and vitals
 * ('host-facts-v1') and the desktop app's update.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose dispatcher answers
 * the one-shot runs through replyOneShot and whose command table the host-local commands through
 * transferAnswer, with the cores returned here; its cleanup, Demo quiesce and
 * socket close end the one-shot runs. The code is the runtime's as it was; deps carry the
 * runtime's own names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { createOneShotCore, type OneShotChild } from './oneshot-core.js'
import { createTransferCore, type TransferCoreDeps } from './transfer-core.js'
import { createTransferPack, type TransferPackDeps } from './transfer-pack-core.js'
import { createHostFacts, type HostFactsDeps } from './host-facts-core.js'
import { createHostVitals, type HostVitalsDeps } from './host-vitals-core.js'
import { createDesktopUpdate } from './desktop-update-core.js'
import { ensureTaskDir, isTaskDirId, taskDirPath } from './task-dir-core.js'
import type { createCliArgvFiles } from './cli-argv-files-core.js'
import type { createHostResume } from './host-resume-core.js'
import type { createDaemonCommandDrain } from './daemon-command-drain.js'
import type { ChildProcessFns } from './daemon-child-spawn.js'
import { ok, fail, type Answer, type DaemonEnv, type DaemonLog, type DaemonReplies, type DaemonSendEvent } from './daemon-module-deps.js'
import { daemonGitWriteRefusal } from '../lib/leader-home-gate.js'

export interface DaemonHostTransferDeps<W extends object> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  HOME_DIR: string
  DAEMON_STATE_DIR: string | undefined
  /** The production daemon dir (its ledgers live under HOME, which a reboot keeps). */
  IS_PROD_DAEMON_DIR: boolean
  /** The service set this runtime is, '' for the default one. */
  SET_ID: string
  DAEMON_INSTANCE_ID: string
  DAEMON_START_TS: number
  /** Where the task directories are (uploads land in the task's own). */
  TASK_DIR_ROOT: string
  /** The runtime's spawn and execFile (its children get the runtime's env and umask). */
  spawn: ChildProcessFns['spawn']
  execFile: ChildProcessFns['execFile']
  /** A claude run's content arguments ride files (cli-argv-files-core.ts). */
  cliArgvFiles: ReturnType<typeof createCliArgvFiles>
  /** The runtime's sessions, read only: an upload's task, and the vitals' running count. */
  sessions: { get(sid: string): { spawnInfo?: { task?: string } } | undefined; values(): Iterable<{ state: string }> }
  /** The resume records: the task of a session this daemon no longer holds. */
  hostResume: Pick<ReturnType<typeof createHostResume>, 'recall'>
  /** The runtime's sockets, and which are a Walnut server's. */
  wsClients: ReadonlySet<W>
  isServerClient: (ws: W) => boolean
  /** Tracked work (a pack, a fetch) rides the command drain. */
  daemonCommands: ReturnType<typeof createDaemonCommandDrain>
  sendEvent: DaemonSendEvent<W>
  logMsg: DaemonLog
}

export function createDaemonHostTransfer<W extends object>(deps: DaemonHostTransferDeps<W>) {
  const { daemonEnv, DAEMON_DIR, HOME_DIR, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, DAEMON_INSTANCE_ID, DAEMON_START_TS, TASK_DIR_ROOT, spawn, execFile, cliArgvFiles, sessions, hostResume, wsClients, isServerClient, daemonCommands, sendEvent, logMsg, sendOk, sendError } = deps

  // ── One-shot claude runs (host-local, capability 'oneshot-v1') ──
  // PARITY: The logic is oneshot-core.ts
  // (shared with the source twin and the server's in-process fallback). Not on
  // the command drain: a handover or shutdown kills these runs (their caller
  // sees the link drop) instead of waiting minutes for a model turn.
  const oneShot = createOneShotCore<W>({
    // A claude run's content arguments ride files too (cli-argv-files-core.ts).
    spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => spawn(cmd, cliArgvFiles.isClaude(cmd, args) ? cliArgvFiles.toFiles(args) : args, opts)) as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => OneShotChild,
    send: (ws, ev, data) => sendEvent(ws, ev, data),
    env: daemonEnv,
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  function replyOneShot(ws: W, id: number, name: string, fn: () => Record<string, unknown>) {
    try {
      sendOk(ws, id, fn())
    } catch (err) {
      sendError(ws, id, name + ' failed: ' + (err as Error).message)
    }
  }

  // ── Workspace transfer + host facts (host-local: 'fs-write-part-v1', 'transfer-v1',
  // 'host-facts-v1') ──
  // PARITY: The logic is transfer-core.ts,
  // transfer-pack-core.ts and host-facts-core.ts (shared with the source twin).
  const transferCore = createTransferCore({
    fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env: daemonEnv, home: HOME_DIR,
    randomId: () => crypto.randomBytes(6).toString('hex'),
    getuid: () => process.getuid!(),
    ownerStamp: readDaemonOwnerStamp,
    instanceId: DAEMON_INSTANCE_ID,
  })
  const transferPack = createTransferPack({
    fs, path, crypto, spawn: spawn as unknown as TransferPackDeps['spawn'], env: daemonEnv, home: HOME_DIR,
    // No git write into a Walnut data home under a leader switch (lib/leader-home-gate.ts).
    gitWriteRefused: daemonGitWriteRefusal,
  })
  const desktopUpdate = createDesktopUpdate({ fs, execFile, spawn, platform: process.platform, home: HOME_DIR, env: daemonEnv, isolated: !IS_PROD_DAEMON_DIR })
  const hostFacts = createHostFacts({
    fs, os, execFile: execFile as unknown as HostFactsDeps['execFile'], http, https,
    env: daemonEnv, home: HOME_DIR, platform: process.platform, arch: process.arch,
  })
  // The minute ledger lives under HOME beside the streams, so it outlives a reboot
  // (/tmp does not); an isolated daemon keeps it inside its own throwaway dir.
  // PARITY:
  const HOST_VITALS_DIR = daemonEnv.WALNUT_HOST_VITALS_DIR
    || (SET_ID ? path.join(DAEMON_STATE_DIR!, 'host-vitals') : IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-vitals') : path.join(DAEMON_DIR, 'host-vitals'))
  const hostVitals = createHostVitals({
    fs, os, execFile: execFile as unknown as HostVitalsDeps['execFile'], platform: process.platform,
    dir: HOST_VITALS_DIR, startedAt: DAEMON_START_TS, diskPath: HOME_DIR,
    // A Walnut server's own link: any socket but a follower's, a lane's or the bridge.
    linked: () => { for (const c of wsClients) if (isServerClient(c)) return true; return false },
    running: () => { let n = 0; for (const s of sessions.values()) if (s.state === 'running') n++; return n },
  })

  /**
   * The raw text of this daemon's owner stamp (`daemon.owner` in its own daemon dir,
   * written only by the local Walnut that spawned it): null when there is none (a
   * daemon started over ssh), undefined when the name holds anything but a small plain
   * file of ours. Opened without blocking and type-checked on its fd, so a FIFO there
   * never stalls the daemon. transfer-core.ts decides what the text vouches for (only
   * a stamp naming DAEMON_INSTANCE_ID).
   */
  function readDaemonOwnerStamp(): string | null | undefined {
    const C = fs.constants
    let fd: number
    try { fd = fs.openSync(path.join(DAEMON_DIR, 'daemon.owner'), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY) } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
    }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.uid !== process.getuid!() || st.size > 64 * 1024) return undefined
      return fs.readFileSync(fd, 'utf8')
    } catch { return undefined } finally { try { fs.closeSync(fd) } catch { /* closed */ } }
  }

  /**
   * Where a session's uploads land: the task's own directory, which survives a
   * reboot and is cleaned with the task. The task is the one THIS daemon started
   * the session for; a bridge caller cannot name another, and only the server's
   * own link may name it for a session this daemon does not know. Without a task,
   * a durable folder beside the task directories (never /tmp, which a reboot
   * empties). The directory is made by an upload's first chunk only.
   */
  /** The uploads folder no task owns (a file sent before its session existed); */
  function uploadsOwnerlessRoot(): string {
    return path.join(path.dirname(TASK_DIR_ROOT), 'uploads')
  }
  function uploadsRootFor(cmd: Record<string, unknown>, bridge: boolean): string {
    const sid = typeof cmd.sessionId === 'string' ? cmd.sessionId : ''
    const known = sid ? (sessions.get(sid)?.spawnInfo?.task ?? hostResume.recall(sid)?.task) : undefined
    const taskId = known ?? (bridge ? undefined : cmd.taskId)
    const fallback = uploadsOwnerlessRoot()
    if (cmd.offset !== 0) {
      const dir = isTaskDirId(taskId) ? taskDirPath(TASK_DIR_ROOT, taskId) : null
      return dir && fs.existsSync(dir) ? path.join(dir, 'uploads') : fallback
    }
    const dir = ensureTaskDir(TASK_DIR_ROOT, taskId, bridge ? undefined : cmd.home)
    return dir ? path.join(dir, 'uploads') : fallback
  }

  /**
   * The answer of one host-local command (the transfer family, host facts, exec, MCP, net, ...):
   * its result, or `{error, code, ...data}`. `tracked` work (a pack, a fetch) rides the command
   * drain, so a shutdown waits for it instead of cutting a bundle or a download in half.
   */
  function transferAnswer(name: string, work: () => Promise<unknown>, tracked: boolean): Promise<Answer> {
    const answer = () => work().then(
      (r) => ok(r as Record<string, unknown>),
      (err) => {
        const e = err as Error & { code?: unknown; data?: Record<string, unknown> }
        return fail(name + ' failed: ' + e.message, { ...(e.data ?? {}), code: typeof e.code === 'string' ? e.code : 'failed' })
      },
    )
    try {
      return tracked ? daemonCommands.run(answer) : answer()
    } catch (err) {
      return Promise.resolve(fail(name + ' failed: ' + (err as Error).message, { code: 'shutting_down' }))
    }
  }

  return {
    oneShot, replyOneShot,
    transferCore, transferPack, desktopUpdate, hostFacts, hostVitals,
    uploadsOwnerlessRoot, uploadsRootFor, transferAnswer,
  }
}
