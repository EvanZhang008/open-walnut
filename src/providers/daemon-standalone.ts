#!/usr/bin/env bun
import { createFeatureRelay } from './feature-relay-core.js'
'use strict'

/**
 * walnut-daemon — Remote session manager for Open Walnut.
 *
 * Runs as a persistent server on the remote machine.
 * Manages Claude CLI processes and streams output via WebSocket.
 *
 * Usage:
 *   bun daemon-standalone.ts --start      # Start daemon, print port to stdout
 *   bun daemon-standalone.ts --stop       # Stop running daemon
 *   bun daemon-standalone.ts --status     # Check if daemon is running
 *   bun daemon-standalone.ts --version    # Print version and exit
 *
 * Protocol: JSON over WebSocket
 *   Client → Daemon: { id, cmd, ...params }
 *   Daemon → Client: { id, ok, ...data } or { ev, ...data }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import http from 'node:http'
import net from 'node:net'
import { spawn as rawSpawn, execSync as rawExecSync, execFile as rawExecFile, execFileSync as rawExecFileSync } from 'node:child_process'
import type { ServerWebSocket } from 'bun'
import {
  createDaemonCore,
  defaultReadStartTime,
  defaultReadStartTimes,
  readProcStartTime,
  createAsyncStartTimeReader,
  boundedExecFile,
  envTimerMs,
  type RegistryEntry as CoreRegistryEntry,
  type SessionMode,
  LIVE_FIFO_MODE,
  keepRuntimeFiles,
  RUNTIME_KEEP_MS,
} from './daemon-core.js'
import { Subscribers, type SessionData as SessionDataOf, type AgentSub as AgentSubOf, type WsData } from './daemon-session-types.js'
import { setRuntimeTreesDirOf } from './service-set.js'
import { applyCliLoginPath, installHomeBin, withInstallHomeBin } from './daemon-cli-path.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { PS_TREE_ARGS, claimedSidVerdict, parentName, parseProcessTree, proofFor, shortProgram, type ProcRow } from './caller-proof-core.js'
import { socketPeerPid, socketPeerPidReady } from './socket-peer-pid.js'
import { createHostRuntime } from './host-runtime-core.js'
import { createHostFix } from './host-fix-core.js'
import { createClaudeInstall } from './claude-install-core.js'
import { createClaudeDownload } from './claude-download-core.js'
import { createDtachBuild } from './dtach-build-core.js'
import { createClaudeCheck } from './claude-check-core.js'
import { createOfflineHostCore, OFFLINE_MAX_RECORDS, type HostSlice, type LeaderDelivery, type OfflineTrigger } from './offline-host-core.js'
import { createJournalMigration, createOfflineJournal } from './offline-journal-core.js'
import { createHostJournal } from './host-journal-core.js'
import { createLeaderBook } from './leader-core.js'
import { createWalnutScope } from './walnut-scope-core.js'
import { createServedWalnuts } from './served-walnuts-core.js'
import { createGatewayIdentity, type GatewaySocketFacts } from './gateway-identity-core.js'
import { createHeldCatalogs } from './held-catalogs-core.js'
import { createLiveSettings } from './live-settings-core.js'
import { createOfflineSearch } from './offline-search-core.js'
import { createBoardOffline } from './offline-board-core.js'
import { createHostReplica } from './host-replica-core.js'
import { unpackReplicaSyncLists } from './replica-sync-gz.js'
import { createAttachmentCopy } from './attachment-copy-core.js'
import { createFollowerReads } from './follower-reads-core.js'
import { createFollowerGateway, type FollowerGatewayResponse, type GatewayCaller } from './follower-gateway-core.js'
import { createHostCallTokens } from './host-call-token-core.js'
import { createFollowerTriggerDelivery, type TriggerDeliveryResult, type TriggerFire } from './follower-trigger-delivery-core.js'
import { pickHostTriggerTarget } from '../core/routines/host-trigger-target.js'
import { createHostServerSupervisor, heldServerAt } from './host-server-core.js'
import { createPluginJobSupervisor } from './plugin-jobs-core.js'
import { createPluginJobDoor } from './plugin-job-door.js'
import { createStreamRelay } from './stream-relay-core.js'
import { createPtyStreams, type PtyChild, type PtySpawnOptions } from './pty-stream-core.js'
import { lineUuidOf } from './line-fate-core.js'
import { createHostStart, type HostStartPlan } from './host-start-core.js'
import { createFollowerEntry, type FollowerAnswer } from './follower-entry-core.js'
import { createClockHostStart } from './clock-host-start-core.js'
import { createReplicaLogs } from './replica-logs-core.js'
import { createOpenItemsText } from '../core/sessions/open-items-text.js'
import { createLetterCheck } from '../core/human-inbox/letter-check.js'
import { createTriggerLabel } from '../core/routines/trigger-label.js'
import { createTriggerWatches } from '../core/routines/trigger-watches.js'
import { createEnvelopeKit } from '../core/peers/envelope-kit.js'
import { createSendRules } from '../core/sessions/send-rules.js'
import { createAcpDaemon } from './acp-daemon.js'
import { ACP_HOST_FILES, ACP_HOST_WORKER } from './acp-host-artifacts.js'
import { singleFile } from '../lib/single-file.js'
import { resolveAgentCommand } from './agent-command-map.js'
import { createDaemonGit } from './daemon-git.js'
import { createDaemonSkills } from './daemon-skills.js'
import { createDaemonFsRead } from './daemon-fs-read.js'
import { createDaemonFsWrite } from './daemon-fs-write.js'
import { createDaemonChanges } from './daemon-changes.js'
import { createDaemonTranscripts } from './daemon-transcripts.js'
import { createDaemonSessionOwner } from './daemon-session-owner.js'
import { createDaemonUsageBudget } from './daemon-usage-budget.js'
import { createDaemonSessionResume } from './daemon-session-resume.js'
import { createDaemonAcpSessions } from './daemon-acp-sessions.js'
import { createDaemonSessionShell } from './daemon-session-shell.js'
import { createDaemonSessionStart } from './daemon-session-start.js'
import { createDaemonSessionCommands } from './daemon-session-commands.js'
import { createDaemonSessionStop } from './daemon-session-stop.js'
import { createDaemonSessionState } from './daemon-session-state.js'
import { createDaemonAgentSubs } from './daemon-agent-subs.js'
import { createDaemonLineChecks, type DaemonLineChecks } from './daemon-line-checks.js'
import { createDaemonSessionTailer, type DaemonSessionTailer } from './daemon-session-tailer.js'
import { createDaemonIdleScan } from './daemon-idle-scan.js'
import { createDaemonCloudBridge } from './daemon-cloud-bridge.js'
import { createDaemonBridgeRelays } from './daemon-bridge-relays.js'
import { createDaemonSpawnJournal } from './daemon-spawn-journal.js'
import { createDaemonSessionSnapshot } from './daemon-session-snapshot.js'
import { createDaemonSessionFold } from './daemon-session-fold.js'
import { createDaemonStreamCompaction } from './daemon-stream-compaction.js'
import { createDaemonHooks } from './daemon-hooks.js'
import { createDaemonTriggerStore } from './daemon-trigger-store.js'
import { createDaemonTriggerRuns } from './daemon-trigger-runs.js'
import { createDaemonTriggerSet } from './daemon-trigger-set.js'
import { createDaemonTriggerCommands } from './daemon-trigger-commands.js'
import { createDaemonHostTransfer } from './daemon-host-transfer.js'
import { createDaemonHostServices } from './daemon-host-services.js'
import { createDaemonProcessGroups } from './daemon-process-groups.js'
import { settleAnswer, fail, type Answer, type AnswerFn, type Answers } from './daemon-module-deps.js'
import { Worker as ThreadWorker } from 'node:worker_threads'
import { createHistoryReady, createReadyWorkerExecutor, readyWorkerEntries, type ReadyWorkerLike } from './history-ready-core.js'
import * as triggerCheck from './trigger-check-core.js'
import * as triggerClock from './trigger-clock-core.js'
import { buildScheduledMessage, buildTriggerMessage } from './trigger-envelope-core.js'
import { createClockSchedule } from './clock-schedule-core.js'
import { takeTriggerStateSnapshot } from './trigger-state-snapshot-core.js'
import { seedTriggerState } from './trigger-state-seed-core.js'
import type { HostTriggerJudge } from './daemon-module-deps.js'
import { archiveTranscripts, bunTranspilerCacheDirs, ensureTaskDir, gitRunnerWith, liveTranscriptIdsFromPs, listTaskDirs, pruneHostCaches, pruneTaskBuilds, pruneTaskDirs, readOpenPaths, removeTaskDirs, restoreSessionAnywhere, setArchiveLog, setRemoteFetcher, RemoteHistoryError, taskDirInUse, taskDirRoot, taskDirSizes, type HostWork } from './task-dir-core.js'
import { ensurePwSilencePreloadAsync, pwSilenceDir, pwSilenceSessionEnv } from './pw-silence-core.js'
import { createLogAppender, type LogAppender } from './log-appender-core.js'
import { armFilePoolDeadline } from './file-pool-deadline.js'
import { createHostExec, runWaitMatcher } from './host-exec-core.js'
import { createHostMcp } from './host-mcp-core.js'
import { createHostHttp } from './host-http-core.js'
import { createBudgetPersistence } from './usage-budget-persistence.js'
const ensureUsageBudgetDirectory = createBudgetPersistence(fs.promises, path).ensureDirectory
import { createCodeServer } from './vscode-server-core.js'
import {
  GATEWAY_SOCKET_FILENAME,
  demoGatewaySocketPath,
  GATEWAY_MAX_LINE_BYTES,
  gatewayCallPlan,
  gatewayIdentifyPlan,
  type GatewayCallPlan,
  GATEWAY_IDENTIFY_WAIT_MS,
  gatewayHubTimeoutMs,
  gatewayShimScript,
  GATEWAY_MIN_RELAY_MS,
  relayAttemptMs,
  relayMayResendTo,
  busyRelayAgainMs,
  busyRelayMinLeftMs,
  helloReadOps,
  EXTERNAL_CALLER_SID,
  CALLER_PROOF_CAPABILITY,
  isDaemonCliKeyword,
  isExternalCallerSid,
  wantsCallerProof,
  withoutCallerProof,
  type CallerProof,
  parseGatewayLine,
  resolveGatewayCallerSid,
  SHIM_CORE_BASENAME,
  shimCoreNeedsCopy,
  gatewayApiAnswerOf,
  passesSilentLeader,
  readFallsToService,
  type GatewayErrorCode,
  type GatewayRequest,
  type GatewayResponse,
} from './gateway-core.js'
import type { DaemonRuntimeOptions, DaemonFrame, DaemonClient, DaemonRuntime, FollowerSeat } from './daemon-runtime-types.js'
import { createRuntimeTimers } from './daemon-runtime-timers.js'
import { createInProcessClient } from './daemon-in-process-client.js'
import { DAEMON_STAMP_NAME, openDaemonDoor, publishDoorFiles } from './daemon-door.js'
import { createSpawnPool } from './spawn-pool.js'
import { createDaemonChildSpawn, type ChildProcessUse } from './daemon-child-spawn.js'
import { DaemonSessionGate, createDaemonCronRuntime, persistCronHooks, processStartedAtMs, readCronCliConfig, cliOneShotTime, nextCliCronMinute, CRON_PROMPT_LIMIT } from './daemon-cron-runtime.js'
import { createCronMetadataTracker } from './daemon-cron-metadata.js'
import { readCronBootId } from './daemon-cron-host.js'
import { askOwnPort, daemonServesCheck, startLauncherBeat, type LauncherBeat } from './service-launcher-beat.js'
import { createServiceRolesReader, programServiceRoles, SERVICE_ROLES_FLAG, withGoodRoles } from './service-roles.js'
import { acquireDaemonInstanceLock, readDaemonInstanceOwner, type DaemonInstanceLockOwner } from './daemon-instance-lock.js'
import { createDaemonCommandDrain } from './daemon-command-drain.js'
import { createDemoDaemonQuiesce } from './demo-daemon-quiesce-core.js'
import { prepareDaemonServiceHandover, consumeDaemonServiceHandover } from './daemon-service-handover.js'
import { RESTART_MARK_NAME, restartMarkText } from './daemon-restart-mark.js'

// ── Version ──
// Baked in at compile time via `bun build --define` (see scripts/build-daemon.sh).
const DAEMON_VERSION = process.env.DAEMON_VERSION || 'dev'

// The runtime's options and its surface: daemon-runtime-types.ts (a server that creates one reads them there).
export type { DaemonRuntimeOptions, DaemonFrame, DaemonClient, DaemonRuntime } from './daemon-runtime-types.js'

const { validateTriggerDef, checkGatewayCall, createCheckCallers, withoutTriggerCaller } = triggerCheck
const { START_TASK_TOKEN } = triggerClock
/** The trigger logic the trigger area runs on (task logic): the area modules take it as their `judge` dep. */
const hostTriggerJudge: HostTriggerJudge = {
  ...triggerCheck, ...triggerClock, buildScheduledMessage, buildTriggerMessage, createClockSchedule, takeTriggerStateSnapshot, seedTriggerState,
}

export async function createDaemonRuntime(options: DaemonRuntimeOptions): Promise<DaemonRuntime> {
// The daemon's body, as it was when it was the whole program: not indented, so its lines and
// their history stay as they were. Everything it holds lives in this closure, one per runtime.
const daemonEnv = options.env
/** The WebSocket door (its port, daemon.port): closed for a runtime its server calls directly (in-process-daemon.ts). */
/** A daemon program of its own (exits, signals, its own error handlers); false: a runtime inside a server's process. */
const LISTEN = options.listen !== false
/** The file pool probe's limit in a server's process (file-pool-deadline.ts); a daemon program keeps 500 ms. */
const SERVER_POOL_PROBE_MS = 5_000
/**
 * The WebSocket door (daemon-door.ts): a program always opens it; a runtime inside a server opens
 * it when asked, for everyone the server does not call directly (a leader's tunnel, walnut-net, a
 * host's follower server, hub forwards).
 */
const DOOR = LISTEN || options.door === true
/** daemon.pid names this process (a program, or a host's one service a leader looks for by its command line). */
const WRITES_PID_FILE = LISTEN || options.pidFile === true
/** What its hello says it is (`serves`): a daemon program, or a host's one Walnut service. */
const RUNS_AS: 'daemon' | 'walnut-serve' = LISTEN ? 'daemon' : (options.serves ?? 'daemon')
const PROGRAM_SCRIPT = options.program?.script ?? ''
// Every timer this runtime starts ends with stop(). In a server's process (no door) one that throws
// is logged, never the server's crash; a daemon program lets it reach its crash handler, which
// exits for a clean restart that re-adopts every CLI, as it always did (daemon-runtime-timers.ts).
const runtimeTimers = createRuntimeTimers((what, err) => {
  try { logMsg('error', `daemon ${what} threw; the daemon goes on`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }) } catch { /* the log itself */ }
}, LISTEN && !daemonEnv.WALNUT_DAEMON_SLOW_CALLBACK_MS ? undefined : {
  // Inside another program a callback that holds the loop holds that program: it is named in the log.
  ms: Number(daemonEnv.WALNUT_DAEMON_SLOW_CALLBACK_MS) || 50,
  report: (what, heldMs, label) => logMsg('warn', 'daemon callback held the loop', { what, heldMs: Math.round(heldMs), label }),
}, !LISTEN)
const { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate } = runtimeTimers
const clearRuntimeTimers = () => runtimeTimers.clearAll()
// Children get the runtime's env, its dir as cwd once started, and umask 077 (daemon-child-spawn.ts).
let childCwd: string | undefined
const CHILD_UMASK = options.childUmask === undefined ? 0o077 : options.childUmask
// Inside another program, a start's block of the thread (tens of ms each, spawn-pool.ts) is that
// program's: execFile's helpers and the sessions' CLIs start on the pool's thread instead.
const spawnPool = LISTEN ? null : createSpawnPool({ umask: CHILD_UMASK, onError: (err) => { try { logMsg('error', 'spawn pool: a handler threw', { error: String(err) }) } catch { /* the log itself */ } } })
const childProcess = createDaemonChildSpawn(
  { spawn: rawSpawn, execFile: rawExecFile, execFileSync: rawExecFileSync, execSync: rawExecSync, bunSpawn: ((...a: never[]) => (Bun.spawn as (...b: never[]) => unknown)(...a)) as never, umask: (mask?: number) => (mask === undefined ? process.umask() : process.umask(mask)), ...(spawnPool ? { pool: spawnPool } : {}) },
  // A dir removed under it (a temp cleanup) is no cwd: the process's own then, never a failed start.
  { env: daemonEnv, cwd: () => (childCwd && fs.existsSync(childCwd) ? childCwd : undefined), umask: CHILD_UMASK, ...(LISTEN ? {} : { contain: runtimeTimers.contain }) },
)
const spawn = childProcess.spawn
const execFile = childProcess.execFile
const execFileSync = childProcess.execFileSync
const execSync = childProcess.execSync
const execFileCb = execFile
/**
 * What every module this runtime imports starts its children with: these functions and this env,
 * never node's own and process.env (tests/providers/daemon-runtime-child-process-ratchet.test.ts).
 */
const childUse: ChildProcessUse = { spawn, execFile, execFileSync, execSync, env: daemonEnv }
/** This runtime's embedded editor (capability 'vscode-v1', vscode-server-core.ts): its record under the runtime's HOME. */
const codeServer = createCodeServer(childUse)
/** The test hooks' and the stuck drain's hard end (a process SIGKILLs itself). */
const dieHard = (): void => { if (options.hardExit) options.hardExit(); else exitRuntime(1) }
const daemonCommands = createDaemonCommandDrain()
const sessionStartGate = new DaemonSessionGate()
const sessionStopVersions = new Map<string, number>()
const retryCheckVersions = new Map<string, number>()
let cronRuntime: Awaited<ReturnType<typeof createDaemonCronRuntime>> | null = null
let daemonInstanceLock: DaemonInstanceLockOwner | null = null
let daemonBootId: string | undefined
let requestDaemonShutdown: (() => void) | null = null
let handoverPrepared = false
let serviceUpdateRequested = false

// ── Constants ──
// DAEMON_DIR default is /tmp/open-walnut; tests override via env var.
// PROD_DAEMON_DIR is duplicated from local-daemon.ts (the daemon is a standalone
// binary and cannot import it); any dir OTHER than this one is "isolated" —
// sandbox, test, ephemeral demo — which decides CLI-reap-on-exit.
const PROD_DAEMON_DIR = '/tmp/open-walnut'
const DAEMON_DIR = daemonEnv.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR
const DAEMON_STATE_DIR = daemonEnv.WALNUT_DAEMON_STATE_DIR
const SERVICE_MODE = options.mode === 'service'
// The launcher's heartbeat and ready mark when a launcher runs this service (service-launcher-beat.ts).
let launcherBeat: LauncherBeat | null = null
/**
 * What the launcher's good version can take as a service, asked of that file once per path
 * (service-roles.ts). The first hello goes out before the answer: once it is known, every server
 * linked here hears the facts again (`launcher-facts`), with no reconnect.
 */
const goodRolesOf = createServiceRolesReader(childUse.execFile, { env: daemonEnv, known: () => tellLauncherFacts() })
function tellLauncherFacts(): void {
  const launcher = launcherFactsNow()
  if (!launcher) return
  for (const client of wsClients) if (isServerClient(client)) sendEvent(client, 'launcher-facts', { launcher })
}
/** The launcher's facts for hello: this program's own beat, or the host service's (options.launcherFacts), with its good version's roles. */
const launcherFactsNow = () => withGoodRoles(launcherBeat?.facts() ?? options.launcherFacts?.() ?? null, goodRolesOf)
// An isolated dir whose sessions must outlive this process anyway: the cloud
// companion's daemon for the paired Mac (providers/cloud-tunnel-daemon.ts). A
// companion upgrade replaces it the way prod's is replaced, and the successor
// adopts the CLIs, so exiting must not reap them.
const KEEP_SESSIONS_ON_EXIT = daemonEnv.WALNUT_DAEMON_KEEP_SESSIONS === '1'
// Home dir used to expand `~/...` paths from the app (e.g. ~/.claude/projects/...).
// In production this is the real HOME (daemon runs as the same user as walnut, so both
// resolve `~` identically). WALNUT_HOME_OVERRIDE lets a test point the daemon at the same
// throwaway home its mocked CLAUDE_HOME lives under, so `~/.claude` on both sides agree —
// without it, the daemon (a separate process) would read the real ~/.claude and never see
// the test fixtures. Same env-override pattern as WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR.
const HOME_DIR = daemonEnv.WALNUT_HOME_OVERRIDE || daemonEnv.HOME || '/root'
// Each task's durable working directory on this host (src/lib/task-dir.ts).
const TASK_DIR_ROOT = taskDirRoot(daemonEnv, HOME_DIR)
// Every session starts with the page silencer's preload in NODE_OPTIONS, so any Playwright it
// runs is silent whatever branch it builds (pw-silence-core.ts).
const PW_SILENCE_DIR = pwSilenceDir(TASK_DIR_ROOT)
/** The preload file for a session start, checked without a synchronous file call (pw-silence-core.ts). */
function pwSilenceFile(): Promise<string | null> {
  return ensurePwSilencePreloadAsync(PW_SILENCE_DIR, daemonEnv)
}
/** NODE_OPTIONS and BUN_OPTIONS of a session start, from what it would have had (null = cleared). */
function pwSilenceOptions(node: string | null | undefined, bun: string | null | undefined, file: string | null): { NODE_OPTIONS: string | undefined; BUN_OPTIONS: string | undefined } {
  return pwSilenceSessionEnv(node ?? undefined, bun ?? undefined, file)
}
function pwSilenceAcpOptions(env: Record<string, string | null | undefined> | undefined, file: string | null): Record<string, string> {
  const o = pwSilenceOptions(ownOrDaemon(env, 'NODE_OPTIONS'), ownOrDaemon(env, 'BUN_OPTIONS'), file)
  return { NODE_OPTIONS: o.NODE_OPTIONS ?? '', BUN_OPTIONS: o.BUN_OPTIONS ?? '' }
}
/** A key the engine's env names wins over the daemon's own, null and '' meaning cleared. */
function ownOrDaemon(env: Record<string, string | null | undefined> | undefined, key: string): string | undefined {
  return env && Object.prototype.hasOwnProperty.call(env, key) ? (env[key] ?? '') : daemonEnv[key]
}
// Streams live under the user's HOME so they SURVIVE REBOOTS — /tmp is wiped on
// macOS/Linux restarts, which vaporized every stream file mid-session and left
// walnut's stored byte watermarks pointing into dead files (incident 019a7fe5:
// the stale 85 MB watermark silently vetoed every snapshot of the recreated
// file). Isolated daemons (tests/sandbox/demo — any non-prod WALNUT_DAEMON_DIR)
// keep the sibling-dir derivation so their streams stay in the throwaway area.
// LEGACY_STREAMS_DIR is the pre-2026-08 location; startup migrates dead-session
// files from it and live sessions keep their registry-recorded absolute paths.
const PROD_STREAMS_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'streams')
// Env override is for TESTS ONLY (never set in prod) — without it a spawned
// test daemon would migrate the REAL production /tmp/open-walnut-streams.
const LEGACY_STREAMS_DIR = daemonEnv.WALNUT_LEGACY_STREAMS_DIR || '/tmp/open-walnut-streams'
// The home fallback a remote host uses when /tmp cannot take the daemon
// (read-only, noexec, full: the server's remote-daemon-dir.ts). A daemon there
// IS the production daemon, relocated: same streams, same user shim, and its
// sessions outlive it. Only this exact path counts, so a test daemon that
// inherits the env still reads as isolated.
const FALLBACK_DAEMON_DIR = path.join(daemonEnv.HOME || HOME_DIR, '.cache', 'open-walnut')
const IS_PROD_DAEMON_DIR = path.resolve(DAEMON_DIR) === path.resolve(PROD_DAEMON_DIR)
  || path.resolve(DAEMON_DIR) === path.resolve(FALLBACK_DAEMON_DIR)
// A host's own service set beside another Walnut's (service-set.ts): its unit names it in
// WALNUT_SERVICE_SET, read only as a service with a state dir. Its runtime is a real install
// (KEEPS_SESSIONS: sessions outlive it, durable state, no test knobs), but the machine's single
// copies (the user PATH shim, ~/.open-walnut/tmp/<name>, the legacy streams dir, the desktop app)
// stay the default set's: a set keeps its own under its install root.
const SET_ID = SERVICE_MODE && !!DAEMON_STATE_DIR && /^[0-9a-f]{16}$/.test(daemonEnv.WALNUT_SERVICE_SET ?? '') ? daemonEnv.WALNUT_SERVICE_SET! : ''
const KEEPS_SESSIONS = IS_PROD_DAEMON_DIR || SET_ID !== ''
const STREAMS_DIR = daemonEnv.WALNUT_STREAMS_DIR
  || (SET_ID ? path.join(DAEMON_STATE_DIR!, 'streams') : IS_PROD_DAEMON_DIR ? PROD_STREAMS_DIR : `${DAEMON_DIR}-streams`)
// demo.quiesce (demo-daemon-quiesce-core.ts): a Demo's own daemon closes for good before
// its reset and waits for what it accepted. Refused on every other daemon.
const demoQuiesce = createDemoDaemonQuiesce({
  env: daemonEnv, daemonDir: DAEMON_DIR, isProdDaemonDir: IS_PROD_DAEMON_DIR,
  serviceMode: SERVICE_MODE, keepSessions: KEEP_SESSIONS_ON_EXIT,
  resolve: (...parts) => path.resolve(...parts), basename: (p) => path.basename(p),
  settle: () => daemonCommands.settle(),
  endWarmPool: () => { oneShot.endWarmPool() },
  oneShot: () => oneShot.liveChildren(),
  acpRuntimes: () => acp.listWorkers(),
  // The daemon's own automatic work for the Demo's data: its trigger checks end, its plugin jobs retire.
  stopInternalWork: (home) => { demoTriggerChecks.abort(); pluginJobs.quiesce(home) },
  background: (home) => {
    const jobs = pluginJobs.pending(home)
    return {
      triggerChecks: demoTriggerCheckPids.size, triggerRuns: triggerChecksRunning.size, triggerTests: triggerCommands.triggerTestsRunning,
      triggerDeliveries: hostDeliveriesInFlight.size, pluginJobRuns: jobs.runs, pluginJobsDraining: jobs.draining, pluginJobTimers: jobs.timers,
    }
  },
})
// MCP and restart readers derive their paths from the socket's parent; Demo uses its checked short dir.
const GATEWAY_SOCK_PATH = (demoQuiesce.isDemo
  ? demoGatewaySocketPath(daemonEnv.WALNUT_DEMO_ROOT || '', daemonEnv.WALNUT_DEMO_GENERATION || '', typeof process.getuid === 'function' ? process.getuid() : null, fs, path, crypto)
  : null) || path.join(DAEMON_DIR, GATEWAY_SOCKET_FILENAME)
const GATEWAY_SHIM_DIR = path.join(path.dirname(GATEWAY_SOCK_PATH), 'bin')
const GATEWAY_SHIM_PATH = path.join(GATEWAY_SHIM_DIR, 'walnut')
/** The live trigger check runs' gateway tokens (trigger-check-core.ts checkCallers). */
const checkCallers = createCheckCallers()
// Where Walnut saves a session's pictures on this host (user-line-images-core.ts):
// the server's images dir (it names this dir to its daemon), an upload from another
// machine, and image.save. Both spellings of a symlinked /tmp.
const PICTURE_ROOTS: string[] = (() => {
  const dirs = [DAEMON_DIR]
  try { const real = fs.realpathSync(DAEMON_DIR); if (real !== DAEMON_DIR) dirs.push(real) } catch { /* not made yet */ }
  return dirs.flatMap((d) => [`${d}/images/`, `${d}-images/`])
})()

// Which Walnut a pushed setting belongs to, and where its copy is kept
// (walnut-scope-core.ts). Its keyOf is the ONE key every core takes for a home: of the
// Walnut's first home here, so a Walnut whose server declared a move from that home keeps
// its state (adoptCommandHome).
const walnutScope = createWalnutScope({
  path, fs,
  keyOf: (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16),
  // Beside the leader book (defined further down, so asked on first use).
  aliasFile: () => HOME_ALIASES_FILE,
  now: () => Date.now(),
  log: (level, msg, data) => logMsg(level, msg, data),
})

// ── Spawn journal (daemon-spawn-journal.ts): the CLI sessions this host started, and the Walnut a home names ──
const spawnJournal = createDaemonSpawnJournal({ daemonEnv, HOME_DIR, STREAMS_DIR, ISOLATED_FOR: () => ISOLATED_FOR, walnutScope, hostServers: { walnutOf: (home) => hostServers.walnutOf(home), dataDirs: () => hostServers.dataDirs() } })
const { SPAWN_JOURNAL, journaledHomes, journaledWalnuts, isJournalSid, journaledIds, forgetJournaledSids, journaledHome, servedWalnutOf, serverDataHomes,
  walnutOfHome, livedHere, appendSpawnJournal, spawnInfoFor, namedSessionId, backfillSpawnJournal, acpRuntimeOwner, recordAcpRuntime } = spawnJournal
// The walnut file's runtime place a session keeps: a set's own (service-set.ts), never a deploy stage's.
const SESSION_RUNTIME_DIR = setRuntimeTreesDirOf(daemonEnv, fs.realpathSync)

const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
// daemon.pid's start time, by which a leader knows that pid is still this daemon (daemon-door.ts stampDoor).
const STAMP_FILE = path.join(DAEMON_DIR, DAEMON_STAMP_NAME)
const INSTANCE_ID_FILE = path.join(DAEMON_DIR, 'daemon.instance')
const SERVICE_FILE = path.join(DAEMON_DIR, 'daemon.service')
// A stopping production daemon's word that its successor is on the way
// (daemon-restart-mark.ts): `walnut` calls in between wait instead of failing.
// Beside the gateway socket, where `walnut` looks for it (wn-cli.ts daemonRestartingAt).
const RESTART_MARK_FILE = path.join(path.dirname(GATEWAY_SOCK_PATH), RESTART_MARK_NAME)
// Written by the RUNNING daemon at startup. This is the source of truth for
// upgrade decisions: DaemonConnection.shouldUpgradeDaemon `cat`s this file
// instead of executing the on-disk binary's --version, because the on-disk
// binary can be stale while a source-deployed (daemon.cjs) daemon is what's
// actually running — probing the binary then caused an infinite
// stop/redeploy loop that killed the live daemon every cycle.
const VERSION_FILE = path.join(DAEMON_DIR, 'daemon.version')
// Which Walnuts this daemon serves, with its capabilities, beside daemon.version: a
// server keeps a daemon another Walnut still uses when this build brings nothing it
// lacks (served-walnuts-core.ts, daemon-shared.ts).
const SERVES_FILE = path.join(DAEMON_DIR, 'daemon.serves.json')
const servedWalnuts = createServedWalnuts({
  fs, file: SERVES_FILE,
  // What a server computes for its own home (daemon-shared.ts walnutKeyOf): where the Walnut is now.
  keyOf: (value) => walnutScope.pathKeyOf(walnutScope.whereNow(value)),
  // A server this daemon runs for a leader is that leader's Walnut, never another one sharing
  // this daemon: its data dir is filed under the leader's key, and an older build's key of it dropped.
  walnutOf: (home) => servedWalnutOf(home),
  followerHomes: () => serverDataHomes(),
  version: DAEMON_VERSION, twin: 'binary', capabilities: () => helloCapabilities(), now: () => Date.now(),
  // Bun's own pty is built into the bun this twin runs on (pty-stream-v1).
  pty: () => true,
  log: (level, msg, data) => logMsg(level, msg, data),
})
const AGENT_POLL_INTERVAL_MS = 2000
const AGENT_REDISCOVER_INTERVAL_MS = 10000
// Env override exists so tests can exercise heartbeat-driven behavior (the
// parent-liveness watchdog) without waiting 30s. Production leaves it unset.
/** In process: the longest endSelf waits for the lock's release before it closes its clients. */
const END_SELF_LOCK_RELEASE_MS = 2_000
const HEARTBEAT_INTERVAL_MS = (() => {
  const ms = parseInt(daemonEnv.WALNUT_DAEMON_HEARTBEAT_MS || '', 10)
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000
})()
// Parent-liveness watchdog (isolated-dir daemons only — see the heartbeat).
// 0 / unset / garbage → disabled, which is always the case for production.
const WATCHDOG_PARENT_PID = (() => {
  const pid = parseInt(daemonEnv.WALNUT_DAEMON_PARENT_PID || '', 10)
  return Number.isFinite(pid) && pid > 0 ? pid : 0
})()
// A test server's own daemon on a remote host (the server's remote-isolation.ts): the
// key of the test server it serves, said in its hello with its dir so the server can
// tell it from the host's production daemon. Its parent pid lives on another machine,
// so it ends itself once no server has been connected for ISOLATED_ORPHAN_EXIT_MS, and
// takes its root with it. Never on a production dir.
const ISOLATED_FOR = (daemonEnv.WALNUT_DAEMON_ISOLATED_FOR || '').trim()
const ISOLATED_ORPHAN_EXIT_MS = (() => {
  const ms = parseInt(daemonEnv.WALNUT_DAEMON_ORPHAN_EXIT_MS || '', 10)
  return ISOLATED_FOR && Number.isFinite(ms) && ms > 0 ? ms : 0
})()
/** The last time a server socket was connected (the lease's clock; boot counts as one). */
let isolatedServerSeenAt = Date.now()
/** The root a test server made for this daemon, when the dir is one (`/tmp/open-walnut-test-<key>/daemon` or its `$HOME/.cache` twin). */
function isolatedOwnRoot(): string | null {
  if (!ISOLATED_FOR || !/^[A-Za-z0-9_-]+$/.test(ISOLATED_FOR)) return null
  const root = path.dirname(path.resolve(DAEMON_DIR))
  return root === '/tmp/open-walnut-test-' + ISOLATED_FOR || root.endsWith('/.cache/open-walnut-test/' + ISOLATED_FOR) ? root : null
}

function ensureOwnerOnlyStorage(): void {
  const repair = (entryPath: string): void => {
    let stat: fs.Stats
    try { stat = fs.lstatSync(entryPath) } catch { return }
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      fs.chmodSync(entryPath, 0o700)
      let names: string[] = []
      try { names = fs.readdirSync(entryPath) } catch { return }
      for (const name of names) repair(path.join(entryPath, name))
      return
    }
    // A FIFO here is a session's stdin: write-only, never readable (LIVE_FIFO_MODE in daemon-core.ts).
    if (stat.isFIFO()) { fs.chmodSync(entryPath, LIVE_FIFO_MODE); return }
    fs.chmodSync(entryPath, stat.mode & 0o111 ? 0o700 : 0o600)
  }

  // A root that is already ours and owner-only, swept once before (its OWNER_ONLY_SWEPT mark), keeps
  // everything below it from other users: the deep sweep is skipped. On the Mac the daemon dir is also the
  // server's scratch dir (tens of thousands of images), and an in-process daemon starts at every deploy:
  // a full sweep there held the server's start for 3.4 s (2026-11-23). Each live FIFO is made write-only
  // again where it is adopted (lockLiveFifo; an ACP worker does its own).
  const sweptBefore = (root: string): boolean => {
    try {
      const st = fs.statSync(root)
      return (st.mode & 0o777) === 0o700 && (typeof process.getuid !== 'function' || st.uid === process.getuid())
        && fs.existsSync(path.join(root, OWNER_ONLY_SWEPT))
    } catch { return false }
  }
  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  fs.mkdirSync(STREAMS_DIR, { recursive: true, mode: 0o700 })
  const skip = new Set([DAEMON_DIR, STREAMS_DIR].filter(sweptBefore))
  fs.chmodSync(DAEMON_DIR, 0o700)
  fs.chmodSync(STREAMS_DIR, 0o700)
  for (const root of [DAEMON_DIR, STREAMS_DIR]) {
    if (skip.has(root)) continue
    for (const name of fs.readdirSync(root)) repair(path.join(root, name))
    try { fs.writeFileSync(path.join(root, OWNER_ONLY_SWEPT), '', { mode: 0o600 }) } catch { /* the next start sweeps again */ }
  }
}
/** The mark of a root whose entries were all made owner-only once (ensureOwnerOnlyStorage). */
const OWNER_ONLY_SWEPT = '.owner-only-swept'


// ── Legacy streams migration (/tmp/open-walnut-streams → HOME) ─────────────
// One-way, loss-averse, idempotent. Runs at startup BEFORE reconcileRegistry
// so adopted sessions see their files at the final location. Rules:
//   - Only when STREAMS_DIR is the prod HOME location and the legacy dir exists.
//   - A sid with a LIVE process group (per its .pgid) is SKIPPED ENTIRELY: the
//     CLI holds an O_APPEND fd on the old inode — moving the path would split
//     writer and readers. Its registry entry stores absolute paths, so it keeps
//     working from the legacy dir until that process dies; a later restart
//     migrates the files then.
//   - Never overwrite: a same-named file already in the new dir wins (it is
//     newer by construction — this daemon or a successor created it).
//   - rename() first (atomic, same volume); EXDEV falls back to copy + size
//     verify + unlink. A failed verify keeps the original in place.
//   - .pipe files are dead FIFOs from previous daemon lives — recreated at
//     spawn; deleted, not migrated.
function migrateLegacyStreams(): void {
  // Force flag is TEST-ONLY: prod triggers via the dir identity; isolated test
  // daemons opt in explicitly with their own temp legacy/streams dirs.
  if (STREAMS_DIR !== PROD_STREAMS_DIR && !daemonEnv.WALNUT_FORCE_STREAMS_MIGRATION) return
  let names: string[] = []
  // Another user on this machine may own the legacy dir: its files are theirs, not ours to move.
  try {
    const dir = fs.lstatSync(LEGACY_STREAMS_DIR)
    if (!dir.isDirectory() || (typeof process.getuid === 'function' && dir.uid !== process.getuid())) return
  } catch { return }
  try { names = fs.readdirSync(LEGACY_STREAMS_DIR) } catch { return } // no legacy dir — done
  if (names.length === 0) return

  // Live-pgid sids: their whole file family stays put.
  const liveSids = new Set<string>()
  for (const f of names) {
    if (!f.endsWith('.pgid')) continue
    try {
      const pid = parseInt(fs.readFileSync(path.join(LEGACY_STREAMS_DIR, f), 'utf-8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) liveSids.add(f.slice(0, -'.pgid'.length))
    } catch {}
  }

  let migrated = 0, skippedLive = 0, skippedExists = 0, dropped = 0, failed = 0
  for (const f of names) {
    const src = path.join(LEGACY_STREAMS_DIR, f)
    const sid = f.replace(/\.(jsonl\.err|jsonl|pgid|pipe|log)$/, '')
    if (liveSids.has(sid)) { skippedLive++; continue }
    let st: fs.Stats
    try { st = fs.lstatSync(src) } catch { continue }
    if (st.isFIFO()) { try { fs.unlinkSync(src) } catch {}; dropped++; continue }
    if (!st.isFile()) continue // symlinks/dirs: not ours — leave untouched
    const dst = path.join(STREAMS_DIR, f)
    if (fs.existsSync(dst)) { skippedExists++; continue }
    try {
      fs.renameSync(src, dst)
      migrated++
    } catch {
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)
        if (fs.statSync(dst).size !== st.size) throw new Error('size mismatch after copy')
        fs.unlinkSync(src)
        migrated++
      } catch (err) {
        failed++
        try { fs.unlinkSync(dst) } catch {} // never leave a half-copy shadowing the original
        logMsg('warn', 'legacy streams migration: file failed (kept in place)', {
          file: f, error: (err as Error).message,
        })
      }
    }
  }
  logMsg('info', 'legacy streams migration: done', {
    from: LEGACY_STREAMS_DIR, to: STREAMS_DIR,
    migrated, skippedLive, skippedExists, droppedPipes: dropped, failed,
    liveSids: [...liveSids],
  })
}

// ── Dead-stream retention (3 months) ────────────────────────────────────────
// Streams now live under HOME and survive reboots, so they need a lifecycle:
// hourly, delete the file family of any sid that (a) is not in the live
// sessions map, (b) has no live process group, and (c) hasn't been written for
// RETENTION_MS. The conversation's real record lives in ~/.claude/projects/ —
// the stream file is status/replay plumbing, safe to reap after the window.
// Env overrides are TEST-ONLY (drive the sweep inside a test's timeframe).
const STREAM_RETENTION_MS = parseInt(daemonEnv.WALNUT_STREAM_RETENTION_MS || '', 10)
  || 90 * 24 * 60 * 60 * 1000
const STREAM_RETENTION_SWEEP_MS = parseInt(daemonEnv.WALNUT_STREAM_SWEEP_MS || '', 10)
  || 60 * 60 * 1000
function sweepDeadStreams(): void {
  let names: string[] = []
  try { names = fs.readdirSync(STREAMS_DIR) } catch { return }
  const now = Date.now()
  const reaped = new Set<string>()
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue
    const sid = f.slice(0, -'.jsonl'.length)
    if (sessions.has(sid)) continue
    const jsonlPath = path.join(STREAMS_DIR, f)
    let st: fs.Stats
    try { st = fs.statSync(jsonlPath) } catch { continue }
    if (now - st.mtimeMs < STREAM_RETENTION_MS) continue
    // Paranoia: a live pgid means a process still owns this family — skip.
    try {
      const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, sid + '.pgid'), 'utf-8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) continue
    } catch {}
    for (const ext of ['.jsonl', '.jsonl.err', '.jsonl.fold', '.jsonl.fold.next', '.jsonl.lines', '.jsonl.compact', '.pgid', '.pipe', '.log']) {
      try { fs.unlinkSync(path.join(STREAMS_DIR, sid + ext)) } catch {}
    }
    reaped.add(sid)
  }
  // Argv files nothing names: no session of this daemon, no live process (another
  // daemon's CLI included; a CLI reads its --settings file again).
  execFile('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error) return
    const argvRemoved = cliArgvFiles.sweep([...sessions.values()].map((x) => x.args), String(stdout).split('\n'))
    if (argvRemoved > 0) logMsg('info', 'argv file sweep: removed', { count: argvRemoved })
  })
  if (reaped.size > 0) {
    logMsg('info', 'dead-stream retention sweep: reaped', { count: reaped.size, sids: [...reaped] })
  }
}

// ── Daemon Instance ID ──
// Unique per daemon lifetime. Short hash of port+pid+startTs so it fits in log
// lines without dominating. Written to daemon.instance so clients can verify
// they're talking to the same daemon they expected (detect PID reuse / swap).
const DAEMON_START_TS = Date.now()
// What runs this daemon, for `hello`: the compiled binary (its own executable),
// or bun running this file. The server shows it in the host status; the pid
// files alone cannot tell them apart.
const DAEMON_RUNTIME: 'bun' | 'binary' = /(^|\/)bun(-debug)?$/.test(process.execPath) ? 'bun' : 'binary'
const DAEMON_INSTANCE_ID = (() => {
  const seed = `${process.pid}-${DAEMON_START_TS}-${Math.random()}`
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `d-${process.pid}-${hash}`
})()
const LOG_FILE = path.join(DAEMON_DIR, `daemon-${DAEMON_INSTANCE_ID}.log`)

// ── PATH setup ──
// When running as a compiled binary, the daemon starts with a bare PATH.
// Claude CLI (#!/usr/bin/env node) needs BOTH claude AND node in PATH.
// Order (host-runtime-core.ts buildDaemonPath): the user's login-shell PATH,
// captured from a CLEAN env so our inherited PATH cannot leak into it, then the
// fallback tool dirs (the user's own tool dirs first), then the inherited PATH.
// The old order was fallbacks -> rc PATH -> inherited: the fallback dirs
// (/usr/local/bin, /usr/bin, ...) came BEFORE the user's rc PATH, and that rc
// PATH was captured in the inherited env, so a node in a system dir or in the
// server's own shell beat the one the user's rc chose (a Mac session got Node 18
// while .zshrc picked 22).
// Node discovery is NOT done here: buildSpawnPreamble() handles it at spawn
// time, and hostRuntime.ensureClaude() gates the spawn.
// claudeCheck: host.preflight's sign-in and version-floor answer (claude-check-core.ts).
// spawnPreamble and sessionShell: this daemon spawns through `<shell> -c "<preamble>; exec claude"`
// with the host's shell_setup file in the preamble, so preflight runs shell_setup and asks that
// shell before calling claude missing, as gateClaudeLaunch does: one builder for both.
// shellSetupFile: preflight's setup goes to the shell as a private file (the store's scratch).
const hostRuntime = createHostRuntime({
  fs, execFile, execFileSync, env: daemonEnv, platform: process.platform, arch: process.arch,
  claudeCheck: createClaudeCheck({ fs, execFile, env: daemonEnv, platform: process.platform, sha256Hex: (s) => crypto.createHash('sha256').update(s).digest('hex') }),
  spawnPreamble: (shellSetupFile) => buildSpawnPreamble({ shellSetupFile }),
  shellSetupFile: (setup) => shellSetupStore.scratch(setup),
  sessionShell: () => sessionShell(),
})
const bootPath = hostRuntime.computeDaemonPath()
// A test server's isolated daemon installs Claude Code and dtach under its own HOME
// (host-fix-core.ts): its sessions find them there. The CLI's daemon commands get the same PATH.
daemonEnv.PATH = withInstallHomeBin(bootPath.path, daemonEnv)
const INSTALL_HOME_BIN = installHomeBin(daemonEnv)
// 'hostfix-v1': the named, idempotent fixes host.fix runs (host-fix-core.ts).
const hostFix = createHostFix({
  fs, execFile, env: daemonEnv, runtime: hostRuntime, claudeInstall: createClaudeInstall, claudeDownload: createClaudeDownload, dtachBuild: createDtachBuild,
  os: { platform: () => process.platform, tmpdir: () => os.tmpdir(), uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1) },
  log: (level, msg, data) => logMsg(level, msg, data),
})
/** The accepted host.fix command whose fix runs (see cmdServiceHandover). */
let hostFixWork: Promise<unknown> | undefined

// ── Types ──
// The session records and socket data live in daemon-session-types.ts; here they take this runtime's socket.
type SessionData = SessionDataOf<ServerWebSocket<WsData>>
type AgentSub = AgentSubOf<ServerWebSocket<WsData>>

/** Bridge commands that name a session by `sid` (checked against the link's Walnut). */
const BRIDGE_SESSION_COMMANDS = new Set(['status', 'appendUserMarker', 'send', 'attach', 'read-history', 'bridgeResume', 'markers.find', 'session.permission'])

/**
 * Commands the cloud bridge is allowed to invoke. This MUST stay a subset of
 * what routes/session-stream-v1.ts + ws/bridge-registry.ts actually send:
 * status/appendUserMarker/send/attach/read-history/ping. Anything else from a
 * bridge socket is a compromised-cloud-box escalation attempt and is rejected.
 */
const BRIDGE_ALLOWED_COMMANDS = new Set([
  'status', 'appendUserMarker', 'send', 'attach', 'read-history', 'ping', 'bridgeResume', 'stt',
  // The replica says what it can reassemble (chunk size, clamped host-side):
  // it only shapes how THIS socket's own frames are cut, nothing else.
  'bridge.peer',
  // Narrow image fetch (extension allowlist + size cap) — lets the cloud box
  // proxy session-referenced pictures to phones. NOT fs.read: a compromised
  // cloud box must never get arbitrary file reads on exec hosts.
  'fs.readImage',
  // Narrow image save (mediaType allowlist + decoded-size cap + magic-byte
  // check, fixed daemon-owned directory, generated filename) — lets a phone
  // attach pictures to a session over the cloud box. NOT fs.write: a
  // compromised cloud box must never get arbitrary file writes on exec hosts.
  'image.save',
  // Narrow session upload ('upload-part-v1', transfer-core.ts uploadPart): a
  // file a phone attached, in chunks, written ONLY as <uploads root>/<id>/<name>
  // with the id and name checked and the root this daemon's own. NOT fs.write
  // or fs.writePart: the caller never names a path.
  'upload.part',
  // Narrow bounded file read (2MB cap + host-side path sandbox: traversal
  // rejection, realpath resolution, secret-path denylist) — lets the cloud
  // box serve phone file previews (HTML/text) for files on this host. NOT
  // fs.read: a compromised cloud box must never get unbounded arbitrary
  // reads (keys, configs) off exec hosts.
  'fs.readBounded',
  // Narrow launch relay: forwarded UP to the connected walnut server (same
  // relay shape as stt), which runs its full quick-start validation chain —
  // the daemon spawns NOTHING from this command. NOT the raw spawn command:
  // a compromised cloud box must never hand this daemon arbitrary argv.
  'session.launch',
  // Narrow control relay (model/effort/fork/model-options): same forward-to-
  // walnut-server shape as session.launch — the daemon executes NOTHING
  // itself, the primary re-validates everything.
  'session.control',
  // A pending can_use_tool answer only ('session-permission-v1'), never raw stdin.
  'session.permission',
  // Narrow message relay: forwarded UP to the connected walnut server, which
  // enqueues into the DURABLE session message queue (same store + reconnect
  // redelivery as web sends). The asymmetry fix for the 2026-08-13 phone-send
  // data-loss family — a daemon death mid-sequence becomes delayed delivery,
  // not loss. The daemon writes NOTHING itself from this command.
  'session.message',
  // The backup leader (leader-core.ts, docs/plan/walnut-control-plane.md). Each
  // checks for itself what the bridge may do: witness only reads; claim is
  // granted only when the user allowed it and THIS host has not heard the
  // primary for the takeover window; deliver writes into a session (no more
  // than `send` already can) only for the current epoch; gateway-result only
  // answers a relay this host sent to the bridge.
  'leader.witness', 'leader.claim', 'leader.deliver', 'gateway-result', 'feature.result',
  // A model or effort change on a live session here, while the companion leads
  // (current epoch only, a session of that Walnut): the same line the server
  // writes, its value checked (live-settings-core.ts).
  'leader.settings',
  // The same, for a permission answer, a permission mode or a user stop
  // ('leader-control-v1'): no more than the primary does for that session.
  'leader.control',
  // Narrow delivery-marker lookup (marker-find-v1): which of the given phone
  // message ids have a delivery marker in one session's stream. Read-only,
  // bounded (ids and bytes), and the answer is ids the caller already holds.
  'markers.find',
  // The companion's end of a stream a host server opened to it ('stream-relay-v1'):
  // frames of a stream on this socket only.
  'stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close',
  // The companion's forward to the Mac ('bridge-stream-v1'): a stream to the
  // primary only (streamTarget), where the Mac's own door gives it the rights
  // of a paired device, as the server.http forward has. Never to a follower.
  'stream.open',
  // DELIBERATELY ABSENT: the fs.rename / fs.rm / fs.copy mutation family (and
  // fs.write / fs.mkdir). A compromised cloud box must never be able to move or
  // delete files on an exec host — mutation is reachable only over the trusted
  // SSH-tunneled walnut client.
])

/**
 * What the bridge hello tells the companion this daemon does for it. WALNUT_BRIDGE_HIDE_CAPS (comma list, tests) leaves some out, so a
 * companion meets this daemon as an older one and takes its older path; refused for the
 * prod daemon dir, as every test knob that changes what a daemon does (section 10).
 */
const BRIDGE_HIDDEN_CAPS = KEEPS_SESSIONS ? [] : (daemonEnv.WALNUT_BRIDGE_HIDE_CAPS ?? '').split(',').map((x) => x.trim())
const BRIDGE_CAPABILITIES = ['bridge-stream-v1', 'send-dedupe-v1', 'send-lost-line-v1', 'session-permission-v1', 'feature-relay-v1'].filter((c) => !BRIDGE_HIDDEN_CAPS.includes(c))

/**
 * What a follower socket (the host server) may ask ('follower-v1'): who leads,
 * and reads of this host's sessions. Everything that writes state the leader
 * owns (leader.*, host.slice, replica.*, hooks/triggers/bridge/server configure,
 * offline.drain, stop) is refused: two writers of one host's configuration would
 * overwrite each other.
 */
const FOLLOWER_ALLOWED_COMMANDS = new Set([
  'hello', 'ping', 'follower.hello', 'follower.status', 'follower.report', 'server.status',
  'list', 'status', 'attach', 'read-history', 'markers.find',
  // While no server answers its Walnut ('follower-alone-v1'): that Walnut's
  // sessions here, a message to a running one, the answer to its prompt.
  // Each checks the leader and the session's owner itself.
  'follower.sessions', 'follower.send', 'follower.permission',
  // The slice of its Walnut, for a service that keeps no copy ('copyless-service-v1'): read only, own Walnut only.
  'follower.slice',
  // Journal v2 ('journal-v2', 'replica-ops-v1'): the replica's writes while the Mac is
  // away, and its read of what is pending (its overlay). Each is scoped to the follower's
  // own Walnut and checks the leader itself.
  'follower.op', 'follower.pending',
  // This Walnut's triggers here, and a check run once, for the follower's trigger_list and
  // trigger_test ('follower-triggers-v1'): reads only, own Walnut only.
  'follower.triggers', 'follower.trigger.test',
  // A line of its host call entry ('host-call-entry-v1'): checked for the caller's token here.
  'follower.gateway',
  // A message between this Walnut's sessions here that the follower decided ('follower-peer-v1').
  'follower.peer',
  // A new ask while the Mac is away ('replica-start-v1'): the Mac's template, filled
  // from the follower's validated fields only (host-start-core.ts).
  'follower.start',
  // The answer to a `walnut` call handed to it while its leader is away
  // ('follower-gateway-v1'): taken only for a relay sent to that socket.
  'gateway-result',
  // Its pick of the session for a trigger fire it was offered ('follower-trigger-delivery-v1'):
  // taken only for the live attempt sent to that socket.
  'follower.trigger.deliver',
  // Streams to the leader or the companion ('stream-relay-v1'): the frames of a
  // stream on this socket only; where an open may go is checked in streamTarget.
  'stream.open', 'stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close',
])

// What a lane socket (the leader's second link, for streams) may send ('stream-lane-v1').
const LANE_ALLOWED_COMMANDS = new Set([
  'hello', 'ping', 'stream.lane',
  'stream.open', 'stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close',
])

/** A Walnut server socket that may be the leader: not the bridge, a follower, a lane or a test server's probe. */
function isServerClient(ws: ServerWebSocket<WsData>): boolean {
  const origin = ws.data?.origin
  return origin !== 'bridge' && origin !== 'follower' && origin !== 'lane' && origin !== 'probe'
}

// DUP-DEBUG: per-process counter and lookup map for stable ws ids.
// Lets logs distinguish "same ws received twice" from "two different ws each
// received once" — critical for diagnosing the daemon→walnut duplicate-event
// bug where stderr_tail and tool_use both arrived twice on a single conn.
let __wsIdCounter = 0
const __wsIds = new WeakMap<ServerWebSocket<WsData>, number>()
function wsId(ws: ServerWebSocket<WsData>): number {
  let id = __wsIds.get(ws)
  if (id === undefined) {
    id = ++__wsIdCounter
    __wsIds.set(ws, id)
  }
  return id
}

// ── Logging ──
// Every log line includes DAEMON_INSTANCE_ID so `grep <id> daemon-*.log`
// isolates one daemon's lifetime even when multiple daemons have run.
// Appended off the thread, one write at a time (log-appender-core.ts); an error line, and the
// exit paths, write what is queued synchronously.
let logAppender: LogAppender | null = null
// A daemon program exits through process.exit in many places (a CLI action, a crash, a stop):
// it is handed this flush and writes what is still queued on the way out (runDaemonProcess). A
// runtime in a server's process flushes at its own stop (cleanup) instead.
options.onExitFlush?.(() => { try { logAppender?.flushSync() } catch { /* exiting */ } })
function logMsg(level: string, msg: string, data?: Record<string, unknown>) {
  // debug lines (cmd_recv per status poll ≈ 3/sec) are 60k+ writes/day of pure
  // polling noise. Gate them behind an env opt-in; info/warn/error always land.
  if (level === 'debug' && daemonEnv.WALNUT_DAEMON_DEBUG !== '1') return
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    instanceId: DAEMON_INSTANCE_ID,
    ...data,
  })
  // In a try: a line logged before this module's state exists (its first lines) is dropped, as before.
  try {
    if (!logAppender) logAppender = createLogAppender({ fs, file: LOG_FILE, armDeadline: LISTEN ? armFilePoolDeadline : (o) => armFilePoolDeadline({ ...o, probeMs: SERVER_POOL_PROBE_MS }) })
    logAppender.append(entry + '\n', level === 'error')
  } catch {}
  if (level === 'error') console.error(msg, data || '')
}

// ── Exit breadcrumb + last-resort crash guards ──
// The daemon died SILENTLY ≥7 times over 2026-08-11..13 (mid phone-bridge
// sends): no log line, no exit trace, stderr discarded by the spawner. This
// mirrors the server's /tmp/open-walnut-exit.log pattern: every JS-visible
// death appends one line to daemon-exit-<instanceId>.log in the daemon dir.
// A crash with NO breadcrumb but a stderr tail (local-daemon.ts now captures
// it) = a runtime-level death (OOM / native abort) that JS can never see.
const EXIT_BREADCRUMB_FILE = path.join(DAEMON_DIR, `daemon-exit-${DAEMON_INSTANCE_ID}.log`)
function writeExitBreadcrumb(kind: string, err: unknown): void {
  try {
    const mem = process.memoryUsage()
    let sessionCount = -1
    try { sessionCount = sessions.size } catch { /* module-init crash: map not born yet */ }
    fs.appendFileSync(EXIT_BREADCRUMB_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      pid: process.pid,
      instanceId: DAEMON_INSTANCE_ID,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      sessions: sessionCount,
      error: err instanceof Error ? err.message : (err === undefined ? undefined : String(err)),
      stack: err instanceof Error ? err.stack : undefined,
    }) + '\n')
  } catch { /* the breadcrumb must never be the thing that crashes */ }
}

/** Fatal-path funnel: structured log + breadcrumb. The process entry then exits(1)
 *  so the supervisor (LocalDaemon.ensureRunning / next Mac reconnect) respawns a
 *  clean process instead of us limping on with unknown state. */
function daemonCrash(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  try {
    logMsg('error', 'FATAL: ' + kind + ' — daemon exiting', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  } catch {}
  logAppender?.flushSync()
  writeExitBreadcrumb(kind, err)
}
// From here on a crash is reported the way it always was (daemonCrash), at the point the
// daemon always began to: what its log and breadcrumb need exists now. The host decides what
// follows (the process entry registers its handlers here and exits, as the daemon always did);
// a crash before this point keeps the runtime's default (its stack on stderr).
options.onCrashReporter?.(daemonCrash)

/**
 * Structured state-transition log. Emit BEFORE mutating state so the log line
 * is ordered with the mutation. Every lifecycle flip (session, FIFO, CLI
 * process, daemon itself) should flow through this.
 */
function logStateTransition(
  sid: string,
  oldState: string,
  newState: string,
  reason: string,
  source: string,
  extra?: Record<string, unknown>,
): void {
  logMsg('info', 'state_transition', {
    sid,
    oldState,
    newState,
    reason,
    source,
    ...(extra || {}),
  })
}

// ── Process group helpers (daemon-process-groups.ts): a CLI's pid is its group's id ──
const { killProcessGroup, isProcessGroupAlive, killSessionProcessGroup, sleepSync, runningGroupsSync, runningGroupIdsSync } = createDaemonProcessGroups({ logMsg, setTimeout, execFileSync })

/**
 * Is this an isolated-dir daemon (sandbox / test / ephemeral demo) whose CLI
 * children must die with it? Derived from DAEMON_DIR — the same definition
 * local-daemon.ts uses for parentWatchdogEnv/stopIfIsolated — NOT from
 * WALNUT_DAEMON_PARENT_PID. Deriving it means test launchers that spawn the
 * daemon directly (7 of them) get the leak fix without opting in, and a stale
 * inherited PARENT_PID can never trick the PRODUCTION daemon into killing live
 * sessions.
 */
function shouldReapOnExit(): boolean {
  try {
    return !SERVICE_MODE && !handoverPrepared && !KEEPS_SESSIONS && !KEEP_SESSIONS_ON_EXIT
  } catch {
    return false // unresolvable → treat as prod (never kill)
  }
}

/**
 * Synchronous kill-all for isolated-dir daemon exit (cleanup() runs right
 * before process.exit, so the async ladder in killSessionProcessGroup would
 * never fire). Mirrors that ladder's phases — SIGINT (on-stop hooks) → SIGTERM
 * → SIGKILL — with a budget sized above the CLI's ~3.5-5s graceful-shutdown
 * window so hooks are not truncated (CLAUDE.md: never force-kill the CLI).
 * Production daemons never call this — see cleanup().
 */
function reapAllSessionGroupsSync() {
  const pids: number[] = []
  for (const [sid, session] of sessions) {
    // Only LIVE sessions. A dead session's `pid` is never nulled, and macOS
    // recycles pids — signalling a stale one can hit an unrelated process
    // group that inherited the number (another agent's daemon, a browser).
    if (session.state !== 'running' || session.exitCode !== null) continue
    if (!session.pid || !isProcessGroupAlive(session.pid)) continue
    logMsg('info', 'isolated-dir exit: SIGINT session group', { sid, pid: session.pid })
    killProcessGroup(session.pid, 'SIGINT')
    pids.push(session.pid)
  }
  if (pids.length === 0) return

  // Phase 1 — SIGINT grace. The CLI needs ~3.5s (2s cleanup race + 1.5s
  // SessionEnd hooks); poll so a fast exit doesn't cost the full budget.
  const sigintDeadline = Date.now() + 5000
  while (Date.now() < sigintDeadline && runningGroupsSync(pids).length > 0) sleepSync(200)

  // Phase 2 — SIGTERM the stragglers.
  const stillAlive = runningGroupsSync(pids)
  if (stillAlive.length === 0) return
  for (const pid of stillAlive) {
    logMsg('info', 'isolated-dir exit: SIGTERM session group', { pid })
    killProcessGroup(pid, 'SIGTERM')
  }
  const termDeadline = Date.now() + 2000
  while (Date.now() < termDeadline && runningGroupsSync(stillAlive).length > 0) sleepSync(200)

  // Phase 3 — SIGKILL whatever refuses to die (orphan CLIs blocked on FIFO
  // stdin ignore SIGTERM entirely; observed 2026-07-25).
  for (const pid of runningGroupsSync(stillAlive)) {
    logMsg('warn', 'isolated-dir exit: SIGKILL session group', { pid })
    killProcessGroup(pid, 'SIGKILL')
  }
}

/**
 * reapAllSessionGroupsSync's ladder for a stop that can wait (stopDaemon): the same phases and
 * budgets, but the waits are timers and the ps (macOS) runs async, so a runtime inside a server's
 * process never holds every route for the CLIs' 3.5 to 7 s shutdown (A3b measure: one stall of
 * 0.2 s at best, 3.7 s with a real CLI's exit, 7.2 s with a stuck one). The /proc read stays as it
 * is (a few milliseconds). cleanup()'s sync ladder then finds nothing left to wait for.
 */
async function reapAllSessionGroups(): Promise<void> {
  const pids: number[] = []
  for (const [sid, session] of sessions) {
    if (session.state !== 'running' || session.exitCode !== null) continue
    if (!session.pid || !isProcessGroupAlive(session.pid)) continue
    logMsg('info', 'isolated-dir stop: SIGINT session group', { sid, pid: session.pid })
    killProcessGroup(session.pid, 'SIGINT')
    pids.push(session.pid)
  }
  if (pids.length === 0) return
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const runningGroups = async (group: number[]): Promise<number[]> => {
    const alive = group.filter(isProcessGroupAlive)
    if (alive.length === 0) return alive
    let running: Set<number> | null
    if (fs.existsSync('/proc/self/stat')) running = runningGroupIdsSync()
    else {
      running = await new Promise<Set<number> | null>((resolve) => {
        childUse.execFile('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf-8', timeout: 2000 }, (error, stdout) => {
          if (error) { resolve(null); return }
          const set = new Set<number>()
          for (const line of String(stdout).split('\n')) {
            const [pgid, stat] = line.trim().split(/\s+/)
            if (pgid && stat && !stat.startsWith('Z')) set.add(Number(pgid))
          }
          resolve(set)
        })
      })
    }
    return running ? alive.filter((pid) => running!.has(pid)) : alive
  }
  const sigintDeadline = Date.now() + 5000
  while (Date.now() < sigintDeadline && (await runningGroups(pids)).length > 0) await wait(200)
  const stillAlive = await runningGroups(pids)
  if (stillAlive.length === 0) return
  for (const pid of stillAlive) {
    logMsg('info', 'isolated-dir stop: SIGTERM session group', { pid })
    killProcessGroup(pid, 'SIGTERM')
  }
  const termDeadline = Date.now() + 2000
  while (Date.now() < termDeadline && (await runningGroups(stillAlive)).length > 0) await wait(200)
  for (const pid of await runningGroups(stillAlive)) {
    logMsg('warn', 'isolated-dir stop: SIGKILL session group', { pid })
    killProcessGroup(pid, 'SIGKILL')
  }
}

// ── Shell helpers: the session shell, shell_setup, the preamble, the launch gate (daemon-session-shell.ts) ──
const sessionShellHelpers = createDaemonSessionShell({ daemonEnv, SERVICE_MODE, DAEMON_STATE_DIR, DAEMON_DIR, GATEWAY_SHIM_DIR, INSTALL_HOME_BIN, childUse, hostRuntime,
  // Defined further down (the session owners, the followers), so asked on use.
  walnutOfHome, followsHere: (home) => followerHere(home).here, sessionHomeOf: (sid) => sessionHomeOf(sid), spawnFallbackPath, setTimeout, clearTimeout, logMsg })
const { passwdReady, sessionShell, shellSetupStore, shellSetupOfStart, buildSpawnPreamble, walnutThroughGateway, sessionWalnutApiUrl, sessionPathWithShim, settingsEnvOf, gateClaudeLaunch } = sessionShellHelpers

/** The fallback tool dirs and the shim dir, read each time a preamble is built. */
function spawnFallbackPath(): string {
  return (
    // APPEND (not prepend) common tool dirs as a fallback. Prepending used to
    // shadow a user's RC-ordered `claude` (e.g. ~/.toolbox/bin/claude, which is
    // logged in) with ~/.local/bin/claude (a separate, NOT-logged-in install),
    // causing "Not logged in · Please run /login". The sourced RC above already
    // sets the user's intended PATH order; these dirs only fill gaps when claude
    // /node aren't on the RC PATH at all.
    // GATEWAY_SHIM_DIR is appended at runtime (string concat, not a $HOME
    // template) so `walnut` — the peer-session CLI shim — is on every session's
    // PATH.
    'export PATH="$PATH:$HOME/.toolbox/bin:$HOME/.local/bin:$HOME/.npm-global/bin:'
      + GATEWAY_SHIM_DIR + '"'
  )
}

// ── Permission Policy FIFO Writer ──
//
// Used by the auto-allow path (which bypasses cmdSendRaw / daemon-core). Must
// handle payloads larger than PIPE_BUF (512B on macOS) — a control_response
// embedding a tool input can easily exceed that. See writeFifoFullyAsync docs
// in daemon-core.ts for why a single non-blocking writeSync isn't safe. This
// SYNC variant (500ms busy-wait budget) is only safe here because auto-allow
// fires while the CLI is provably alive and draining stdin (it just emitted
// the control_request); user sends go through the async path in daemon-core.
function writeFifoRaw(pipePath: string, raw: string): boolean {
  try {
    const buf = Buffer.from(raw.endsWith('\n') ? raw : raw + '\n')
    let fd: number
    try {
      fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENXIO') return false
      throw err
    }
    try {
      let offset = 0
      let consecutiveEagain = 0
      while (offset < buf.length) {
        try {
          const n = fs.writeSync(fd, buf, offset, buf.length - offset)
          if (n > 0) { offset += n; consecutiveEagain = 0; continue }
          consecutiveEagain++
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
            consecutiveEagain++
          } else {
            throw err
          }
        }
        if (consecutiveEagain >= 50) return false
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch {}
      }
      return true
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
  } catch {
    return false
  }
}

// ── Managed Sessions ──
const sessions = new Map<string, SessionData>()

// ── WebSocket connections ──
const wsClients = new Set<ServerWebSocket<WsData>>()

// When each trusted (non-bridge) client was last HEARD from: any frame, ping or
// pong. A trusted client is a walnut
// server, normally over an SSH port forward. When that forward dies on the far
// side (a Mac asleep, a network that changed under it), the host's sshd keeps
// the forwarded socket to this daemon open for many minutes: nothing ever
// closes it and nothing ever comes back on it. The keepalive in main() pings
// every trusted client once a beat and closes one it has not heard from for
// CLIENT_KEEPALIVE_MISSED beats; a live walnut server is heard every beat (it
// pings every 15s and answers these pings). The env override exists for tests
// (sub-second beats); production leaves it unset. Parsed once, here, with the
// floor every daemon timer knob has (envTimerMs).
const TRUSTED_CLIENT_BEAT_MS = envTimerMs(daemonEnv.WALNUT_TRUSTED_CLIENT_BEAT_MS, 15_000, 100)
function heardFrom(ws: ServerWebSocket<WsData>): void {
  const wasSilent = (ws.data?.missedBeats ?? 0) > 0
  if (ws.data) { ws.data.lastHeardAt = Date.now(); ws.data.missedBeats = 0 }
  if (!isServerClient(ws)) return
  // A trusted socket tagged with a Walnut's home is that Walnut's primary: this
  // host is a witness of whether it is still there (leader-core.ts).
  const home = gatewayClientHomes.get(ws)
  leaderBook.noteHeard(home)
  // A primary that missed beats is a target again (heard first, so it no longer reads
  // quiet): the calls waiting for one go now.
  if (wasSilent) wakeGatewayCalls()
  // A socket that outlived the primary's sleep speaks again while the companion
  // leads: tell the primary, which takes the lead back after its handover.
  if (home && ws.data && leaderBook.backupLead(home) && Date.now() - (ws.data.leaderNudgedAt ?? 0) > LEADER_NUDGE_MS) {
    ws.data.leaderNudgedAt = Date.now()
    sendEvent(ws, 'leader-lost', { home })
  }
}

// Which trusted (non-bridge) client a relay goes to. A trusted client is a walnut server, normally over an SSH
// port forward. When that forward dies on the far side (a Mac asleep, a network
// that changed under it), the host's sshd keeps the forwarded socket to this
// daemon open for many minutes: nothing ever closes it, nothing ever comes back
// on it. Picking "the first trusted client" handed every phone send to that
// socket (2026-10-01: each relay timed out, the companion held the sends, and the
// Mac's fresh link opened later sat behind the dead one in insertion order).
// So every client stamps when it was last HEARD from (any frame, ping or pong).
// A live walnut server is heard at least every beat (it pings every 15s). The
// pick, in connect order:
//   fresh   (heard within one beat plus slack): the first one wins, so with two
//           live servers the relay keeps going to the one that came first;
//   suspect (missed a beat, not yet quiet): only when no client is fresh, so a
//           redial beats the socket it replaces at once;
//   quiet   (three beats with nothing): never a target. With none left the relay
//           answers at once that no primary server is connected (it forwarded
//           nothing, which is what lets the companion take its direct path).
const TRUSTED_CLIENT_FRESH_MS = Math.round(TRUSTED_CLIENT_BEAT_MS * 4 / 3)
const TRUSTED_CLIENT_QUIET_MS = TRUSTED_CLIENT_BEAT_MS * 3
function isQuietTrustedClient(client: ServerWebSocket<WsData>): boolean {
  const at = client.data?.lastHeardAt
  return typeof at === 'number' && Date.now() - at > TRUSTED_CLIENT_QUIET_MS
}
/**
 * A suspect client (past one beat, not yet quiet) of a Walnut the companion
 * leads: that Walnut's server has gone silent (that is how the lead was won),
 * so it is a target again once it speaks, never before. A takeover shorter than
 * three beats left a window where a phone send went to a Mac asleep and waited
 * there for it to wake (2026-10-11, the takeover e2e on CI). A client with no
 * Walnut named is held to it too while the companion leads any: a server's
 * second socket (its bulk channel) never says which Walnut it is, and it was
 * that socket of the sleeping Mac the send went to.
 */
function ledAway(client: ServerWebSocket<WsData>): boolean {
  const home = gatewayClientHomes.get(client)
  return home ? leaderBook.backupLead(home) !== null : leaderBook.anyBackupLead()
}
/**
 * `home` is the Walnut whose bridge link the relay came in on: a named link's
 * relay goes only to that Walnut's server (servesBridgeHome); '' keeps the old pick.
 */
function pickTrustedClient(home = ''): { client: ServerWebSocket<WsData> | null; quiet: number; quietForMs: number | null } {
  const now = Date.now()
  let fresh: ServerWebSocket<WsData> | null = null
  let suspect: ServerWebSocket<WsData> | null = null
  let quietAt: number | null = null
  let quiet = 0
  for (const client of wsClients) {
    if (!isServerClient(client)) continue
    if (!servesBridgeHome(client, home)) continue
    const at = typeof client.data?.lastHeardAt === 'number' ? client.data.lastHeardAt : now
    const silentMs = now - at
    if (silentMs > TRUSTED_CLIENT_QUIET_MS) {
      quiet += 1
      if (quietAt === null || at > quietAt) quietAt = at
    } else if (silentMs <= TRUSTED_CLIENT_FRESH_MS) {
      if (!fresh) fresh = client
    } else if (!suspect && !ledAway(client)) {
      suspect = client
    }
  }
  return { client: fresh ?? suspect, quiet, quietForMs: quietAt === null ? null : now - quietAt }
}
/**
 * A relay answered from a server of another Walnut than the link it came in on
 * (`home`): refused, and the relay stays for its own server to answer. '' = the
 * link of an older server, which any trusted client may answer as before.
 */
function answersForOtherWalnut(ws: ServerWebSocket<WsData>, home: string): boolean {
  if (!home) return false
  const bound = gatewayClientHomes.get(ws)
  return bound !== undefined && bound !== home
}
/** The error a relay answers when no trusted client can take it: the caller's
 *  contract text ("<cmd>: no primary server connected", which companions key on
 *  as provably unsent), plus why when a quiet client was skipped. */
function noPrimaryError(contract: string, picked: ReturnType<typeof pickTrustedClient>): string {
  const why = picked.quietForMs !== null ? ` (the last one went quiet ${Math.round(picked.quietForMs / 1000)}s ago)` : ''
  if (picked.quiet > 0) {
    logMsg('warn', 'relay: every trusted client is quiet, none is a target', { what: contract, quiet: picked.quiet, quietForMs: picked.quietForMs })
  }
  return contract + why
}

let cronMetadataConfig: Awaited<ReturnType<typeof readCronCliConfig>> | null = null
const cronMetadata = createCronMetadataTracker({
  epoch: DAEMON_INSTANCE_ID,
  changed: (value) => {
    for (const client of wsClients) {
      if (isServerClient(client)) sendEvent(client, 'cron-metadata', { value })
    }
  },
  oneShotTime: (cron, createdAt, id) => cronMetadataConfig ? cliOneShotTime(cron, createdAt, id, cronMetadataConfig) : null,
  nextRun: nextCliCronMinute,
  promptLimit: CRON_PROMPT_LIMIT,
})
function cronProcess(session: SessionData) {
  const epoch = streamEpochOf(session)
  const identity = `${session.bootId ?? ''}:${session.pid}:${session.startTime}:${epoch}`
  const origin = session.cronMetadataOrigin
  const valid = session.startTime && epoch && origin?.identity === identity
    && Number.isSafeInteger(origin.offset) && origin.offset >= 0 && Number.isFinite(origin.startedAt) && origin.startedAt > 0
  const byTime = !!valid && origin!.byTime === true
  return { identity, alive: session.state === 'running', version: session.cliVersion,
    startedAt: valid ? origin!.startedAt : undefined,
    // A by-time origin's offset is the adopt boundary, not a process boundary:
    // reporting it as the start offset would make the tracker attribute by the
    // wrong rule (and hide everything the live process wrote before the adopt).
    startOffset: valid && !byTime ? origin!.offset : undefined,
    attributeByTime: byTime,
    fresh: !!valid && origin!.fresh === true }
}

function updateCronMetadata(sid: string, session: SessionData, line?: string) {
  const process = cronProcess(session)
  cronMetadata.configure(sid, process, cronMetadataConfig)
  if (line) {
    if (!session.cronMetadataLoading) cronMetadata.observe(sid, process, line)
  } else cronMetadata.state(sid, process)
}

// ── Write-ahead Registry (Phase C) ──
// Persists the daemon's session inventory to disk before returning spawn() to
// the caller. After a daemon crash/restart, reconcile() reads this file and
// for each entry probes kill(pid,0) to decide adopt vs reap. Implementation
// lives in daemon-core.ts (dependency-injected, unit-testable); this file
// only provides Bun-specific I/O bindings.
const REGISTRY_FILE = path.join(SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR, 'sessions.json')
type RegistryEntry = CoreRegistryEntry

// ── Agent subscriptions ──
const agentSubs = new Map<string, AgentSub>()

// Current byte size of a stream file, 0 if missing. Used as the adopt-time
// watcher offset so a new daemon generation never replays history it didn't
// stream itself.
function statSizeOrZero(p: string): number {
  try { return fs.statSync(p).size } catch { return 0 }
}

// ── L2 task state, the fold checkpoints and rebuilds (C1), the fold prewarm (daemon-session-fold.ts) ──
const sessionFold = createDaemonSessionFold({ daemonEnv, readRegistry: () => readRegistry(), streamEpochOf: (session) => streamEpochOf(session), logMsg })
const { BG_TERMINAL_STATUSES, emptyTaskState, applyTaskEvent, TASK_LINE_MARKER, foldCheckpoint, FOLD_CHECKPOINT_SWEEP_MS, checkpointSessionFold,
  rebuildTaskStateFromJsonl, SNAPSHOT_COALESCE_MS, TAILER_CARRY_MAX, TAILER_TICK_READ_MAX, FOLD_REBUILD_CHUNK, rebuildFoldStateFromJsonl,
  prewarmFoldCheckpoints } = sessionFold

// ── Stream compaction and the async stream fold with its rotation on resume (daemon-stream-compaction.ts) ──
const streamCompaction = createDaemonStreamCompaction({ daemonEnv, HOME_DIR, STREAMS_DIR, TAILER_CARRY_MAX, TASK_LINE_MARKER, sessions, sessionStartGate, foldCheckpoint,
  emptyTaskState, applyTaskEvent, isProcessGroupAlive, cliOwner: { holderOf: (sid) => cliOwner.holderOf(sid) }, streamEpochOf: (session) => streamEpochOf(session),
  pushSnapshot: (sid, immediate) => pushSnapshot(sid, immediate), logMsg })
const { STREAM_COMPACT_IDLE_MS, STREAM_COMPACT_SWEEP_MS, streamCompact, streamFold, CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_DIRS, pidAlive, streamWriterGone,
  compactIdleStreams } = streamCompaction

// ── C18: the synchronous pre-death fold drain, the stream epoch, the session snapshot and its push (daemon-session-snapshot.ts) ──
const sessionSnapshot = createDaemonSessionSnapshot({ FOLD_REBUILD_CHUNK, SNAPSHOT_COALESCE_MS, TAILER_CARRY_MAX, sessions, applyTaskEvent, setTimeout, clearTimeout,
  logMsg, sendEvent })
const { drainSessionFold, streamEpochOf, assembleSessionSnapshot, pushSnapshot } = sessionSnapshot

// ── daemon-core wiring ──
// SessionData already extends CoreSessionData (same field names). Core reaps,
// persists, and reconciles in pure functions; we inject the Bun-specific
// broadcast + kill + readStartTime deps.
// The start time of a pid without holding the clock: /proc on Linux, an asynchronous `ps` on macOS.
const readStartTimeAsync = createAsyncStartTimeReader({
  fs,
  env: daemonEnv,
  execFileFn: (file, args, options, callback) => execFile(file, args, options, (error, stdout) => callback(error, String(stdout ?? ''))),
})
const core = createDaemonCore<SessionData>({
  // In a server's process (no door of its own to listen on: in process, or the host service) a
  // sync write runs on the web server's thread: only a pool silent for 5 s counts as wedged.
  ...(LISTEN ? {} : { poolProbeMs: SERVER_POOL_PROBE_MS }),
  get bootId() { return daemonBootId },
  fs,
  clock: () => Date.now(),
  killFn: (pid, sig) => { process.kill(pid, sig as NodeJS.Signals) },
  readStartTimeFn: (pid) => defaultReadStartTime(fs, pid, childUse),
  readStartTimesFn: (pids) => defaultReadStartTimes(fs, pids, childUse),
  readStartTimeAsyncFn: (pid) => readStartTimeAsync(pid),
  killProcessGroupFn: killProcessGroup,
  streamsDir: STREAMS_DIR,
  pictureRoots: PICTURE_ROOTS,
  registryFile: REGISTRY_FILE,
  orphanPollIntervalMs: 1000,
  orphanStartTimeCheckMs: 30_000,
  logger: logMsg,
  allowBudgetFn: (sid) => budgetAllowance(sid),
  // line-answer-v1: the CLI's transcript, asked when the stream lost a line's frames (daemon-core.ts lineFateInProcess).
  transcriptPathFn: (sid, session) => streamFold.transcriptPathOf(CLAUDE_PROJECTS_DIRS, cliOwner.transcriptIdOf(session.args ?? []) ?? sid),
  broadcastSessionStateFn: (payload) => {
    const session = sessions.get(payload.sid)
    if (session) updateCronMetadata(payload.sid, session)
    // Its last mode, for a host resume after this daemon is gone (host-resume-core.ts).
    if (session && payload.state === 'dead' && session.args.length > 0 && session.cwd) {
      hostResume.remember(payload.sid, { args: session.args, cwd: session.cwd, mode: session.mode, home: session.spawnInfo?.home, task: session.spawnInfo?.task })
    }
    for (const client of wsClients) {
      if (followerHears(client, payload.sid) && bridgeHearsSession(client, payload.sid)) sendEvent(client, 'session_state', payload)
    }
  },
  broadcastExitToWatchersFn: (session, code, stderrTail) => {
    // Fan exit to all current subscribers, then close watcher + clear set.
    for (const client of session.subscribers) {
      sendEvent(client, 'exit', { sid: sessionSidOf(session), code, stderr: stderrTail })
    }
    stopSessionWatcher(sessionSidOf(session))
    session.subscribers.clear()
  },
  sessions,
  pushSnapshotFn: (sid, immediate) => pushSnapshot(sid, immediate),
  // C18: synchronous pre-death fold drain + last-line fan-out (see drainSessionFold).
  // Death is also when a fold checkpoint is worth most: a resume or the next
  // daemon's adopt starts from it (fold-checkpoint-core.ts).
  drainFoldFn: (session) => {
    drainSessionFold(session, sessionSidOf(session))
    try { checkpointSessionFold(session, true) } catch {}
  },
  // Daemon hooks: core's session.reap point consults the same pushed rules as
  // the tailer points (hookActions comes from daemon-hooks.ts below; evaluated only at runtime).
  hookActionsFn: (point, ctx) => hookActions(point, ctx),
  createAdoptedSession: async (_sid, entry) => {
    // C1: rebuild fold state from the durable jsonl (streamed, whale-safe) AND
    // take the watcher offset from the SAME rebuild's complete-line boundary.
    // Contract §4 "Rebuild boundary rule": a raw stat().size here would start
    // the watcher MID-LINE whenever the CLI was writing during adopt — the
    // rebuild would have consumed the fragment's first half and the completed
    // line would never be folded whole (C3/C7).
    // One async pass folds both states from the checkpoint and gives the thread
    // back after every read (stream-fold-core.ts): a server running this runtime
    // in process keeps answering while a restart adopts its sessions.
    const folded = await streamFold.foldFile(entry.jsonlPath, Date.now())
    const adoptFold = { state: folded.fold, boundary: folded.boundary }
    const adopted = {
      proc: null,
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      pid: entry.pid,
      // Adopt at the CURRENT end of the stream file, not 0. The previous daemon
      // generation already fanned out everything before this point; starting the
      // watcher at 0 made it re-emit the entire file to every subscriber (UI
      // symptom: whole conversation replays after a daemon restart). Subscribers
      // that genuinely need history request it via attach fromOffset.
      offset: adoptFold.boundary,
      // Rebuild task state from the durable jsonl — recovers terminal events the previous
      // daemon generation saw (and Walnut's live stream may have missed across the restart).
      taskState: folded.task,
      foldState: adoptFold.state,
      // The checkpoint the fold just left (or found): a death right after needs no other.
      foldCheckpointV: folded.checkpointV || undefined,
      watcher: null,
      subscribers: new Subscribers(),
      exitCode: null,
      state: 'running' as const,
      exitReason: null,
      exitedAt: null,
      parented: false,
      startTime: entry.startTime,
      bootId: entry.bootId,
      cliVersion: entry.cliVersion,
      cronMetadataOrigin: entry.cronMetadataOrigin,
      cwd: entry.cwd ?? '',
      args: entry.args ?? [],
      orphanPollTimer: null,
      mode: entry.mode ?? 'default',
      pendingCtrl: entry.pendingCtrl ?? null,
      turnRetry: entry.turnRetry,
      budgetGracefulStop: entry.budgetGracefulStop === true || budgetStopGroups.has(_sid),
    }
    // A session spawned before cron bookkeeping existed carries no origin, and
    // without one EVERY cron line counted as historical (never active, so no
    // badge) while the replay rescanned the whole stream from byte 0 — a 1GB
    // whale stream aborted at the 10s budget and reported no jobs at all.
    //
    // The live process is the one piece of evidence an adopt does have: the OS
    // knows when it started, and a cron the CLI created after that moment is
    // held by the process that is still running. So attribute by TIME here (the
    // recorded offset belongs to the previous daemon generation, not to the
    // process) and only pay for the extra stream pass when the fold actually saw
    // an armed job. Without a start time from the OS, fall back to the adopt
    // boundary: evidence from here on, unknown before.
    // A DERIVED origin is re-derived, never inherited: it is a guess about a
    // process this daemon never spawned, and the previous generation's guess must
    // not outlive the evidence behind it. Records written before the marker
    // existed are caught by their own inconsistency: a spawn stamps its clock just
    // BEFORE forking, so a real spawn origin's startedAt is never later than the
    // start the OS reports (which macOS floors to the whole second, hence a small
    // allowance). A record claiming a later start was derived after the fact.
    const processStart = processStartedAtMs(entry.pid, entry.startTime)
    const inherited = adopted.cronMetadataOrigin
    if (!inherited || inherited.derived === true
      || (processStart !== null && inherited.startedAt > processStart + 5_000)) {
      const armed = Object.keys(adoptFold.state.cronIds ?? {}).length > 0
      adopted.cronMetadataOrigin = {
        identity: cronProcess(adopted as SessionData).identity,
        offset: adoptFold.boundary,
        startedAt: processStart ?? Date.now(),
        fresh: false,
        derived: true,
        // Time attribution costs one pass over the stream, so it is only turned on
        // for a session whose fold actually saw a job armed.
        ...(processStart !== null && armed ? { byTime: true as const } : {}),
      }
    }
    return adopted
  },
})

// Back-reference lookup — the exit-watcher broadcast needs sid from session,
// but SessionData doesn't store it. Reverse-index once at call time.
function sessionSidOf(session: SessionData): string {
  for (const [sid, s] of sessions) if (s === session) return sid
  return ''
}

// Expose primitive names for the rest of the file (no large rewrite needed).
const readRegistry = core.readRegistry
const persistRegistry = core.persistRegistry
// The write-ahead: resolves once the registry holds what this daemon knows now (registry-writer-core.ts).
const persistRegistryDurable = core.persistRegistryDurable
// One synchronous write now: the exit cleanup and a server's shutdown bail (saveNow).
const persistRegistryNow = core.persistRegistrySync
const readStartTime = core.readStartTime
const broadcastSessionState = core.broadcastSessionState
const reapSession = core.reapSession
const startOrphanPoll = core.startOrphanPoll
const reconcileRegistry = core.reconcileRegistry

// ── ACP worker supervision (in-process model; see acp-daemon.ts) ──
// Inside the compiled walnut file (a compiled Mac's remote daemon slot, the host's boot
// service) this daemon runs ACP engines for the primary itself, as the source twin does:
// the worker and the bundled adapters are in the file's own runtime tree under their dist
// names, and the file runs them (src/binary/main.ts runtimeScript). A plain daemon binary
// carries none and stays without 'acp-host-v1' (2026-11-02: once hosts ran the boot
// service, pi and Codex could not start on any remote Linux host).
const ACP_ARTIFACT_DIR = (() => {
  const root = singleFile()?.root
  if (!root) return undefined
  const dir = path.join(root, 'dist', 'daemon-binaries')
  return fs.existsSync(path.join(dir, ACP_HOST_FILES[ACP_HOST_WORKER] ?? ACP_HOST_WORKER)) ? dir : undefined
})()
// The work that outlives this daemon, listed for a launcher's rollback stop (detached-registry.ts:
// `<state dir>/detached/stop-detached.sh <that dir>`).
const DETACHED_RUNS_DIR = path.join(SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR, 'detached')
const acp = createAcpDaemon<ServerWebSocket<WsData>>({
  registryDir: DETACHED_RUNS_DIR,
  childProcess: childUse,
  // Its idle sweep is one of this runtime's timers: stop() ends it.
  setIntervalFn: setInterval,
  maySpawn: () => !demoQuiesce.fenced,
  strictStop: () => demoQuiesce.isDemo,
  streamsDir: STREAMS_DIR,
  daemonDir: DAEMON_DIR,
  ...(ACP_ARTIFACT_DIR ? { artifactDir: ACP_ARTIFACT_DIR, artifactNames: ACP_HOST_FILES } : {}),
  sendEvent,
  isWsOpen: (ws) => ws.readyState === 1,
  log: logMsg,
  // Called only after startup, when usageBudget exists.
  onTurnEnd: (sid) => usageBudget.observeRuntime(sid),
})

// Daemon NEVER auto-exits. It's a permanent process manager on the remote host.
// Mac disconnecting should NOT cause daemon to exit — sessions keep running.
// Session lifecycle is managed by the session idle scanner (scanIdleSessions).

// ── Session management commands ──

const featureRelay = createFeatureRelay(crypto.randomUUID())
const featureSockets = new WeakMap<object, { send(text: string): boolean }>()
function featureSocket(ws: ServerWebSocket<WsData>) {
  let socket = featureSockets.get(ws)
  if (!socket) {
    socket = { send: (text: string) => { if (ws.readyState !== 1) return false; safeSend(ws, text); return true } }
    featureSockets.set(ws, socket)
  }
  return socket
}

function handleCommand(ws: ServerWebSocket<WsData>, msg: string) {
  let cmd: unknown
  try { cmd = JSON.parse(msg) } catch { return sendError(ws, null, 'invalid JSON') }
  return handleCommandFrame(ws, cmd)
}

/** One command frame, from a socket (parsed above) or a client in this process (the object it sent). */
function handleCommandFrame(ws: ServerWebSocket<WsData>, frame: unknown) {
  const cmd = passCommandGates(ws, frame, (reply) => sendFrame(ws, reply))
  // Refused and answered.
  if (!cmd) return
  const id = cmd.id as number
  // One command must never kill the daemon: a throw anywhere in a handler
  // (the pre-guard era: a whale-file rebuild OOM inside cmdAttach took the
  // whole process down MID phone-send — marker written, message lost) becomes
  // an error reply to the caller. Async handlers (fs.*) return promises — a
  // rejection there would otherwise surface as unhandledRejection and trip
  // the fatal guard above, so it is caught here too.
  const replyError = (err: unknown) => sendAnswer(ws, id, handlerThrew(cmd, err))
  // demo.quiesce runs outside the drain (it waits for the drain); once it fenced, only reads and stops.
  if (cmd.cmd === 'demo.quiesce') {
    void demoQuiesce.quiesce(ws.data?.origin, cmd).then((reply) => {
      if (reply.ok) sendOk(ws, id, reply)
      else sendError(ws, id, reply.error, reply)
    }, replyError)
    return
  }
  try {
    const out = admitCommand(cmd, () => dispatchCommand(ws, id, cmd)) as unknown
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      (out as Promise<unknown>).catch(replyError)
    }
    return
  } catch (err) {
    return replyError(err)
  }
}

/**
 * A command a client in this process calls (DaemonClient.call): one the runtime answers by function
 * (commandAnswers), through the same gates and admission as handleCommandFrame, its Answer handed
 * back as the reply object, with no frame on the client's queue. null for any other command: the
 * client sends that one as a frame.
 */
function callCommand(ws: ServerWebSocket<WsData>, frame: DaemonFrame): Promise<DaemonFrame> | null {
  const answerFn = answerFnOf(frame.cmd)
  if (!answerFn) return null
  return new Promise<DaemonFrame>((resolve) => {
    const cmd = passCommandGates(ws, frame, resolve)
    if (!cmd) return
    const id = cmd.id as number
    const failed = (err: unknown) => resolve(answerFrame(ws, id, handlerThrew(cmd, err)))
    try {
      const out = admitCommand(cmd, () => answerCommand(ws, cmd, answerFn, (answer) => resolve(answerFrame(ws, id, answer))))
      // As handleCommandFrame's .catch(replyError): a rejection is one error reply, never a hang.
      if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).catch(failed)
    } catch (err) {
      failed(err)
    }
  })
}

/**
 * The gates every command frame passes before it runs, from a socket or a client in this process
 * (handleCommandFrame, callCommand): the home it names adopted, the receive log, the per-Walnut
 * pushes noted, each origin's allowlist (bridge, follower, lane) and owner scope, and a stopping
 * Demo. The command to run, or null when a gate refused it and answered through `reply`.
 */
function passCommandGates(ws: ServerWebSocket<WsData>, frame: unknown, reply: (frame: DaemonFrame) => void): Record<string, unknown> | null {
  const sent = frame as Record<string, unknown>
  // Valid JSON ≠ a command frame: "null"/"42"/"\"x\"" parse fine but the
  // destructure below would THROW on null (a poison frame that predates the
  // dispatch guard — one bad client frame killed the whole daemon).
  if (!sent || typeof sent !== 'object') { reply(errorFrame(ws, null, 'invalid JSON')); return null }
  // From here on a command names its Walnut by its first home on this host (adoptCommandHome).
  const cmd = adoptCommandHome(ws, sent, reply)
  // Refused and answered (another data dir speaks as this Walnut here).
  if (!cmd) return null
  const { id } = cmd

  // Structured per-command receive log. Traces (traceId) originate at walnut
  // and propagate through the daemon → CLI spawn. Logging on receive gives us
  // the first server-side timestamp for a command, pairing with walnut's
  // `enqueue` line and the eventual `jsonl` forward.
  const traceId = typeof cmd.traceId === 'string' ? cmd.traceId : undefined
  const sid = typeof cmd.sid === 'string' ? cmd.sid : undefined
  if (cmd.cmd !== 'ping' && cmd.cmd !== 'stream.data' && cmd.cmd !== 'stream.ack') {
    // ping is high-frequency keepalive and stream frames carry bytes: tracing them is log spam
    logMsg('debug', 'cmd_recv', { cmd: cmd.cmd, id, sid, traceId })
  }
  // The Walnuts this daemon serves (served-walnuts-core.ts): a server socket's per-Walnut push.
  // A bridge push names no home also from a new server whose hello failed: only a named one counts.
  if (SERVED_PUSHES.has(cmd.cmd as string) && isServerClient(ws)) {
    const home = walnutScope.askedHome(sent) || gatewayClientHomes.get(ws) || ''
    if (home || cmd.cmd !== 'bridge.configure') servedWalnuts.note(home)
  }

  // Cloud bridge is a PUBLIC relay: restrict it to the phone-proxy command set.
  // A frame outside the allowlist on a bridge socket means the cloud box was
  // compromised and is trying to escalate to fs.write/start/etc — refuse it.
  if (ws.data?.origin === 'bridge' && !BRIDGE_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    logMsg('warn', 'bridge: rejected non-allowlisted command', { cmd: cmd.cmd, id })
    reply(errorFrame(ws, id as number, 'command not permitted over bridge: ' + cmd.cmd))
    return null
  }
  // A named bridge link reaches only its own Walnut's sessions (or one whose Walnut
  // is not recorded, as before).
  if (ws.data?.origin === 'bridge' && BRIDGE_SESSION_COMMANDS.has(cmd.cmd as string)
    && typeof cmd.sid === 'string' && !bridgeHearsSession(ws, cmd.sid)) {
    reply(errorFrame(ws, id as number, `${cmd.cmd}: a session of another Walnut`, { errorKind: 'not_owner' }))
    return null
  }
  // A follower (the host server) reads; the leader alone writes this host's state.
  if (ws.data?.origin === 'follower' && !FOLLOWER_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    logMsg('warn', 'follower: refused a command only the leader sends', { cmd: cmd.cmd, id })
    reply({ id, ok: false, error: 'only the leader sends ' + cmd.cmd, errorKind: 'follower_refused' })
    return null
  }
  // Owner scope (replica-reads-v1, follower-reads-core.ts): a follower reads its own Walnut only.
  if (ws.data?.origin === 'follower' && followerScope(ws, id as number, cmd, reply)) return null
  // A lane carries the leader's streams and nothing else.
  if (ws.data?.origin === 'lane' && !LANE_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    reply({ id, ok: false, error: 'a stream lane carries streams only, not ' + cmd.cmd, errorKind: 'lane_refused' })
    return null
  }
  // demo.quiesce itself runs outside this fence (handleCommandFrame); once it fenced, only reads and stops.
  if (cmd.cmd !== 'demo.quiesce' && !demoQuiesce.allows(cmd.cmd)) {
    reply(errorFrame(ws, id as number, 'Demo is stopping; no new work is accepted', { errorKind: 'demo_stopping' }))
    return null
  }
  return cmd
}

/**
 * Run a command that passed the gates under the drain's admission (a shutdown or handover pause
 * turns it away with a throw). An answer to a relay is not new work: it is taken while the daemon
 * pauses or drains, so a call the server finished in those seconds gets its result
 * (releaseGatewayRelays). A read of a resumable host_exec run (one that only waits; it holds no
 * update) neither holds a handover's pause nor is turned away by it: its caller reads again from
 * the next daemon.
 */
function admitCommand<T>(cmd: Record<string, unknown>, work: () => T): T {
  const free = cmd.cmd === 'gateway-result' || (cmd.cmd === 'exec.read' && hostExec.resumableJob(cmd.jobId))
  return free ? work() : daemonCommands.admit(work)
}

/** A handler's throw (or rejection) as its one error reply: logged, and named after its command. */
function handlerThrew(cmd: Record<string, unknown>, err: unknown): Answer {
  logMsg('error', 'handleCommand: handler threw — replying with error instead of dying', {
    cmd: cmd.cmd, id: cmd.id, sid: typeof cmd.sid === 'string' ? cmd.sid : undefined,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  return fail('internal daemon error handling ' + cmd.cmd + ': ' + (err instanceof Error ? err.message : String(err)))
}

/** What this daemon's hello advertises: also what its serves file records. */
/**
 * What needs the WebSocket door (its port file): walnut-net dials it, a host server and a hub
 * forward are reached through it. A runtime inside a server's process has none, so it does not
 * claim them (the server then says the host lacks them, never a silent failure).
 */
const DOOR_CAPABILITIES = new Set(['net-v1', 'net-join-v1', 'net-web-v1', 'host-server-v1', 'hub-forward-v1'])
function helloCapabilities(): string[] {
  const advertised = DOOR ? ADVERTISED_DAEMON_CAPABILITIES : ADVERTISED_DAEMON_CAPABILITIES.filter((c) => !DOOR_CAPABILITIES.has(c))
  return [...advertised, 'service-handover-v1', ...(cronRuntime ? ['cron-supervision-v1', 'service-update-v1', 'service-update-force-v1'] : []), ...(acp.hostEngines ? ['acp-host-v1'] : []), ...(socketPeerPidReady() ? [CALLER_PROOF_CAPABILITY] : [])]
}

/** This Walnut's per-Walnut pushes: an older server sends them naming no home. */
const SERVED_PUSHES = new Set(['hooks.configure', 'triggers.configure', 'bridge.configure', 'turns.configure', 'workspace.configure'])

function dispatchCommand(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  // A command answered by function (commandAnswers): its Answer is the reply frame.
  const answerFn = answerFnOf(cmd.cmd)
  if (answerFn) return answerCommand(ws, cmd, answerFn, (answer) => sendAnswer(ws, id, answer))
  switch (cmd.cmd) {
    case 'start': return daemonCommands.run(() => cmdStart(ws, id as number, cmd))
    case 'attach': return daemonCommands.run(() => cmdAttach(ws, id as number, cmd))
    case 'line.fate': return daemonCommands.run(() => cmdLineFate(ws, id as number, cmd))
    case 'send': return daemonCommands.run(() => cmdSend(ws, id as number, cmd))
    case 'sendRaw': return daemonCommands.run(() => cmdSendRaw(ws, id as number, cmd))
    case 'appendUserMarker': return cmdAppendUserMarker(ws, id as number, cmd)
    case 'stop': return daemonCommands.run(() => cmdStop(ws, id as number, cmd))
    case 'setMode': return cmdSetMode(ws, id as number, cmd)
    case 'status': return cmdStatus(ws, id as number, cmd)
    // caller-proof-v1: is a process of this host inside a session this daemon runs (approvals-v1.ts).
    case 'caller.check': return void cmdCallerCheck(ws, id as number, cmd as Record<string, unknown>)
    case 'cancelPendingStart': return cmdCancelPendingStart(ws, id as number, cmd)
    case 'getState': return cmdGetState(ws, id as number, cmd)
    case 'cron.metadata': {
      for (const [sid, session] of sessions) updateCronMetadata(sid, session)
      return sendOk(ws, id, { values: cronMetadata.list() })
    }
    case 'cron.supervision': return daemonCommands.run(() => cmdCronSupervision(ws, id, cmd))
    case 'rename': return cmdRename(ws, id as number, cmd)
    case 'read-history': return cmdReadHistory(ws, id as number, cmd)
    case 'markers.find': return cmdMarkersFind(ws, id as number, cmd)
    case 'subscribe-agent': return cmdSubscribeAgent(ws, id as number, cmd)
    case 'unsubscribe-agent': return cmdUnsubscribeAgent(ws, id as number, cmd)
    case 'write-inbox': return cmdWriteInbox(ws, id as number, cmd)
    // Task directories (task-dir-v1). NOT in BRIDGE_ALLOWED_COMMANDS: removal
    // deletes host files, which the cloud bridge may never ask for.
    case 'taskdir.ensure': return cmdTaskDirEnsure(ws, id as number, cmd)
    // Read only (cli-holder-v1): who holds a session's transcript on this host.
    case 'cli.holder': return cmdCliHolder(ws, id as number, cmd)
    case 'taskdir.list': return cmdTaskDirList(ws, id as number)
    case 'taskdir.remove': return cmdTaskDirRemove(ws, id as number, cmd)
    case 'taskdir.prune': return cmdTaskDirPrune(ws, id as number, cmd)
    case 'taskdir.pruneBuilds': return cmdTaskDirPrune(ws, id as number, cmd, true)
    case 'taskdir.sizes': return cmdTaskDirSizes(ws, id as number, cmd)
    case 'transcript.archive': return cmdTranscriptArchive(ws, id as number, cmd)
    case 'taskdir.pruneCaches': return cmdTaskDirPruneCaches(ws, id as number, cmd)
    case 'transcript.restore': return cmdTranscriptRestore(ws, id as number, cmd)
    case 'vscode.status': return codeServer.codeServerStatus().then(
      (s) => sendOk(ws, id as number, s as unknown as Record<string, unknown>),
      (err) => sendError(ws, id as number, 'vscode.status failed: ' + (err as Error).message),
    )
    // 'preflight-v1': read-only look at what this host can run (claude and the
    // node it needs, a C compiler, dtach). Not bridge-reachable: only the
    // trusted walnut socket asks.
    case 'host.preflight': return hostRuntime.preflight(cmd).then(
      (r) => sendOk(ws, id as number, r as unknown as Record<string, unknown>),
      (err) => sendError(ws, id as number, 'host.preflight failed: ' + (err as Error).message),
    )
    // 'hostfix-v1': run ONE named fix (install the native claude, gcc under
    // sudo -n, build dtach). Never a free-form command, one at a time. Not
    // bridge-reachable: only the trusted walnut socket asks. Tracked like
    // start/send (run, not just admit): a handover pause then waits for it, and
    // a shutdown drains it, instead of cutting a package install mid-dpkg.
    case 'host.fix': {
      // The fix that will run (none runs yet): a handover may skip waiting for it.
      const starts = !hostFix.running
      const work = daemonCommands.run(() => hostFix.run(cmd.action, cmd).then(
        (r) => sendOk(ws, id as number, { result: r }),
        (err) => sendError(ws, id as number, 'host.fix failed: ' + (err as Error).message),
      ))
      if (starts) hostFixWork = work
      return work
    }
    // 'oneshot-v1' (oneshot-core.ts): the hidden one-shot claude runs. NOT in
    // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: they start processes.
    case 'oneshot.run': return replyOneShot(ws, id as number, 'oneshot.run', () => oneShot.run(ws, cmd))
    case 'oneshot.prewarm': return replyOneShot(ws, id as number, 'oneshot.prewarm', () => oneShot.prewarm(cmd))
    case 'oneshot.cancel': return replyOneShot(ws, id as number, 'oneshot.cancel', () => oneShot.cancel(cmd))
    case 'usage.budget.get': return cmdUsageBudget(ws, id as number, cmd, false)
    case 'usage.budget.configure': return cmdUsageBudget(ws, id as number, cmd, true)
    case 'usage.budget.list': return cmdUsageBudgetList(ws, id as number, cmd)
    case 'list': return cmdList(ws, id as number)
    case 'bridge.configure': return cmdBridgeConfigure(ws, id as number, cmd)
    // walnut-trigger ('triggers-v1'). NOT in BRIDGE_ALLOWED_COMMANDS: a check is
    // an arbitrary shell command on this host, and a fire carries host data — the
    // whole family belongs to the trusted SSH-tunneled walnut socket only.
    case 'triggers.configure': return daemonCommands.run(() => triggerSet.cmdTriggersConfigure(ws, id as number, cmd))
    case 'bridgeResume': return daemonCommands.run(() => cmdBridgeResume(ws, id as number, cmd))
    case 'stt': return cmdSttRelay(ws, id as number, cmd)
    case 'stt-result': return cmdSttResult(ws, id as number, cmd)
    case 'session.launch': return cmdLaunchRelay(ws, id as number, cmd)
    case 'launch-result': return cmdLaunchResult(ws, id as number, cmd)
    case 'session.control': return cmdControlRelay(ws, id as number, cmd)
    case 'session.permission': return daemonCommands.run(() => cmdSessionPermission(ws, id as number, cmd))
    case 'control-result': return cmdControlResult(ws, id as number, cmd)
    case 'session.message': return cmdMessageRelay(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: only the trusted SSH-tunneled walnut
    // client may answer message relays (same rule as control-result).
    case 'message-result': return cmdMessageResult(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: reverse direction — the trusted walnut
    // server pushes slim mobile feed events DOWN, the daemon relays them to
    // the cloud bridge (see cmdMobileEvent).
    case 'feature.request': {
      // Over the link of the asking server's own Walnut only.
      const home = isServerClient(ws) ? gatewayClientHomes.get(ws) : undefined
      const link = home ? bridgeLinkFor(home) : null
      if (!home || !link || link.config?.hostAlias !== '__local__' || link.config.home !== home) return sendError(ws, id, 'Feature request refused')
      return featureRelay.request(featureSocket(ws), id, link.adapter ? featureSocket(link.adapter) : null, cmd.frame,
        () => isServerClient(ws) && gatewayClientHomes.get(ws) === home && bridgeLinkFor(home) === link && link.config?.home === home)
    }
    case 'feature.result': {
      if (!bridgeLinkOf(ws)) return sendError(ws, id, 'Feature result refused')
      const accepted = featureRelay.result(featureSocket(ws), cmd.requestId, cmd.result)
      return sendOk(ws, id, { accepted })
    }
    case 'mobile-event': return cmdMobileEvent(ws, id as number, cmd)
    // A relay is answered by whom it went to (see the gateway section).
    case 'gateway-result': return cmdGatewayResult(ws, id as number, cmd)
    // Leader book ('leader-epoch-v1'): configure from the trusted primary only;
    // claim / witness from either side, deliver from the bridge only, each
    // checked in its handler.
    case 'leader.configure': return cmdLeaderConfigure(ws, id as number, cmd)
    // A server on this host that follows the leader ('follower-v1') and the
    // server the daemon keeps running for the leader ('host-server-v1'). NOT in
    // BRIDGE_ALLOWED_COMMANDS.
    case 'follower.hello': return cmdFollowerHello(ws, id as number, cmd)
    case 'follower.status': return cmdFollowerStatus(ws, id as number)
    case 'follower.report': return cmdFollowerReport(ws, cmd)
    case 'follower.sessions': return cmdFollowerSessions(ws, id as number)
    case 'follower.slice': return cmdFollowerSlice(ws, id as number)
    case 'follower.send': return daemonCommands.run(() => cmdFollowerSend(ws, id as number, cmd))
    case 'follower.permission': return daemonCommands.run(() => cmdFollowerPermission(ws, id as number, cmd))
    case 'follower.op': return daemonCommands.run(() => cmdFollowerOp(ws, id as number, cmd))
    case 'follower.peer': return daemonCommands.run(() => cmdFollowerPeer(ws, id as number, cmd))
    case 'follower.pending': return cmdFollowerPending(ws, id as number, cmd)
    // The follower's trigger_list and trigger_test ('follower-triggers-v1').
    case 'follower.triggers': return cmdFollowerTriggers(ws, id as number, cmd)
    case 'follower.trigger.test': return cmdFollowerTriggerTest(ws, id as number, cmd)
    // Not serialized: a call may wait minutes (its waitMs), as a socket line does.
    case 'follower.gateway': return cmdFollowerGateway(ws, id as number, cmd)
    case 'follower.trigger.deliver': return daemonCommands.run(() => cmdFollowerTriggerDeliver(ws, id as number, cmd))
    // A new ask while the Mac is away ('replica-start-v1', WP12).
    case 'follower.start': return daemonCommands.run(() => cmdFollowerStart(ws, id as number, cmd))
    case 'leader.spawnTemplate': return cmdLeaderSpawnTemplate(ws, id as number, cmd)
    // Streams between servers through this daemon ('stream-relay-v1',
    // stream-relay-core.ts): frames, never answered by id.
    case 'stream.open': return cmdStreamOpen(ws, cmd)
    case 'stream.lane': return cmdStreamLane(ws, id as number, cmd)
    case 'client.role': return cmdClientRole(ws, id as number, cmd)
    case 'stream.accept': case 'stream.data': case 'stream.ack': case 'stream.end': case 'stream.close':
    // A terminal's new size ('pty-stream-v1'): a frame of a stream on this socket, like the rest.
    case 'stream.resize':
      return streamRelay.frame(ws, (cmd.cmd as string).slice('stream.'.length), cmd)
    case 'server.configure': return cmdServerConfigure(ws, id as number, cmd)
    case 'server.status': return cmdServerStatus(ws, id as number, cmd)
    // Plugin jobs ('plugin-jobs-v1', plugin-jobs-core.ts).
    case 'jobs.configure': return cmdJobsConfigure(ws, id as number, cmd)
    case 'jobs.status': return cmdJobsStatus(ws, id as number, cmd)
    case 'jobs.logs': return cmdJobsLogs(ws, id as number, cmd)
    case 'jobs.http': return cmdJobsHttp(ws, id as number, cmd)
    case 'leader.claim': return cmdLeaderClaim(ws, id as number, cmd)
    case 'leader.witness': return cmdLeaderWitness(ws, id as number)
    case 'leader.deliver': return daemonCommands.run(() => cmdLeaderDeliver(ws, id as number, cmd))
    case 'leader.settings': return daemonCommands.run(() => cmdLeaderSettings(ws, id as number, cmd))
    case 'leader.control': return daemonCommands.run(() => cmdLeaderControl(ws, id as number, cmd))
    // Offline host ('offline-host-v1', docs/plan/daemon-first-hosts.md). NOT in
    // BRIDGE_ALLOWED_COMMANDS: a Walnut's copy and journal belong to that
    // Walnut's trusted SSH-tunneled server only.
    case 'host.slice': return cmdHostSlice(ws, id as number, cmd)
    case 'offline.drain': return cmdOfflineDrain(ws, id as number, cmd)
    case 'offline.ack': return cmdOfflineAck(ws, id as number, cmd)
    case 'offline.blob': return cmdOfflineBlob(ws, id as number, cmd)
    // The host's copy ('host-replica-v1'): NOT in BRIDGE_ALLOWED_COMMANDS either.
    case 'replica.sync': return cmdReplica(ws, id as number, 'sync', cmd)
    case 'replica.put': return cmdReplica(ws, id as number, 'put', cmd)
    case 'replica.drop': return cmdReplica(ws, id as number, 'drop', cmd)
    case 'replica.status': return cmdReplica(ws, id as number, 'status', cmd)
    // The host's copy of the notes' pictures ('attachment-copy-v1'): NOT in BRIDGE_ALLOWED_COMMANDS either.
    case 'attachments.sync':
    case 'attachments.put':
    case 'attachments.drop':
    case 'attachments.status': return cmdAttachments(ws, id as number, cmd)
    case 'acpModelCatalog': {
      if (typeof cmd.binary !== 'string' || !path.isAbsolute(cmd.binary)) return sendError(ws, id as number, 'acpModelCatalog: missing absolute binary')
      return acp.modelCatalog(cmd.binary, { cwd: cmd.cwd as string | undefined, env: cmd.env as Record<string, string> | undefined })
        .then((result) => sendOk(ws, id as number, result), (error) => sendError(ws, id as number, error.message))
    }
    case 'acpHostEngines': {
      if (!acp.hostEngines) return sendError(ws, id as number, 'acpHostEngines: this daemon has no ACP engine files')
      if (!Array.isArray(cmd.specs)) return sendError(ws, id as number, 'acpHostEngines: missing specs')
      return acp.hostEngines(cmd.specs)
        .then((engines) => sendOk(ws, id as number, { engines }), (error) => sendError(ws, id as number, error.message))
    }
    // 'engine-sign-in-v1' (acp-engine-sign-in.ts): sign an engine's CLI in on this host, or
    // install it; only Walnut's own fixed argv runs. NOT bridge- or follower-reachable: only the
    // trusted walnut socket asks.
    case 'engine.signIn': return acp.engineSignIn.handle(cmd)
      .then((result) => sendOk(ws, id as number, { result }), (error) => sendError(ws, id as number, 'engine.signIn failed: ' + (error as Error).message))
    case 'acpStart': return cmdAcpStart(ws, id as number, cmd)
    case 'acpSend': return cmdAcpOp(ws, id as number, cmd, 'prompt')
    case 'acpSteer': return cmdAcpOp(ws, id as number, cmd, 'steer')
    case 'acpCancel': return cmdAcpOp(ws, id as number, cmd, 'cancel')
    case 'acpRespond': return cmdAcpOp(ws, id as number, cmd, 'permissionResponse')
    case 'acpSetConfigOption': return cmdAcpOp(ws, id as number, cmd, 'setConfigOption')
    case 'acpState': return cmdAcpOp(ws, id as number, cmd, 'getState')
    case 'acpNewSession': return cmdAcpOp(ws, id as number, cmd, 'newSession')
    case 'acpStop': return cmdAcpStop(ws, id as number, cmd)
    case 'acpSubscribe': return cmdAcpSubscribe(ws, id as number, cmd)
    // Unified agent.* family (agent-commands-v1): one namespace, engine-routed
    // onto the legacy per-engine handlers. See src/providers/agent-command-map.ts.
    // SECURITY: the re-dispatch below bypasses the bridge allowlist check (it
    // runs BEFORE dispatch), so no 'agent.*' name may ever join
    // BRIDGE_ALLOWED_COMMANDS — that would hand the cloud box every routed
    // target, including start (arbitrary-argv spawn). Pinned by test.
    case 'agent.start': case 'agent.send': case 'agent.steer': case 'agent.cancel':
    case 'agent.respond': case 'agent.setOption': case 'agent.state':
    case 'agent.newSession': case 'agent.stop': case 'agent.subscribe': {
      const route = resolveAgentCommand(cmd.engine, String(cmd.cmd).slice('agent.'.length))
      if (!route.ok) {
        logMsg('error', 'command error', { id, error: route.error, errorKind: route.errorKind })
        sendFrame(ws, { id, ok: false, error: route.error, errorKind: route.errorKind })
        return
      }
      return dispatchCommand(ws, id as number, { ...cmd, cmd: route.cmd })
    }
    case 'ping':
      // From the replica, a ping answers one of our bridge-ping markers: it
      // confirms every byte written before that marker (bridge-uplink-core.ts).
      if (ws.data?.origin === 'bridge') bridgeLinkOf(ws)?.uplink?.ack(cmd.ackSeq)
      return sendOk(ws, id as number, { pong: true })
    case 'bridge.peer': return cmdBridgePeer(ws, id as number, cmd)
    case 'bridge.status': return cmdBridgeStatus(ws, id as number, cmd)
    case 'service.handover': case 'service.update': return daemonCommands.run(() => cmdServiceHandover(ws, id, cmd))
    case 'hello': {
      // Load the parser thread without reading any transcript before a cold click.
      void historyReadyExecutor.warm()
      // A server names its run: a relay goes again only to the run it went to (gatewayRelaysSocketGone).
      // ...or to any run of a server that names its op read-only (helloReadOps). A hello
      // that names no run (a diagnostic probe on the same socket) changes neither.
      if (typeof cmd.run === 'string' && cmd.run && ws.data) {
        ws.data.serverRun = cmd.run.slice(0, 80)
        ws.data.readOps = helloReadOps(cmd.readOps)
        // A server that says it binds (gateway-binds-v1) is nobody's target until it does, for a moment.
        ws.data.helloAt = cmd.binds === true ? Date.now() : undefined
        // Its grace ends: a call held back from it (gatewayCandidates) looks again.
        if (cmd.binds === true && !gatewayClientHomes.has(ws) && isServerClient(ws)) setTimeout(wakeGatewayCalls, GATEWAY_BIND_GRACE_MS + 50)
        // A socket bound before it named its run: every socket of that run speaks for its Walnut.
        const bound = gatewayClientHomes.get(ws)
        if (bound && isServerClient(ws)) gatewayIdentity.noteRun(ws.data.serverRun, bound)
      }
      sendOk(ws, id as number, {
      version: DAEMON_VERSION,
      capabilities: helloCapabilities(),
      // The Walnuts this daemon served lately (served-walnuts-core.ts).
      served: { twin: 'binary', walnuts: servedWalnuts.recent(), pty: true },
      cronSupervision: { managed: !!cronRuntime, startup: SERVICE_MODE ? 'service' : 'on-demand' },
      instanceId: DAEMON_INSTANCE_ID,
      // A daemon program, or a host's one Walnut service holding the runtime always 'daemon').
      serves: RUNS_AS,
      // Whose follower the service is: only that Walnut's leader switches it back (one-service-mode.ts).
      ...(RUNS_AS === 'walnut-serve' && options.selfHome ? { serviceHome: options.selfHome } : {}),
      ...(SERVICE_MODE ? { serviceExecutable: process.execPath } : {}),
      // A host's own service set beside another Walnut's (service-set.ts): its leader reads the set's files, never the default's.
      ...(SET_ID ? { serviceSet: SET_ID } : {}),
      ...(launcherFactsNow() ? { launcher: launcherFactsNow() } : {}),
      // The roles this program can take as a host's one Walnut service (service-roles.ts). The template twin says none.
      serviceRoles: programServiceRoles(singleFile() !== null),
      startedAt: DAEMON_START_TS,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      runtime: DAEMON_RUNTIME,
      // What this machine calls itself: a URL that names it (a session's dev server) is a service
      // here, reached on this loopback (session-service-preview.ts).
      hostname: os.hostname(),
      // Its system: a leader offers the one Walnut service only where the one table lets it (one-service-targets.ts).
      platform: process.platform,
      // This machine's stable id: the server joins its aliases by it (daemon-twins.ts).
      ...(DAEMON_MACHINE_ID ? { machineId: DAEMON_MACHINE_ID } : {}),
      taskDirRoot: TASK_DIR_ROOT,
      // Which Walnut this daemon is: its dir, and a test server's key when it is that
      // server's isolated daemon (the server's remote-isolation.ts checks both).
      dir: DAEMON_DIR,
      ...(ISOLATED_FOR ? { isolatedFor: ISOLATED_FOR } : {}),
      // host_exec runs a stop would end: every update path waits for them (exec-runs-hold.ts).
      execRunning: hostExec.running(),
      // Of those, the ones an update waits for: a resumable run does not hold it. An older server
      // reads `execHolding` and puts a daemon here that cannot follow a detached run, so for it the
      // detached runs count too; a server that knows them reads `execHoldsUpdate` (local-daemon.ts).
      execHolding: hostExec.holdingForOlder(),
      execHoldsUpdate: hostExec.holding(),
      })
      // A server is here: the calls waiting for one go now.
      if (isServerClient(ws)) setTimeout(wakeGatewayCalls, 0)
      return
    }
    case 'logs.tail': return cmdLogsTail(ws, id as number, cmd)
    default: return sendError(ws, id as number, 'unknown command: ' + cmd.cmd)
  }
}

// The line a resumable host_exec run's log ends with when this daemon stops (stopDaemon;
const RESUMABLE_RUN_ENDED = 'the daemon on this host stopped (an update or a restart); this run was marked resumable, so run it again to go on waiting.'
// The host_exec work a handover waits for: every run but a resumable one (it only waits, and its caller runs it again), and plugin scripts.
const execHolds = (): number => hostExec.holding() + (hostExec.scripts?.() ?? 0)

async function cmdServiceHandover(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const updating = cmd.cmd === 'service.update'
  if (updating !== SERVICE_MODE || !requestDaemonShutdown || typeof cmd.stateDir !== 'string' || cmd.instanceId !== DAEMON_INSTANCE_ID) {
    return sendError(ws, id, 'service.handover: daemon mode or instance does not match the requested operation')
  }
  // force: an update overdue for hours (daemon-update-behind.ts) goes over this daemon's own
  // work instead of refusing. The CLI sends it only after plain asks were refused for 30 s
  // (daemon-over-busy.ts), so a run about to end or a relay of a second has ended on its own.
  // The shutdown answers the gateway's relays and waiting calls (they ask the next daemon) and
  // ends the ACP workers, the host_exec runs and the requests still open, as a plain daemon
  // restart does. Session commands and file writes are drained either way; live CLI sessions
  // are handed over.
  const force = updating && cmd.force === true
  const relaying = [sttRelayPending, launchRelayPending, controlRelayPending, messageRelayPending, gatewayRelayPending, gatewayWaiting].some((pending) => pending.size)
  const busyWith = [
    acp.workers.size ? `${acp.workers.size} ACP worker(s)` : '',
    relaying ? 'relay requests' : '',
    hostExec.running() ? `${hostExec.running()} host_exec run(s)` : '',
    hostExec.scripts?.() ? `${hostExec.scripts()} plugin script(s)` : '',
  ].filter(Boolean)
  if (force && busyWith.length) logMsg('warn', 'service.update: forced, going over its own work', { busyWith })
  // A surviving ACP worker (acp-survive-v1) outlives this daemon: only one on pipes holds the swap.
  if (!force && (acp.holdingWorkers() || relaying)) {
    return sendError(ws, id, 'service.handover: active ACP workers or relay requests must finish first')
  }
  // A host_exec run shares this daemon's pipes and ends with it (each ends by its own deadline).
  if (!force && execHolds()) return sendError(ws, id, 'service.handover: running host_exec jobs must finish first')
  if (process.platform !== 'linux' && process.platform !== 'darwin') return sendError(ws, id, 'service.handover: unsupported platform')
  // Pause before the first await so the handover RPC does not count itself in the wait set.
  // A Claude Code install in flight (up to 45 minutes) is not waited for: the shutdown
  // after a committed handover stops it (stopDaemon), its download kept for the next
  // Install, and a handover that fails leaves it running. A gcc install is waited for.
  const pause = daemonCommands.pause(hostFix.cancellable ? hostFixWork : undefined, { force })
  // Paused, the gateway turns calls away as stopping: the mark tells them to wait for the next daemon.
  noteRestarting()
  let recovery: ReturnType<NonNullable<typeof cronRuntime>['pause']> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    recovery = updating ? cronRuntime?.pause() : undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Service preparation timed out; existing work is still running, retry after it finishes')), 15_000)
    })
    const drained = await Promise.race([Promise.allSettled([pause.drained, recovery?.drained]), deadline])
    const failed = drained.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  } catch (error) {
    recovery?.resume()
    pause.resume()
    clearRestartMark()
    throw error
  } finally { clearTimeout(timer) }
  // Drained, the swap goes ahead: each run it ends says why in its own log (the resumable ones: stopDaemon).
  if (force && (hostExec.running() || hostExec.scripts?.())) hostExec.endForUpdate?.('the daemon on this host is being replaced by an update that had waited hours for its work to end, and this run was stopped with it. Run it again if it is still needed.')
  // What runs detached is adopted by the next daemon, unless the one asking for this daemon's place
  // cannot (an older version: a rollback, its request names no `adopts`): it ends, saying why, once
  // this daemon is surely going (never on a prepare that fails and leaves it serving).
  const adopts = new Set(Array.isArray(cmd.adopts) ? cmd.adopts.filter((c): c is string => typeof c === 'string') : [])
  // Never throws: the reply and the shutdown after it always follow.
  const endUnadopted = async () => {
    try {
      if (!adopts.has('host-exec-detach-v1')) hostExec.endForRollback()
      if (!adopts.has('acp-survive-v1')) await acp.endForRollback()
    } catch (err) { logMsg('warn', 'rollback stop of detached work failed', { error: String(err) }) }
  }
  const location = { stateDir: cmd.stateDir, uid: os.userInfo().uid, instanceId: DAEMON_INSTANCE_ID }
  if (updating) serviceUpdateRequested = true
  try {
    if (updating) await cronRuntime?.close()
    await persistRegistryDurable(true)
    if (!updating) await prepareDaemonServiceHandover({
      ...location, home: HOME_DIR, platform: process.platform,
      pid: process.pid, startTime: await readStartTimeAsync(process.pid), entries: readRegistry(), registryFile: REGISTRY_FILE, hooks: handoverHooks(),
      childProcess: childUse,
    })
  } catch (error) {
    if (updating) {
      handoverPrepared = true
      await endUnadopted()
      try { sendError(ws, id, String(error), { updateStarted: true, instanceId: DAEMON_INSTANCE_ID }) }
      finally { await waitForHandoverReceipt(ws); requestDaemonShutdown() }
      return
    }
    if ((error as NodeJS.ErrnoException).code === 'handover-published') {
      handoverPrepared = true
      await endUnadopted()
      requestDaemonShutdown()
    } else { pause.resume(); clearRestartMark() }
    throw error
  }
  handoverPrepared = true
  await endUnadopted()
  try { sendOk(ws, id, { prepared: true, instanceId: DAEMON_INSTANCE_ID }) }
  finally { await waitForHandoverReceipt(ws); requestDaemonShutdown() }
}

async function waitForHandoverReceipt(ws: ServerWebSocket<WsData>): Promise<void> {
  // Close the connection only after the dedicated client confirms receipt, so exiting cannot drop a reply that has not been sent yet.
  const deadline = Date.now() + 1500
  while (ws.readyState === 1 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

// ── Resume records, argv files, one CLI per session id, a session's Walnut (daemon-session-owner.ts) ──
const sessionOwner = createDaemonSessionOwner({ daemonEnv, HOME_DIR, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, STREAMS_DIR, SPAWN_JOURNAL,
  DAEMON_INSTANCE_ID, execFile, readStartTime, killProcessGroup, sessions, journaledIds, forgetJournaledSids,
  journaledHome, journaledHomes, journaledWalnuts, walnutOfHome, servedWalnutOf, walnutScope,
  // Made further down (the offline host), so asked on use.
  offlineHost: { ownerOf: (sid) => offlineHost.ownerOf(sid) }, setTimeout, logMsg })
const { RESUME_RECORD_DIR, hostResume, cliArgvFiles, cliOwner, strictStartRefusal, waitForStoppedProcess, spawnRecordOf, sessionHomeOf, sessionStartHomeOf, lastSpawnHomeOf, servedStopRefusal } = sessionOwner

// ── The usage budget of the sessions here (daemon-usage-budget.ts) ──
// What is defined further down in the body is asked on use.
const usageBudgets = createDaemonUsageBudget({ daemonEnv, HOME_DIR, SERVICE_MODE, RESUME_RECORD_DIR, execFile, childUse, ensureUsageBudgetDirectory, sessions, acp, core,
  cronRuntime: () => cronRuntime, daemonBootId: () => daemonBootId, sessionStopVersions, BG_TERMINAL_STATUSES, isJournalSid, journaledIds, journaledHome,
  isProcessGroupAlive, killProcessGroup, readStartTimeAsync, persistRegistry, reapSession,
  cancelTurnRetry: (sid, reason) => cancelTurnRetry(sid, reason),
  stopOwnerRefusal: (sid, cmd) => stopOwnerRefusal(sid, cmd),
  stopSessionProcess: (ws, id, sid) => stopSessionProcess(ws, id, sid),
  refuseForeignHome: (ws, id, cmd, what) => refuseForeignHome(ws, id, cmd, what),
  isServerClient, setTimeout, logMsg, sendOk, sendError })
const { budgetStopGroups, budgetStopsReady, budgetControl, usageBudget, budgetAllowance, budgetGate, budgetRefusal, requireBudgetAllowance, cmdUsageBudget, cmdUsageBudgetList } = usageBudgets

// ── Host resume for a trigger fire, and the bridge-safe resume (daemon-session-resume.ts) ──
// What is defined further down in the body is asked on use.
const sessionResume = createDaemonSessionResume({ daemonEnv, STREAMS_DIR, sessions, core, hostResume, cronRuntime: () => cronRuntime, sessionStartGate, sessionStopVersions,
  isJournalSid, livedHere, journaledHome, walnutOfHome, spawnRecordOf, fireLineUuid,
  startSessionProcess: (cmd, isCurrent, canStart) => startSessionProcess(cmd, isCurrent, canStart),
  cmdStart: (ws, id, cmd) => cmdStart(ws, id, cmd),
  cmdSend: (ws, id, cmd) => cmdSend(ws, id, cmd),
  bridgeHearsSession: (ws, sid) => bridgeHearsSession(ws, sid), logMsg, sendError })
const { resumeForTrigger, cmdBridgeResume } = sessionResume

// ── Agent gateway: on-host unix socket → Mac hub relay ──
// A `walnut` CLI writes one NDJSON request line to ${DAEMON_DIR}/agent-gateway.sock
// (env-injected inside a Walnut-spawned session; the same path found by
// wellKnownGatewaySocketPath() when `walnut` runs with no env, which is how a
// hand-started agent reaches Walnut); the daemon resolves the caller's
// CURRENT sid (env sid is only a lookup key — fresh spawns use a tmp sid that
// cmdRename re-keys) and relays the request to the Mac hub with the same
// reverse-RPC shape as cmdLaunchRelay/cmdLaunchResult: relayId + pending map +
// `gateway-request` event answered by a `gateway-result` command. Shared pure
// logic (parse/validate/alias resolution) lives in gateway-core.ts.
//section (hand-inlined there).
// GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR and GATEWAY_SHIM_PATH are defined right after demoQuiesce.

// oldSid → newSid, maintained by cmdRename. resolveCallerSid follows the
// chain (max 5 hops) to map a CLI's spawn-time WALNUT_SESSION_ID to the sid
// the daemon currently tracks.
const gatewaySidAliases = new Map<string, string>()

let gatewayRelayCounter = 0
/**
 * A relay to the primary, kept so it can go again (2026-11-03: a deploy and an SSH
 * link that broke six times in eight minutes failed every call on clouddev, each
 * after waiting 20 s, because a reply lost with its socket was never asked for again).
 */
type GatewayRelayCall = {
  home: string | undefined; capability: string; callerSid: string; payload: Record<string, unknown>
  readable: boolean
  /** When the caller stops listening (its `waitMs`, else the legacy budget). */
  deadline: number
  /** The socket the last attempt went out on (null once it closed), and the server run of the first. */
  sentOn: ServerWebSocket<WsData> | null
  run?: string
  attempts: number
  /** The server it last went to names its op read-only (serverReadsOp): it may be sent again after a stop. */
  readOnly?: boolean
  /** When its last attempt went out (readFallsToService: was the leader heard since?). */
  sentAt?: number
  /** How many times this call was asked again after a busy refusal (busyAskAgain). */
  busyAgain?: number
  /** Its Walnut identifies itself here (walnutPinned): only a socket of that Walnut answers it. */
  pinned?: boolean
  /** The plugin job that made it (pluginJobs.callerOfRun), named on every attempt as the follower hears it. */
  caller?: GatewayCaller
}
const gatewayRelayPending = new Map<number, {
  respond: (resp: GatewayResponse) => void; timer: ReturnType<typeof setTimeout> | undefined
  /** Sent to the cloud bridge (the companion leads): only the bridge may answer it. */
  via?: 'bridge'
  /** The link it went out on: another Walnut's link may not answer it. */
  bridge?: ServerWebSocket<WsData>
  /** A relay to the primary (relayToPrimary); absent for the bridge's. */
  call?: GatewayRelayCall
}>()

/** A gateway caller's answer function, and whether its socket closed (startGatewayListener). */
const gatewayCallerLeft = new WeakMap<(resp: GatewayResponse) => void, () => boolean>()

function gatewayError(code: GatewayErrorCode, message: string, detail?: unknown): GatewayResponse {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } }
}

// ── Offline host: answers a Walnut's sessions while that Walnut is away ──
// (offline-host-core.ts; docs/plan/daemon-first-hosts.md). The server pushes a
// read copy per home (`host.slice`, which also tags its socket with that home),
// and drains the journal on reconnect (`offline.drain` / `offline.ack`).

/** Trusted socket → the Walnut data dir it pushed a copy for. */
const gatewayClientHomes = new WeakMap<ServerWebSocket<WsData>, string>()
/**
 * Which Walnut each server socket speaks for, its bulk channel's included (one server
 * run binds them all), and where a session's call may go (gateway-identity-core.ts).
 */
const gatewayIdentity = createGatewayIdentity()
/** The op catalogs this host was sent, per Walnut, by hash (held-catalogs-core.ts, tools-list-held-v1). */
const heldCatalogs = createHeldCatalogs()
function bindGatewayClientHome(ws: ServerWebSocket<WsData>, home: string): void {
  const fresh = gatewayClientHomes.get(ws) !== home
  if (fresh) featureRelay.disconnect(featureSocket(ws))
  gatewayClientHomes.set(ws, home)
  if (isServerClient(ws)) {
    servedWalnuts.note(home)
    gatewayIdentity.noteRun(ws.data?.serverRun, home)
  }
  // This Walnut's primary is here: its calls waiting for one go now.
  if (fresh) setTimeout(wakeGatewayCalls, 0)
  // And a hub forward waiting for a primary link listens now (hub-forward-v1).
  if (fresh) setTimeout(hubLinksChanged, 0)
}
/** Where the Walnut a socket speaks for lives now (a path on disk, not its key): its server's own home. */
function boundLocationOf(ws: ServerWebSocket<WsData>): string | null {
  const bound = gatewayClientHomes.get(ws)
  return bound ? walnutScope.whereNow(bound) : null
}
/**
 * A command that names another Walnut than the one its socket speaks for is refused:
 * one Walnut's server never reads, writes or acks another's copy, journal or lead on a
 * shared host (walnut-scope-core.ts). An unbound socket (the bulk channel, an older
 * server before it binds) may name any.
 */
function refuseForeignHome(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, what: string): boolean {
  const refusal = foreignHomeRefusal(ws, cmd, what)
  if (refusal) sendAnswer(ws, id, refusal)
  return !!refusal
}

/** The refusal of a command that names another Walnut than the one its socket speaks for, or null. */
function foreignHomeRefusal(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>, what: string): Answer | null {
  if (!walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return null
  logMsg('warn', 'refused: the command names another Walnut than its socket', { what, walnut: walnutScope.label(walnutScope.askedHome(cmd)) })
  return fail(`${what}: this socket speaks for another Walnut`, { errorKind: 'not_owner' })
}

// This host's copy of each Walnut's notes, memory and skills (host-replica-core.ts),
// pushed by the primary with replica.sync / replica.put, removed with replica.drop.
// Kept across reboots (unlike /tmp), in the trigger state's home. WALNUT_REPLICA_DIR
// is for TESTS ONLY.
const REPLICA_DIR = SERVICE_MODE && DAEMON_STATE_DIR
  ? path.join(DAEMON_STATE_DIR, 'host-replica')
  : daemonEnv.WALNUT_REPLICA_DIR || (IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-replica') : path.join(DAEMON_DIR, 'host-replica'))
const hostReplica = createHostReplica({
  fs, path,
  dir: REPLICA_DIR,
  now: () => Date.now(),
  keyOf: walnutScope.keyOf,
  hash: (body) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
  log: (level, msg, data) => logMsg(level, msg, data),
})
// Beside it, each Walnut's copy of the pictures and files in its notes ('attachment-copy-v1',
// attachment-copy-core.ts, the core the cloud companion keeps its copy with):
// <REPLICA_DIR>/<home key>/attachments/.
const attachmentCopy = createAttachmentCopy({
  fs, path, crypto,
  dirOf: (home) => path.join(REPLICA_DIR, walnutScope.keyOf(home), 'attachments'),
  log: (level, msg, data) => logMsg(level, msg, data),
})

// ── Journal v2 (offline-journal-core.ts; docs/plan/walnut-replica-servers-impl.md
// section 5 Location): records that exist nowhere else get ONE place per host, whatever
// mode the daemon runs in. The host's own daemon (the prod dir, where the service runs too,
// or its home fallback) keeps journals, slices and the leader book in ~/.open-walnut/tmp
// (the trigger state's home, kept across reboots); an isolated daemon keeps them in its
// DAEMON_DIR, even in service mode (a test's --service daemon on a temp dir must never read
// or rename the real /tmp/open-walnut journal). So no v2 record ever moves between dirs.
// WALNUT_JOURNAL_DIR is for TESTS ONLY and is refused on the prod dir. Every boot moves the
// v1 journals an older daemon left (in its DAEMON_DIR, and for the prod dir's daemon also in
// the home fallback) into v2.
const JOURNAL_PROD_STATE_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp')
const JOURNAL_HOST_DAEMON = IS_PROD_DAEMON_DIR
const JOURNAL_TEST_DIR = !KEEPS_SESSIONS ? daemonEnv.WALNUT_JOURNAL_DIR : undefined
// A set's journal lives in its install root: ~/.open-walnut/tmp is the default set's, and its runtime dir may be /tmp.
const JOURNAL_ROOT = JOURNAL_TEST_DIR || (JOURNAL_HOST_DAEMON ? JOURNAL_PROD_STATE_DIR : (SET_ID && DAEMON_STATE_DIR) || DAEMON_DIR)
const OFFLINE_HOST_DIR = path.join(JOURNAL_ROOT, 'offline-host')
const LEADER_BOOK_DIR = path.join(JOURNAL_ROOT, 'leader')
// Which homes name a Walnut kept here under another home (walnut-scope-core.ts declared moves).
// Beside the leader book, whose records the aliases follow; an older daemon never reads it.
const HOME_ALIASES_FILE = path.join(LEADER_BOOK_DIR, 'homes.json')
/**
 * Where a v1 daemon (1fe1fd194 and older) kept its journal and leader book: its own
 * DAEMON_DIR, always. The daemon on the prod dir (/tmp/open-walnut, the service's runtime
 * dir too) also reads the home fallback, which a v1 daemon used while the server picked it.
 * The home fallback daemon NEVER reads /tmp/open-walnut: the server picks the fallback when
 * that dir is another user's or a symlink (remote-daemon-dir.ts), so whatever sits there
 * is not this user's. An isolated daemon (any other DAEMON_DIR, service mode or not, the
 * test knob or not) reads only its own dir. Read for v1 files, slices and leader records
 * only, each of them this user's own (the core checks), never written but for the
 * `.migrated` rename.
 */
const JOURNAL_ON_PROD_DIR = path.resolve(DAEMON_DIR) === path.resolve(PROD_DAEMON_DIR)
const JOURNAL_LEGACY_ROOTS = [DAEMON_DIR, ...(JOURNAL_ON_PROD_DIR ? [FALLBACK_DAEMON_DIR] : [])]
  .filter((d, i, all) => all.findIndex((x) => path.resolve(x) === path.resolve(d)) === i)
const LEGACY_JOURNAL_DIRS = JOURNAL_LEGACY_ROOTS.map((d) => path.join(d, 'offline-host'))
  .filter((d) => path.resolve(d) !== path.resolve(OFFLINE_HOST_DIR))
const LEGACY_LEADER_DIRS = JOURNAL_LEGACY_ROOTS.map((d) => path.join(d, 'leader'))
  .filter((d) => path.resolve(d) !== path.resolve(LEADER_BOOK_DIR))

/** Whether daemon.pid names this process or none (a zombie predecessor refuses journal writes, and its stop reaps none of a successor's sessions). */
function ownsDaemonDir(): boolean {
  try {
    const owner = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    return !(owner > 0) || owner === process.pid
  } catch {
    return true
  }
}

/**
 * Pending records per Walnut before a write is refused (offline-host-core.ts OFFLINE_MAX_RECORDS).
 * Tests only (never in the real daemon dir) may lower it.
 */
const OFFLINE_JOURNAL_MAX = !KEEPS_SESSIONS && /^[1-9][0-9]{0,6}$/.test(daemonEnv.WALNUT_TEST_OFFLINE_MAX_RECORDS ?? '')
  ? Number(daemonEnv.WALNUT_TEST_OFFLINE_MAX_RECORDS) : OFFLINE_MAX_RECORDS

/**
 * trigger-resume-once: the one line uuid of a message delivered under one id on every try (a
 * trigger fire), whether it goes into a live CLI or starts a stopped one (line-fate-core.ts
 * lineUuidOf).
 */
function fireLineUuid(messageId: string): string {
  return lineUuidOf(crypto.createHash('sha256').update('walnut-line:' + messageId).digest('hex'))
}

// A host delivery is a send outside the command drain: a Demo admits it (quiesce waits for it) and refuses it once fenced, also after it queued at the gate.
function deliverFromOfflineHost(sid: string, text: string, messageId: string, o: { resend?: boolean } = {}): Promise<{ ok: true; noticeLeftOut?: true } | { ok: false; reason: string }> {
  if (demoQuiesce.fenced) return Promise.resolve({ ok: false as const, reason: 'demo_stopping' })
  const work = () => sessionStartGate.run(sid, async () => {
    if (demoQuiesce.fenced) return { ok: false as const, reason: 'demo_stopping' }
    cancelTurnRetry(sid, 'superseded-by-send')
    // A resend (a trigger fire again) writes nothing when the line record says it went (send-dedupe-v1),
    // and goes under the fire's own uuid, the one a host resume gives it too (trigger-resume-once).
    const uuid = o.resend === true ? fireLineUuid(messageId) : undefined
    const r = await core.handleSendCommand(sid, text, uuid, [{ message: text, messageId }], { fromHost: true, dedupe: o.resend === true })
    if ('ok' in r && r.ok) return r.noticeLeftOut ? { ok: true as const, noticeLeftOut: true as const } : { ok: true as const }
    return { ok: false as const, reason: 'reason' in r ? String(r.reason) : String((r as { error?: string }).error) }
  })
  return demoQuiesce.isDemo && !daemonCommands.closed ? daemonCommands.admit(work) : work()
}

/**
 * The journal store, the offline host on it, the boot migration and the minute sweep
 * (host-journal-core.ts). Building it reads the slices and
 * writes nothing: this module runs for every use of the binary (the walnut CLI, --status,
 * --stop). Only its migrate(), after daemon.pid names this process, copies slices and
 * leader records, imports v1 journals or sweeps.
 */
const hostJournal = createHostJournal({
  fs, path,
  dir: OFFLINE_HOST_DIR,
  legacyDirs: LEGACY_JOURNAL_DIRS,
  maxRecords: OFFLINE_JOURNAL_MAX,
  now: () => Date.now(),
  randomHex: (n) => crypto.randomBytes(n).toString('hex'),
  sha256: (body) => crypto.createHash('sha256').update(body).digest('hex'),
  keyOf: walnutScope.keyOf,
  canonical: walnutScope.canonical,
  startTimeOf: (pid) => readStartTime(pid),
  isOwner: ownsDaemonDir,
  ignoredTestDir: KEEPS_SESSIONS ? daemonEnv.WALNUT_JOURNAL_DIR || null : null,
  importLegacyLeaders: () => leaderBook.importLegacy(),
  rearm: () => triggerHoldsChanged(),
  fenced: () => demoQuiesce.fenced,
  createJournal: createOfflineJournal,
  createMigration: createJournalMigration,
  createHost: createOfflineHostCore,
  log: (level, msg, data) => logMsg(level, msg, data),
  host: {
    drainsOf: (home) => leaderBook.drainsFor(home),
    kit: createEnvelopeKit(),
    rules: createSendRules(),
    boards: createBoardOffline(),
    replica: hostReplica,
    openItems: createOpenItemsText(),
    search: createOfflineSearch(),
    // A session's letter to the user is saved here while its Walnut is away (a Mac that drains `letter`).
    letters: createLetterCheck(),
    // A trigger created here gets the label the server would give it.
    labels: createTriggerLabel(),
    // How a trigger's `watches` reads, the server's own rule.
    watches: createTriggerWatches(),
    // Which session here takes a trigger fire: the rule the host's own server applies too.
    triggerTarget: pickHostTriggerTarget,
    // The checks run here: their ops answer here while the Walnut is away (walnut-trigger).
    triggers: {
      // Clock routines are not triggers a session lists, pauses or tests here.
      armed: () => [...armedTriggers.values()].filter((e) => !!e.def.check).map((e) => ({
        ...(e.home ? { home: e.home } : {}),
        def: e.def as unknown as OfflineTrigger,
        status: {
          nextRunAtMs: e.nextRunAtMs, running: e.running, consecutiveErrors: e.state.consecutiveErrors,
          lastRunAtMs: e.state.lastRunAtMs, lastFireAtMs: e.state.lastFireAtMs, pendingFires: e.state.pendingFires.length,
        },
      })),
      test: async (check, triggerId, home) => (await runTriggerTest(check, triggerId, home ?? '')) as unknown as Record<string, unknown>,
      changed: () => triggerHoldsChanged(),
      cwdOf: (sid) => sessions.get(sid)?.cwd,
      // A trigger created here is checked as a pushed one is, before it is journaled.
      validate: (def) => { const r = validateTriggerDef(def); return r.ok ? { ok: true } : { ok: false, error: r.error } },
    },
    isLive: (sid) => sessions.get(sid)?.state === 'running',
    turnActive: (sid) => sessions.get(sid)?.foldState.turnActive === true,
    pendingPrompt: (sid) => sessions.get(sid)?.pendingCtrl?.toolName ?? null,
    // The same gate and turn-retry reset a server send goes through (cmdSend).
    deliver: (sid, text, messageId, o) => deliverFromOfflineHost(sid, text, messageId, o),
    // A stopped session started again for a trigger fire (trigger-host-resume-v1).
    resume: (home, sid, text, messageId, taskId) => resumeForTrigger(home, sid, text, messageId, taskId),
    streamOffset: (sid) => {
      const s = sessions.get(sid)
      try { return s ? fs.statSync(s.jsonlPath).size : undefined } catch { return undefined }
    },
    onJournal: (home) => {
      for (const client of wsClients) {
        if (client.data?.origin !== 'bridge' && gatewayClientHomes.get(client) === home) sendEvent(client, 'offline-journal', { home })
      }
    },
    // The gateway's own test for "the server answers this Walnut" (sendGatewayRequest).
    serverAnswers: (home) => {
      if (leaderBook.backupLead(home)) return false
      for (const client of wsClients) {
        if (client.data?.origin === 'bridge' || gatewayClientHomes.get(client) !== home) continue
        if ((client.data?.missedBeats ?? 0) < GATEWAY_SILENT_BEATS) return !followerEntry.quietWithFollower(home)
      }
      return false
    },
    // A reply or notice for a session on another host: only the companion, while
    // it leads, can carry it there.
    relay: (home, req) => new Promise((resolve) => {
      const sent = forwardToBackup(home, 'leader.deliverText', req.fromSessionId ?? '', req as unknown as Record<string, unknown>, (resp) => {
        resolve(resp.ok ? { ok: true } : { ok: false, reason: resp.error.message })
      })
      if (!sent) resolve({ ok: false, reason: 'no server leads this Walnut right now' })
    }),
  },
})
const offlineHost = hostJournal.host

// ── Leader book: who leads this host's work, the primary or (while it is away)
// the cloud companion (leader-core.ts; docs/plan/walnut-control-plane.md). The
// primary describes its Walnut with leader.configure and takes the lead back
// with leader.claim (trusted socket). The companion asks with leader.witness /
// leader.claim and, once it leads, answers what this host cannot answer itself
// and routes messages with leader.deliver (bridge, fenced by epoch).

const LEADER_TAKEOVER_MS = envTimerMs(daemonEnv.WALNUT_LEADER_TAKEOVER_MS, 60_000, 500)
/** At most one leader-lost event per primary socket in this window. */
const LEADER_NUDGE_MS = 10_000
/** Missed keepalive beats after which a primary is skipped for reads the copy answers. */
const GATEWAY_SILENT_BEATS = 3
const leaderBook = createLeaderBook({
  fs, path,
  dir: LEADER_BOOK_DIR,
  legacyDirs: LEGACY_LEADER_DIRS,
  now: () => Date.now(),
  keyOf: walnutScope.keyOf,
  log: (level, msg, data) => logMsg(level, msg, data),
  takeoverMs: LEADER_TAKEOVER_MS,
  bootAt: DAEMON_START_TS,
})

// Model and effort changes the companion makes while it leads (live-settings-core.ts).
const liveSettings = createLiveSettings({
  writeLine: async (sid, line) => {
    const r = await core.handleSendRawCommand(sid, line)
    if ('error' in r) return 'failed'
    if (r.ok) return 'ok'
    return r.reason === 'not_found' ? 'not_found' : 'dead'
  },
  randomHex: (n) => crypto.randomBytes(n).toString('hex'),
  now: () => Date.now(),
  log: (level, msg, data) => logMsg(level, msg, data),
})

/** A trusted socket of this Walnut's primary is open (heard or not). */
function primarySocketOpen(home: string): boolean {
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge' && gatewayClientHomes.get(client) === home) return true
  }
  return false
}

/**
 * Hand one gateway call to the companion while it leads `home`. False when it
 * does not lead, or there is no bridge. An open primary socket is no reason to
 * refuse: a sleeping Mac keeps its sockets, and the companion won the lead
 * because this host stopped hearing them.
 */
function forwardToBackup(
  home: string,
  capability: string,
  callerSid: string,
  payload: Record<string, unknown>,
  respond: (resp: GatewayResponse) => void,
  /** How long to wait for its answer (default the hub's own timeout): a call's own deadline's rest. */
  timeoutMs?: number,
): boolean {
  const lead = leaderBook.backupLead(home)
  // The companion of this Walnut, on its own link.
  const adapter = bridgeLinkFor(home)?.adapter ?? null
  if (!lead || !adapter) return false
  const relayId = ++gatewayRelayCounter
  const timer = setTimeout(() => {
    gatewayRelayPending.delete(relayId)
    respond(gatewayError('hub_timeout', 'the cloud companion, which leads while the Walnut server is away, did not answer in time; the call may have run, read before trying again'))
  }, timeoutMs ?? gatewayHubTimeoutMs())
  gatewayRelayPending.set(relayId, { respond, timer, via: 'bridge', bridge: adapter })
  logMsg('info', 'gateway: relaying to the backup leader', { relayId, capability, callerSid, epoch: lead.epoch })
  sendEvent(adapter, 'gateway-request', {
    relayId, capability, callerSid, payload,
    walnutId: lead.walnutId, epoch: lead.epoch,
    // What this host still waits for, so the companion holds its work to it (backup-gateway.ts).
    answerInMs: timeoutMs,
    caller: callerSid ? offlineHost.callerOf(home, callerSid) : undefined,
  })
  return true
}

function cmdLeaderConfigure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge') return sendError(ws, id, 'leader.configure: trusted clients only')
  if (refuseForeignHome(ws, id, cmd, 'leader.configure')) return
  try {
    const rec = leaderBook.configure({ home: cmd.home as string, walnutId: cmd.walnutId as string, backup: cmd.backup === true, drains: cmd.drains })
    bindGatewayClientHome(ws, rec.home)
    const notTaken = moveNotTaken.get(cmd)
    // A home a declared move made an alias: the server hears the home this host keeps its Walnut
    // under, the one its words to this host's service name (one-service-mode.ts serviceModeAsk).
    const aliased = homeNamedAs.has(cmd)
    sendOk(ws, id, { epoch: rec.epoch, holder: rec.holder, since: rec.since, takeoverMs: LEADER_TAKEOVER_MS, ...(notTaken ? { moveNotTaken: notTaken } : {}), ...(aliased ? { homeHere: rec.home } : {}) })
  } catch (err) {
    sendError(ws, id, (err as Error).message)
  }
}

// ── One Walnut, one home (walnut-scope-core.ts aliases) ──
// A Walnut is named by its instance id; its data dir is only where it is now. A leader whose
// data dir moved says so (leader.configure's movedFrom, src/core/home-move.ts), and the new
// home continues the first home's state here: its epoch, trigger memory, journal, copies,
// jobs and host server. Nothing is inferred.

/**
 * The command as the daemon reads it: its `home` names the Walnut's first home here.
 * leader.configure may first declare a move (only from a server socket: never the bridge, a
 * follower, a lane or a test server's probe). A server socket that speaks as a home its Walnut
 * moved away from is refused for good (null, answered here, `walnut_home_busy` with `movedTo`):
 * two diverged copies of one data dir never take turns on one Walnut's state. A copy, never
 * the sender's object: a client in this process sends its own.
 */
function adoptCommandHome(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>, reply: (frame: DaemonFrame) => void): Record<string, unknown> | null {
  const home = walnutScope.askedHome(cmd)
  if (!home) return cmd
  let notTaken = ''
  if (cmd.cmd === 'leader.configure' && cmd.movedFrom !== undefined && isServerClient(ws)) {
    const move = walnutScope.declareMove({
      home, movedFrom: cmd.movedFrom, formerHomes: cmd.formerHomes, walnutId: cmd.walnutId, volatile: cmd.walnutIdVolatile === true, copyGone: cmd.copyGone,
      recordIdOf: (h) => leaderBook.recordOf(h)?.walnutId ?? null, homes: () => leaderBook.homes(),
    })
    if (move.moved && move.aliased) foldAliasedHome(home, move.to)
    else if (!move.moved) logMsg('warn', 'walnut home: a declared move was not taken; the home stays a Walnut of its own', { why: move.why, home: walnutScope.pathKeyOf(home) })
    // Its server hears it (leader.configure's moveNotTaken) and says so in Walnut Health.
    if (!move.moved && walnutScope.moveNotTakenTold(move.why)) notTaken = move.why
  }
  if (!HOME_IS_A_PLACE.has(cmd.cmd as string) && refuseMovedHome(ws, cmd, home, reply)) return null
  const canon = walnutScope.canonical(home)
  if (canon === home || HOME_IS_A_PLACE.has(cmd.cmd as string)) {
    if (notTaken) moveNotTaken.set(cmd, notTaken)
    return cmd
  }
  // What the command carries names the Walnut too: a host server's or the jobs' spec, a spawn template.
  const out: Record<string, unknown> = { ...cmd, home: canon }
  for (const field of ['spec', 'template']) {
    const inner = cmd[field] as Record<string, unknown> | null | undefined
    if (inner && typeof inner === 'object' && inner.home === home) out[field] = { ...inner, home: canon }
  }
  if (notTaken) moveNotTaken.set(out, notTaken)
  homeNamedAs.set(out, home)
  return out
}

/** Commands whose `home` is a place on this machine, never a Walnut's name. */
const HOME_IS_A_PLACE = new Set(['demo.quiesce'])
/** A leader.configure whose declared move was not taken, with why (adoptCommandHome to cmdLeaderConfigure). */
const moveNotTaken = new WeakMap<Record<string, unknown>, string>()
/** A command whose home adoptCommandHome replaced by the Walnut's first home here, with the home it named. */
const homeNamedAs = new WeakMap<Record<string, unknown>, string>()

/**
 * A server socket that speaks as a home its Walnut moved away from: refused for good, answered
 * through `reply` (`walnut_home_busy` with where the Walnut is now). True when it was refused.
 */
function refuseMovedHome(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>, home: string, reply: (frame: DaemonFrame) => void = (frame) => sendFrame(ws, frame)): boolean {
  const refusal = isServerClient(ws) ? walnutScope.refusalOf(home, cmd.walnutId, (h) => leaderBook.recordOf(h)?.walnutId ?? null) : null
  if (!refusal) return false
  const key = walnutScope.keyOf(home)
  const taken = refusal.errorKind === 'walnut_home_taken'
  logMsg('warn', taken ? 'walnut home: refused, another Walnut used this data dir and moved' : 'walnut home: refused, this Walnut moved to another data dir', { cmd: cmd.cmd, walnut: key, home: walnutScope.pathKeyOf(home) })
  reply(errorFrame(ws, typeof cmd.id === 'number' ? cmd.id : null, `${taken ? 'another Walnut used this data dir here and moved to another one' : 'this Walnut moved to another data dir'}: ${key}`, { errorKind: refusal.errorKind, movedTo: refusal.movedTo }, 'warn'))
  return true
}

/**
 * `from` just became an alias of `to`: what its server set up here before (pushes at connect,
 * before leader.configure) is `to`'s, so one Walnut keeps one set of everything.
 */
function foldAliasedHome(from: string, to: string): void {
  for (const client of wsClients) {
    if (gatewayClientHomes.get(client) === from) bindGatewayClientHome(client, to)
    const d = client.data
    if (!d) continue
    if (d.triggerScope === from) d.triggerScope = to
    if (d.followerHome === from) d.followerHome = to
    if (d.laneHome === from) d.laneHome = to
  }
  const follower = followerSockets.get(from)
  if (follower) { followerSockets.delete(from); if (!followerSockets.has(to)) followerSockets.set(to, follower) }
  const saidOnline = followerSaidOnline.get(from)
  if (saidOnline !== undefined) { followerSaidOnline.delete(from); if (!followerSaidOnline.has(to)) followerSaidOnline.set(to, saidOnline) }
  followerWaitMissed.delete(from)
  foldTriggerScope(from, to)
  foldHooks(from, to)
  foldBridgeLink(from, to)
  offlineHost.foldHome(from, to)
  // The first home's key must not read as another Walnut still using this daemon (daemon-shared.ts).
  servedWalnuts.forgetKey(walnutScope.pathKeyOf(to))
  logMsg('info', 'walnut home: a Walnut known here came from another data dir; it keeps its state', { from: walnutScope.pathKeyOf(from), to: walnutScope.pathKeyOf(to) })
}

/** The set `from` pushed is `to`'s, armed with `to`'s memory (epoch, seq, seen). */
function foldTriggerScope(from: string, to: string): void {
  const scope = triggerScopes.get(from)
  if (!scope) return
  // A declared move comes before the set (home-move.ts), so this is only a set pushed when the
  // declaration did not get through: its fresh memory goes, the first home's carries on.
  for (const map of [armedTriggers, drainingTriggers]) {
    for (const [key, entry] of [...map]) if (entry.home === from) map.delete(key)
  }
  triggerScopes.delete(from)
  const target = triggerScopeOf(to)
  target.configured = scope.configured
  target.hash = scope.hash
  if (scope.push) target.push = scope.push
  else delete target.push
  armTriggerSet(to, effectiveTriggerDefs(to, scope.configured), Date.now())
  persistTriggersFile(to)
  logMsg('info', 'triggers: the set of a new home armed as its Walnut\'s', { scope: walnutScope.label(to), count: scope.configured.length })
}

/** The rules `from` pushed are `to`'s when they are the newer copy. */
function foldHooks(from: string, to: string): void {
  const entry = daemonHooksByHome.get(from)
  if (!entry) return
  daemonHooksByHome.delete(from)
  const mine = daemonHooksByHome.get(to)
  if (mine && mine.at > entry.at) return
  daemonHooksByHome.set(to, entry)
  const stored = { ...entry.config, home: to, scoped: 1 }
  const dir = walnutScope.dirFor(HOOKS_DIR, to)
  if (SERVICE_MODE && DAEMON_STATE_DIR) {
    void persistCronHooks(dir, stored).catch((err) => logMsg('warn', 'daemon hooks persist failed (in-memory only)', { error: (err as Error).message }))
    return
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(stored), { mode: 0o600 })
  } catch (err) { logMsg('warn', 'daemon hooks persist failed (in-memory only)', { error: (err as Error).message }) }
}

/** One bridge link per Walnut: `from`'s becomes `to`'s, or closes when `to` has its own. */
function foldBridgeLink(from: string, to: string): void {
  const link = bridgeLinks.get(from)
  if (!link) return
  bridgeLinks.delete(from)
  const cfg = link.config ? { ...link.config, home: to } : null
  const own = bridgeLinks.get(to)
  if (own) stopBridge(link)
  const target = own ?? link
  if (!own) {
    link.home = to
    if (link.adapter?.data) link.adapter.data.bridgeHome = to
    bridgeLinks.set(to, link)
  }
  const changed = !!cfg && bridgeConfigKey(cfg) !== bridgeConfigKey(own ? own.config : null)
  if (cfg) target.config = cfg
  if (cfg) {
    try {
      const file = bridgeFileFor(to)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 })
    } catch (err) { logMsg('error', 'bridge: failed to persist bridge.json', { err: (err as Error).message }) }
  }
  if (own && changed) startBridge(own, 'configure')
}

// The server this daemon keeps running for a leader (host-server-core.ts).
const HOST_SERVER_DIR = SERVICE_MODE && DAEMON_STATE_DIR
  ? path.join(DAEMON_STATE_DIR, 'host-server')
  : IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-server') : path.join(DAEMON_DIR, 'host-server')
const hostServers = createHostServerSupervisor({
  fs, path,
  spawn: (command, args, opts) => spawn(command, args, opts),
  dir: HOST_SERVER_DIR,
  keyOf: walnutScope.keyOf,
  // The service's own home under any home a declared move made the same Walnut.
  canonical: (home) => walnutScope.canonical(home),
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (level, msg, data) => logMsg(level, msg, data),
  startTimeOf: readStartTime,
  killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  heldAt: heldServerAt,
  baseEnv: () => ({
    PATH: daemonEnv.PATH ?? '',
    HOME: daemonEnv.HOME ?? HOME_DIR,
    ...(daemonEnv.LANG ? { LANG: daemonEnv.LANG } : {}),
    WALNUT_HOST_DAEMON_DIR: DAEMON_DIR,
  }),
  randomToken: () => crypto.randomBytes(32).toString('hex'),
  // The stdout log's cap while the server runs (WP14; tests set a small one).
  maxLogBytes: Number(daemonEnv.WALNUT_HOST_SERVER_LOG_MAX_BYTES) || undefined,
  // The host's one Walnut service is the follower of options.selfHome: no child for it, and a spec
  // the leader changes for it restarts the whole service (its launcher starts it again).
  // dataHome: the data dir this service's own server runs on, the home its session starts name (walnutOf).
  ...(options.selfHome ? { self: { home: options.selfHome, pid: process.pid, dataHome: daemonEnv.OPEN_WALNUT_HOME || undefined, changed: (why: string) => {
    logMsg('info', 'host server: the service\'s own follower spec changed; restarting the service', { home: options.selfHome, why })
    setTimeout(() => requestDaemonShutdown?.(), 0)
  } } } : {}),
  // A leading service: no follower of the Walnut it leads runs here.
  ...(options.leadsWalnut ? { leads: options.leadsWalnut } : {}),
  // A server's data dir names its Walnut (walnutOf) only by real path, and never a Walnut's own home.
  realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
  walnutHomes: () => [...leaderBook.homes(), path.join(HOME_DIR, '.open-walnut')],
})

// ── logs.tail ('replica-logs-v1', replica-logs-core.ts; WP14) ──
// The Mac reads what its replica on this host and this daemon's journal logged
// here. A trusted leader socket whose leader.configure named `home` only:
// another Walnut's logs are never readable.
const replicaLogs = createReplicaLogs({ fs, path, daemonDir: DAEMON_DIR, logsOf: (home) => hostServers.logsOf(home) })
function cmdLogsTail(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const origin = ws.data?.origin
  if (origin === 'bridge' || origin === 'follower' || origin === 'lane') return sendError(ws, id, 'logs.tail: trusted clients only', { errorKind: 'refused' })
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  if (!home || gatewayClientHomes.get(ws) !== home) return sendError(ws, id, 'logs.tail: send leader.configure for this Walnut first', { errorKind: 'not_owner' })
  const r = replicaLogs.tail(home, cmd.sources, cmd.n, cmd.match)
  if (!r.ok) return sendError(ws, id, 'logs.tail: ' + r.message, { errorKind: r.code })
  sendOk(ws, id, r as unknown as Record<string, unknown>)
}

/** The socket that speaks as the follower of each Walnut (the server this daemon started). */
const followerSockets = new Map<string, ServerWebSocket<WsData>>()
/** The in-process clients the follower seat attached (a host's one Walnut service): a socket's follower.hello never replaces one. */
const seatSockets = new WeakSet<ServerWebSocket<WsData>>()
/**
 * What each Walnut's follower last said about same-host sends (`answersOnline`, its hello or report),
 * kept while its socket is gone: a same-host send in a restart of one that takes them waits for it.
 */
const followerSaidOnline = new Map<string, boolean>()
/**
 * This host's follower of the Walnut of `home`, as this daemon knows it now: the one answer to
 * "does this host have a follower", for the session PATH rule (walnutThroughGateway), the call entry
 * and the gateway's waits. Two facts, each also under the Walnut a server's own data dir names
 * (walnutOfHome):
 *   - `linked`: its socket now (a hello, or the in-process seat);
 *   - the server spec this daemon keeps for it (hostServers): written by server.configure and read
 *     back by boot() from server-*.json before any connection is taken, so a daemon that just took
 *     over (a handover, an update) knows its follower before the follower's hello. Never a leader's
 *     own Walnut: no follower of it is configured or adopted (host-server-core.ts `leads`);
 * and, for `here`, a third: this very process is that follower (a host's one Walnut service, the
 * daemon runtime inside the follower server: hostServers.followsAsSelf), whether or not it kept a
 * spec or attached its seat yet. A leading service (the Mac's one service) is never one.
 */
function followerHere(home: string | undefined) {
  const linked = home ? followerSockets.get(home) ?? followerSockets.get(walnutOfHome(home)) : undefined
  const spec = !home ? undefined : hostServers.keeps(home) ? home : hostServers.keeps(walnutOfHome(home)) ? walnutOfHome(home) : undefined
  return {
    linked,
    /** A follower is linked, this daemon keeps its server (running, starting or restarting), or this process is it. */
    here: linked !== undefined || spec !== undefined || (!!home && (hostServers.followsAsSelf(home) || hostServers.followsAsSelf(walnutOfHome(home)))),
    /**
     * It answers this host's own `walnut` calls: the fact the gateway routes by, so the daemon's own
     * away answers serve only a host with none (no follower configured, below the floors of
     * core/host-server/eligibility.ts, or turned off by its person: the leader then sends no spec).
     * Its linked socket's word when linked, else its kept spec's (hostServers.answersCalls). Never
     * "linked right now": a follower restarting, or not linked yet after a boot, is still this host's.
     */
    kept: linked ? linked.data?.answersLocal === true : spec !== undefined && hostServers.answersCalls(spec),
    /** It may answer by `by`: linked, its server starting or running, or restarting before then. */
    dueBy(by: number): boolean {
      if (linked) return true
      if (spec === undefined) return false
      const st = hostServers.status(spec)
      return st.state === 'starting' || st.state === 'running' || (st.state === 'retrying' && typeof st.nextRetryAt === 'number' && st.nextRetryAt < by)
    },
  }
}
/**
 * This process is the one Walnut service of `home` and keeps no copy of its leader's data
 * (core/host-server/copyless.ts, experiment service_without_copy: the spec's WALNUT_COPIES=none).
 * The daemon's own away answers (offlineHost.handle, handleLocal, holdWrite, deliverTrigger) are
 * never asked for it: what the follower in this process answers is final, a call before it is
 * seated waits within its own time and then answers `needs_leader` `service_starting` (retryable,
 * nothing ran), and a same-host send while the leader answers goes to the leader.
 */
function ownAnswersOff(home: string | undefined): boolean {
  return !!home && SERVICE_MODE && (hostServers.selfWithoutCopy(home) || hostServers.selfWithoutCopy(walnutOfHome(home)))
}

/** A call the service in this process could not take yet (it is starting): retryable, nothing ran. */
function serviceStartingAnswer(): GatewayResponse {
  return { ok: false, error: { code: 'needs_leader', message: 'this host\'s Walnut service is starting; nothing was sent, try again in a moment', retryAfterMs: 1_000, detail: { why: 'service_starting', retryable: true } } }
}

/**
 * When a call last waited its whole room for this host's follower and got no answer (waitForFollower):
 * a follower alive but never linking (a hung boot, a refused hello) or linked but not taking calls (the
 * leader still heard) would make every call wait its room again. While it is younger than
 * FOLLOWER_MISS_HOLD_MS a new call does not wait; the follower's next hello clears it.
 */
const followerWaitMissed = new Map<string, number>()

// `walnut` calls this host's own Walnut server answers while its leader is away
// ('follower-gateway-v1', follower-gateway-core.ts).
const followerGateway = createFollowerGateway<ServerWebSocket<WsData>>({
  follower: (home) => {
    const ws = followerSockets.get(home)
    return ws && ws.data?.answersLocal === true ? ws : null
  },
  answersOnline: (ws) => ws.data?.answersOnline === true,
  // One rule for "the leader is away": the test follower.op applies (followerEntry.mayWrite).
  mayWrite: (home) => followerEntry.mayWrite(home),
  kept: (home) => followerHere(home).kept,
  // The companion leading takes what the follower refuses for want of a leader: relayed to it on its
  // link, held for the Mac when it takes nothing either (follower-gateway-core.ts askElsewhere).
  leaderElsewhere: (home) => leaderBook.backupLead(home) !== null,
  relayElsewhere: (call, answer, timeoutMs) => forwardToBackup(call.home, call.capability, call.callerSid, call.payload, answer, timeoutMs),
  holdForLeader: (call) => (ownAnswersOff(call.home) ? null : offlineHost.holdWrite(call.home, call.callerSid, call.capability, call.payload) as FollowerGatewayResponse | null),
  now: () => Date.now(),
  send: (ws, ev, data) => { try { sendEvent(ws, ev, data); return true } catch { return false } },
  nextRelayId: () => ++gatewayRelayCounter,
  instanceId: DAEMON_INSTANCE_ID,
  attemptMs: (deadline) => relayAttemptMs(deadline, Date.now(), gatewayHubTimeoutMs()),
  minRelayMs: GATEWAY_MIN_RELAY_MS,
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (level, msg, data) => logMsg(level, msg, data),
  stopping: () => daemonCommands.closed,
})

// Trigger fires no server claimed, delivered by this host's own Walnut server while its
// leader is away ('follower-trigger-delivery-v1', follower-trigger-delivery-core.ts): it picks
// the session with its copies, this daemon writes it.
const FOLLOWER_TRIGGER_ANSWER_MS = 15_000
let followerTriggerCounter = 0
const followerTriggers = createFollowerTriggerDelivery<ServerWebSocket<WsData>>({
  follower: (home) => {
    const ws = followerSockets.get(home)
    return ws && ws.data?.deliversTriggers === true ? ws : null
  },
  mayWrite: (home) => followerEntry.mayWrite(home),
  send: (ws, ev, data) => { try { sendEvent(ws, ev, data); return true } catch { return false } },
  liveSids: (home) => offlineHost.liveSessionsOf(home),
  own: (fire) => deliverFireOwn(fire),
  deliverTo: (fire, target) => deliverFireTo(fire, target),
  nextId: () => `td-${DAEMON_INSTANCE_ID}-${++followerTriggerCounter}`,
  answerMs: FOLLOWER_TRIGGER_ANSWER_MS,
  // Counted with the gateway's own answers (the count task B drives to zero).
  ownAnswerUsed: (fire) => { if (!ownAnswersOff(fire.home)) followerGateway.noteOwnAnswer('trigger_delivery', 'handed_back') },
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (level, msg, data) => logMsg(level, msg, data),
})

/** The daemon's own delivery of a fire (follower-trigger-delivery-core.ts `own`): a stopping Demo delivers nothing. */
function deliverFireOwn(fire: TriggerFire): Promise<TriggerDeliveryResult> {
  if (demoQuiesce.fenced) return Promise.resolve({ ok: false, reason: 'demo_stopping' })
  // The service without a copy delivers while its leader is away through its follower only: the fire
  // stays due and is tried again a minute later (ownAnswersOff).
  if (ownAnswersOff(fire.home) && followerEntry.mayWrite(fire.home)) return Promise.resolve({ ok: false, reason: 'service_starting' })
  return offlineHost.deliverTrigger(fire.home, fire.taskId, fire.text, fire.messageId)
}

/** The mechanics for the follower's pick (`deliverTo`): a write or a resume, so the fence comes first too. */
function deliverFireTo(fire: TriggerFire, target: { sid: string; resume: boolean }): Promise<TriggerDeliveryResult> {
  if (demoQuiesce.fenced) return Promise.resolve({ ok: false, reason: 'demo_stopping' })
  return offlineHost.deliverTriggerTo(fire.home, fire.taskId, target, fire.text, fire.messageId)
}

function cmdFollowerHello(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge') return sendError(ws, id, 'follower.hello: not over the bridge')
  if (gatewayClientHomes.has(ws)) return sendError(ws, id, 'follower.hello: this socket already speaks for a leader')
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  const view = home ? followerEntry.view(home) : null
  if (!view || view.walnutId !== cmd.walnutId) {
    return sendFrame(ws, { id, ok: false, error: 'this host does not know that Walnut yet: its leader has not connected here', errorKind: 'unknown_walnut' })
  }
  // The follower server in this process holds the seat (followerSeat.attach): no socket takes it,
  // whatever token it holds (review A3b S56-L3).
  const held = followerSockets.get(home)
  if (held && seatSockets.has(held)) {
    return sendFrame(ws, { id, ok: false, error: 'the follower of that Walnut runs in this daemon\'s own process', errorKind: 'not_started_here' })
  }
  // Only the server this daemon started for that Walnut: no stray process takes its place.
  if (!hostServers.tokenMatches(home, cmd.token)) {
    return sendFrame(ws, { id, ok: false, error: 'this daemon did not start that server', errorKind: 'not_started_here' })
  }
  if (ws.data) { ws.data.origin = 'follower'; ws.data.followerHome = home; ws.data.answersLocal = cmd.answersLocal === true; ws.data.deliversTriggers = cmd.deliversTriggers === true; ws.data.answersOnline = cmd.answersOnline === true }
  if (ws.data) ws.data.callSocket = cmd.answersLocal === true ? hostCallTokens.socketOf(cmd.callSocket) : undefined
  followerSockets.set(home, ws)
  followerSaidOnline.set(home, cmd.answersOnline === true)
  followerWaitMissed.delete(home)
  logMsg('info', 'follower: a server on this host follows its leader', { wsId: wsId(ws), home, answersLocal: cmd.answersLocal === true, deliversTriggers: cmd.deliversTriggers === true })
  sendOk(ws, id, view)
  // Calls that wait for this host's own Walnut server go now (sendGatewayRequest waitForFollower).
  wakeWaitingCalls()
}

/** The follower says how it is; the leader reads it with server.status. Not answered. */
function cmdFollowerReport(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>) {
  const home = ws.data?.followerHome
  if (!home || followerSockets.get(home) !== ws) return
  followerEntry.report(home, cmd.report)
  // Whether it takes a same-host send while the leader answers (its `host_call_entry` experiment, on or off).
  const said = cmd.report as { answersOnline?: unknown } | null | undefined
  if (ws.data && said && typeof said === 'object' && 'answersOnline' in said) { ws.data.answersOnline = said.answersOnline === true; followerSaidOnline.set(home, ws.data.answersOnline) }
  // The entry's socket as the follower says it now (its experiment turned on or off).
  const report = cmd.report as { callSocket?: unknown } | null | undefined
  if (ws.data && report && typeof report === 'object' && 'callSocket' in report) {
    const next = ws.data.answersLocal === true ? hostCallTokens.socketOf(report.callSocket) : undefined
    if (next !== ws.data.callSocket) logMsg('info', 'host call entry: follower socket', { home, callSocket: next ?? null })
    ws.data.callSocket = next
  }
}

// ── The host call entry ('host-call-entry-v1', host-call-token-core.ts) ──
// A run this daemon starts (a session, an ACP worker, a plugin job) while a follower that answers
// local calls said its entry socket gets WALNUT_CALL_SOCKET and a token of that run
// (WALNUT_CALL_TOKEN), and posts its calls there; the follower hands each line back here
// (`follower.gateway`), checked for that token, and it runs as a socket line does (handleGatewayLine).
// The socket check, the runs and the env are the core's.
const hostCallTokens = createHostCallTokens({
  fs, path, crypto, dir: DAEMON_DIR,
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  // A host server's own data dir names its leader's Walnut (walnutOfHome): its ACP and job starts name that dir.
  socketFor: (home) => { const ws = followerHere(home).linked; return ws?.data?.answersLocal === true ? ws.data.callSocket : undefined },
  log: (level, msg, data) => logMsg(level, msg, data),
})

/**
 * `follower.gateway {request, token, openedAt}`: a line its entry took. The token must be the one
 * this daemon gave the line's sid for its current run; then the line goes the socket's way, with no
 * socket peer (an approval's caller proof is the gateway socket's: the entry sends those there).
 * The answer is `{response}`, whatever the call said; a refusal here means nothing of it ran.
 */
function cmdFollowerGateway(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = ws.data?.origin === 'follower' ? ws.data.followerHome : undefined
  if (!home || followerSockets.get(home) !== ws) return sendError(ws, id, 'follower.gateway: send follower.hello first')
  const request = cmd.request
  const sid = request && typeof request === 'object' ? (request as { sid?: unknown }).sid : undefined
  if (!hostCallTokens.verify(sid, cmd.token)) {
    logMsg('warn', 'host call entry: token refused', { home, sid: typeof sid === 'string' ? sid : null })
    return safeSend(ws, JSON.stringify({ id, ok: false, error: 'follower.gateway: this token is not the caller\'s', errorKind: 'bad_token' }))
  }
  // A plugin job's run is vouched for only by the process on the gateway socket (jobCallerVouched),
  // and this door has no socket peer: its line goes back, nothing ran, and its client sends the same
  // line on the socket (the entry answers entry_unavailable). Else every start it makes is capped.
  if (pluginJobs.isRunSid(sid)) {
    return safeSend(ws, JSON.stringify({ id, ok: false, error: 'follower.gateway: a plugin job\'s call is vouched for on the daemon socket; use it', errorKind: 'job_on_socket' }))
  }
  let line: string
  try { line = JSON.stringify(request) } catch { return sendError(ws, id, 'follower.gateway: the request does not serialize') }
  const openedAt = typeof cmd.openedAt === 'number' && Number.isFinite(cmd.openedAt) ? cmd.openedAt : Date.now()
  const respond = (resp: GatewayResponse) => sendOk(ws, id, { response: resp })
  // The caller "left" once this follower's link is gone (a waiting call ends, as on the socket).
  gatewayCallerLeft.set(respond, () => followerSockets.get(home) !== ws)
  // null: the token proved the line's sid (it is the one the token was made for), no socket to read.
  handleGatewayLine(line, respond, null, openedAt)
}

// ── Streams between servers ('stream-relay-v1', stream-relay-core.ts) ──
// A host server's browser reaches the leader (or the companion) and the leader
// reaches the host server through this daemon, on the links each already has.
// Terminal streams ('pty-stream-v1', pty-stream-core.ts): bun's own pty (the bun this twin
// is built with has it), so this twin always advertises it.
const PTY_SPAWN = (argv: string[], opts: PtySpawnOptions): PtyChild => childProcess.bunSpawn(argv, opts as never) as unknown as PtyChild
const ptyStreams = createPtyStreams<ServerWebSocket<WsData>>({
  send: (ws, ev, data) => sendEvent(ws, ev, data),
  log: (level, msg, data) => logMsg(level, msg, data),
  spawn: PTY_SPAWN,
  user: () => { const u = os.userInfo(); return { shell: u.shell, home: u.homedir, name: u.username } },
  env: daemonEnv,
  // bun's os.userInfo().shell is the env's SHELL: the core reads the passwd shell with this.
  readCommand: (file, args, cb) => { execFile(file, args, { timeout: 3_000 }, (err, stdout) => cb(err ? null : String(stdout))) },
  platform: process.platform,
  uid: () => process.getuid?.() ?? null,
  executable: (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } },
  foregroundGroup: (pid, cb) => psGroupField(pid, 'tpgid', cb),
  ownGroup: (cb) => psGroupField(process.pid, 'pgid', cb),
  killGroup: (pgid, signal) => { process.kill(-pgid, signal as NodeJS.Signals) },
})
/** One process's `ps -o <field>=` as an integer (tpgid, pgid), or null; Linux and macOS ps both take it. */
function psGroupField(pid: number, field: 'tpgid' | 'pgid', cb: (n: number | null) => void): void {
  execFile('ps', ['-o', `${field}=`, '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => {
    const n = err ? NaN : Number.parseInt(String(stdout).trim(), 10)
    cb(Number.isInteger(n) ? n : null)
  })
}
/** The cloud companion's tunnel daemons live here (cloud-tunnel-daemon.ts tunnelDaemonDir). */
const TUNNEL_DAEMON_BASE: string = daemonEnv.WALNUT_TUNNEL_DAEMON_DIR || path.join(daemonEnv.HOME || HOME_DIR, '.local', 'state', 'open-walnut', 'primary-daemon')
/** The port this daemon listens on, once it does. */
let listeningPort: number | null = null
const streamRelay = createStreamRelay<ServerWebSocket<WsData>>({
  send: (ws, ev, data) => sendEvent(ws, ev, data),
  log: (level, msg, data) => logMsg(level, msg, data),
  // Port streams ('port-stream-v1'): the relay picks the loopback address.
  connect: (port, host) => net.connect({ port, host, allowHalfOpen: true }),
  // Never a daemon socket on this machine: ours, or a sibling's (the production dirs, the
  // cloud companion's tunnel daemon).
  daemonPorts: {
    own: () => listeningPort,
    dirs: [...new Set([DAEMON_DIR, PROD_DAEMON_DIR, FALLBACK_DAEMON_DIR, TUNNEL_DAEMON_BASE])],
    deviceBases: [TUNNEL_DAEMON_BASE],
    // Every other Walnut's service on this machine (service-set.ts).
    setBase: path.join(HOME_DIR, '.open-walnut-host', 'walnuts'),
    uid: process.getuid?.() ?? 0,
    read: (file) => { try { return fs.readFileSync(file, 'utf8').slice(0, 16) } catch { return null } },
    list: (dir) => { try { return fs.readdirSync(dir) } catch { return [] } },
  },
  ptys: ptyStreams,
})

/** The primary's socket for `home` that was heard last. */
function primaryClientFor(home: string): ServerWebSocket<WsData> | null {
  // The leader's lane first, while it answers: a stream's bytes stay off its session link.
  for (const client of wsClients) {
    if (client.data?.origin === 'lane' && client.data.laneHome === home && (client.data.missedBeats ?? 0) < 2) return client
  }
  let best: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (!isServerClient(client) || gatewayClientHomes.get(client) !== home) continue
    if (!best || (client.data?.missedBeats ?? 0) < (best.data?.missedBeats ?? 0)) best = client
  }
  return best
}

/**
 * The primary socket a companion stream goes to ('bridge-stream-v1'): a server
 * socket that named its Walnut here (host.slice, leader.configure), the one heard
 * last, never a quiet one. Its bulk channel names none and drops stream frames.
 */
function primaryForBridge(home = ''): ServerWebSocket<WsData> | null {
  let best: { link: ServerWebSocket<WsData>; heardAt: number } | null = null
  for (const l of freshLeaderLinks()) {
    // A named link's companion reaches its own Walnut's primary only.
    if (!servesBridgeHome(l.link, home)) continue
    if (!best || l.heardAt > best.heardAt) best = l
  }
  return best?.link ?? null
}

/**
 * The primary server sockets here that named their Walnut (host.slice, leader.configure) and
 * were heard lately, in connection order: never the bridge, a follower, a lane or a probe.
 * A companion stream (primaryForBridge) and a hub forward (hubLinks) go to one of them.
 */
function freshLeaderLinks(): Array<{ link: ServerWebSocket<WsData>; home: string; heardAt: number }> {
  const now = Date.now()
  const out: Array<{ link: ServerWebSocket<WsData>; home: string; heardAt: number }> = []
  for (const client of wsClients) {
    if (!isServerClient(client)) continue
    const home = gatewayClientHomes.get(client)
    if (home === undefined) continue
    const at = typeof client.data?.lastHeardAt === 'number' ? client.data.lastHeardAt : now
    if (now - at > TRUSTED_CLIENT_QUIET_MS) continue
    out.push({ link: client, home, heardAt: at })
  }
  return out
}

/** Where a stream `ws` opens to `to` goes, or why it cannot. */
function streamTarget(ws: ServerWebSocket<WsData>, to: unknown): { link: ServerWebSocket<WsData>; meta: Record<string, unknown> } | { why: string } {
  if (ws.data?.origin === 'follower') {
    const home = ws.data.followerHome
    if (!home || followerSockets.get(home) !== ws) return { why: 'send follower.hello first' }
    if (to === 'primary') {
      const link = primaryClientFor(home)
      return link ? { link, meta: { from: 'follower', home } } : { why: 'the Mac is not linked to this host' }
    }
    if (to === 'companion') {
      const companion = bridgeLinkFor(home)?.adapter
      return companion ? { link: companion, meta: { from: 'follower', home } } : { why: 'the cloud companion is not linked to this host' }
    }
    return { why: 'a follower opens streams to the primary or the companion' }
  }
  if (ws.data?.origin === 'lane') {
    const laneHome = ws.data.laneHome
    const link = laneHome && to === 'follower' ? followerSockets.get(laneHome) : undefined
    if (link) return { link, meta: { from: 'primary', home: laneHome } }
    return { why: to === 'follower' ? 'no server on this host follows that Walnut' : 'a lane opens streams to the follower only' }
  }
  // The companion ('bridge-stream-v1'): to the primary only, the server its
  // server.http relay reaches. It is the primary socket heard last (primaryForBridge), which can
  // differ from pickTrustedClient's pick while the daemon and the companion disagree on who
  // leads; a stream whose request is never written is then answered on the companion.
  if (ws.data?.origin === 'bridge') {
    if (to !== 'primary') return { why: 'the companion opens streams to the primary only' }
    const link = primaryForBridge(bridgeHomeOf(ws))
    return link ? { link, meta: { from: 'companion', home: gatewayClientHomes.get(link) } } : { why: 'no primary server connected' }
  }
  const home = isServerClient(ws) ? gatewayClientHomes.get(ws) : undefined
  if (home && to === 'follower') {
    const link = followerSockets.get(home)
    return link ? { link, meta: { from: 'primary', home } } : { why: 'no server on this host follows that Walnut' }
  }
  return { why: 'this link opens no such stream' }
}

/**
 * The leader makes this socket its lane for streams ('stream-lane-v1'): a link
 * on its own SSH connection that carries streams only. The Walnut must be the
 * one the leader described here (leader.configure on its session link).
 */
function cmdStreamLane(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const origin = ws.data?.origin
  if (origin === 'bridge' || origin === 'follower') return sendError(ws, id, 'stream.lane: the leader only')
  if (gatewayClientHomes.has(ws)) return sendError(ws, id, 'stream.lane: this socket already speaks for a leader')
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  const rec = home ? leaderBook.recordOf(home) : undefined
  if (!rec || rec.walnutId !== cmd.walnutId) {
    return sendFrame(ws, { id, ok: false, error: 'this host does not know that Walnut yet: its leader has not connected here', errorKind: 'unknown_walnut' })
  }
  if (ws.data) { ws.data.origin = 'lane'; ws.data.laneHome = home }
  logMsg('info', 'stream lane: the leader opened a lane for its streams', { wsId: wsId(ws), home })
  sendOk(ws, id, {})
  // The follower's streams that waited for it.
  releaseLaneOpens(home)
}

/**
 * A test server says what it is ('client-role-v1'): `role: 'probe'`, an ephemeral
 * server attached read only to this host's shared daemon. From then on this socket
 * is no leader candidate (isServerClient), so the real Walnut's traffic never lands
 * on it. Only a socket that has not spoken for a leader may take it, and only
 * once: a probe cannot turn back into a server.
 */
function cmdClientRole(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (cmd.role !== 'probe') return sendError(ws, id, 'client.role: unknown role')
  const origin = ws.data?.origin
  if (origin === 'bridge' || origin === 'follower' || origin === 'lane') return sendError(ws, id, 'client.role: this socket already has a role')
  if (gatewayClientHomes.has(ws)) return sendError(ws, id, 'client.role: this socket already speaks for a leader')
  if (ws.data) ws.data.origin = 'probe'
  sendOk(ws, id, {})
}

/**
 * A Walnut whose lane closed a moment ago gets it back within seconds (the Mac
 * dials it again at once), so a follower's stream to the primary waits for it
 * a little rather than taking the session link, whose SSH connection a bulk
 * stream can break. After LANE_HOLD_MS it goes the way it can.
 */
const LANE_BACK_MS = 30_000
const LANE_HOLD_MS = 3_000
const laneClosedAt = new Map<string, number>()
const heldLaneOpens = new Map<string, Array<{ ws: ServerWebSocket<WsData>; cmd: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>>()

function liveLaneFor(home: string): boolean {
  for (const client of wsClients) {
    if (client.data?.origin === 'lane' && client.data.laneHome === home && (client.data.missedBeats ?? 0) < 2) return true
  }
  return false
}

function cmdStreamOpen(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>) {
  const home = ws.data?.origin === 'follower' && cmd.to === 'primary' ? ws.data.followerHome : undefined
  if (home && followerSockets.get(home) === ws && !liveLaneFor(home) && Date.now() - (laneClosedAt.get(home) ?? 0) < LANE_BACK_MS) {
    const held = heldLaneOpens.get(home) ?? []
    const entry = { ws, cmd, timer: setTimeout(() => releaseLaneOpens(home, entry), LANE_HOLD_MS) }
    held.push(entry)
    heldLaneOpens.set(home, held)
    return
  }
  openStreamNow(ws, cmd)
}

/** Open the held streams of `home` now (all of them, or the one whose wait ran out). */
function releaseLaneOpens(home: string, only?: { ws: ServerWebSocket<WsData>; cmd: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }) {
  const held = heldLaneOpens.get(home) ?? []
  const go = only ? held.filter((e) => e === only) : held
  const rest = only ? held.filter((e) => e !== only) : []
  if (rest.length) heldLaneOpens.set(home, rest)
  else heldLaneOpens.delete(home)
  for (const e of go) {
    clearTimeout(e.timer)
    if (wsClients.has(e.ws)) openStreamNow(e.ws, e.cmd)
  }
}

function openStreamNow(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>) {
  // A TCP port on this host's loopback ('port-stream-v1'): the primary's own socket only.
  if (cmd.to === 'port') {
    if (!isServerClient(ws)) return streamRelay.open(ws, cmd.sid, null, {}, 'only the Walnut server linked here opens a port stream')
    return streamRelay.openPort(ws, cmd.sid, cmd.port, cmd.host)
  }
  // A terminal on this host ('pty-stream-v1'): the primary's own socket only, as a port stream.
  if (cmd.to === 'pty') {
    if (!isServerClient(ws)) return streamRelay.open(ws, cmd.sid, null, {}, 'only the Walnut server linked here opens a terminal stream')
    return streamRelay.openPty(ws, cmd.sid, cmd)
  }
  const target = streamTarget(ws, cmd.to)
  const purpose = typeof cmd.purpose === 'string' ? cmd.purpose.slice(0, 32) : undefined
  if ('why' in target) return streamRelay.open(ws, cmd.sid, null, {}, target.why)
  streamRelay.open(ws, cmd.sid, target.link, { ...target.meta, ...(purpose ? { purpose } : {}) })
}

function cmdFollowerStatus(ws: ServerWebSocket<WsData>, id: number) {
  const home = ws.data?.followerHome
  const view = home ? followerEntry.view(home) : null
  if (!view) return sendError(ws, id, 'follower.status: send follower.hello first')
  sendOk(ws, id, view)
}

/** Leader sockets that sent server.configure: the first one on a link says the Mac is (back) here. */
const serverConfiguredBy = new WeakSet<object>()
function freshServerLink(ws: object): boolean {
  if (serverConfiguredBy.has(ws)) return false
  serverConfiguredBy.add(ws)
  return true
}

/** The leader, on the socket its leader.configure tagged, sets what runs here for its Walnut. */
function cmdServerConfigure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (!isServerClient(ws)) return sendError(ws, id, 'server.configure: the leader only')
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  if (!home || gatewayClientHomes.get(ws) !== home) return sendError(ws, id, 'server.configure: send leader.configure for this Walnut first')
  const spec = cmd.spec as { walnutId?: unknown } | null | undefined
  if (spec && spec.walnutId !== leaderBook.recordOf(home)?.walnutId) return sendError(ws, id, 'server.configure: the spec names another Walnut')
  try {
    const status = hostServers.configure(home, spec ?? null, { freshLink: freshServerLink(ws) })
    // Its follower is removed: what it last said about same-host sends goes with it.
    if (!spec) followerSaidOnline.delete(home)
    sendOk(ws, id, { status })
  } catch (err) {
    sendError(ws, id, (err as Error).message)
  }
}

function cmdServerStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = ws.data?.origin === 'follower' ? ws.data.followerHome : typeof cmd.home === 'string' ? cmd.home : ''
  if (!home) return sendError(ws, id, 'server.status: missing home')
  if (ws.data?.origin !== 'follower' && refuseForeignHome(ws, id, cmd, 'server.status')) return
  // The daemon's own away answers given while a follower was there for them (followerGateway.noteOwnOffline).
  sendOk(ws, id, { status: hostServers.status(home), offlineAnswers: followerGateway.ownAnswers() })
}

// ── Plugin jobs ('plugin-jobs-v1', plugin-jobs-core.ts) ──
// The leader says which plugin jobs run on this machine for its Walnut; the daemon
// runs each as `<this daemon's program> walnut plugin-job <bundle> <job>` and keeps
// it running. Durable dir (never /tmp), as the host server's.
const PLUGIN_JOBS_DIR = SERVICE_MODE && DAEMON_STATE_DIR
  ? path.join(DAEMON_STATE_DIR, 'plugin-jobs')
  : IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'plugin-jobs') : path.join(DAEMON_DIR, 'plugin-jobs')
/** A job's environment: this daemon's, minus Walnut's own variables, with the shim dir on PATH. */
function pluginJobBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(daemonEnv)) {
    if (typeof v !== 'string' || k.startsWith('WALNUT_') || k.startsWith('OPEN_WALNUT_') || k === 'BUN_BE_BUN') continue
    env[k] = v
  }
  env.PATH = (daemonEnv.PATH || '') + path.delimiter + GATEWAY_SHIM_DIR
  env.HOME = daemonEnv.HOME || HOME_DIR
  return env
}
const pluginJobs = createPluginJobSupervisor({
  fs, path,
  spawn: (command, args, opts) => spawn(command, args, opts),
  dir: PLUGIN_JOBS_DIR,
  keyOf: walnutScope.keyOf,
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (level, msg, data) => logMsg(level, msg, data),
  startTimeOf: readStartTime,
  alive: (pid) => { try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' } },
  bootTime: () => { const up = os.uptime(); return up > 0 ? Date.now() - up * 1000 : null },
  randomToken: () => crypto.randomBytes(32).toString('hex'),
  killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  program: () => ({ command: walnutCliArgv[0]!, args: [...walnutCliArgv.slice(1), 'walnut', 'plugin-job'] }),
  baseEnv: pluginJobBaseEnv,
  gatewaySocket: () => GATEWAY_SOCK_PATH,
  // host-call-entry-v1: the job's run id gets a token of its own, ended with the run.
  callEnv: (home, sid) => hostCallTokens.envFor(home, sid),
  callEnvEnd: (sid) => hostCallTokens.retire(sid),
  sha256File: (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null } },
  maxLogBytes: Number(daemonEnv.WALNUT_PLUGIN_JOB_LOG_MAX_BYTES) || undefined,
  // A test knob: never on the production daemon dir.
  minEveryMs: KEEPS_SESSIONS ? undefined : Number(daemonEnv.WALNUT_PLUGIN_JOB_MIN_EVERY_MS) || undefined,
  maySpawn: () => !demoQuiesce.fenced,
  // A serving job's routes ('plugin-jobs-serve-v1', plugin-job-door.ts); a socket path too deep
  // under the jobs dir goes beside this daemon's gateway socket.
  socketDir: () => path.join(path.dirname(GATEWAY_SOCK_PATH), 'job-sockets'),
  door: createPluginJobDoor({
    fs, net,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }),
})

/** The leader only, on the socket its leader.configure tagged, for its own Walnut. */
function jobsLeaderHome(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, name: string): string | null {
  if (!isServerClient(ws)) { sendError(ws, id, `${name}: the leader only`); return null }
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  if (!home || gatewayClientHomes.get(ws) !== home) { sendError(ws, id, `${name}: send leader.configure for this Walnut first`); return null }
  return home
}

function cmdJobsConfigure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = jobsLeaderHome(ws, id, cmd, 'jobs.configure')
  if (!home) return
  const spec = cmd.spec as { walnutId?: unknown } | null | undefined
  if (!spec || spec.walnutId !== leaderBook.recordOf(home)?.walnutId) return sendError(ws, id, 'jobs.configure: the spec names another Walnut')
  try {
    sendOk(ws, id, pluginJobs.configure(home, spec))
  } catch (err) {
    sendError(ws, id, (err as Error).message)
  }
}

function cmdJobsStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = jobsLeaderHome(ws, id, cmd, 'jobs.status')
  if (!home) return
  sendOk(ws, id, pluginJobs.status(home))
}

function cmdJobsLogs(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = jobsLeaderHome(ws, id, cmd, 'jobs.logs')
  if (!home) return
  try {
    sendOk(ws, id, pluginJobs.logs(home, String(cmd.plugin ?? ''), String(cmd.job ?? ''), cmd.lines))
  } catch (err) {
    sendError(ws, id, (err as Error).message)
  }
}

/** One request to the plugin's serving job of this Walnut ('plugin-jobs-serve-v1'); a refusal says why in `errorKind`. */
function cmdJobsHttp(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = jobsLeaderHome(ws, id, cmd, 'jobs.http')
  if (!home) return
  // Returned, so the command drain counts it as open work (a handover waits for it, a forced one ends it).
  return pluginJobs.http(home, cmd).then(
    (answer) => sendOk(ws, id, answer),
    (err: Error & { code?: string; retryAfterS?: number; level?: 'error' | 'warn' | 'info' }) => sendError(ws, id, err.message, {
      errorKind: err.code || 'internal', ...(typeof err.retryAfterS === 'number' ? { retryAfterS: err.retryAfterS } : {}),
    }, err.code ? err.level ?? 'error' : 'error'),
  )
}

function cmdLeaderClaim(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge') {
    // A named link claims only its own Walnut's lead (never fence another companion).
    const own = bridgeHomeOf(ws)
    if (own && (leaderBook.recordOf(own)?.walnutId !== cmd.walnutId || (typeof cmd.home === 'string' && cmd.home !== own))) {
      return sendError(ws, id, 'leader.claim: another Walnut\'s lead', { errorKind: 'not_owner' })
    }
    const r = leaderBook.backupClaim(cmd.walnutId, cmd.epoch)
    if (!r.ok) return sendFrame(ws, { id, ok: false, error: r.message, errorKind: r.code, epoch: r.epoch })
    return sendOk(ws, id, { epoch: r.record.epoch, holder: r.record.holder })
  }
  if (typeof cmd.home !== 'string' || !cmd.home) return sendError(ws, id, 'leader.claim: missing home')
  if (refuseForeignHome(ws, id, cmd, 'leader.claim')) return
  const rec = leaderBook.primaryClaim(cmd.home)
  if (!rec) return sendError(ws, id, 'leader.claim: send leader.configure first')
  bindGatewayClientHome(ws, rec.home)
  sendOk(ws, id, { epoch: rec.epoch, holder: rec.holder })
}

function cmdLeaderWitness(ws: ServerWebSocket<WsData>, id: number) {
  // A named bridge link hears only its own Walnut.
  const own = bridgeHomeOf(ws)
  const ownId = own ? leaderBook.recordOf(own)?.walnutId : undefined
  const walnuts = leaderBook.witness(primarySocketOpen).filter((w) => !own || w.walnutId === ownId)
  sendOk(ws, id, { walnuts, takeoverMs: LEADER_TAKEOVER_MS })
}

async function cmdLeaderDeliver(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin !== 'bridge') return sendError(ws, id, 'leader.deliver: the cloud bridge only')
  const f = leaderBook.fence(cmd.walnutId, cmd.epoch)
  if (!f.ok) return sendFrame(ws, { id, ok: false, error: f.message, errorKind: f.code, epoch: f.epoch })
  if (!bridgeSpeaksFor(ws, f.home)) return sendError(ws, id, 'leader.deliver: another Walnut\'s companion', { errorKind: 'refused' })
  const delivery = cmd.delivery as LeaderDelivery | undefined
  if (!delivery || typeof delivery !== 'object') return sendError(ws, id, 'leader.deliver: missing delivery')
  const r = await offlineHost.deliverFromLeader(f.home, delivery)
  if (r.ok) return sendOk(ws, id, { result: r.result })
  sendFrame(ws, { id, ok: false, error: r.error.message, errorKind: r.error.code, detail: r.error.detail })
}

async function cmdLeaderSettings(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin !== 'bridge') return sendError(ws, id, 'leader.settings: the cloud bridge only')
  const f = leaderBook.fence(cmd.walnutId, cmd.epoch)
  if (!f.ok) return sendFrame(ws, { id, ok: false, error: f.message, errorKind: f.code, epoch: f.epoch })
  if (!bridgeSpeaksFor(ws, f.home)) return sendError(ws, id, 'leader.settings: another Walnut\'s companion', { errorKind: 'refused' })
  const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
  if (!sid || offlineHost.ownerOf(sid) !== f.home) return sendError(ws, id, 'leader.settings: not a session of this Walnut on this host')
  const r = await liveSettings.apply(sid, { model: cmd.model, effort: cmd.effort })
  if (!r.ok) return sendError(ws, id, 'leader.settings: ' + r.error)
  // The server keeps it on the session's record when it takes this host back.
  offlineHost.noteSettings(f.home, sid, { cliModel: r.cliModel, effort: r.effort })
  sendOk(ws, id, { appliedLive: r.appliedLive, ...(r.reason ? { reason: r.reason } : {}) })
}

/**
 * A session control the cloud companion sends while it leads this host
 * (`leader.control`, 'leader-control-v1'; docs/plan/walnut-control-plane.md
 * "Session controls while the Mac is away"): fenced at the current epoch, for a
 * session of that Walnut on this host, like leader.settings.
 *
 *   permission {requestId, allow, message?, answers?}  answers the pending can_use_tool
 *   mode {mode}                                        set_permission_mode, kept for the Mac
 *   stop {stopRequestId, requestedAt, force?}          the user stop the Mac's terminate sends,
 *                                                      journaled first (the Mac records it by its id)
 */
async function cmdLeaderControl(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin !== 'bridge') return sendError(ws, id, 'leader.control: the cloud bridge only')
  const f = leaderBook.fence(cmd.walnutId, cmd.epoch)
  if (!f.ok) return sendFrame(ws, { id, ok: false, error: f.message, errorKind: f.code, epoch: f.epoch })
  if (!bridgeSpeaksFor(ws, f.home)) return sendError(ws, id, 'leader.control: another Walnut\'s companion', { errorKind: 'refused' })
  const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
  if (!sid || offlineHost.ownerOf(sid) !== f.home) return sendError(ws, id, 'leader.control: not a session of this Walnut on this host')
  const session = sessions.get(sid)
  if (cmd.action === 'permission') {
    const r = await answerPermission(sid, cmd, 'leader.control')
    if (!r.ok) return sendError(ws, id, 'leader.control: ' + r.error, { errorKind: r.errorKind })
    return sendOk(ws, id, { status: 'resolved', requestId: cmd.requestId as string, allow: r.allow })
  }
  if (cmd.action === 'mode') {
    const r = await liveSettings.setMode(sid, cmd.mode)
    if (!r.ok) return sendError(ws, id, 'leader.control: ' + r.error, { errorKind: 'refused' })
    const now = sessions.get(sid)
    if (now) applyModePolicy(now, sid, r.mode as SessionMode)
    // The server keeps it on the session's record when it takes this host back.
    offlineHost.noteSettings(f.home, sid, { mode: r.mode })
    return sendOk(ws, id, { mode: r.mode, appliedLive: r.appliedLive, ...(r.reason ? { reason: r.reason } : {}) })
  }
  if (cmd.action === 'stop') {
    // The stop's id and time come from the companion: the server records the same stop when it is back.
    const stopRequestId = typeof cmd.stopRequestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cmd.stopRequestId) ? cmd.stopRequestId : ''
    const requestedAt = typeof cmd.requestedAt === 'string' && cmd.requestedAt.length <= 40 && Number.isFinite(Date.parse(cmd.requestedAt)) ? cmd.requestedAt : ''
    if (!stopRequestId || !requestedAt) return sendError(ws, id, 'leader.control: a stop needs stopRequestId and requestedAt', { errorKind: 'bad_request' })
    // As the Mac's terminate: a session that keeps scheduled jobs stops only when the user confirms.
    if (session && cmd.force !== true && assembleSessionSnapshot(session).cronActive) {
      return sendError(ws, id, 'leader.control: this session owns scheduled jobs; confirm the stop', { errorKind: 'cron_owner' })
    }
    // A person asked for it on a phone; the session is this Walnut's (ownerOf above).
    const stop = { sid, reason: 'user', home: f.home, initiator: 'human', stopRequestId }
    const refusal = stopOwnerRefusal(sid, stop)
    if (refusal) return sendOk(ws, id, { stopped: false, ...refusal })
    offlineHost.noteStop(f.home, sid, { id: stopRequestId, requestedAt })
    logMsg('info', 'leader.control: stopping a session for the companion', { sid, epoch: cmd.epoch, stopRequestId })
    return cmdStop(ws, id, stop)
  }
  return sendError(ws, id, 'leader.control: unknown action', { errorKind: 'bad_request' })
}

/** The bridge fallback answers only a pending prompt, using the daemon's own tool input. */
async function cmdSessionPermission(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin !== 'bridge') return sendError(ws, id, 'session.permission: the cloud bridge only', { errorKind: 'refused' })
  if (!isJournalSid(cmd.sid)) return sendError(ws, id, 'session.permission: invalid sid', { errorKind: 'bad_request' })
  const owner = sessionStartHomeOf(cmd.sid)
  if (owner && !bridgeSpeaksFor(ws, owner)) return sendError(ws, id, 'session.permission: not a session of this Walnut', { errorKind: 'refused' })
  const r = await answerPermission(cmd.sid, { requestId: cmd.requestId, allow: cmd.allow, message: cmd.message, answers: cmd.answers, optionId: cmd.optionId }, 'session.permission')
  if (!r.ok) return sendError(ws, id, 'session.permission: ' + r.error, { errorKind: r.errorKind })
  return sendOk(ws, id, { status: 'resolved', requestId: cmd.requestId as string, allow: r.allow })
}

/**
 * Answer a session's pending can_use_tool with the line the server would write
 * (live-settings-core.ts permissionAnswer), on the server's own write path
 * (sendRaw), and clear the prompt it answers.
 */
async function answerPermission(sid: string, raw: Record<string, unknown>, label: string): Promise<{ ok: true; allow: boolean } | { ok: false; error: string; errorKind: string }> {
  const session = sessions.get(sid)
  const pending = session?.pendingCtrl ? { reqId: session.pendingCtrl.reqId, request: session.pendingCtrl.request } : null
  const answer = liveSettings.permissionAnswer(pending, { requestId: raw.requestId, allow: raw.allow, message: raw.message, answers: raw.answers, optionId: raw.optionId }, sid)
  if (!answer.ok) return { ok: false, error: answer.error, errorKind: answer.code }
  // Answered here already (a retry after its reply was lost): resolved, nothing written again.
  if (answer.duplicate) {
    logMsg('info', label + ': permission asked again, answered once', { sid, requestId: raw.requestId, allow: answer.allow })
    return { ok: true, allow: answer.allow }
  }
  const wrote = await core.handleSendRawCommand(sid, answer.line)
  if ('error' in wrote || !wrote.ok) return { ok: false, error: 'the session could not be reached', errorKind: 'not_live' }
  liveSettings.noteAnswered(sid, raw.requestId as string, answer.allow)
  const now = sessions.get(sid)
  if (now?.pendingCtrl?.reqId === raw.requestId) {
    now.pendingCtrl = null
    try { persistRegistry() } catch {}
    pushSnapshot(sid, false)
  }
  logMsg('info', label + ': permission answered', { sid, requestId: raw.requestId, allow: answer.allow })
  return { ok: true, allow: answer.allow }
}

/**
 * What the server this daemon started may do for its Walnut while no server
 * answers it ('follower-alone-v1'; docs/plan/walnut-servers-everywhere.md "Host
 * server, leader away"): list that Walnut's sessions here, write to a running
 * one, answer its prompt. A message is journaled for the server that takes this
 * host back (offline-host-core.ts deliverHuman). While a server answers that
 * Walnut, a write is refused: the browser reaches that server, and its own path
 * records the write.
 */
function followerHomeOf(ws: ServerWebSocket<WsData>): string | null {
  const home = ws.data?.followerHome
  return home && followerSockets.get(home) === ws ? home : null
}

/** A follower call's answer on its socket (follower-entry-core.ts FollowerAnswer). */
function sendFollowerAnswer(ws: ServerWebSocket<WsData>, id: number, a: FollowerAnswer) {
  if (a.ok) return sendOk(ws, id, a.result)
  sendError(ws, id, a.error, a.extra)
}

function cmdFollowerSessions(ws: ServerWebSocket<WsData>, id: number) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.sessions: send follower.hello first')
  sendOk(ws, id, followerEntry.sessions(home))
}

/** The slice of the follower's Walnut, for a service that keeps no copy (follower-entry-core.ts slice). */
function cmdFollowerSlice(ws: ServerWebSocket<WsData>, id: number) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.slice: send follower.hello first')
  sendOk(ws, id, followerEntry.slice(home))
}

/**
 * The window a follower's write and gateway routing call the primary away by: the same
 * window the host server routes by (host-server/route.ts LEADER_QUIET_MS) and a host
 * replica's presence (replica/presence.ts), so the page and the daemon agree on "away".
 * One window (docs/plan/walnut-replica-servers-impl.md C4), knob WALNUT_LEADER_QUIET_MS
 * for tests; the rules that read it are follower-entry-core.ts's.
 */
const LEADER_QUIET_MS = envTimerMs(daemonEnv.WALNUT_LEADER_QUIET_MS, 30_000, 500)

async function cmdFollowerSend(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.send: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.send(home, cmd))
}

/** The follower's pick for a trigger fire it was offered (follower-trigger-delivery-core.ts). */
async function cmdFollowerTriggerDeliver(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (!followerHomeOf(ws)) return sendError(ws, id, 'follower.trigger.deliver: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.triggerDeliver(ws, cmd))
}

async function cmdFollowerPermission(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.permission: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.permission(home, cmd))
}

/** A message between two of this Walnut's sessions here that the follower decided ('follower-peer-v1'). */
async function cmdFollowerPeer(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.peer: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.peer(home, cmd))
}

/** The replica's write while the Mac is away ('replica-ops-v1', journal v2). */
async function cmdFollowerOp(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.op: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.op(home, cmd))
}

/**
 * The follower's read of its Walnut's triggers here, and its trigger_test ('follower-triggers-v1'):
 * reads only (a test writes no trigger state), own Walnut only, never in the serial command lane
 * (a check may run for minutes).
 */
function cmdFollowerTriggers(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.triggers: send follower.hello first')
  sendOk(ws, id, followerEntry.triggers(home, cmd))
}

async function cmdFollowerTriggerTest(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.trigger.test: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.triggerTest(home, cmd))
}

/** What is pending for the follower's Walnut (its overlay; read only, own Walnut only). */
function cmdFollowerPending(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.pending: send follower.hello first')
  sendOk(ws, id, followerEntry.pending(home, cmd))
}

// ── A new ask while the Mac is away ('replica-start-v1', host-start-core.ts; WP12) ──
// The Mac pushes its spawn template for its Walnut (leader.spawnTemplate, trusted socket);
// the replica's follower.start fills only its slots, each value validated. The spawn
// journal names the follower's Walnut, so a stop from the Mac after it adopted the
// session is honoured (owner-home-v1).
const hostStart = createHostStart({
  env: daemonEnv, fs, path,
  dir: OFFLINE_HOST_DIR,
  keyOf: walnutScope.keyOf,
  now: () => Date.now(),
  log: (level, msg, data) => logMsg(level, msg, data),
  busy: () => {
    let n = 0
    for (const s of sessions.values()) if (s.state === 'running' && s.foldState?.turnActive) n++
    return n
  },
})

/**
 * The leader's spawn template for its Walnut: the socket its leader.configure tagged only.
 * `use: 'routine'` (clock-host-start-v1): the template a routine run starts from, kept
 * apart from the ask template.
 */
function cmdLeaderSpawnTemplate(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (!isServerClient(ws)) return sendError(ws, id, 'leader.spawnTemplate: the leader only')
  const home = typeof cmd.home === 'string' ? cmd.home : ''
  if (!home || gatewayClientHomes.get(ws) !== home) return sendError(ws, id, 'leader.spawnTemplate: send leader.configure for this Walnut first')
  if (cmd.use !== undefined && cmd.use !== 'ask' && cmd.use !== 'routine') return sendError(ws, id, 'leader.spawnTemplate: use must be ask or routine')
  const use = cmd.use === 'routine' ? 'routine' : 'ask'
  // push-probe-v1: a server asks `{probe: true, hash}` and sends the template (about 200 KB)
  // only when this host does not hold it under that hash. The hash is kept with the template in
  // its file (host-start-core.ts), so a daemon update or restart still holds it (2026-11-13).
  const hash = typeof cmd.hash === 'string' && cmd.hash.length > 0 && cmd.hash.length <= 128 ? cmd.hash : ''
  if (cmd.probe === true) {
    return sendOk(ws, id, { held: !!hash && hostStart.pushHashOf(home, use) === hash })
  }
  try {
    const t = hostStart.setTemplate(home, cmd.template, use, hash || undefined)
    sendOk(ws, id, { builtAt: t.builtAt })
  } catch (err) {
    sendError(ws, id, (err as Error).message)
  }
}

/** Tests only (never in the real daemon dir): die right after a host ask's CLI is spawned, before its record. */
const DIE_AFTER_ASK_SPAWN = !KEEPS_SESSIONS && daemonEnv.WALNUT_TEST_DIE_AFTER_ASK_SPAWN === '1'
/** Tests only (never in the real daemon dir): die right after a routine run's CLI is spawned, before its records. */
const DIE_AFTER_ROUTINE_SPAWN = !KEEPS_SESSIONS && daemonEnv.WALNUT_TEST_DIE_AFTER_ROUTINE_SPAWN === '1'

/** How a start made on this host (a follower's ask, a routine run) runs its CLI: one set for both cores. */
const hostStartSessions = {
  ran: (sid: string) => sessions.has(sid) || livedHere(sid),
  spawn: (home: string, taskId: string, p: HostStartPlan) => sessionStartGate.run(p.sid, () => startSessionProcess({ cmd: 'start', sid: p.sid, args: p.args, cwd: p.cwd, message: p.message, resume: false, mode: p.mode, origin: { home, task: taskId } })),
  stop: (sid: string) => { const s = sessions.get(sid); if (s?.pid) killProcessGroup(s.pid, 'SIGTERM') },
}

/**
 * What this host's own Walnut server asks its daemon (follower-entry-core.ts): the cmdFollower* handlers check the socket speaks for the home and
 * send what it answers.
 */
const followerEntry = createFollowerEntry<ServerWebSocket<WsData>>({
  fs, leaderBook, offline: offlineHost, hostStart,
  primarySocketOpen: (home) => primarySocketOpen(home),
  followerLinked: (home) => followerSockets.has(home),
  bridgeLink: (home) => bridgeLinkFor(home),
  settingsOf: (home) => hostServers.settingsOf(home),
  reportServer: (home, said) => hostServers.report(home, said),
  offlineAnswers: () => followerGateway.ownAnswers(),
  triggerAnswer: (ws, cmd) => followerTriggers.answer(ws, cmd),
  takeoverMs: LEADER_TAKEOVER_MS,
  quietMs: LEADER_QUIET_MS,
  ownsDir: () => ownsDaemonDir(),
  session: (sid) => sessions.get(sid),
  sidTaken: (sid) => sessions.has(sid) || journaledIds().has(sid),
  ...hostStartSessions,
  marker: (sid, text, messageId) => { core.handleAppendUserMarker(sid, text, messageId) },
  answerPermission: (sid, raw, label) => answerPermission(sid, raw, label),
  randomHex: (n) => crypto.randomBytes(n).toString('hex'),
  ...(DIE_AFTER_ASK_SPAWN ? { afterAskSpawn: () => { dieHard() } } : {}),
  log: (level, msg, data) => logMsg(level, msg, data),
})

// A claude-code routine's run while the Mac is away ('clock-host-start-v1',
// clock-host-start-core.ts): the trigger tick hands it a due fire of a clock def with
// `start` (startUnclaimedRun).
const clockHostStart = createClockHostStart({
  hostStart,
  offline: {
    checkRoutineRun: (home, sid) => offlineHost.checkRoutineRun(home, sid),
    noteRoutineTask: (home, rec, opId, jobId) => offlineHost.noteRoutineTaskWaiting(home, rec, opId, jobId),
    noteSession: (home, rec, opId) => offlineHost.noteSessionWaiting(home, rec, opId),
    knowsSession: (home, sid) => offlineHost.knowsSession(home, sid),
  },
  primaryAnswers: (home) => followerEntry.primaryAnswers(home),
  ownsDir: () => ownsDaemonDir(),
  ...hostStartSessions,
  marker: (sid, text, messageId) => { core.handleAppendUserMarker(sid, text, messageId) },
  taskToken: () => START_TASK_TOKEN,
  sha256: (text) => crypto.createHash('sha256').update(text).digest('hex'),
  now: () => Date.now(),
  log: (level, msg, data) => logMsg(level, msg, data),
  ...(DIE_AFTER_ROUTINE_SPAWN ? { afterSpawn: () => { dieHard() } } : {}),
})

/**
 * The replica's new ask while the Mac is away (follower-entry-core.ts start: every check,
 * then the CLI from the template, then its `session` record).
 */
async function cmdFollowerStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const home = followerHomeOf(ws)
  if (!home) return sendError(ws, id, 'follower.start: send follower.hello first')
  sendFollowerAnswer(ws, id, await followerEntry.start(home, cmd))
}

/** The Walnut a session belongs to: the home whose copy lists it. */
function gatewayOwnerHome(callerSid: string): string | undefined {
  // A walnut run outside any session (a terminal, a script, a cron line) names no
  // session; on a daemon that holds one Walnut's copy it is that Walnut's, so while
  // the Mac is away its reads come from the copy and the rest goes to the companion
  // (2026-11-03: such calls answered hub_unreachable while the companion led).
  // With two Walnuts on the host nothing says which, so none; a copy nothing refreshed for
  // weeks (a test run's) is not one of them (gateway-identity-core.ts externalOwner).
  if (callerSid === EXTERNAL_CALLER_SID) {
    return gatewayIdentity.externalOwner(offlineHost.homes(), offlineHost.freshHomes((h) => servedWalnuts.knows(h)), gatewayCandidates(true))
  }
  // The copy names the session, else what this host recorded of the Walnut that asked
  // for it (its spawn, the spawn journal): pinned to its Walnut from its first spawn,
  // whether or not a copy lists it yet (gateway-identity-core.ts).
  return sessionOwnerHome(callerSid)
}

/**
 * The Walnut a session id belongs to on this host: the copy that names it, the record of its spawn,
 * or, for an ACP session, whose worker its runtime id is (the id its `walnut` calls carry: the
 * copy's runtimeId, else the record of the worker's start). 2026-11-25: an Antigravity session's
 * task_send named only its runtime id, so no Walnut was found, the call went to a link that names
 * none (this host's own replica) and its needs_leader came back instead of reaching the Mac.
 */
function sessionOwnerHome(sid: string): string | undefined {
  return offlineHost.ownerOf(sid) || sessionHomeOf(sid) || acpRuntimeHome(sid) || undefined
}

/** The Walnut whose ACP worker `runtimeId` is: the Mac's copy first, else the record of who started it here. */
function acpRuntimeHome(runtimeId: string): string | undefined {
  return offlineHost.runtimeOwnerOf(runtimeId) ?? acpRuntimeOwner(runtimeId)
}

function cmdHostSlice(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  try {
    // A probe (host-slice-probe-v1): the Mac names the copy it would send. Holding it,
    // this daemon binds the socket as if it had come, so a reconnect sends no copy.
    if (cmd.slice === undefined && typeof cmd.home === 'string' && typeof cmd.hash === 'string') {
      if (refuseForeignHome(ws, id, cmd, 'host.slice')) return
      const have = offlineHost.holdsSlice(cmd.home, cmd.hash, cmd.asOf)
      if (have) bindGatewayClientHome(ws, cmd.home)
      return sendOk(ws, id, have ? { have: true, changed: false, pendingHandover: offlineHost.hasRecords(cmd.home) } : { have: false })
    }
    // host-slice-gz-v1: the copy gzipped (a tenth of the bytes on the shared link).
    let slice = (typeof cmd.sliceGz === 'string'
      ? JSON.parse(zlib.gunzipSync(Buffer.from(cmd.sliceGz, 'base64')).toString('utf8'))
      : cmd.slice) as HostSlice
    // A copy from a home its Walnut moved away from is refused, as every command naming it is.
    if (slice && typeof slice.home === 'string' && refuseMovedHome(ws, cmd, slice.home)) return
    // The copy names its Walnut by the home its server has now: it is kept under the first one here.
    const sliceHome = slice && typeof slice.home === 'string' ? walnutScope.canonical(slice.home) : ''
    if (sliceHome && sliceHome !== slice.home) slice = { ...slice, home: sliceHome }
    if (refuseForeignHome(ws, id, { home: slice?.home }, 'host.slice')) return
    const r = offlineHost.configure(slice)
    // host-slice-unbound-v1: a copy sent on the bulk channel names no socket (that
    // socket drops stream frames); the session socket is bound by the probe or leader.configure.
    if (cmd.bind !== false) bindGatewayClientHome(ws, slice.home)
    sendOk(ws, id, { changed: r.changed, pendingHandover: offlineHost.hasRecords(slice.home) })
  } catch (err) {
    sendError(ws, id, 'host.slice: ' + (err as Error).message)
  }
}

/** `kinds` (journal-v2): the v2 kinds the Mac applies; absent, an older Mac's v1 prefix. The reply carries this host's clock. */
function cmdOfflineDrain(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (typeof cmd.home !== 'string' || !cmd.home) return sendError(ws, id, 'offline.drain: missing home')
  if (refuseForeignHome(ws, id, cmd, 'offline.drain')) return
  const kinds = Array.isArray(cmd.kinds) ? cmd.kinds.filter((k): k is string => typeof k === 'string') : null
  const out = offlineHost.drain(cmd.home, kinds)
  // A batch whose freeze could not be saved is never handed out (its ack could not be saved either).
  if (out.error) return sendError(ws, id, 'offline.drain: ' + out.error, { errorKind: 'journal_unwritable', why: out.why })
  if (out.records.length) logMsg('info', 'journal: drained', { home: cmd.home, records: out.records.length, more: out.more, kinds: kinds ? kinds.join(',') : 'v1', firstSeq: out.records[0].seq, lastSeq: out.records[out.records.length - 1].seq })
  sendOk(ws, id, out as unknown as Record<string, unknown>)
}

/** `seqs` (journal-v2) names exactly what the Mac applied or gave up on; `upTo` is an older Mac's watermark. */
function cmdOfflineAck(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const seqs = Array.isArray(cmd.seqs) ? cmd.seqs : undefined
  if (typeof cmd.home !== 'string' || !cmd.home || (typeof cmd.upTo !== 'number' && !seqs)) return sendError(ws, id, 'offline.ack: missing home, seqs or upTo')
  if (refuseForeignHome(ws, id, cmd, 'offline.ack')) return
  // Counted for this Walnut alone: another Walnut's hold of the same id must not hide a change.
  const holdsHere = () => offlineHost.triggerHoldsByHome().get(cmd.home as string)?.size ?? 0
  const held = holdsHere()
  // `now`: the Mac's clock as it acks (a host replica's overlay compares on it, overlay.ts).
  const r = offlineHost.ack(cmd.home, seqs ? { seqs, ...(typeof cmd.now === 'number' ? { leaderNow: cmd.now } : {}) } : (cmd.upTo as number))
  if (r.error) return sendError(ws, id, 'offline.ack: ' + r.error, { errorKind: 'journal_unwritable' })
  logMsg('info', 'journal: acked', { home: cmd.home, ...(seqs ? { seqs: seqs.length } : { upTo: cmd.upTo }), remaining: r.remaining, ...(r.ignored ? { ignored: r.ignored.length } : {}) })
  sendOk(ws, id, r)
  // The server took the trigger changes made here: from now on its set alone
  // decides (a change it refused is undone here too; its push for one it applied follows).
  if (held > 0 && holdsHere() !== held) triggerHoldsChanged()
}

/** A note body a journal record names (journal-v2): at most 2 MB per reply, from `offset`. Trusted only. */
function cmdOfflineBlob(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge' || ws.data?.origin === 'follower') return sendError(ws, id, 'offline.blob: trusted clients only')
  const r = hostJournal.store.readBlob(cmd.sha, cmd.offset)
  if (!r.ok) return sendError(ws, id, 'offline.blob: ' + r.message, { errorKind: r.code })
  sendOk(ws, id, r as unknown as Record<string, unknown>)
}

// The host's copy ('host-replica-v1'): trusted sockets only, like host.slice.
function cmdReplica(ws: ServerWebSocket<WsData>, id: number, op: 'sync' | 'put' | 'drop' | 'status', cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge') return sendError(ws, id, `replica.${op}: trusted clients only`)
  if (refuseForeignHome(ws, id, cmd, `replica.${op}`)) return
  try {
    const home = cmd.home as string
    // `confirm`/`confirmFor` (note-journal-v1): the leader's override of the half rule, bound to its manifest.
    // replica-sync-gz-v1: the manifest's lists may come gzipped (`listsGz`).
    if (op === 'sync') cmd = unpackReplicaSyncLists(cmd)
    if (op === 'sync') return sendOk(ws, id, hostReplica.sync(home, cmd.kind, cmd.entries, cmd.asOf, cmd.opts as Record<string, unknown> | undefined, { confirm: cmd.confirm, confirmFor: cmd.confirmFor }, cmd))
    if (op === 'put') return sendOk(ws, id, hostReplica.put(home, cmd.kind, cmd.files))
    if (op === 'drop') return sendOk(ws, id, hostReplica.drop(home, cmd.kind))
    if (typeof home !== 'string' || !home) return sendError(ws, id, 'replica.status: missing home')
    return sendOk(ws, id, { kinds: hostReplica.status(home) })
  } catch (err) {
    // A refusal the leader reads (manifest_removes_most_rows) carries its code and sizes.
    const e = err as Error & { code?: unknown; detail?: unknown }
    sendError(ws, id, e.message, typeof e.code === 'string' ? { errorKind: e.code, ...(e.detail && typeof e.detail === 'object' ? { detail: e.detail } : {}) } : undefined)
  }
}

// The host's copy of the notes' pictures ('attachment-copy-v1'): trusted sockets only, like replica.*.
function cmdAttachments(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (ws.data?.origin === 'bridge') return sendError(ws, id, `${String(cmd.cmd)}: trusted clients only`)
  if (refuseForeignHome(ws, id, cmd, String(cmd.cmd))) return
  return attachmentCopy.command(cmd.home as string, cmd.cmd, cmd).then((r) => {
    if (r.ok === true) return sendOk(ws, id, r)
    // A refusal the leader reads (offset, hash_mismatch, manifest_removes_most_rows) carries its code and sizes.
    sendError(ws, id, String(r.error ?? 'refused'), r)
  })
}

// ── Follower reads, owner scoped ('replica-reads-v1', follower-reads-core.ts;
// docs/plan/walnut-replica-servers-impl.md WP6). A follower reads its own
// Walnut's sessions, the files under that Walnut's session cwds and this host's
// copy of its notes; anything of another Walnut on this host is not_found.
const followerReads = createFollowerReads({
  path,
  homeDir: HOME_DIR,
  claudeProjectsDirs: [path.join(HOME_DIR, '.claude', 'projects'), ...(daemonEnv.CLAUDE_CONFIG_DIR ? [path.join(daemonEnv.CLAUDE_CONFIG_DIR, 'projects')] : [])],
  streamsDir: STREAMS_DIR,
  realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
  sliceOwner: (sid) => offlineHost.ownerOf(sid),
  // The Mac's copy first (as sliceOwner), else the record of who started the worker here.
  runtimeOwner: (runtimeId) => acpRuntimeHome(runtimeId),
  journalOwner: (sid) => journaledHome(sid),
  liveSessions: () => [...sessions].map(([sid, s]) => ({ sid, cwd: s.cwd })),
  journalSize: () => { try { return fs.statSync(SPAWN_JOURNAL).size } catch { return -1 } },
  readJournal: () => { try { return fs.readFileSync(SPAWN_JOURNAL, 'utf8') } catch { return '' } },
  replica: hostReplica,
  attachments: attachmentCopy,
  denyRoots: () => followerDenyRoots(),
  log: (level, msg, data) => logMsg(level, msg, data),
})
for (const c of followerReads.COMMANDS) FOLLOWER_ALLOWED_COMMANDS.add(c)

/**
 * Where no follower reads through, whatever session cwd lies above (the core's
 * denyRoots): this daemon's own dirs (every Walnut's notes copy, logs, journals),
 * every Walnut's data dir on this host, the CLI's config dirs, the streams dirs.
 */
function followerDenyRoots(): string[] {
  const out = [DAEMON_DIR, REPLICA_DIR, HOST_SERVER_DIR, STREAMS_DIR,
    path.join(HOME_DIR, '.open-walnut'), path.join(HOME_DIR, '.open-walnut-host'), path.join(HOME_DIR, '.claude')]
  // The legacy streams dir is this daemon's only when it is the production one (an isolated daemon never looks there).
  if (IS_PROD_DAEMON_DIR || daemonEnv.WALNUT_LEGACY_STREAMS_DIR) out.push(LEGACY_STREAMS_DIR)
  if (DAEMON_STATE_DIR) out.push(DAEMON_STATE_DIR)
  if (daemonEnv.CLAUDE_CONFIG_DIR) out.push(daemonEnv.CLAUDE_CONFIG_DIR)
  return out.concat(hostServers.dataDirs())
}

/** A session's broadcast reaches a follower of the Walnut that owns it only (every other client as before). */
function followerHears(client: ServerWebSocket<WsData>, sid: string): boolean {
  return client.data?.origin !== 'follower' || followerReads.ownRows(followerHomeOf(client), [{ sid }]).length === 1
}

/** A follower's frame, through the owner scope: true when it was answered here (refused or a copy read). */
function followerScope(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, reply: (frame: DaemonFrame) => void): boolean {
  const d = followerReads.gate(followerHomeOf(ws), cmd)
  if ('pass' in d) {
    // The handler's answer is cut to this Walnut's scope on its way out (okFrame).
    if (d.scope) followerReads.hold(ws, id, d.scope)
    return false
  }
  if ('answer' in d) reply(okFrame(ws, id, d.answer))
  // An ordinary not_found (the core logged it at info): no 'command error' line.
  else if ('refuse' in d) reply({ errorKind: 'not_found', id, ok: false, error: d.refuse })
  else reply(errorFrame(ws, id, d.error))
  return true
}

/** A new server's socket may name its run this long before it binds (its leader.configure follows the hello). */
const GATEWAY_BIND_GRACE_MS = 60_000

/**
 * The server sockets as the gateway's pick sees them (gateway-identity-core.ts), in
 * connect order; `withQuiet` keeps the quiet ones too (who is here, not who may take
 * a call). A socket that named a run moments ago and is not bound yet is `pending`;
 * one that opened moments ago and has named no run yet is `fresh`.
 */
function gatewayCandidates(withQuiet: boolean): Array<GatewaySocketFacts<ServerWebSocket<WsData>>> {
  const now = Date.now()
  const out: Array<GatewaySocketFacts<ServerWebSocket<WsData>>> = []
  for (const client of wsClients) {
    // A quiet client is a dead forward (see pickTrustedClient): never a target.
    if (!isServerClient(client) || (!withQuiet && isQuietTrustedClient(client))) continue
    const bound = gatewayClientHomes.get(client)
    const run = client.data?.serverRun
    const helloAt = client.data?.helloAt
    const connectedAt = client.data?.connectedAt
    const pending = !bound && !!run && helloAt !== undefined && now - helloAt < GATEWAY_BIND_GRACE_MS
    const fresh = !bound && !run && connectedAt !== undefined && now - connectedAt < GATEWAY_BIND_GRACE_MS
    out.push({ socket: client, bound, run, ...(pending ? { pending } : {}), ...(fresh ? { fresh } : {}) })
  }
  return out
}

/** The Walnut a server socket speaks for: its binding, else its server run's (gateway-identity-core.ts). */
function socketWalnut(ws: ServerWebSocket<WsData>): string | undefined {
  return gatewayIdentity.walnutOf(gatewayClientHomes.get(ws), ws.data?.serverRun)
}

/**
 * `home`'s Walnut identifies itself on this host: it pushed a copy, a socket of it was
 * bound (now, or within the week served-walnuts keeps across restarts). Then a socket
 * that names no Walnut is never its.
 */
function walnutPinned(home: string | undefined): boolean {
  return !!home && (offlineHost.hasHome(home) || servedWalnuts.knows(home) || gatewayIdentity.knowsHome(home))
}

/**
 * The server socket a relay for `home` goes to now (null: none may take it). Only a
 * socket of the caller's Walnut: bound to it, or of the same server run as one that is
 * (its bulk channel). A socket of another Walnut never; one that names no Walnut only
 * for a Walnut that never named itself here (an older server), or for a call no Walnut
 * owns. Never the bridge adapter. 2026-11-10: a link that dropped three times in ten
 * minutes sent its sessions' calls to another person's Walnut on the same host, whose
 * bulk socket names none. `say` logs why a server is passed over (the first look at a
 * call, not a resend's).
 */
function gatewayTargetFor(home: string | undefined, say?: { callerSid: string; op: unknown }, seen?: { identifying: number }): ServerWebSocket<WsData> | null {
  const candidates = gatewayCandidates(false)
  const pinned = walnutPinned(home)
  const picked = gatewayIdentity.pick(candidates, home, { pinned, allowUnidentified: !home || !offlineHost.pendingHandover(home) })
  // How many of the sockets passed over may name this Walnut in a moment (gatewayServerIdentifying).
  if (seen) seen.identifying = picked.target === null ? picked.identifying : 0
  let target = picked.target
  if (!target && home && say && (picked.otherWalnut > 0 || picked.unidentified > 0)) {
    logMsg('info', 'gateway: no server of this Walnut connected, other servers not asked', {
      callerSid: say.callerSid, op: say.op, walnut: walnutScope.label(home), otherWalnut: picked.otherWalnut, unidentified: picked.unidentified,
    })
  }
  // While the companion leads this Walnut its primary's sockets are silent
  // (that is how the lead was won): no target until the primary takes it back.
  if (home && leaderBook.backupLead(home)) target = null
  // A primary that has missed beats (a Mac asleep with its socket open) is away
  // for every call, as it is once the socket closes: what this host does itself
  // (reads, its own task and Board writes, messages between its sessions) is done
  // here at once and journaled, the rest goes to the companion while it leads or
  // is refused at once, never after a timeout. Nothing was sent to it, so nothing
  // is applied twice; its first pong makes it the target again.
  if (target && (target.data?.missedBeats ?? 0) >= GATEWAY_SILENT_BEATS) {
    if (say) logMsg('info', 'gateway: primary silent, answering here', { callerSid: say.callerSid, op: say.op, missedBeats: target.data?.missedBeats })
    target = null
  }
  // A follower is linked: the same quiet window as its writes (followerEntry.quietWithFollower).
  if (target && home && followerEntry.quietWithFollower(home)) {
    if (say) logMsg('info', 'gateway: primary quiet, answering here', { callerSid: say.callerSid, home, op: say.op, quietMs: LEADER_QUIET_MS })
    target = null
  }
  return target
}

/**
 * Servers are connected, and each has said whose Walnut it is: a call naming no Walnut has none to go
 * to (the pick takes a socket that names none, a starting one included). False with no server at all.
 */
function gatewayOnlyNamedWalnuts(): boolean {
  const picked = gatewayIdentity.pick(gatewayCandidates(false), undefined, { pinned: false, allowUnidentified: true })
  return picked.target === null && picked.otherWalnut > 0
}

/**
 * No server of `home`'s Walnut takes calls now, but one may in a moment: a socket between
 * its hello and its bind, or one that just opened and has named no run yet (a server
 * starting).
 */
function gatewayServerIdentifying(home: string | undefined): boolean {
  const seen = { identifying: 0 }
  gatewayTargetFor(home, undefined, seen)
  return seen.identifying > 0
}

/**
 * No server of the call's Walnut may take it, and nothing was sent: retryable. Says
 * so when servers of another Walnut are connected here, so nobody reads it as this
 * host having no server at all.
 */
function gatewayNoServerError(home: string | undefined): GatewayResponse {
  let others = false
  if (home) {
    for (const client of wsClients) {
      if (isServerClient(client) && !gatewayIdentity.sameWalnut(socketWalnut(client), home)) { others = true; break }
    }
  }
  return gatewayError('hub_unreachable', others
    ? 'no primary server connected for this session\'s Walnut (another Walnut\'s server on this host was not asked); nothing was sent, try again'
    : 'no primary server connected')
}

/** A call waits for this host's own Walnut server at most this long from its first wait (waitForFollower). */
const FOLLOWER_WAIT_MS = 15_000
/** ...looking again this often (the leader's quiet window ends with no event), or when a follower says hello. */
const FOLLOWER_WAIT_STEP_MS = 500
/** ...and never into the last of the call's time the server needs to run it: a start's budget (replica/local-calls.ts START_LEFT_MS) and margins. */
const FOLLOWER_WAIT_SPARE_MS = 12_000
/** After a wait that ran out, new calls do not wait for this long (followerWaitMissed). */
const FOLLOWER_MISS_HOLD_MS = 60_000

function sendGatewayRequest(
  capability: string,
  callerSid: string,
  payload: Record<string, unknown>,
  respond: (resp: GatewayResponse) => void,
  plan: GatewayCallPlan & { ownServerAsked?: boolean; ownAnswerNoted?: boolean; followerBy?: number; home?: string; silentSince?: number } = gatewayCallPlan(undefined, gatewayHubTimeoutMs(), Date.now()),
) {
  // `home`: the Walnut the daemon itself knows the call is for (a trigger check's run), else the caller's.
  const home = plan.home || gatewayOwnerHome(callerSid)
  // Why a server is passed over is logged on a call's first look, not on each look of a wait.
  let target = gatewayTargetFor(home, plan.followerBy === undefined ? { callerSid, op: payload.name } : undefined)
  // A read that fell to this host's service (relayAttemptEnded) passes its silent leader by until it is heard.
  if (target && passesSilentLeader(plan.silentSince, target.data?.lastHeardAt)) target = null
  const deadline = plan.deadline
  // A relayed read this host can answer from its copy does not end in a timeout:
  // nothing is applied twice by reading.
  const noOwn = ownAnswersOff(home)
  const readable = !noOwn && !!home && capability === 'tools.call' && offlineHost.hasHome(home) && offlineHost.answersRead(payload.name, home)
  // A call from outside any session (a person's terminal on this host) is answered away only when
  // it reads: a write this host journals names a session for the Mac to replay, and this has none.
  const external = callerSid === EXTERNAL_CALLER_SID
  // No leader to relay to, or one still taking this host's journal: the call is this host's own
  // Walnut server's (follower-gateway-core.ts), a session's and an outside caller's read alike. It
  // comes back to the rules below when it hands it back.
  const followers = !!home && (!target || offlineHost.pendingHandover(home)) && (!external || readable) && !plan.ownServerAsked
  if (home && followers && followerGateway.answers(home)) {
    const fallback = () => sendGatewayRequest(capability, callerSid, payload, respond, { ...plan, ownServerAsked: true })
    const left = () => gatewayCallerLeft.get(respond)?.() === true
    // Without a copy (ownAnswersOff) the follower's refusal is the caller's answer: never handed back.
    if (followerGateway.handOff({ home, capability, callerSid, payload, deadline, readable, fallback, left, ...(noOwn ? { noOwnAnswer: true as const } : {}) }, (r) => respond(r as GatewayResponse))) return
  }
  // The daemon's own away answer, counted once per call: a call that waits and comes again is not counted again.
  let noted = false
  const noteOwn = () => {
    if (!home || plan.ownAnswerNoted || noted) return
    noted = true
    followerGateway.noteOwnOffline(home, capability, callerSid, payload, plan.ownServerAsked)
  }
  // No server now and nothing sent: a call that may wait does, while it has time
  // (a deploy's restart, a link dialing again), then goes as if it had just come. A call
  // that named no wait (an older client) still waits a moment while a server socket is here
  // that has not said whose Walnut it is yet (a server starting): GATEWAY_IDENTIFY_WAIT_MS
  // from its arrival, a relay then keeping the whole hub timeout. Never a list, nor a call
  // whose client chose not to wait (waitMs 0).
  const again = (p: typeof plan) => () => sendGatewayRequest(capability, callerSid, payload, respond, noted ? { ...p, ownAnswerNoted: true } : p)
  const waitHere = (): boolean => {
    if (plan.waits) return waitForPrimary(deadline, again(plan), respond)
    const soon = capability === 'tools.call' ? gatewayIdentifyPlan(plan, gatewayHubTimeoutMs(), GATEWAY_IDENTIFY_WAIT_MS, Date.now()) : null
    return !!soon && gatewayServerIdentifying(home) && waitForPrimary(soon.plan.deadline, again(soon.plan), respond, soon.atMostMs)
  }
  // This host has a follower for the call that does not answer now (its server restarting, not linked
  // yet, or the leader's quiet window not over): the call waits for it within its own time, and goes
  // again when it says hello or a step later. The daemon's own away answer below is for a host with no
  // follower, or a call whose wait is over (FOLLOWER_WAIT_MS, or what the server needs of its time left).
  const waitForFollower = (): boolean => {
    if (!home || plan.never || plan.ownServerAsked || !followerHere(home).kept) return false
    const now = Date.now()
    if (plan.followerBy === undefined && now - (followerWaitMissed.get(home) ?? -Infinity) < FOLLOWER_MISS_HOLD_MS) return false
    const by = plan.followerBy ?? now + FOLLOWER_WAIT_MS
    const room = Math.min(by, deadline - FOLLOWER_WAIT_SPARE_MS) - now
    if (room <= 0 || !followerHere(home).dueBy(now + room)) {
      // A wait that ran out: the next calls answer at once for a while (followerWaitMissed).
      if (plan.followerBy !== undefined) followerWaitMissed.set(home, now)
      return false
    }
    if (plan.followerBy === undefined) logMsg('info', 'gateway: waiting for this host\'s Walnut server', { capability, callerSid, op: payload.name, leftMs: deadline - now })
    return waitForPrimary(deadline, again({ ...plan, followerBy: by }), respond, Math.min(FOLLOWER_WAIT_STEP_MS, room))
  }
  if (followers && waitForFollower()) return
  // An outside caller's other calls go to the companion while it leads.
  if (external && home && !target && !readable) {
    if (forwardToBackup(home, capability, callerSid, payload, respond)) return
    if (waitHere()) return
    logMsg('info', 'gateway: no server connected', { capability, callerSid })
    return respond(gatewayNoServerError(home))
  }
  // The service in this process keeps no copy: never the daemon's own away answer below. Its follower
  // not seated yet (the service starting): retryable at once, nothing ran. Seated but not allowed to
  // write yet (the leader's quiet window not over), or a call it left: looked at again each step
  // within the call's own time, then no server.
  if (home && noOwn && (!target || (offlineHost.pendingHandover(home) && !external))) {
    if (!followerGateway.answers(home) && !followerHere(home).linked && !plan.ownServerAsked) {
      logMsg('info', 'gateway: this host\'s Walnut service is not seated yet', { capability, callerSid, op: payload.name })
      return respond(serviceStartingAnswer())
    }
    if (!plan.never && !plan.ownServerAsked && waitForPrimary(deadline, again(plan), respond, FOLLOWER_WAIT_STEP_MS)) return
    return respond(gatewayNoServerError(home))
  }
  // Answer here while the Walnut is away, and while its server is still taking
  // the handover: an id it has not imported yet must never reach it. An outside
  // caller's write still goes to that server, which drains this host first.
  if (home && (!target || (offlineHost.pendingHandover(home) && (!external || readable))) && offlineHost.hasHome(home)) {
    // A search goes to the companion first while it leads: its copy holds every
    // task, this host's only its own. Answered here when the companion cannot.
    if (!target && capability === 'tools.call' && payload.name === 'search') {
      const here = () => {
        noteOwn()
        void offlineHost.handle(home, callerSid, capability, payload).then((r) => respond(r as GatewayResponse))
      }
      if (forwardToBackup(home, capability, callerSid, payload, (resp) => { if (resp.ok) respond(resp); else here() })) return
      logMsg('info', 'gateway: answered offline', { capability, callerSid, op: 'search', serverConnected: false })
      here()
      return
    }
    logMsg('info', 'gateway: answered offline', { capability, callerSid, op: typeof payload.name === 'string' ? payload.name : undefined, serverConnected: !!target })
    // Nothing could take it (this host, the companion, a server within the call's time): a
    // message or a memory write is held here for the server, and the caller hears "queued"
    // (offline-host-core.ts holdWrite). Any other answer goes back as it is.
    const unreachable = (r: GatewayResponse) => !r.ok && r.error.code === 'hub_unreachable' && !target
    const heldOr = (r: GatewayResponse) => respond(unreachable(r) ? (offlineHost.holdWrite(home, callerSid, capability, payload) as GatewayResponse | null) ?? r : r)
    noteOwn()
    void offlineHost.handle(home, callerSid, capability, payload).then((r) => {
      // What this host cannot answer itself goes to the companion while it
      // leads (a message to another host, a task outside the copy).
      if (unreachable(r as GatewayResponse)
        && forwardToBackup(home, capability, callerSid, payload, (b) => { if (unreachable(b) && waitHere()) return; heldOr(b) })) return
      // Not this host's to answer, and no server now: wait for one while the call has time.
      if (unreachable(r as GatewayResponse) && waitHere()) return
      heldOr(r as GatewayResponse)
    })
    return
  }
  if (!target) {
    // A call that names no Walnut while only other Walnuts' servers are here: no server would take it,
    // however long it waits (2026-11-25: a shared host's outside calls waited 90 s each). Told at once.
    if (!home && external && gatewayOnlyNamedWalnuts()) {
      logMsg('info', 'gateway: an outside call names no Walnut, and this host serves more than one', { capability, op: payload.name })
      return respond(gatewayError('unknown_caller', 'this host serves more than one Walnut and this call, from outside any session, names none; nothing was sent. Run it from a session or a trigger check of the Walnut you mean'))
    }
    if (waitHere()) {
      logMsg('info', 'gateway: no server connected, waiting for one', { capability, callerSid, leftMs: deadline - Date.now() })
      return
    }
    logMsg('info', 'gateway: no server connected', { capability, callerSid })
    return respond(gatewayNoServerError(home))
  }
  // A message between two of this Walnut's sessions on this host is delivered
  // here even while the server answers: the server would only send it back to
  // this daemon. What this host cannot take for sure goes to the server as before.
  if (home && !external && offlineHost.hasHome(home)) {
    const primary = target
    // This host's own Walnut server takes it when it answers same-host sends (replica/away-sends.ts),
    // with the message id set here; whatever it leaves goes to the server, never to handleLocal.
    // One side writes it (offline-host-core.ts openOnline/endOnline): a relay never follows a
    // follower.peer write of it, and a follower.peer after the relay is refused.
    if (followerGateway.answersOnline(home) && offlineHost.localCandidate(home, callerSid, capability, payload)) {
      const relay = () => relayToPrimary(primary, home, capability, callerSid, payload, respond, readable, deadline)
      if (!offlineHost.openOnline(home, payload)) return relay()
      // Ended with nothing written here: to the leader that answers NOW, never to one whose link
      // closed meanwhile (a relay on a dead socket, with the hand-off's time spent, is lost). With
      // none, the call goes as any call with no leader, not to the follower again (its hand-off
      // ended, so its late follower.peer is refused): this host's own away answer, written once.
      const ended = () => {
        void offlineHost.endOnline(home, payload).then((r) => {
          if (r) return respond(r as GatewayResponse)
          const leader = gatewayTargetFor(home)
          if (leader) return relayToPrimary(leader, home, capability, callerSid, payload, respond, readable, deadline)
          sendGatewayRequest(capability, callerSid, payload, respond, { ...plan, ownServerAsked: true })
        })
      }
      if (followerGateway.handOff({ home, capability, callerSid, payload, deadline, online: true, fallback: ended }, (r) => respond(r as GatewayResponse))) return
      return ended()
    }
    // A follower that takes same-host sends (it said so last, its `host_call_entry` experiment on) and
    // is not linked this moment (a restart): the send waits for it, as a call with no leader does.
    if (followerSaidOnline.get(home) === true && offlineHost.localCandidate(home, callerSid, capability, payload) && waitForFollower()) return
    // The service without a copy: the leader delivers it (ownAnswersOff), never handleLocal.
    if (noOwn) return relayToPrimary(primary, home, capability, callerSid, payload, respond, readable, deadline)
    // What this host's follower said: it is linked, or kept here and away.
    const kept = followerHere(home).kept
    const linked = followerGateway.answersOnline(home)
    void offlineHost.handleLocal(home, callerSid, capability, payload).then((r) => {
      if (r) {
        logMsg('info', 'gateway: delivered on this host', { capability, callerSid, op: payload.name, ok: r.ok })
        // The daemon's own same-host delivery although this host has a follower (noteOwnAnswer): one
        // that takes these (linked, or away past the wait), or one that does not take them.
        if (linked || kept) followerGateway.noteOwnAnswer(payload.name, linked ? 'follower_linked' : followerSaidOnline.get(home) === true ? 'follower_away' : 'same_host', callerSid)
        return respond(r as GatewayResponse)
      }
      relayToPrimary(primary, home, capability, callerSid, payload, respond, readable, deadline)
    }, () => {
      // Nothing was delivered here (a delivery failure is caught inside): the server's.
      relayToPrimary(primary, home, capability, callerSid, payload, respond, readable, deadline)
    })
    return
  }
  relayToPrimary(target, home, capability, callerSid, payload, respond, readable, deadline)
}

/** Calls waiting for a server of their Walnut (nothing of them was sent yet). */
const gatewayWaiting = new Set<{ retry: () => void; respond: (resp: GatewayResponse) => void; timer: ReturnType<typeof setTimeout> | undefined }>()

/**
 * Park a call until a server says hello, names its Walnut or speaks again after
 * missed beats (wakeGatewayCalls), or until it must go anyway: a relay still gets
 * GATEWAY_MIN_RELAY_MS of the call's time (or after `atMostMs`, when sooner).
 * False when there is no time to wait. A call whose caller left meanwhile goes
 * nowhere (`saysLeft` logs it).
 */
function waitForPrimary(
  deadline: number, retry: () => void, respond: (resp: GatewayResponse) => void, atMostMs = Number.POSITIVE_INFINITY,
  saysLeft: () => void = () => logMsg('info', 'gateway: a waiting call ends, its caller left; nothing was sent'),
): boolean {
  const left = deadline - GATEWAY_MIN_RELAY_MS - Date.now()
  if (left <= 0 || daemonCommands.closed) return false
  // Its caller hung up while it waited (a ^C, a client that gave up): nothing of it was sent,
  // nobody reads the answer, so it goes nowhere (a retry of the caller's would run it twice).
  const go = () => {
    if (gatewayCallerLeft.get(respond)?.() === true) return saysLeft()
    retry()
  }
  const w: { retry: () => void; respond: (resp: GatewayResponse) => void; timer: ReturnType<typeof setTimeout> | undefined } = { retry: go, respond, timer: undefined }
  w.timer = setTimeout(() => { if (gatewayWaiting.delete(w)) go() }, Math.min(left, atMostMs))
  gatewayWaiting.add(w)
  return true
}

/**
 * Leave the restart mark when a successor takes this dir over (a production
 * daemon: an update, a handover, a service restart), so a `walnut` call in the
 * seconds between waits for it (daemon-restart-mark.ts). Never for an isolated
 * daemon, and never once daemon.pid names another daemon: that successor is up.
 */
function noteRestarting(): void {
  if (shouldReapOnExit()) return
  try {
    const owner = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (owner > 0 && owner !== process.pid) return
    fs.writeFileSync(RESTART_MARK_FILE, restartMarkText(Date.now()))
  } catch { /* a convenience: without it the calls fail at once, as before */ }
}

/** A handover that did not happen: this daemon carries on, so nothing waits for another. */
function clearRestartMark(): void {
  try { fs.unlinkSync(RESTART_MARK_FILE) } catch {}
}

/** The daemon stops: the waiting calls are told now (nothing of them was sent) rather than cut off. */
function releaseGatewayWaiters(): void {
  for (const w of [...gatewayWaiting]) {
    gatewayWaiting.delete(w)
    clearTimeout(w.timer)
    // `stopping`: a CLI that finds the restart mark waits for the next daemon (wn-cli.ts requestRidingRestart).
    w.respond(gatewayError('hub_unreachable', 'the daemon is restarting; nothing was sent, try again', { stopping: true }))
  }
}

/**
 * The daemon stops with relays still at the server (their answers did not come while it
 * drained): each caller is told now rather than cut off with no word. A read (this host's
 * copy answers it, or the server named it read-only) is `stopping`, so a CLI that finds
 * the restart mark sends it again to the next daemon. Anything else may have run there:
 * `hub_timeout`, the answer that did not come back, so every client says "do not run it
 * again" (and names a host_exec job to read) and none sends it another way.
 */
function releaseGatewayRelays(): void {
  if (gatewayRelayPending.size === 0) return
  // The mark fresh again: a long drain must not age it past what a read waits for.
  noteRestarting()
  for (const [relayId, entry] of [...gatewayRelayPending]) {
    gatewayRelayPending.delete(relayId)
    clearTimeout(entry.timer)
    const read = !!entry.call && (entry.call.readable || !!entry.call.readOnly)
    entry.respond(read
      ? gatewayError('hub_unreachable', 'the daemon is restarting; this read was not answered, try again', { stopping: true })
      : gatewayError('hub_timeout', 'the daemon restarted while the Walnut server had this call: it may have run, so check before running it again'))
  }
}

/** A server may take calls now: the waiting ones go, and relays whose socket closed go again. */
function wakeGatewayCalls(): void {
  wakeWaitingCalls()
  for (const [relayId, entry] of gatewayRelayPending) {
    if (!entry.call || entry.call.sentOn) continue
    const next = relayResendTarget(entry.call)
    if (next) sendRelayAttempt(relayId, next)
  }
}

/** The calls waiting for a server (waitForPrimary) go again now, each by the rules as it finds them. */
function wakeWaitingCalls(): void {
  for (const w of [...gatewayWaiting]) {
    gatewayWaiting.delete(w)
    clearTimeout(w.timer)
    w.retry()
  }
}

/** Where a relay may go again now: the primary of its Walnut, when relayMayResendTo allows it. */
function relayResendTarget(call: GatewayRelayCall): ServerWebSocket<WsData> | null {
  const target = gatewayTargetFor(call.home)
  return target && relayMayResendTo(call, target.data?.serverRun, serverReadsOp(target, call)) ? target : null
}

/** The server behind `ws` names this call's op read-only in its hello: it may run it whatever ran before. */
function serverReadsOp(ws: ServerWebSocket<WsData>, call: GatewayRelayCall): boolean {
  const name = call.payload.name
  return call.capability === 'tools.call' && typeof name === 'string' && !!ws.data?.readOps?.has(name)
}

/** The socket a relay went out on closed: it goes again at once where it may, else when a server says hello. */
function gatewayRelaysSocketGone(ws: ServerWebSocket<WsData>): void {
  for (const [relayId, entry] of gatewayRelayPending) {
    if (!entry.call || entry.call.sentOn !== ws) continue
    entry.call.sentOn = null
    const next = relayResendTarget(entry.call)
    if (next) sendRelayAttempt(relayId, next)
  }
}

function relayToPrimary(
  target: ServerWebSocket<WsData>,
  home: string | undefined,
  capability: string,
  callerSid: string,
  payload: Record<string, unknown>,
  respond: (resp: GatewayResponse) => void,
  readable: boolean,
  deadline: number = Date.now() + gatewayHubTimeoutMs(),
  caller?: GatewayCaller,
) {
  // A cold daemon asks for one catalog per Walnut at a time; the rest go once it is held.
  const resume = () => relayToPrimary(gatewayTargetFor(home) ?? target, home, capability, callerSid, payload, respond, readable, deadline, caller)
  if (heldCatalogs.wait(home, capability, payload, resume)) return
  const relayId = ++gatewayRelayCounter
  // A schemas tools.list names the catalogs held for its Walnut (held-catalogs-core.ts).
  payload = heldCatalogs.ask(home, capability, payload)
  const call: GatewayRelayCall = { home, capability, callerSid, payload, readable, deadline, sentOn: null, attempts: 0, pinned: walnutPinned(home), ...(caller ? { caller } : {}) }
  gatewayRelayPending.set(relayId, { respond, timer: undefined, call })
  sendRelayAttempt(relayId, target)
}

/** Send relay `relayId` to `target` and time this attempt (relayAttemptEnded). */
function sendRelayAttempt(relayId: number, target: ServerWebSocket<WsData>): void {
  const entry = gatewayRelayPending.get(relayId)
  const call = entry?.call
  if (!entry || !call) return
  clearTimeout(entry.timer)
  if (call.attempts === 0) {
    call.run = target.data?.serverRun
    // A server that names no run (an older one) is never sent a relay twice: its call ends
    // when it always did, not at the end of the time the CLI gave it.
    if (!call.run && !call.readable) call.deadline = Math.min(call.deadline, Date.now() + gatewayHubTimeoutMs())
  }
  call.sentOn = target
  call.sentAt = Date.now()
  call.attempts += 1
  call.readOnly = serverReadsOp(target, call)
  entry.timer = setTimeout(() => relayAttemptEnded(relayId), relayAttemptMs(call.deadline, Date.now(), gatewayHubTimeoutMs()))
  logMsg('info', call.attempts === 1 ? 'gateway: relaying to primary server' : 'gateway: relaying to primary server again', {
    relayId, capability: call.capability, callerSid: call.callerSid, attempt: call.attempts, to: wsId(target),
  })
  // The instance id makes (instance, relayId) unique across daemon restarts: the server runs a relay once by it.
  // `busyAgain`: this host asks a busy call again; it paid its write at its first ask (capability-router.ts).
  // `caller`: the plugin job that made it, the field the follower gets (follower-gateway-core.ts GatewayCaller).
  // `callerWaitsMs`: how long its caller still waits (an answer is taken until then, on any attempt).
  sendEvent(target, 'gateway-request', {
    relayId, instanceId: DAEMON_INSTANCE_ID, capability: call.capability, callerSid: call.callerSid, payload: call.payload,
    callerWaitsMs: Math.max(0, call.deadline - Date.now()),
    ...(call.busyAgain ? { busyAgain: call.busyAgain } : {}),
    ...(call.caller ? { caller: call.caller } : {}),
  })
}

/** Less time left than this, a relay is not sent again. */
const GATEWAY_RESEND_MIN_MS = 2_000

/**
 * At the end of an attempt (relayAttemptEnded), a read relayed for this host's service without a copy
 * whose leader is not heard (its socket closed under the relay and no leader took it again, or silent
 * since the attempt went out): the service answers it now (its slice, or
 * no_copy; gateway-core.ts readFallsToService), and the call passes that leader by until it is heard
 * again (passesSilentLeader). A write keeps waiting for the leader: it may have run there. A plugin
 * job's call (`caller`) keeps its own route (routeJob), which this one would not carry. Never at the
 * socket's close itself: a leader that redials within the attempt (a link blip) answers the read. True when it fell.
 */
function relayFellToService(relayId: number): boolean {
  const entry = gatewayRelayPending.get(relayId)
  const call = entry?.call
  if (!entry || !call || !call.home || call.caller || call.sentAt === undefined) return false
  const heard = !!call.sentOn && (call.sentOn.data?.lastHeardAt ?? 0) > call.sentAt
  if (!readFallsToService({ readOnly: !!call.readOnly, withoutCopy: ownAnswersOff(call.home), leaderHeardSinceSent: heard, leftMs: call.deadline - Date.now(), minRelayMs: GATEWAY_MIN_RELAY_MS })) return false
  gatewayRelayPending.delete(relayId)
  clearTimeout(entry.timer)
  logMsg('info', 'gateway: the leader did not answer a read; this host\'s service answers it', { relayId, callerSid: call.callerSid, op: call.payload.name, attempts: call.attempts, closed: !call.sentOn })
  sendGatewayRequest(call.capability, call.callerSid, call.payload, entry.respond, { deadline: call.deadline, waits: true, home: call.home, silentSince: call.sentAt })
  return true
}

/**
 * An attempt had no answer in time. With time left the relay goes again where it
 * may (the same server run, which answers it once), or waits for a server to say
 * hello; at the call's end it is answered as before: from the copy for a read,
 * else hub_timeout.
 */
function relayAttemptEnded(relayId: number): void {
  const entry = gatewayRelayPending.get(relayId)
  const call = entry?.call
  if (!entry || !call) return
  const left = call.deadline - Date.now()
  // A read of this host's service without a copy whose leader went silent under it: the service answers it.
  if (relayFellToService(relayId)) return
  if (left >= GATEWAY_RESEND_MIN_MS) {
    const next = relayResendTarget(call)
    if (next) return sendRelayAttempt(relayId, next)
    call.sentOn = null
    entry.timer = setTimeout(() => relayAttemptEnded(relayId), left)
    return
  }
  gatewayRelayPending.delete(relayId)
  // A schemas tools.list whose catalog is still on its way is held when it lands (held-catalogs-core.ts).
  heldCatalogs.timedOut(relayId, call.home, call.capability, call.payload, !!call.pinned)
  // Never for a service without a copy: its relays are never `readable` (sendGatewayRequest noOwn).
  if (call.readable && call.home) {
    logMsg('info', 'gateway: primary timed out, reading from the copy', { relayId, callerSid: call.callerSid, op: call.payload.name, attempts: call.attempts })
    // The daemon's own answer although this host has a follower: that server's reads go to the same
    // leader while it answers, so it would be as late (replica/dispatch.ts), and it refuses a call
    // while it sees the leader answer (replica/local-calls.ts `leader_answers`). Counted.
    if (followerHere(call.home).kept) followerGateway.noteOwnAnswer(call.payload.name, 'read_late', call.callerSid)
    void offlineHost.handle(call.home, call.callerSid, call.capability, call.payload).then((r) => entry.respond(r as GatewayResponse))
    return
  }
  logMsg('info', 'gateway: primary timed out', { relayId, callerSid: call.callerSid, op: call.payload.name, attempts: call.attempts })
  entry.respond(gatewayError('hub_timeout', 'primary server timed out'))
}

// A relay is answered by whom it went to: the trusted walnut client, or, for a
// relay handed to the companion while it leads (via: 'bridge'), the bridge.
// So `gateway-result` is on the bridge allowlist, and a bridge answer to a relay
// it was never sent is refused here.
function cmdGatewayResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, error, errorCode, detail } = cmd as {
    relayId?: number; error?: string
    errorCode?: string; detail?: unknown
  }
  // How Walnut's API answered the op (a server that sends it), for a check run's machine faults.
  const api = gatewayApiAnswerOf(cmd.api)
  // gateway-result-gz-v1: a big answer's result comes gzipped.
  let result = cmd.result as Record<string, unknown> | undefined
  if (typeof cmd.resultGz === 'string') {
    try {
      // At most the frame cap unpacked: the server sends a bigger answer as an error, never gzipped.
      result = JSON.parse(zlib.gunzipSync(Buffer.from(cmd.resultGz, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')) as Record<string, unknown>
    } catch (err) {
      return sendError(ws, id, 'gateway-result: resultGz is not gzipped JSON: ' + (err as Error).message)
    }
  }
  // A call handed to this host's own Walnut server (follower-gateway-core.ts): only its socket answers it.
  if (ws.data?.origin === 'follower') {
    const taken = typeof relayId === 'number' ? followerGateway.settle(ws, relayId, followerGateway.responseOf({ result, error, errorCode, detail, api })) : 'stale'
    if (taken === 'wrong_socket' || (taken === 'stale' && gatewayRelayPending.has(relayId as number))) return sendError(ws, id, 'gateway-result: not sent to this socket')
    return sendOk(ws, id, taken === 'stale' ? { stale: true } : {})
  }
  const pending = typeof relayId === 'number' ? gatewayRelayPending.get(relayId) : undefined
  if (pending && ((ws.data?.origin === 'bridge') !== (pending.via === 'bridge') || (pending.bridge && pending.bridge !== ws))) {
    logMsg('warn', 'gateway: result from a socket the relay was not sent to', { relayId, fromBridge: ws.data?.origin === 'bridge' })
    return sendError(ws, id, 'gateway-result: not sent to this socket')
  }
  // A relay to a Walnut's server is answered by a socket of that Walnut only
  // (gateway-identity-core.ts): another Walnut's server never settles its call.
  if (pending?.call && ws.data?.origin !== 'bridge'
    && !gatewayIdentity.mayAnswer(gatewayClientHomes.get(ws), ws.data?.serverRun, pending.call.home, !!pending.call.pinned)) {
    logMsg('warn', 'gateway: result from another Walnut\'s server refused', { relayId, walnut: walnutScope.label(pending.call.home) })
    return sendError(ws, id, 'gateway-result: not this Walnut\'s relay', { errorKind: 'not_owner' })
  }
  if (!pending) {
    // Late result after timeout: ack and drop (same as cmdLaunchResult). A late full tool
    // catalog is still held, so the caller's next ask is answered by its hash (held-catalogs-core.ts).
    if (typeof relayId === 'number' && result && !error && ws.data?.origin !== 'bridge'
      && heldCatalogs.late(relayId, result, (home, pinned) => gatewayIdentity.mayAnswer(gatewayClientHomes.get(ws), ws.data?.serverRun, home, pinned))) {
      logMsg('info', 'gateway: a tool catalog that came after its relay timed out is held', { relayId })
    }
    return sendOk(ws, id, { stale: true })
  }
  gatewayRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    // A relay to the primary of a schemas tools.list: a held catalog the server named by its
    // hash, or one to hold (held-catalogs-core.ts). The bridge's relays carry no `have`.
    const held = pending.call ? heldCatalogs.settle(pending.call.home, pending.call.capability, pending.call.payload, result) : { result }
    if ('again' in held) heldCatalogAskAgain(relayId as number, pending.call as GatewayRelayCall, held.again, pending.respond)
    else if ('error' in held) pending.respond(gatewayError('internal', held.error))
    else pending.respond({ ok: true, result: held.result })
  } else {
    if (pending.call) heldCatalogs.failed(pending.call.home, pending.call.capability, pending.call.payload)
    const errObj: GatewayResponse & { ok: false } = {
      ok: false,
      error: {
        code: (errorCode as GatewayErrorCode) || 'internal',
        message: error || 'gateway request failed',
        ...(api ? { api } : {}),
      },
    }
    if (detail !== undefined) {
      errObj.error.detail = detail
      const ra = (detail as { retryAfterMs?: unknown } | null)?.retryAfterMs
      if (typeof ra === 'number') errObj.error.retryAfterMs = ra
    }
    // Refused for want of a slot, so nothing ran: asked again while the call has time.
    const call = pending.call
    const again = call ? busyRelayAgainMs(call.capability === 'tools.call' ? call.payload.name : undefined, error, call.deadline, Date.now(), gatewayHubTimeoutMs()) : null
    if (call && again !== null) busyAskAgain(relayId as number, call, pending.respond, errObj, again)
    else pending.respond(errObj)
  }
  sendOk(ws, id, {})
}

/** `call` as a NEW relay with nothing sent yet: its Walnut, op, caller and deadline kept. */
function relayAgainOf(call: GatewayRelayCall, change: Partial<GatewayRelayCall>): GatewayRelayCall {
  return {
    home: call.home, capability: call.capability, callerSid: call.callerSid, payload: call.payload, readable: call.readable, deadline: call.deadline,
    sentOn: null, attempts: 0, pinned: call.pinned, ...(call.caller ? { caller: call.caller } : {}), ...change,
  }
}

/**
 * The server named a catalog this host no longer holds (dropped for a newer one, or this
 * daemon restarted): the same call goes again as a NEW relay without `have`, to its Walnut's
 * server, so that server sends the catalog in full. Once: a call without `have` is never
 * answered by a hash (held-catalogs-core.ts).
 */
function heldCatalogAskAgain(relayId: number, call: GatewayRelayCall, payload: Record<string, unknown>, respond: (resp: GatewayResponse) => void): void {
  const target = gatewayTargetFor(call.home)
  // Its server went in the moment since it answered: nothing of this ask was sent.
  if (!target) return respond(gatewayNoServerError(call.home))
  const next = ++gatewayRelayCounter
  logMsg('info', 'gateway: tool catalog not held here; asking for it in full', { relayId, next, callerSid: call.callerSid })
  gatewayRelayPending.set(next, {
    respond, timer: undefined,
    call: relayAgainOf(call, { payload }),
  })
  sendRelayAttempt(next, target)
}

/**
 * A call the server refused as busy (busyRelayAgainMs) goes again after `inMs` as a NEW relay:
 * the server answers a relay id it saw with the same refusal. Meanwhile it waits with the calls
 * that wait for a server, so a server's hello sends it at once and a daemon that stops tells it
 * (nothing of it is at a server). With no server when it is due, it waits for one while a relay
 * would still have its whole hub timeout; else the refusal is the answer. A caller that left
 * (its `walnut` was stopped) is not asked for again: nobody would read the run.
 */
function busyAskAgain(relayId: number, call: GatewayRelayCall, respond: (resp: GatewayResponse) => void, refusal: GatewayResponse, inMs: number): void {
  const attempt = (call.busyAgain ?? 0) + 1
  // waitForPrimary drops it when its caller left.
  const saysLeft = () => logMsg('info', 'gateway: busy call not asked again, its caller left', { relayId, callerSid: call.callerSid, op: call.payload.name, attempt })
  const go = () => {
    const target = gatewayTargetFor(call.home)
    const spare = call.deadline - busyRelayMinLeftMs(gatewayHubTimeoutMs()) - Date.now()
    if (!target || spare < 0) {
      if (!target && spare > 0 && waitForPrimary(call.deadline, go, respond, spare, saysLeft)) return
      return respond(refusal)
    }
    const next = ++gatewayRelayCounter
    logMsg('info', 'gateway: host_exec waits for a slot; asking again', {
      relayId, next, callerSid: call.callerSid, op: call.payload.name, attempt, leftMs: call.deadline - Date.now(),
    })
    gatewayRelayPending.set(next, {
      respond, timer: undefined,
      call: relayAgainOf(call, { busyAgain: attempt }),
    })
    sendRelayAttempt(next, target)
  }
  if (!waitForPrimary(call.deadline, go, respond, inMs, saysLeft)) respond(refusal)
}

/**
 * A plugin job's call (plugin-jobs-core.ts): to the server of the Walnut that runs the
 * job and no other, as `external` (no session: what the user's own terminal may do) with
 * `caller` naming the job, from this daemon's record of the run (callerOfRun): the leader
 * keeps it only from the host its config runs the plugin's jobs on (daemon-connection.ts).
 * While that server is away the job is told so at once and tries again later.
 */
function sendPluginJobGatewayRequest(home: string, capability: string, payload: Record<string, unknown>, respond: (resp: GatewayResponse) => void, caller?: GatewayCaller, deadline = Date.now() + gatewayHubTimeoutMs(), waited = false) {
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (!isServerClient(client) || isQuietTrustedClient(client)) continue
    if (gatewayClientHomes.get(client) === home) target = client
  }
  if (target && ((target.data?.missedBeats ?? 0) >= GATEWAY_SILENT_BEATS || leaderBook.backupLead(home) || followerEntry.quietWithFollower(home))) target = null
  if (!target) {
    // This host's own Walnut server answers it while its leader is away (its answer is final);
    // while the leader's quiet window is not over yet, the call waits for one of the two.
    // The cloud companion leading is the leader away too: this host's server takes the job's
    // call as it takes a session's, and its refusal stands (no fallback: the companion is never
    // asked, as it would run the call without the job's name). 2026-11-25: with the Mac away
    // five hours and the companion leading, every job call was refused here as "not connected".
    if (caller) {
      const again = () => {
        // The job's process left, or this daemon stops: nobody to answer, and a write relayed now would run for no one.
        if (daemonCommands.closed) return respond(gatewayError('hub_unreachable', 'daemon is shutting down; retry after reconnecting', { stopping: true }))
        if (gatewayCallerLeft.get(respond)?.()) return logMsg('info', 'gateway: a plugin job\'s waiting call ends, its caller left', { home, op: payload.name })
        sendPluginJobGatewayRequest(home, capability, payload, respond, caller, deadline, true)
      }
      const left = () => gatewayCallerLeft.get(respond)?.() === true
      if (followerGateway.routeJob({ home, capability, callerSid: EXTERNAL_CALLER_SID, payload, caller, deadline, left }, (r) => respond(r as GatewayResponse), again, waited) !== 'none') return
    }
    logMsg('info', 'gateway: plugin job call, its Walnut is not connected', { home, op: payload.name, waited })
    return respond(gatewayError('hub_unreachable', waited
      ? 'the Walnut that runs this job went quiet; this call waited for it to answer again, or for this host\'s own Walnut server to take over, and neither happened in time. Nothing was done; try again later'
      : 'the Walnut that runs this job is not connected now; try again later'))
  }
  relayToPrimary(target, home, capability, EXTERNAL_CALLER_SID, payload, respond, false, deadline, caller)
}

/**
 * One parsed NDJSON line from the agent socket → local reject or hub relay. `fd`: the gateway
 * socket's own (undefined when unknown), or null for a host call entry line its token proved.
 */
function handleGatewayLine(line: string, respond: (resp: GatewayResponse) => void, fd: number | null | undefined, openedAt = Date.now()) {
  if (daemonCommands.closed) return respond(gatewayError('hub_unreachable', 'daemon is shutting down; retry after reconnecting', { stopping: true }))
  const parsed = parseGatewayLine(line)
  if (!parsed.ok) return respond({ ok: false, error: parsed.error })
  const req = parsed.request
  // caller-proof-v1: only this daemon writes callerProof, on any path the line takes.
  req.args = withoutCallerProof(req.args)
  // trigger-caller-v1: nor triggerCaller, which only a check run's token earns (checkCallers).
  req.args = withoutTriggerCaller(req.args)
  const check = checkCallers.resolve(req.sid)
  if (check !== undefined) {
    // A trigger check's call: `external` as before, with the trigger this daemon ran it for.
    const call = checkGatewayCall(req.op, req.args, check)
    if (call.local) {
      // The check's own CLI met a machine fault over HTTP (trigger-check-core.ts CHECK_FAULT_OP).
      if (call.fault !== undefined) checkCallers.noteFault(req.sid, call.fault)
      return respond({ ok: true, result: {} })
    }
    logMsg('info', 'gateway: trigger check caller', { op: req.op, ...(check ? { trigger: check.id, kind: check.kind } : { ended: true }) })
    // The run hears whether the machine failed this call (trigger-check-core.ts machineFaultOf).
    const answer = (resp: GatewayResponse) => { checkCallers.noteAnswer(req.sid, resp); respond(resp) }
    // The check's caller hanging up ends its waiting call too (waitForPrimary).
    const left = gatewayCallerLeft.get(respond)
    if (left) gatewayCallerLeft.set(answer, left)
    // `external` names no Walnut: the run's own (the trigger's) routes it on a host two Walnuts share.
    const plan = gatewayCallPlan(req.waitMs, gatewayHubTimeoutMs(), Date.now())
    return sendGatewayRequest(req.op, EXTERNAL_CALLER_SID, call.args, answer, check?.home ? { ...plan, home: check.home } : plan)
  }
  if (pluginJobs.isRunSid(req.sid)) {
    const home = pluginJobs.homeOfRun(req.sid)
    if (!home) return respond(gatewayError('unknown_caller', 'no plugin job of this daemon runs under this id'))
    const caller = pluginJobs.callerOfRun(req.sid)
    if (!caller) return sendPluginJobGatewayRequest(home, req.op, req.args, respond)
    // The run's id names the job; `vouched` says the process on the socket is that run or one of its
    // descendants which cannot read a socket's process and so
    // never vouches). A process outside the run that holds its id still goes, unvouched: a job's own
    // helpers can fall out of its tree (a child whose parent exited is the init process's), and
    // refusing them would break calls that work today; unvouched it is told nothing the anonymous
    // caller is not.
    const sid = req.sid
    void jobCallerVouched(socketPeerPid(fd), pluginJobs.runProcOf(sid), openedAt).then((seen) => {
      // Gone while its process was read: asked of no one (its next run would retry it: applied twice).
      if (gatewayCallerLeft.get(respond)?.()) return logMsg('info', 'gateway: a plugin job\'s call ends before it is sent, its caller left', { op: req.op })
      if (seen === 'outside') warnJobCallerOutside(sid, caller)
      sendPluginJobGatewayRequest(home, req.op, req.args, respond, seen === 'inside' ? { ...caller, vouched: true } : caller)
    })
    return
  }
  // ACP sessions (engine=codex) live in the acp worker map, not `sessions` —
  // their WALNUT_SESSION_ID is the runtimeId, stable for the worker's life.
  // sid 'external' (env-less `walnut`: a hand-started agent or the user's own
  // terminal) is not a tracked session and passes through as a provenance
  // label — the owner-only socket already vouched for the caller, and the hub
  // grants 'external' nothing a tracked session lacks. Every other unknown sid
  // is still refused here.
  const callerSid = resolveGatewayCallerSid(req.sid, sessions, gatewaySidAliases)
    ?? (acp.hasWorker(req.sid) ? req.sid : null)
  if (!callerSid) {
    // Unknown sid (CLI adopted from before a daemon restart) — refuse locally,
    // the request never leaves this host. A respawn self-heals (plan §5).
    return respond(gatewayError('unknown_caller', 'session is not tracked by this daemon (a respawn self-heals)'))
  }
  // The call's time runs from now, not from when its caller was read.
  const plan = gatewayCallPlan(req.waitMs, gatewayHubTimeoutMs(), Date.now())
  if (isExternalCallerSid(callerSid)) {
    logMsg('info', 'gateway: external caller (no session env)', { op: req.op })
    return sendSessionGatewayLine(req, callerSid, respond, plan)
  }
  // The line names a session. A host call entry line was proven by its run's token (`fd` null);
  // a socket line is that session's only when the process on the socket runs inside it (or started
  // this daemon): anyone else naming it is the anonymous `external`. Where the process cannot be
  // read at all, the sid stands, marked unproven which never
  // reads it).
  if (fd === null) return sendSessionGatewayLine(req, callerSid, respond, plan)
  void gatewayCallerIdentity(socketPeerPid(fd), callerSid, openedAt).then((seen) => {
    // Gone while its process was read: asked of no one (its retry would apply a write twice).
    if (gatewayCallerLeft.get(respond)?.()) return logMsg('info', 'gateway: a session\'s call ends before it is sent, its caller left', { op: req.op })
    if (seen === 'outside') warnSessionCallerOutside(callerSid)
    if (seen === 'unread') req.args = { ...req.args, callerUnproven: true }
    sendSessionGatewayLine(req, seen === 'outside' ? EXTERNAL_CALLER_SID : callerSid, respond, plan, { fd, openedAt })
  })
}

/**
 * The rest of a session's (or the anonymous caller's) gateway line, its caller settled. `socket`:
 * the gateway socket it came on (an approval reads its process); none for a host call entry line.
 */
function sendSessionGatewayLine(req: GatewayRequest, callerSid: string, respond: (resp: GatewayResponse) => void,
  plan: ReturnType<typeof gatewayCallPlan>, socket?: { fd: number | undefined; openedAt: number }) {
  // caller-proof-v1: only this daemon writes callerProof. For an approval it reads the process on
  // the socket now, while the caller still holds it, and tells the server whether it runs inside
  // the session it names which sends none).
  const args = req.args
  if (!isExternalCallerSid(callerSid) && wantsCallerProof(req.op, args)) {
    void gatewayCallerProof(socketPeerPid(socket?.fd), callerSid, socket?.openedAt ?? Date.now()).then((callerProof) =>
      sendGatewayRequest(req.op, callerSid, { ...args, callerProof }, respond, plan))
    return
  }
  sendGatewayRequest(req.op, callerSid, args, respond, plan)
}

// At most a few process lookups at once: a burst of approval calls queues here.
let proofsRunning = 0
const proofsWaiting: Array<() => void> = []
async function proofSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (proofsRunning >= 3) await new Promise<void>((resolve) => proofsWaiting.push(resolve))
  proofsRunning++
  try { return await fn() } finally { proofsRunning--; proofsWaiting.shift()?.() }
}

/**
 * The processes this daemon holds alive for session `sid`, each still the one it started: its CLI
 * with the start time recorded at spawn (and this boot's, for a system service), or its ACP worker
 * not seen to exit, with the start time read after spawn; and each one's start
 * time read again now by the reader that recorded it (the CLI's by the daemon's own, an ACP
 * worker's by `ps` as acp-daemon.ts reads it), so a locale never makes it differ.
 */
async function sessionProcsNow(sid: string): Promise<{ procs: Array<{ pid: number; start?: string | null }>; now: Map<number, string | null> }> {
  const native = sessions.get(sid)
  const worker = acp.hasWorker(sid) ? acp.workers.get(sid) : undefined
  const procs: Array<{ pid: number; start?: string | null }> = []
  if (native?.state === 'running' && native.pid && native.pid !== process.pid && (!SERVICE_MODE || (!!daemonBootId && native.bootId === daemonBootId))) {
    procs.push({ pid: native.pid, start: native.startTime })
  }
  // A worker adopted after a restart (it outlived the last daemon) has its pid and start, no `proc`.
  const wpid = worker?.proc?.pid ?? worker?.pid
  if (worker && wpid && wpid !== process.pid && !worker.exited() && worker.start) {
    procs.push({ pid: wpid, start: worker.start })
  }
  const now = new Map<number, string | null>()
  for (const p of procs) now.set(p.pid, p.pid === wpid ? await psLstart(p.pid) : await proofStartTime(p.pid))
  return { procs, now }
}

/**
 * Whether the process on the gateway socket (`peer`) runs inside session `sid`: it descends from
 * the process this daemon runs for that session, its Claude Code CLI or its ACP worker. Never
 * throws; a peer it could not read, or a session with no live process here, is not verified.
 */
async function gatewayCallerProof(peer: number | undefined, sid: string, openedAt: number): Promise<CallerProof> {
  if (!peer) return { v: 1, verified: false, unchecked: true }
  const table = await processTreeSnapshot(openedAt)
  if (!table?.size) return { v: 1, verified: false, pid: peer, unchecked: true }
  // The asker must have started by `openedAt`: a process given its pid after it exited started later.
  const { procs, now } = await sessionProcsNow(sid)
  const verdict = proofFor(table, peer, openedAt, procs, (pid) => now.get(pid))
  const parent = table.get(peer)?.ppid
  const args = parent && parent > 1 ? await new Promise<string | null>((resolve) => {
    execFile('ps', ['-o', 'args=', '-p', String(parent)], { timeout: 2_000 }, (err, stdout) => resolve(err ? null : String(stdout ?? '').trim()))
  }) : null
  const proc = parentName(table, peer)
  return {
    v: 1, verified: verdict.verified, pid: peer,
    ...(verdict.unchecked ? { unchecked: true } : {}),
    ...(proc ? { process: proc } : {}),
    ...(args ? { ranBy: shortProgram(args.split('\n')[0]!).slice(0, 300) } : {}),
  }
}

/**
 * Whether the process on the gateway socket (`peer`) may speak as session `sid`, the one its line
 * names (caller-proof-core.ts claimedSidVerdict): `session` inside it, `starter` the process that
 * started this daemon, `outside` any other (a process gone before it was read included), `unread`
 * when it cannot tell at all (no socket peer reader, no peer, no `ps`). Never throws.
 */
async function gatewayCallerIdentity(peer: number | undefined, sid: string, openedAt: number): Promise<'session' | 'starter' | 'outside' | 'unread'> {
  try {
    if (!peer) return 'unread'
    const table = await processTreeSnapshot(openedAt)
    if (!table?.size) return 'unread'
    const { procs, now } = await sessionProcsNow(sid)
    return claimedSidVerdict(table, peer, openedAt, procs, (pid) => now.get(pid), process.pid)
  } catch {
    return 'unread'
  }
}

/** Sids already warned about a caller outside their session: one line per sid, never one per call. */
const sessionCallersOutside = new Set<string>()
function warnSessionCallerOutside(sid: string): void {
  if (sessionCallersOutside.has(sid)) return
  if (sessionCallersOutside.size >= 256) sessionCallersOutside.clear()
  sessionCallersOutside.add(sid)
  logMsg('warn', 'gateway: a process names a session it does not run inside; its calls go as the anonymous caller', { sid })
}

/** The last process snapshot, and when it was asked for (in flight until it settles). */
let treeSnapshot: { at: number; table: Promise<Map<number, ProcRow> | null> } | null = null

/**
 * One `ps` snapshot of every process with its parent and its start time, so each pid a check reads
 * in it is the process it was then, never only a number; null when `ps` could not tell. A snapshot
 * asked for at or after `since` (a caller's connection time) is shared: every process on a socket
 * opened by then is in it, so a burst of calls runs one `ps`.
 */
function processTreeSnapshot(since: number): Promise<Map<number, ProcRow> | null> {
  if (treeSnapshot && treeSnapshot.at >= since) return treeSnapshot.table
  const at = Date.now()
  const table = proofSlot(() => new Promise<string | null>((resolve) => {
    execFile('ps', PS_TREE_ARGS, { timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { ...daemonEnv, LC_ALL: 'C', LANG: 'C' } },
      (err, stdout) => resolve(err && !stdout ? null : String(stdout ?? '')))
  })).then((ps) => (ps ? parseProcessTree(ps) : null))
  treeSnapshot = { at, table }
  return table
}

/**
 * Whether the process on the gateway socket (`peer`) is a plugin job's run (`proc`, runProcOf) or
 * one of its descendants: `inside`, `outside` (seen, and not), or `unknown` (no peer read, no run,
 * no snapshot, a run whose process it cannot tell). This daemon's own child not yet seen to exit
 * holds its pid, so the peer that is that pid is the run with no read at all; any other check reads
 * the run's start time again the way it was recorded (/proc ticks on Linux, else the snapshot's
 * lstart), so a pid handed to another process never passes. Never throws.
 */
async function jobCallerVouched(peer: number | undefined, proc: { pid: number; startTime: string | null; spawned: boolean } | null, openedAt: number): Promise<'inside' | 'outside' | 'unknown'> {
  try {
    if (!peer || !proc || proc.pid <= 1) return 'unknown'
    if (proc.spawned && peer === proc.pid) return 'inside'
    const run = proc.startTime ? { pid: proc.pid, start: proc.startTime } : proc.spawned ? { pid: proc.pid, before: Date.now() } : null
    if (!run) return 'unknown'
    const table = await processTreeSnapshot(openedAt)
    if (!table?.size) return 'unknown'
    const procFs = fs.existsSync('/proc/self/stat')
    const verdict = proofFor(table, peer, openedAt, [run], (pid) => (procFs ? readStartTime(pid) : undefined))
    return verdict.unchecked ? 'unknown' : verdict.verified ? 'inside' : 'outside'
  } catch {
    return 'unknown'
  }
}

/** Run ids already warned about a caller outside their run: one line per run, never one per call. */
const jobCallersOutside = new Set<string>()
function warnJobCallerOutside(sid: string, caller: GatewayCaller): void {
  if (jobCallersOutside.has(sid)) return
  if (jobCallersOutside.size >= 256) jobCallersOutside.clear()
  jobCallersOutside.add(sid)
  logMsg('warn', 'gateway: a call under a plugin job\'s run id came from a process outside that run; its job is named unvouched', { plugin: caller.plugin, job: caller.job })
}

const proofStartTime = createAsyncStartTimeReader({
  fs,
  env: daemonEnv,
  execFileFn: (file, args, options, callback) => execFile(file, args, options, (error, stdout) => callback(error, String(stdout ?? ''))),
})

/** A process's lstart read as acp-daemon.ts reads its workers' (psField), or null. */
function psLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => resolve(err ? null : String(stdout ?? '').trim() || null))
  })
}

/**
 * caller-proof-v1 `caller.check {sid, pid, at}`: the same word for a process the server found on
 * its own HTTP connection (lsof/ss), from what this daemon holds in memory for the session, never
 * from a file another process could write. Read-only; not reachable through a bridge.
 */
async function cmdCallerCheck(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>): Promise<void> {
  const pid = Number(cmd.pid)
  const at = Number(cmd.at)
  const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isFinite(at) || !sid) return sendError(ws, id, 'caller.check: needs sid, pid and at')
  const callerSid = resolveGatewayCallerSid(sid, sessions, gatewaySidAliases) ?? (acp.hasWorker(sid) ? sid : null)
  if (!callerSid || isExternalCallerSid(callerSid)) return sendOk(ws, id, { proof: { v: 1, verified: false, pid, unchecked: true } })
  try {
    sendOk(ws, id, { proof: await gatewayCallerProof(pid, callerSid, at) })
  } catch (err) {
    sendError(ws, id, `caller.check: ${String(err)}`)
  }
}

/** The gateway's unix listener, once it listens (stop() closes it; a process just exits). */
let gatewayListener: { stop(closeActive?: boolean): void } | null = null

/** Second listener: owner-only unix socket, raw NDJSON, one request per conn. */
function startGatewayListener() {
  // Unlink a stale socket from a crashed predecessor — bind fails on EADDRINUSE
  // otherwise (the file outlives the process).
  try { fs.unlinkSync(GATEWAY_SOCK_PATH) } catch {}
  try {
    // Bytes are accumulated RAW and decoded once, for two reasons that both
    // only bite now that a request line can be 10MB (a letter body with inline
    // base64 audio) instead of 256KB: decoding each chunk on its own splits any
    // multi-byte character that straddles a chunk boundary into replacement
    // characters (corrupt JSON), and re-measuring/re-scanning the accumulated
    // string per chunk is O(line²) — ~1.6GB of rescanning for 10MB in 64KB
    // chunks.
    type GwSockData = { chunks: Uint8Array[]; bytes: number; done: boolean; out?: Buffer; sent?: number; openedAt?: number; closed?: boolean }
    type GwSocket = { data: GwSockData; write(s: string | Buffer): number; end(): void }
    // Bun.listen raw sockets do PARTIAL writes: write() returns the bytes the
    // kernel buffer took (~8KB) and end() closes immediately, silently
    // truncating anything larger (a skill_read reply is ~11KB — the walnut client
    // then saw "socket closed without a response"). Buffer the remainder and
    // finish in drain().
    const pump = (socket: GwSocket) => {
      const d = socket.data
      if (!d.out) return
      while ((d.sent ?? 0) < d.out.byteLength) {
        let n = 0
        try { n = socket.write(d.out.subarray(d.sent ?? 0)) } catch { return }
        if (n <= 0) return // kernel buffer full — resume on next drain
        d.sent = (d.sent ?? 0) + n
      }
      d.out = undefined
      try { socket.end() } catch {}
    }
    const reply = (socket: GwSocket, resp: GatewayResponse) => {
      socket.data.out = Buffer.from(JSON.stringify(resp) + '\n', 'utf8')
      socket.data.sent = 0
      pump(socket)
    }
    gatewayListener = Bun.listen<GwSockData>({
      unix: GATEWAY_SOCK_PATH,
      socket: {
        open(socket) { socket.data = { chunks: [], bytes: 0, done: false, openedAt: Date.now() } },
        data(socket, chunk) {
          const d = socket.data
          if (d.done) return
          d.bytes += chunk.byteLength
          if (d.bytes > GATEWAY_MAX_LINE_BYTES) {
            d.done = true
            d.chunks = []
            reply(socket, gatewayError('bad_request', 'request line too large'))
            return
          }
          // '\n' (0x0A) can never be a continuation byte of a multi-byte
          // character, so scanning raw bytes for it is exact.
          const nl = chunk.indexOf(0x0a)
          d.chunks.push(nl === -1 ? chunk : chunk.subarray(0, nl))
          if (nl === -1) return
          d.done = true
          const line = Buffer.concat(d.chunks).toString('utf-8')
          d.chunks = []
          const respond = (resp: GatewayResponse) => reply(socket, resp)
          gatewayCallerLeft.set(respond, () => d.closed === true)
          // One request's error is its own answer. Inside a server's process that is all (a throw would
          // end the server); a daemon program still goes on to its crash handler, as it always did.
          try { handleGatewayLine(line, respond, socket.fd, d.openedAt) } catch (err) {
            logMsg('error', 'agent gateway request threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
            try { respond(gatewayError('internal', 'the request failed in the daemon')) } catch { /* the caller went away */ }
            if (LISTEN) throw err
          }
        },
        drain(socket) { pump(socket) },
        close(socket) { if (socket.data) socket.data.closed = true },
        error() { /* client went away — pending timer self-cleans */ },
      },
    })
    // Owner-only IS the credential: don't rely on umask, chmod explicitly.
    fs.chmodSync(GATEWAY_SOCK_PATH, 0o600)
    logMsg('info', 'agent gateway listening', { sock: GATEWAY_SOCK_PATH })
  } catch (err) {
    // The gateway is additive — never fail daemon startup over it.
    logMsg('warn', 'agent gateway listener failed', { error: (err as Error).message })
  }
}

// The retired `wn` name (fully removed 2026-08-24): shims we previously wrote
// under it are deleted at startup, recognized by their markers.
const LEGACY_WN_SHIM_MARKERS = ['walnut-wn-shim v1']

// `walnut` on the user's PATH (one name everywhere, decision 2026-08-23). On
// the hub the REAL npm-installed walnut CLI must always win, whatever the
// PATH order — so this shim first scans PATH (minus its own dir) for another
// walnut and execs it, and only then falls back to the daemon's gateway shim.
// Built from parts, so the literal is not in the compiled file: a 0.6.x daemon finds the
// marker in ~/.local/bin/walnut, reads it as its own shim and writes over it (through
// install.sh's symlink, into the real install). The shim text it writes still carries it.
const USER_WALNUT_SHIM_TAG = ['walnut', 'user', 'shim'].join('-')
const USER_WALNUT_SHIM_MARKER = USER_WALNUT_SHIM_TAG + ' v1'
const USER_WALNUT_SHIM_MAX_BYTES = 16 * 1024

function userWalnutShimText(): string {
  return '#!/bin/sh\n'
    + '# ' + USER_WALNUT_SHIM_MARKER + ' — installed by the Walnut session daemon. Safe to delete.\n'
    + '# A real walnut CLI anywhere else on PATH always wins; otherwise the\n'
    + '# daemon gateway shim answers (guide / wait / tools work on any host).\n'
    + 'self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
    + 'old_ifs=$IFS; IFS=:\n'
    + 'for d in $PATH; do\n'
    + '  [ "$d" = "$self_dir" ] && continue\n'
    + '  [ -x "$d/walnut" ] || continue\n'
    + '  # skip sibling copies of this shim (two installs must not exec each other)\n'
    + '  grep -q "' + USER_WALNUT_SHIM_TAG + '" "$d/walnut" 2>/dev/null && continue\n'
    + '  IFS=$old_ifs && exec "$d/walnut" "$@"\n'
    + 'done\n'
    + 'IFS=$old_ifs\n'
    + '# The daemon dir: WALNUT_DAEMON_DIR when set; otherwise ' + PROD_DAEMON_DIR + ' or\n'
    + '# ~/.cache/open-walnut (a daemon moved there because /tmp was unusable), the\n'
    + '# one whose daemon is alive first. Exported, so walnut reaches THAT socket.\n'
    + '# A daemon restarting here leaves <dir>/restarting (the epoch second it stopped;\n'
    + '# daemon-restart-mark.ts): while that is under 45s old, wait for the next one to\n'
    + '# write its bin/walnut instead of failing in the seconds between the two.\n'
    + 'ride() {\n'
    + '  i=0\n'
    + '  while [ ! -x "$1/bin/walnut" ]; do\n'
    + '    [ -f "$1/restarting" ] && [ ! -h "$1/restarting" ] || return 1\n'
    + '    m=$(dd if="$1/restarting" bs=16 count=1 2>/dev/null)\n'
    + '    case $m in ""|0*|*[!0-9]*|?????????????*) return 1 ;; esac\n'
    + '    a=$(( $(date +%s) - m ))\n'
    + '    [ "$a" -ge -5 ] && [ "$a" -lt 45 ] && [ $i -lt 120 ] || return 1\n'
    + '    [ $i -eq 0 ] && [ -t 2 ] && echo "walnut: the Walnut daemon on this host is restarting; waiting for the next one (up to 45s)" >&2\n'
    + '    sleep 0.5 2>/dev/null || sleep 1\n'
    + '    i=$((i+1))\n'
    + '  done\n'
    + '  return 0\n'
    + '}\n'
    + 'if [ -n "$WALNUT_DAEMON_DIR" ]; then\n'
    + '  [ -x "$WALNUT_DAEMON_DIR/bin/walnut" ] || ride "$WALNUT_DAEMON_DIR"\n'
    + '  [ -x "$WALNUT_DAEMON_DIR/bin/walnut" ] && exec "$WALNUT_DAEMON_DIR/bin/walnut" "$@"\n'
    + '  echo "walnut: no Walnut daemon on this host ($WALNUT_DAEMON_DIR/bin/walnut is missing)." >&2\n'
    + '  exit 6\n'
    + 'fi\n'
    + 'found=\n'
    + 'dead=\n'
    + 'for d in "' + PROD_DAEMON_DIR + '" "$HOME/.cache/open-walnut"; do\n'
    + '  [ -x "$d/bin/walnut" ] || continue\n'
    + '  p=$(cat "$d/daemon.pid" 2>/dev/null)\n'
    + '  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then found=$d; break; fi\n'
    + '  [ -n "$dead" ] || dead=$d\n'
    + 'done\n'
    + '# None alive: a dir whose daemon is restarting is waited for before a dead one is taken.\n'
    + 'if [ -z "$found" ]; then\n'
    + '  for d in "' + PROD_DAEMON_DIR + '" "$HOME/.cache/open-walnut"; do\n'
    + '    [ -x "$d/bin/walnut" ] && continue\n'
    + '    ride "$d" && { found=$d; break; }\n'
    + '  done\n'
    + 'fi\n'
    + '[ -n "$found" ] || found=$dead\n'
    + 'if [ -n "$found" ]; then WALNUT_DAEMON_DIR=$found; export WALNUT_DAEMON_DIR; exec "$found/bin/walnut" "$@"; fi\n'
    + 'echo "walnut: no Walnut daemon on this host (' + PROD_DAEMON_DIR + '/bin/walnut is missing)." >&2\n'
    + 'exit 6\n'
}

/**
 * Install the user-PATH `walnut` shim. Two guards, both load-bearing:
 *  - PRODUCTION dir only — a test/sandbox/ephemeral daemon must never write
 *    into the user's real bin dir.
 *  - never clobber a foreign `walnut`: we only write a path that is absent or
 *    already carries our marker.
 * ~/bin is written only when it already exists (creating it would put the shim
 * somewhere that is not on anyone's PATH). Retired `wn` shims we wrote in the
 * alias era are deleted here (marker-guarded — a foreign `wn` is left alone).
 */
function installUserWalnutShim() {
  if (!IS_PROD_DAEMON_DIR) return
  const text = userWalnutShimText()
  const installed: string[] = []
  for (const [dir, createDir] of [
    [path.join(HOME_DIR, '.local', 'bin'), true],
    [path.join(HOME_DIR, 'bin'), false],
  ] as Array<[string, boolean]>) {
    try {
      const legacy = path.join(dir, 'wn')
      if (fs.existsSync(legacy)) {
        const body = fs.readFileSync(legacy, 'utf-8')
        if (LEGACY_WN_SHIM_MARKERS.some((m) => body.includes(m))) fs.unlinkSync(legacy)
      }
    } catch { /* removal is hygiene — never fail startup over it */ }
    try {
      if (!fs.existsSync(dir)) {
        if (!createDir) continue
        fs.mkdirSync(dir, { recursive: true })
      }
      const target = path.join(dir, 'walnut')
      if (fs.existsSync(target)) {
        // Our shim is a short script. A big file is a real walnut (the compiled
        // Walnut file carries this marker in its own code): never read or replace it.
        if (fs.statSync(target).size > USER_WALNUT_SHIM_MAX_BYTES) continue
        const existing = fs.readFileSync(target, 'utf-8')
        if (!existing.includes(USER_WALNUT_SHIM_MARKER)) continue // someone else's binary — leave it
        if (existing === text) { installed.push(target); continue }
      }
      fs.writeFileSync(target, text, { mode: 0o755 })
      fs.chmodSync(target, 0o755)
      installed.push(target)
    } catch { /* additive convenience — never fail startup over it */ }
  }
  if (installed.length > 0) logMsg('info', 'walnut on user PATH', { paths: installed })
}

/**
 * Copy the running binary to GATEWAY_SHIM_DIR/walnut-core and return that path,
 * or null when the copy could not be made.
 *
 * WHY: the shim must exec a path that OUTLIVES this process. On the hub the
 * daemon binary is launched from a stage temp dir (dev-prod clones dist/ into
 * /var/folders/…/open-walnut-stage.<ts>/ and boots from the clone), and the next
 * deploy deletes that clone — a shim holding `process.execPath` then pointed at
 * nothing and every `walnut` call in a live session exited 126. DAEMON_DIR is
 * stable (/tmp/open-walnut), so the copy lives next to the shim it serves.
 *
 * Atomicity: write to a temp name in the SAME dir, then rename. Same-dir rename
 * is atomic and can never be EXDEV, and a session mid-exec keeps the old inode.
 *
 * Cost: this runs on the startup path the parent's port-file wait watches, so it
 * must stay cheap. Three things keep it that way: a binary that ALREADY lives in
 * the stable daemon dir (every SSH-deployed host) is used as-is and never copied;
 * a matching size + version stamp skips the copy on an ordinary restart; and
 * COPYFILE_FICLONE makes a same-volume copy a COW clone instead of hundreds of MB
 * of real I/O. A clone stays valid after the source is deleted, which is the
 * whole point.
 */
function ensureShimCoreCopy(): string | null {
  // Already stable: the daemon dir is exactly the place the copy would go.
  if (path.resolve(path.dirname(process.execPath)) === path.resolve(DAEMON_DIR)) return process.execPath
  const dst = path.join(GATEWAY_SHIM_DIR, SHIM_CORE_BASENAME)
  const stampPath = dst + '.version'
  const tmp = dst + '.tmp-' + process.pid
  try {
    const statSize = (p: string): number | null => {
      try { return fs.statSync(p).size } catch { return null }
    }
    let stamped: string | null = null
    try { stamped = fs.readFileSync(stampPath, 'utf-8').trim() } catch { /* absent */ }
    const needsCopy = shimCoreNeedsCopy({
      srcSize: statSize(process.execPath),
      dstSize: statSize(dst),
      stampedVersion: stamped,
      version: DAEMON_VERSION,
    })
    if (!needsCopy) return fs.existsSync(dst) ? dst : null
    // Inside another program (a server, in-process-daemon.ts) a copy of hundreds of MB must not hold
    // its clock: it is made in the background, and the shim names the running binary until it lands.
    if (!LISTEN) { copyShimCoreInBackground(dst, stampPath, tmp); return null }
    const startedAt = Date.now()
    fs.copyFileSync(process.execPath, tmp, fs.constants.COPYFILE_FICLONE)
    fs.chmodSync(tmp, 0o700)
    fs.renameSync(tmp, dst)
    fs.writeFileSync(stampPath, DAEMON_VERSION)
    logMsg('info', 'walnut shim core copied', {
      path: dst, version: DAEMON_VERSION, ms: Date.now() - startedAt,
    })
    return dst
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    // A shim that works until the next deploy beats no shim at all, so the
    // caller falls back to process.execPath instead of skipping the shim.
    logMsg('warn', 'walnut shim core copy failed — shim will point at the running binary', {
      error: (err as Error).message,
      execPath: process.execPath,
    })
    return null
  }
}

let shimCoreCopying = false
/** ensureShimCoreCopy's copy, asynchronously; once it landed the shim is written again to name it. */
function copyShimCoreInBackground(dst: string, stampPath: string, tmp: string): void {
  if (shimCoreCopying) return
  shimCoreCopying = true
  const startedAt = Date.now()
  void (async () => {
    try {
      await fs.promises.copyFile(process.execPath, tmp, fs.constants.COPYFILE_FICLONE)
      await fs.promises.chmod(tmp, 0o700)
      await fs.promises.rename(tmp, dst)
      await fs.promises.writeFile(stampPath, DAEMON_VERSION)
      logMsg('info', 'walnut shim core copied', { path: dst, version: DAEMON_VERSION, ms: Date.now() - startedAt, background: true })
      writeWalnutShim()
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {})
      logMsg('warn', 'walnut shim core copy failed — shim will point at the running binary', { error: (err as Error).message, execPath: process.execPath })
    } finally { shimCoreCopying = false }
  })()
}

/**
 * Sweep GATEWAY_SHIM_DIR of core copies the freshly written shim does NOT name.
 *
 * Two kinds of debris, each one artifact-sized (tens to hundreds of MB) and both
 * permanent until this ran: (1) `walnut-core.tmp-<pid>` left behind when a
 * SIGKILL/OOM/power loss lands between copyFileSync and renameSync — the catch
 * only covers a thrown copy, and every attempt picks a fresh pid-suffixed name,
 * so they accumulate; (2) a stable copy from an earlier deploy this daemon no
 * longer execs (an artifact already in DAEMON_DIR takes the no-copy path forever),
 * which would otherwise sit there with its orphaned `.version` stamp. Hosts here
 * have run out of disk before.
 *
 * Call only AFTER the shim has been rewritten: nothing names these files then, and
 * unlink does not disturb a process already exec'ing the inode.
 */
function reapShimCoreArtifacts(referenced: string[]) {
  try {
    const keep = new Set(referenced.map((p) => path.resolve(p)))
    const ownTmp = SHIM_CORE_BASENAME + '.tmp-' + process.pid
    for (const name of fs.readdirSync(GATEWAY_SHIM_DIR)) {
      if (!name.startsWith(SHIM_CORE_BASENAME) || name === ownTmp) continue
      const full = path.join(GATEWAY_SHIM_DIR, name)
      // A `.version` stamp lives and dies with the copy it stamps.
      const stamps = name.endsWith('.version') ? full.slice(0, -'.version'.length) : full
      if (keep.has(path.resolve(stamps))) continue
      try { fs.unlinkSync(full) } catch { /* already gone */ }
    }
  } catch { /* hygiene — never fail startup over it */ }
}

/** What the PATH shim runs (this daemon's program): a plugin job's process is `<it> walnut plugin-job ...`. */
let walnutCliArgv: string[] = [process.execPath, ...(PROGRAM_SCRIPT && !PROGRAM_SCRIPT.includes('$bunfs') && !PROGRAM_SCRIPT.includes('~BUN') && PROGRAM_SCRIPT !== process.execPath ? [PROGRAM_SCRIPT] : [])]

/** PATH shim so `walnut` inside spawned sessions reaches this daemon's dispatch. */
function writeWalnutShim() {
  try {
    fs.mkdirSync(GATEWAY_SHIM_DIR, { recursive: true, mode: 0o700 })
    // Dev run (`bun daemon-standalone.ts`): argv[1] is the real script on disk →
    // exec runtime + script, unchanged. Compiled binary: argv[1] is a bunfs
    // VIRTUAL path (embedded, must never leak into the shim) → exec the binary
    // itself, but via the STABLE copy, because the running execPath can be
    // deleted under us (see ensureShimCoreCopy).
    const entry = PROGRAM_SCRIPT
    const isVirtualEntry = entry.includes('$bunfs') || entry.includes('~BUN')
    const devScript = entry && !isVirtualEntry && entry !== process.execPath && fs.existsSync(entry)
      ? entry
      : ''
    const argv = devScript
      ? [process.execPath, devScript]
      : [ensureShimCoreCopy() ?? process.execPath]
    // One name: `walnut`, and the shim passes the canonical `walnut` dispatch
    // keyword. GATEWAY_SHIM_DIR is APPENDED to the PATH of the hub's own sessions,
    // so there the installed hub walnut still wins, and put FIRST for every other
    // session (walnutThroughGateway), where this shim IS the walnut command. The retired `wn` file is removed, not rewritten.
    const shim = gatewayShimScript(argv)
    walnutCliArgv = argv
    const p = path.join(GATEWAY_SHIM_DIR, 'walnut')
    // Written aside, then renamed: a call waiting out a restart runs it the moment it appears.
    const tmp = p + '.tmp-' + process.pid
    fs.writeFileSync(tmp, shim, { mode: 0o755 })
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, p)
    try { fs.unlinkSync(path.join(GATEWAY_SHIM_DIR, 'wn')) } catch {}
    // The shim now names its final target — anything else in here is debris.
    reapShimCoreArtifacts(argv)
  } catch (err) {
    logMsg('warn', 'walnut shim write failed', { error: (err as Error).message })
  }
  installUserWalnutShim()
}

// ── Task directories, cli.holder, the transcript archive (task-dir-core.ts, transcript-archive.ts) ──

/**
 * Task directories (task-dir-core.ts): `ensure` makes one for a session that
 * started before its daemon knew about them; `list` and `remove` are the
 * server's cleanup, which decides WHICH tasks are done and leaves the check for
 * unmerged work to this host. A live session working inside a directory keeps it.
 */
function cmdTaskDirEnsure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (refuseForeignHome(ws, id, cmd, 'taskdir.ensure')) return
  const dir = ensureTaskDir(TASK_DIR_ROOT, cmd.taskId, cmd.home)
  if (!dir) return sendError(ws, id, 'taskdir.ensure: invalid taskId or the directory could not be made')
  sendOk(ws, id, { path: dir, root: TASK_DIR_ROOT })
}

/**
 * Whether a CLI of a session runs on this host, by the start's own claim rules (cli-holder-v1,
 * cli-owner-core.ts holderOf), and the Walnut the spawn journal says started it. Read only.
 */
async function cmdCliHolder(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sid)) return sendError(ws, id, 'cli.holder: invalid sid')
  try {
    const holder = await cliOwner.holderOf(sid)
    // Another daemon of this host may have journaled it since this one read the journal.
    if (!journaledIds().has(sid)) forgetJournaledSids()
    sendOk(ws, id, {
      holder: holder ? { kind: holder.kind, pid: holder.pid, ...(holder.home ? { home: holder.home } : {}), ...(holder.unrecorded ? { unrecorded: true } : {}) } : null,
      journaledHome: journaledHome(sid) ?? null,
    })
  } catch (err) {
    sendError(ws, id, `cli.holder: ${(err as Error).message}`)
  }
}

async function cmdTaskDirList(ws: ServerWebSocket<WsData>, id: number) {
  sendOk(ws, id, { root: TASK_DIR_ROOT, dirs: await listTaskDirs(TASK_DIR_ROOT) })
}

/** Read only: how much each named task directory takes (task-dir-sizes.ts). */
async function cmdTaskDirSizes(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const ids = Array.isArray(cmd.taskIds) ? cmd.taskIds : []
  try {
    sendOk(ws, id, { sizes: await taskDirSizes(TASK_DIR_ROOT, ids) })
  } catch (err) {
    sendError(ws, id, `taskdir.sizes failed: ${(err as Error).message}`)
  }
}

/**
 * Everything running here now that may work in a task directory: live
 * sessions, running host commands (a task on another host builds and tests
 * here through them: 2026-11-08, a simulator check's app was taken mid-run),
 * ACP workers.
 */
function hostWorkNow(): HostWork[] {
  const work: HostWork[] = []
  for (const s of sessions.values()) if (!s.exitedAt) work.push({ task: s.spawnInfo?.task, cwd: s.cwd })
  for (const j of hostExec.active()) work.push({ task: j.taskId, cwd: j.cwd })
  for (const w of acp.workers.values()) work.push({ cwd: w.cwd }, { cwd: w.taskDir })
  return work
}
const taskDirBusy = (dir: string, taskId: string) => taskDirInUse(dir, taskId, hostWorkNow())
/** git for the task dir sweeps (task-dir-core.ts), started as every child of this runtime. */
const taskDirGit = gitRunnerWith(childUse)

/**
 * Session history archive (transcript-archive.ts, capability transcript-archive-v1).
 * `transcript.archive {olderThanDays, dryRun?, budgetMs?}` compresses this host's
 * Claude Code sessions untouched for that long, never one a live CLI holds (this
 * daemon's sessions, and any `claude` process naming it, read from ps once a pass);
 * one pass at a time. `transcript.restore {sessionId}` brings one back plain.
 */
let transcriptArchiveBusy = false
async function cmdTranscriptArchive(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const days = Number(cmd.olderThanDays)
  if (!Number.isFinite(days) || days < 1) return sendError(ws, id, 'transcript.archive: olderThanDays must be 1 or more')
  if (transcriptArchiveBusy) return sendOk(ws, id, { busy: true })
  transcriptArchiveBusy = true
  setArchiveLog((msg) => logMsg('warn', 'transcript archive', { msg }))
  try {
    const live = new Set<string>()
    for (const [sid, s] of sessions) if (!s.exitedAt) live.add(sid)
    const ps = await boundedExecFile(
      (f, a, options, callback) => execFile(f, a, options, (error, stdout) => callback(error, String(stdout ?? ''))),
      'ps', ['-A', '-o', 'args='], { encoding: 'utf-8' as const, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
    )
    if (ps.error) return sendError(ws, id, 'transcript.archive: the process table could not be read')
    for (const sid of liveTranscriptIdsFromPs(ps.stdout)) live.add(sid)
    const budgetMs = Number(cmd.budgetMs)
    // Asked again right before a session's originals go: this daemon's sessions now, then a fresh
    // process table (a CLI started since the pass began, a terminal's included). Unreadable = live.
    const isLiveNow = async (sid: string): Promise<boolean> => {
      const s = sessions.get(sid)
      if (s && !s.exitedAt) return true
      const now = await boundedExecFile(
        (f, a, options, callback) => execFile(f, a, options, (error, stdout) => callback(error, String(stdout ?? ''))),
        'ps', ['-A', '-o', 'args='], { encoding: 'utf-8' as const, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
      )
      return !!now.error || liveTranscriptIdsFromPs(now.stdout).has(sid)
    }
    const report = await archiveTranscripts(CLAUDE_PROJECTS_DIRS, {
      olderThanMs: days * 86_400_000,
      isLive: (sid) => live.has(sid),
      isLiveNow,
      dryRun: cmd.dryRun === true,
      ...(Number.isFinite(budgetMs) && budgetMs > 0 ? { budgetMs } : {}),
    })
    if (report.sessions > 0 || report.finalized > 0 || report.conflicts > 0 || report.failed > 0) logMsg('info', 'transcript archive pass', { ...report })
    sendOk(ws, id, report)
  } catch (err) {
    sendError(ws, id, 'transcript.archive failed: ' + (err as Error).message)
  } finally { transcriptArchiveBusy = false }
}

/**
 * A session whose archive files went to remote storage (transcript-offload.ts) comes back
 * through this daemon's server: only it holds the storage's credentials. The restore asks it
 * (capability `history.fetch`) to download what is missing next to the manifest and check each
 * file, then decompresses as for any archive. With no server connected the restore fails with
 * a RemoteHistoryError and nothing is touched.
 */
const HISTORY_FETCH_MS = 180_000
// A restore's own warnings (a file kept twice, a fetch that failed) go to this daemon's log from the start.
setArchiveLog((msg) => logMsg('warn', 'transcript archive', { msg }))
/**
 * The server that fetches a session's history: its own Walnut's (only that Walnut's storage
 * holds it, gateway-identity-core.ts). A session no record names (one started before homes were
 * recorded, or outside Walnut) goes to the Walnut a call outside any session goes to
 * (gatewayOwnerHome: the one this host holds a fresh copy of, or every server speaks for), else
 * to an older server's unnamed link: pickTrustedClient('') alone skips every named link, so such a
 * session could never be fetched (2026-11-19). A wrong server can do no harm: each download is
 * checked against the manifest's hashes here.
 */
function historyFetchTarget(sid: string): { target: ServerWebSocket<WsData> | null; home: string | undefined } {
  const home = sessionOwnerHome(sid) || gatewayOwnerHome(EXTERNAL_CALLER_SID) || undefined
  return { target: home ? gatewayTargetFor(home) : pickTrustedClient('').client, home }
}
function fetchRemoteHistory(dir: string, sid: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { target, home } = historyFetchTarget(sid)
    if (!target) return reject(new RemoteHistoryError('the history of ' + sid + ' is in remote storage, and no server of its Walnut is connected to fetch it'))
    const respond = (resp: Parameters<Parameters<typeof relayToPrimary>[5]>[0]) => {
      if (resp.ok) return resolve()
      const code = resp.error?.code
      reject(new RemoteHistoryError(resp.error?.message || 'the server could not fetch it from remote storage', { stillRunning: code === 'hub_timeout' }))
    }
    const deadline = Date.now() + HISTORY_FETCH_MS
    relayToPrimary(target, home, 'history.fetch', EXTERNAL_CALLER_SID, { dir, sessionId: sid }, respond, false, deadline)
  })
}
setRemoteFetcher(fetchRemoteHistory)

/** Rebuildable tool caches older than `olderThanMs` (host-cache-prune.ts, host-cache-prune-v1). */
async function cmdTaskDirPruneCaches(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const olderThanMs = Number(cmd.olderThanMs)
  if (!Number.isFinite(olderThanMs) || olderThanMs < 3_600_000) return sendError(ws, id, 'taskdir.pruneCaches: olderThanMs must be an hour or more')
  try {
    const result = await pruneHostCaches(bunTranspilerCacheDirs(daemonEnv, HOME_DIR), olderThanMs)
    if (result.removedFiles > 0) logMsg('info', 'host caches pruned', { ...result })
    sendOk(ws, id, result)
  } catch (err) {
    sendError(ws, id, 'taskdir.pruneCaches failed: ' + (err as Error).message)
  }
}

async function cmdTranscriptRestore(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = typeof cmd.sessionId === 'string' ? cmd.sessionId : ''
  if (!sid) return sendError(ws, id, 'transcript.restore: missing sessionId')
  try {
    sendOk(ws, id, { path: await restoreSessionAnywhere(CLAUDE_PROJECTS_DIRS, sid) })
  } catch (err) {
    sendError(ws, id, 'transcript.restore failed: ' + (err as Error).message)
  }
}

async function cmdTaskDirRemove(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const ids = Array.isArray(cmd.taskIds) ? cmd.taskIds : []
  const busy = taskDirBusy
  try {
    const result = await removeTaskDirs(TASK_DIR_ROOT, ids, { busy, git: taskDirGit })
    if (result.removed.length > 0 || result.kept.length > 0) logMsg('info', 'task dirs swept', { removed: result.removed, kept: result.kept })
    sendOk(ws, id, result)
  } catch (err) {
    sendError(ws, id, 'taskdir.remove failed: ' + (err as Error).message)
  }
}

/**
 * A finished task's clean clones and build output (task-dir-prune-v1), or with
 * `buildsOnly` the build output alone of an idle task's directory, open or not
 * (`taskdir.pruneBuilds`, task-dir-prune-builds-v1).
 */
async function cmdTaskDirPrune(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, buildsOnly = false) {
  const ids = Array.isArray(cmd.taskIds) ? cmd.taskIds : []
  const busy = taskDirBusy
  try {
    const idleBefore = typeof cmd.idleBefore === 'number' && Number.isFinite(cmd.idleBefore) ? cmd.idleBefore : Date.now()
    // `live` (the server's disk is below its floor): directories in use too, behind the open-file check.
    const openPaths = cmd.live === true ? async () => {
      const open = await readOpenPaths(TASK_DIR_ROOT, childUse)
      return open && [...open, ...hostWorkNow().map((w) => w.cwd).filter((c): c is string => typeof c === 'string' && !!c)]
    } : undefined
    const result = buildsOnly
      ? await pruneTaskBuilds(TASK_DIR_ROOT, ids, { busy, idleBefore, openPaths, git: taskDirGit })
      : await pruneTaskDirs(TASK_DIR_ROOT, ids, { busy, git: taskDirGit })
    if (result.pruned.length > 0 || result.kept.length > 0) logMsg('info', buildsOnly ? 'task dir builds pruned' : 'task dirs pruned', { pruned: result.pruned, kept: result.kept })
    sendOk(ws, id, result)
  } catch (err) {
    sendError(ws, id, 'taskdir.prune failed: ' + (err as Error).message)
  }
}

// ── ACP session commands (engine=codex etc; daemon-acp-sessions.ts) ──
// What is defined further down in the body is asked on use.
const acpSessions = createDaemonAcpSessions({ daemonEnv, DAEMON_DIR, TASK_DIR_ROOT, GATEWAY_SOCK_PATH, SECRETS_ROOT: () => SECRETS_ROOT,
  secretsSessionEnv: () => secretsSessionEnv(), sessions, acp, usageBudget, budgetGate, sessionStartGate, demoQuiesce, hostCallTokens, recordAcpRuntime, isJournalSid,
  walnutThroughGateway, sessionPathWithShim, sessionWalnutApiUrl, pwSilenceFile, pwSilenceAcpOptions, logMsg, sendOk, sendError, sendFrame })
const { cmdAcpStart, cmdAcpOp, cmdAcpStop, cmdAcpSubscribe, cancelledStartPath, cmdCancelPendingStart } = acpSessions

// ── Start a Claude session (daemon-session-start.ts) ──
// What is defined further down in the body is asked on use.
const sessionStart = createDaemonSessionStart({ daemonEnv, SERVICE_MODE, STREAMS_DIR, TASK_DIR_ROOT, GATEWAY_SOCK_PATH, SECRETS_ROOT: () => SECRETS_ROOT,
  secretsSessionEnv: () => secretsSessionEnv(), SESSION_RUNTIME_DIR, CLAUDE_PROJECTS_DIRS, sessions, core, spawn, execFile, childUse, spawnPool, runtimeTimers,
  clearInterval, sessionStopVersions, sessionStartGate, cronRuntime: () => cronRuntime, daemonBootId: () => daemonBootId, demoQuiesce, cliArgvFiles, cliOwner,
  hostResume, strictStartRefusal, waitForStoppedProcess, requireBudgetAllowance, budgetRefusal, cancelledStartPath, isJournalSid, readStartTime,
  readStartTimeAsync, killProcessGroup, reapSession, broadcastSessionState, persistRegistryDurable, logStateTransition, spawnInfoFor, appendSpawnJournal,
  namedSessionId, emptyTaskState, statSizeOrZero, streamFold, streamWriterGone, streamCompact, foldCheckpoint, cronMetadata,
  cronMetadataConfig: () => cronMetadataConfig, cronProcess, hostCallTokens, sessionWalnutApiUrl, walnutThroughGateway, settingsEnvOf,
  buildSpawnPreamble, sessionShell, passwdReady, shellSetupOfStart, gateClaudeLaunch, pwSilenceFile, pwSilenceOptions,
  turnSnapshots: { onTurnStart: (sid, cwd) => turnSnapshots.onTurnStart(sid, cwd) },
  ensureWatcher: (sid) => ensureWatcher(sid),
  addSubscriber: (ws, sid, fromOffset) => addSubscriber(ws, sid, fromOffset),
  stopSessionWatcher: (sid) => stopSessionWatcher(sid),
  logMsg, sendOk, sendError })
const { cmdStart, startSessionProcess } = sessionStart

// ── Daemon hooks (daemon-hooks.ts): the declarative rules each Walnut pushes ──
const hooks = createDaemonHooks({ daemonEnv, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, walnutScope, gatewayClientHomes, sessionHomeOf, logMsg })
const { hookActions, HOOKS_DIR, daemonHooksByHome, loadDaemonHooksAtBoot, persistedHooksHashFor, handoverHooks } = hooks

// ── walnut-trigger: the daemon owns the clock and runs the check; clock routines (clock-routine-v1) ──
// The store (daemon-trigger-store.ts), the runs and the clock (daemon-trigger-runs.ts), the set
// (daemon-trigger-set.ts) and the other commands (daemon-trigger-commands.ts).
const triggerStore = createDaemonTriggerStore({ judge: hostTriggerJudge, daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, walnutScope, gatewayClientHomes, wsClients, isServerClient, sendEvent, logMsg })
const { TRIGGERS_BASE_DIR, TRIGGER_STATE_DIR, armedTriggers, drainingTriggers, hostDeliveriesInFlight, triggerChecksRunning, triggerScopes, triggerScopeOf, persistTriggersFile } = triggerStore
const triggerRuns = createDaemonTriggerRuns({ judge: hostTriggerJudge, daemonEnv, triggerStore, demoQuiesce, childUse, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, followerTriggers, clockHostStart, setInterval, clearInterval, logMsg })
const { demoTriggerChecks, demoTriggerCheckPids } = triggerRuns
const triggerSet = createDaemonTriggerSet({ judge: hostTriggerJudge, triggerStore, triggerRuns, offlineHost, walnutScope, gatewayClientHomes, sendEvent, logMsg, sendOk, sendError })
const { loadTriggersAtBoot, effectiveTriggerDefs, armTriggerSet, triggerHoldsChanged } = triggerSet
const triggerCommands = createDaemonTriggerCommands({ judge: hostTriggerJudge, triggerStore, triggerRuns, demoQuiesce, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, clockHostStart, walnutScope, gatewayClientHomes, foreignHomeRefusal, logMsg })
const { runTriggerTest } = triggerCommands
// keepRuntimeFiles clock; cleanup() stops it, so a dying daemon never writes its files back.
let runtimeKeepTimer: ReturnType<typeof setInterval> | null = null

// ── skills.sync (daemon-skills.ts): Walnut's skills in this host's engine stores ──
const skills = createDaemonSkills<ServerWebSocket<WsData>>({ daemonEnv, HOME_DIR, KEEPS_SESSIONS, SET_ID, OFFLINE_HOST_DIR, logMsg })

// ── What the tailer checks on a line: durable CronCreate, turn-error auto-retry, CLI cron fires (daemon-line-checks.ts) ──
const lineChecks: DaemonLineChecks<ServerWebSocket<WsData>> = createDaemonLineChecks({ daemonEnv, sessions, core, daemonCommands, retryCheckVersions, cronRuntime: () => cronRuntime, hookActions, budgetAllowance,
  cmdBridgeResume, persistRegistry, setTimeout, clearTimeout, logMsg })
const { TURN_RETRY_CFG, checkDurableCronCreate, checkTurnRetry, cancelTurnRetry, checkCronFires } = lineChecks

// ── File watching for JSONL streaming: the session tailer and its subscribers (daemon-session-tailer.ts) ──
const sessionTailer: DaemonSessionTailer<ServerWebSocket<WsData>> = createDaemonSessionTailer({ SERVICE_MODE, TAILER_CARRY_MAX, TAILER_TICK_READ_MAX, sessions, core, cliOwner, offlineHost, liveSettings, usageBudget,
  budgetControl, cronMetadata, cronMetadataConfig: () => cronMetadataConfig, cronProcess, hookActions, applyTaskEvent, appendSpawnJournal, namedSessionId,
  streamEpochOf, pushSnapshot, persistRegistry, writeFifoRaw, checkCronFires, checkDurableCronCreate, checkTurnRetry,
  // Made further down (the transcripts), so asked on use.
  turnSnapshots: { onTurnEnd: (sid, cwd, v) => turnSnapshots.onTurnEnd(sid, cwd, v) },
  parsedFor, wsId, setInterval, clearInterval, logMsg, sendEvent })
const { ensureWatcher, stopSessionWatcher, addSubscriber } = sessionTailer

// ── Attach, send, sendRaw, the turn-start marker, setMode, status (daemon-session-commands.ts) ──
// What is defined further down in the body is asked on use.
const sessionCommands = createDaemonSessionCommands({ STREAMS_DIR, sessions, core, streamFold, sessionStartGate, sessionStopVersions,
  cronRuntime: () => cronRuntime, cliOwner, hostResume, readStartTimeAsync, reapSession, startOrphanPoll, persistRegistry,
  cancelTurnRetry: (sid, reason) => cancelTurnRetry(sid, reason),
  addSubscriber: (ws, sid, fromOffset) => addSubscriber(ws, sid, fromOffset),
  logMsg, sendOk, sendError })
const { cmdAttach, cmdLineFate, cmdSend, sendSessionMessage, cmdSendRaw, cmdAppendUserMarker, cmdSetMode, applyModePolicy, cmdStatus } = sessionCommands

// ── Stop session (daemon-session-stop.ts) ──
// What is defined further down in the body is asked on use.
const sessionStop = createDaemonSessionStop({ SERVICE_MODE, SESSION_IDLE_WARNING_MS: () => SESSION_IDLE_WARNING_MS, SESSION_IDLE_KILL_MS: () => SESSION_IDLE_KILL_MS,
  sessions, cliArgvFiles, cronRuntime: () => cronRuntime, daemonBootId: () => daemonBootId, sessionStartGate, sessionStopVersions, journaledHome, journaledIds,
  walnutOfHome, servedStopRefusal, isProcessGroupAlive, killProcessGroup, readStartTime, commandLineOf, reapSession, persistRegistry, persistRegistryDurable,
  deriveSessionProtection: (session, sid, now) => deriveSessionProtection(session, sid, now),
  hasRecentSchedulerFiring: (sid, withinMs) => hasRecentSchedulerFiring(sid, withinMs),
  cancelTurnRetry: (sid, reason) => cancelTurnRetry(sid, reason),
  wsId, setTimeout, logMsg, sendOk, sendError })
const { cmdStop, stopOwnerRefusal, stopSessionProcess } = sessionStop

// ── getState and its cold rebuild, cron supervision, rename, read-history, delivery markers, the session list (daemon-session-state.ts) ──
// What is defined further down in the body is asked on use.
const sessionState = createDaemonSessionState({ STREAMS_DIR, FOLD_REBUILD_CHUNK, TAILER_CARRY_MAX, sessions, cronRuntime: () => cronRuntime, foldCheckpoint,
  streamCompact, followerReads, gatewaySidAliases, cronMetadata, cronProcess, applyTaskEvent, emptyTaskState, assembleSessionSnapshot, pushSnapshot, persistRegistry,
  deriveSessionProtection: (session, sid, now) => deriveSessionProtection(session, sid, now),
  ensureWatcher: (sid) => ensureWatcher(sid),
  stopSessionWatcher: (sid) => stopSessionWatcher(sid),
  demoQuiesce, followerHomeOf, isProcessGroupAlive, setImmediate, clearTimeout, logMsg, sendOk, sendError })
const { cmdCronSupervision, cmdGetState, cmdRename, cmdReadHistory, cmdMarkersFind, cmdList } = sessionState

// ── A team's agents: subscribe to an agent's transcripts, write to its inbox (daemon-agent-subs.ts) ──
const agentSubCommands = createDaemonAgentSubs({ HOME_DIR, STREAMS_DIR, LISTEN, AGENT_POLL_INTERVAL_MS, AGENT_REDISCOVER_INTERVAL_MS, agentSubs, setInterval, clearInterval,
  sendEvent, sendOk, sendError })
const { cmdSubscribeAgent, cmdUnsubscribeAgent, cmdWriteInbox } = agentSubCommands

// ── File system operations (daemon-fs-read.ts, daemon-fs-write.ts) ──
const fsRead = createDaemonFsRead<ServerWebSocket<WsData>>({ HOME_DIR, CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_DIRS, childUse })
const fsWrite = createDaemonFsWrite<ServerWebSocket<WsData>>({ daemonEnv, HOME_DIR, DAEMON_DIR, FALLBACK_DAEMON_DIR, codeServer, looksLikeImage: fsRead.looksLikeImage, logMsg })

// ── Git read commands (daemon-git.ts): diff, status, refs, one file's history, exclude ──
const git = createDaemonGit<ServerWebSocket<WsData>>({ daemonEnv, HOME_DIR, execFileCb })

// ── Session changes, usage scans, session commit (daemon-changes.ts) ──
const sessionChanges = createDaemonChanges<ServerWebSocket<WsData>>({ daemonEnv, HOME_DIR, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, CLAUDE_CONFIG_HOME, childUse, spawn, daemonCommands, sessions, logMsg })
const { computeChangesCached, releaseIdleChangesState, CHANGES_RELEASE_AFTER_MS } = sessionChanges

// ── One-shot claude runs, workspace transfer, host facts (daemon-host-transfer.ts) ──
const hostTransfer = createDaemonHostTransfer({ daemonEnv, DAEMON_DIR, HOME_DIR, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, DAEMON_INSTANCE_ID, DAEMON_START_TS, TASK_DIR_ROOT, spawn, execFile, cliArgvFiles, sessions, hostResume, wsClients, isServerClient, daemonCommands, sendEvent, logMsg, sendOk, sendError })
const { oneShot, replyOneShot, transferCore, transferPack, desktopUpdate, hostFacts, hostVitals, uploadsOwnerlessRoot, uploadsRootFor, transferAnswer } = hostTransfer

// ── Commands for tasks on other hosts (capability 'host-exec-v1') ──
// PARITY: The logic is host-exec-core.ts; this
// twin hands it spawn, the group signal, and an env without Walnut's own variables.
const HOST_EXEC_DIR = SERVICE_MODE && DAEMON_STATE_DIR
  ? path.join(DAEMON_STATE_DIR, 'host-exec')
  : IS_PROD_DAEMON_DIR ? path.join(HOME_DIR, '.open-walnut', 'tmp', 'host-exec') : path.join(DAEMON_DIR, 'host-exec')
function hostExecEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(daemonEnv)) {
    if (typeof v !== 'string' || k.startsWith('WALNUT_') || k.startsWith('OPEN_WALNUT_') || k === 'BUN_BE_BUN') continue
    env[k] = v
  }
  env.HOME = daemonEnv.HOME || HOME_DIR
  return env
}
const hostExec = createHostExec({
  spawn: (command, args, opts) => spawn(command, args, opts),
  killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: sessionShell(),
  home: HOME_DIR,
  taskDirRoot: TASK_DIR_ROOT,
  stateDir: HOST_EXEC_DIR,
  // Detached runs are listed with the surviving ACP workers (detached-registry.ts): one dir for a rollback's stop.
  registryDir: DETACHED_RUNS_DIR,
  env: hostExecEnv(),
  // wait_for's matcher: this program again (the stable copy once the shim made one), as --wait-matcher.
  matcher: () => ({ command: walnutCliArgv[0]!, args: [...walnutCliArgv.slice(1), '--wait-matcher'] }),
  childProcess: childUse,
})
// Which kinds of listed detached work this service adopts, for the launcher (detached-registry.ts
// `adopts`); any other kind is ended now.
// The launcher's ready mark waits for it: a launcher reads a ready service with no `adopts` as one
// older than this file and ends the work (service-launcher-script.ts).
const adoptionSettled: Promise<void> = hostExec.settleAdoption({ acp: typeof acp.endForRollback === 'function' }).then(({ wrote, said }) => {
  if (!wrote) logMsg('warn', 'detached/adopts not written: a launcher will end the detached work as a rollback')
  if (said) logMsg('info', 'detached work this service cannot adopt was ended', { said: said.trim().slice(0, 2000) })
}, () => {})
// A task on another host calling this host's MCP servers ('host-mcp-v1', host-mcp-core.ts)
// and its web services ('host-http-v1', host-http-core.ts). PARITY:
/**
 * The MCP servers of a test server's isolated daemon (WALNUT_INSTALL_HOME) keep the real
 * HOME (their own config and sign-ins live there) but put what `npx -y` / `uvx` fetch
 * under the isolated install home.
 */
function hostMcpEnv(): Record<string, string> {
  const env = hostExecEnv()
  const own = daemonEnv.WALNUT_INSTALL_HOME
  if (own) Object.assign(env, { npm_config_cache: path.join(own, '.npm'), XDG_CACHE_HOME: path.join(own, '.cache'), UV_CACHE_DIR: path.join(own, '.cache', 'uv'), PIP_CACHE_DIR: path.join(own, '.cache', 'pip') })
  return env
}
const hostMcp = createHostMcp({
  spawn: (command, args, opts) => spawn(command, args, opts),
  killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: sessionShell(),
  home: HOME_DIR,
  env: hostMcpEnv(),
})
const hostHttp = createHostHttp()

// ── A session's servers, the host network, hub forwards, shared secrets, task workspaces (daemon-host-services.ts) ──
const hostServices = createDaemonHostServices({ daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, PORT_FILE, spawn, childUse, sessions, acp, gatewaySidAliases, freshLeaderLinks, leaderBook, streamRelay, isServerClient, walnutScope, gatewayClientHomes, daemonCommands, setInterval, clearInterval, logMsg })
const { daemonPorts, DAEMON_MACHINE_ID, netSupervisor, hubForwards, hubLinksChanged, SECRETS_ROOT, secretStore, secretsSessionEnv, WORKSPACE_STATE_DIR } = hostServices

// ── A session's first-paint view, parsed next to its transcript ('history-ready-v1') ──
// history-ready-core.ts holds the whole design (bounded parse, rewind dead set, archived tail,
// readable check). The rewind dead set, read, parse, fit and gzip run in a worker thread
// (history-ready-worker.ts, compiled in as a second entry), never on this loop; this is the wire.
const historyReadyMain = (globalThis as { Bun?: { main?: string } }).Bun?.main ?? ''
const historyReadyExecutor = createReadyWorkerExecutor(
  readyWorkerEntries(historyReadyMain, import.meta.url)
    .map((entry) => () => new ThreadWorker(entry.startsWith('file:') ? new URL(entry) : entry) as unknown as ReadyWorkerLike),
  { log: (level, msg, data) => logMsg(level, msg, data) },
)
const historyReady = createHistoryReady({
  executor: historyReadyExecutor,
  log: (level, msg, data) => logMsg(level, msg, data),
})

// ── Transcript reads: rewind probe, first-paint view, turn snapshots, outside sessions (daemon-transcripts.ts) ──
const transcripts = createDaemonTranscripts({ daemonEnv, DAEMON_DIR, CLAUDE_CONFIG_HOME, execFileCb, walnutScope, gatewayClientHomes, sessionHomeOf, sessions, computeChangesCached, historyReady, logMsg })
const { turnSnapshots } = transcripts

// ── The commands answered by function (AnswerFn, daemon-module-deps.ts), by name ──
// dispatchCommand answers a socket's command from this table (answerCommand: the Answer becomes
// its reply frame), and a client in this process calls it (callCommand: the Answer comes back as
// the reply object). Both go through the same gates first (passCommandGates). Every other command
// is a case of dispatchCommand: one that streams, pushes events, answers more than once or keeps
// something on its socket.
type WsOf = ServerWebSocket<WsData>
/** A host-local core's command (transferAnswer): its result, or `{error, code}`; `tracked` work rides the drain. */
function hostLocal(name: string, work: (cmd: Record<string, unknown>, from: WsOf) => Promise<unknown>, tracked = false): AnswerFn<WsOf> {
  return (cmd, from) => transferAnswer(name, () => work(cmd, from), tracked)
}
const secretsWrite = (name: string, op: (cmd: Record<string, unknown>) => unknown): AnswerFn<WsOf> => (cmd, from) => {
  // A write names its Walnut (the owner a sync prunes by); never another's on a bound socket.
  if (walnutScope.foreign(cmd, gatewayClientHomes.get(from))) return fail(`${name}: this socket speaks for another Walnut`, { code: 'not_owner' })
  return transferAnswer(name, async () => op(cmd), false)
}
const hostCommandAnswers: Answers<WsOf> = {
  // A command for a task on another host (host-exec-v1, host-exec-core.ts). NOT in
  // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: it runs anything the user
  // can, so only the trusted walnut socket asks, after the server checked the
  // user's grant.
  'exec.run': hostLocal('exec.run', (cmd) => hostExec.run(cmd)),
  'exec.read': hostLocal('exec.read', (cmd) => hostExec.read(cmd)),
  'exec.kill': hostLocal('exec.kill', (cmd) => hostExec.kill(cmd)),
  'exec.list': hostLocal('exec.list', (cmd) => hostExec.list(cmd)),
  // A plugin's short script (host-script-v1, host-script-core.ts): the same rule as exec.*.
  'exec.script': hostLocal('exec.script', (cmd) => hostExec.script(cmd)),
  // A task on another host calling this host's MCP servers and web services (host-mcp-v1,
  // host-http-v1). The same rule as exec.*: only the trusted walnut socket asks, after the
  // server checked the user's grant.
  'mcp.list': hostLocal('mcp.list', (cmd) => hostMcp.list(cmd)),
  'mcp.tools': hostLocal('mcp.tools', (cmd) => hostMcp.tools(cmd)),
  'mcp.call': hostLocal('mcp.call', (cmd) => hostMcp.call(cmd)),
  'mcp.result': hostLocal('mcp.result', (cmd) => hostMcp.result(cmd)),
  'http.request': hostLocal('http.request', (cmd) => hostHttp.request(cmd)),
  // The servers a session started (ports-v1, port-scan-core.ts). NOT in
  // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: ports.stop signals host
  // processes.
  'ports.list': hostLocal('ports.list', (cmd) => daemonPorts.list(cmd)),
  'ports.stop': hostLocal('ports.stop', (cmd) => daemonPorts.stop(cmd)),
  // The host network (net-v1, net-core.ts). NOT in BRIDGE_ALLOWED_COMMANDS or
  // FOLLOWER_ALLOWED_COMMANDS: it decides who may reach this daemon, so only the
  // trusted walnut socket asks.
  'net.status': hostLocal('net.status', () => netSupervisor.status()),
  'net.identity': hostLocal('net.identity', async () => ({ endpointId: await netSupervisor.identity() })),
  'net.configure': hostLocal('net.configure', (cmd) => netSupervisor.configure(cmd)),
  'net.forward': hostLocal('net.forward', (cmd) => netSupervisor.forward(cmd)),
  'net.probe': hostLocal('net.probe', (cmd) => netSupervisor.probe(cmd)),
  'net.invites': hostLocal('net.invites', (cmd) => netSupervisor.invites(cmd)),
  'net.join': hostLocal('net.join', (cmd) => netSupervisor.join(cmd)),
  // The secrets the user shared with this host (secrets-v1, secrets-core.ts). NOT in
  // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: only the Mac's trusted socket
  // writes or lists them, and no reply ever carries a value.
  'secrets.list': hostLocal('secrets.list', async () => secretStore.list()),
  'secrets.put': secretsWrite('secrets.put', secretStore.put),
  'secrets.remove': secretsWrite('secrets.remove', secretStore.remove),
  'secrets.sync': secretsWrite('secrets.sync', secretStore.sync),
  // 'fs-write-part-v1' / 'transfer-v1' / 'host-facts-v1' (transfer-core.ts,
  // transfer-pack-core.ts, host-facts-core.ts): moving a workspace to another
  // host. NOT in BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: they
  // write host files, run ssh/scp, or (host.facts) read what this host is,
  // which only the trusted walnut socket asks, like host.preflight.
  // A private write ('transfer-private-v1') is authorized by this socket's own
  // binding (leader.configure / leader.claim), never by a field of the command.
  // 'upload-part-v1': a phone's attachment, bridge-reachable (see BRIDGE_ALLOWED_COMMANDS).
  'upload.part': hostLocal('upload.part', (cmd, from) => {
    const root = uploadsRootFor(cmd, from.data?.origin === 'bridge')
    return transferCore.uploadPart(cmd, root, root === uploadsOwnerlessRoot())
  }),
  'fs.writePart': hostLocal('fs.writePart', (cmd, from) => transferCore.writePart(cmd, { boundHome: boundLocationOf(from), origin: from.data?.origin ?? null })),
  'transfer.pack': hostLocal('transfer.pack', (cmd) => transferPack.pack(cmd), true),
  'transfer.reach': hostLocal('transfer.reach', (cmd) => transferCore.reach(cmd)),
  'transfer.fetch': hostLocal('transfer.fetch', (cmd) => transferCore.fetch(cmd), true),
  'transfer.realpath': hostLocal('transfer.realpath', (cmd) => transferCore.realpath(cmd)),
  'transfer.scan': hostLocal('transfer.scan', (cmd) => transferPack.scan(cmd)),
  'transfer.apply': hostLocal('transfer.apply', (cmd) => transferPack.apply(cmd), true),
  'transfer.clear': hostLocal('transfer.clear', (cmd) => transferPack.clear(cmd), true),
  'transfer.recent': hostLocal('transfer.recent', (cmd) => transferPack.recent(cmd)),
  'host.facts': hostLocal('host.facts', (cmd) => hostFacts.facts(cmd)),
  'host.load': hostLocal('host.load', (cmd) => hostFacts.load(cmd)),
  'host.endpoint': hostLocal('host.endpoint', (cmd) => hostFacts.endpoint(cmd)),
  // 'host-vitals-v1' (host-vitals-core.ts): now (CPU, load, memory, uptime) and the
  // ledger fold (up and linked minutes, outages, boots). Read-only, like host.facts.
  'host.vitals': hostLocal('host.vitals', (cmd) => hostVitals.vitals(cmd) as unknown as Promise<Record<string, unknown>>),
  'desktop.updateStatus': hostLocal('desktop.updateStatus', () => desktopUpdate.status()),
  'desktop.restart': hostLocal('desktop.restart', (cmd) => desktopUpdate.restart(cmd.token, cmd.force), true),
}

/**
 * Every command answered by function. The bridge, follower and lane allowlists decide who may
 * ask each (passCommandGates); an area module's commands (with their capability and bridge
 * notes) are listed in its own file. A name two areas both answer is a wiring mistake: refused here.
 */
const commandAnswers: Answers<WsOf> = (() => {
  const table: Answers<WsOf> = Object.create(null)
  const areas: Array<[string, Answers<WsOf>]> = [
    ['fs-read', fsRead.answers], ['fs-write', fsWrite.answers], ['git', git.answers], ['changes', sessionChanges.answers],
    ['transcripts', transcripts.answers], ['host-services', hostServices.answers], ['hooks', hooks.answers],
    ['trigger-commands', triggerCommands.answers], ['skills', skills.answers], ['host-local', hostCommandAnswers],
  ]
  for (const [area, answers] of areas) {
    for (const [name, answerFn] of Object.entries(answers)) {
      if (name in table) throw new Error(`daemon command ${name} is answered twice (${area})`)
      table[name] = answerFn
    }
  }
  return table
})()

/**
 * Answered inside the drain like session commands: a shutdown or a handover waits for them. A cut
 * writeFile leaves a truncated file; a hooks or trigger push must not be cut halfway either.
 * (workspace.* and the tracked host-local commands ride the drain from their own answer.)
 */
const DRAINED_ANSWERS = new Set(['image.save', 'fs.write', 'fs.mkdir', 'fs.rename', 'fs.rm', 'fs.copy', 'hooks.configure',
  'triggers.run', 'triggers.ack', 'triggers.claim', 'triggers.state.snapshot', 'triggers.state.seed'])

/** The answer function of a command name, or null when dispatchCommand handles it. */
function answerFnOf(name: unknown): AnswerFn<WsOf> | null {
  return typeof name === 'string' ? commandAnswers[name] ?? null : null
}

/**
 * Run one answer function for `from` (inside the drain for DRAINED_ANSWERS) and hand its Answer
 * to `deliver` exactly once: a throw, a rejection or a drain that turns it away is the same
 * error reply a handler's throw gets (handlerThrew).
 */
function answerCommand<R>(from: WsOf, cmd: Record<string, unknown>, answerFn: AnswerFn<WsOf>, deliver: (answer: Answer) => R): R | Promise<R> {
  const threw = (err: unknown) => handlerThrew(cmd, err)
  let delivered = false
  const once = (answer: Answer) => { delivered = true; return deliver(answer) }
  const run = () => {
    // An answer function that ran its work inside the drain (workspace.*, the tracked host-local
    // commands) hands back that work: what delivers its answer is drained work too.
    let made: unknown
    const out = settleAnswer(() => (made = answerFn(cmd, from)), threw, once)
    if (made !== out) daemonCommands.follow(made, out)
    return out
  }
  try {
    return DRAINED_ANSWERS.has(cmd.cmd as string) ? daemonCommands.run(run) : run()
  } catch (err) {
    // The drain turned it away before it ran; a throw after the answer is not answered again.
    if (delivered) throw err
    return once(threw(err))
  }
}

// ── Protocol helpers ──
// ALL socket writes MUST go through safeSend. Bun's ServerWebSocket.send()
// SILENTLY DROPS the message (returns 0) once the socket's backpressure buffer
// is saturated — a single ~28MB fs.read response is enough. Raw `try {
// ws.send() } catch {}` therefore lost concurrent RPC replies (walnut → 30s
// "Session file read timeout") and live `jsonl` events for other sessions on
// the same shared connection (UI: frozen streaming until refresh). safeSend
// queues on drop and flushes in FIFO order when Bun fires `drain`.
// Regression: tests/providers/daemon-ws-backpressure.test.ts (real binary).
const SEND_QUEUE_MAX_BYTES = 256 * 1024 * 1024

function enqueueForDrain(ws: ServerWebSocket<WsData>, payload: string) {
  const data = ws.data
  data.sendQueue ??= []
  data.sendQueueBytes ??= 0
  data.sendQueue.push(payload)
  data.sendQueueBytes += payload.length
  if (data.sendQueueBytes > SEND_QUEUE_MAX_BYTES) {
    // A client that stops reading would pin unbounded memory. Closing is safe:
    // the walnut side auto-reconnects and re-attaches (future-only offsets),
    // and an explicit close is honest where a silent drop was the original bug.
    logMsg('error', 'send queue overflow — closing slow client', {
      wsId: wsId(ws), queuedBytes: data.sendQueueBytes, queuedMsgs: data.sendQueue.length,
    })
    data.sendQueue = []
    data.sendQueueBytes = 0
    try { ws.close() } catch {}
  }
}

function safeSend(ws: ServerWebSocket<WsData>, payload: string) {
  // FIFO ordering: once anything is queued, later sends must queue behind it.
  if (ws.data.sendQueue?.length) return enqueueForDrain(ws, payload)
  let result: number
  try { result = ws.send(payload) } catch { return }
  // Bun send(): >0 = sent, -1 = buffered internally (delivered later, drain
  // will fire), 0 = DROPPED because the buffer is full → queue for drain.
  if (result === 0) enqueueForDrain(ws, payload)
}

function flushSendQueue(ws: ServerWebSocket<WsData>) {
  const data = ws.data
  const q = data.sendQueue
  if (!q?.length) return
  while (q.length) {
    let result: number
    try { result = ws.send(q[0]) } catch { return }
    if (result === 0) return // still saturated — next drain resumes here
    data.sendQueueBytes! -= q[0].length
    q.shift()
  }
}

function sendOk(ws: ServerWebSocket<WsData>, id: number | null, data: Record<string, unknown>) {
  sendFrame(ws, okFrame(ws, id, data))
}

/** `level`: an expected refusal (a job restarting) is logged below error. */
function sendError(ws: ServerWebSocket<WsData>, id: number | null, error: string, data?: Record<string, unknown>, level: 'error' | 'warn' | 'info' = 'error') {
  sendFrame(ws, errorFrame(ws, id, error, data, level))
}

/** A command's Answer (daemon-module-deps.ts) as its reply frame, the same sendOk / sendError send. */
function sendAnswer(ws: ServerWebSocket<WsData>, id: number | null, answer: Answer) {
  sendFrame(ws, answerFrame(ws, id, answer))
}

/**
 * The reply frame of an answer: what goes to a socket, and what a client in this process gets back
 * from a direct call (callCommand). A follower's read is cut to its scope here; an error is logged.
 */
function answerFrame(ws: ServerWebSocket<WsData>, id: number | null, answer: Answer): DaemonFrame {
  return answer.ok ? okFrame(ws, id, answer.data) : errorFrame(ws, id, answer.error, answer.data, answer.level)
}

function okFrame(ws: ServerWebSocket<WsData>, id: number | null, data: Record<string, unknown>): DaemonFrame {
  if (ws?.data?.origin === 'follower') data = followerReads.settle(ws, id, data) ?? data
  // The frame's id wins (a trigger's `id` never re-addresses the answer); a refusal sent here with
  // `ok: false` in its data keeps it (ARG_REFS_MISSING, session_stopped, session_dead).
  return { ok: true, ...data, id }
}

function errorFrame(ws: ServerWebSocket<WsData>, id: number | null, error: string, data?: Record<string, unknown>, level: 'error' | 'warn' | 'info' = 'error'): DaemonFrame {
  if (ws?.data?.origin === 'follower') followerReads.settle(ws, id)
  logMsg(level, level === 'error' ? 'command error' : 'command refused', { id, error, ...(level !== 'error' && typeof data?.errorKind === 'string' ? { errorKind: data.errorKind } : {}) })
  return { ...data, id, ok: false, error }
}

/**
 * What a live jsonl line carries for a client in this process: its JSON as the tailer parsed it
 * once (`parsed`), so the server reads the object and never parses the line again. A socket client
 * gets the text only, and the line is not parsed for it here.
 */
function parsedFor(ws: ServerWebSocket<WsData>, parse: () => unknown): Record<string, unknown> | undefined {
  if (!ws.data?.deliverFrame) return undefined
  try {
    const parsed = parse()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { parsed } : undefined
  } catch { return undefined }
}

function sendEvent(ws: ServerWebSocket<WsData>, ev: string, data: Record<string, unknown>, local?: Record<string, unknown>) {
  // A lane hears its streams and nothing of the broadcasts its session link already hears.
  if (ws.data?.origin === 'lane' && !ev.startsWith('stream-')) return
  sendFrame(ws, { ev, ...data }, local)
}

/**
 * One frame to one client: a client in this process (connect(), daemon-in-process-client.ts)
 * takes the object itself; a socket gets its JSON text. `local` rides only the object.
 */
function sendFrame(ws: ServerWebSocket<WsData>, frame: Record<string, unknown>, local?: Record<string, unknown>) {
  const deliver = ws.data?.deliverFrame
  if (deliver) { deliver(local ? { ...frame, ...local } : frame); return }
  safeSend(ws, JSON.stringify(frame))
}

// ── The session idle scanner, the keep-alive verdict, the cron evidence, the boot adoption (daemon-idle-scan.ts) ──
const idleScan = createDaemonIdleScan({ daemonEnv, HOME_DIR, SERVICE_MODE, STREAMS_DIR, sessions, core, cliOwner, codeServer, cronRuntime: () => cronRuntime, daemonCommands,
  isProcessGroupAlive, killProcessGroup, killSessionProcessGroup, namedSessionId, readStartTime, reapSession, rebuildFoldStateFromJsonl, rebuildTaskStateFromJsonl,
  startOrphanPoll, logMsg })
const { SESSION_IDLE_WARNING_MS, SESSION_IDLE_KILL_MS, SESSION_SCAN_INTERVAL_MS, SESSION_IDLE_SCAN_MS, hasRecentSchedulerFiring, deriveSessionProtection,
  scanIdleSessions, recordAdoptedOwners, cleanupOrphanedProcessGroups } = idleScan

// ── Cleanup ──
/** `registrySaved`: the stop wrote the registry just before (stopDaemon). */
function cleanup(opts: { registrySaved?: boolean } = {}) {
  // One-shot claude runs and the warm pool never outlive the daemon (oneshot-core.ts).
  try { oneShot.disposeAll() } catch {}
  // MCP servers started for tasks on other hosts end with the daemon that holds their stdin.
  try { hostMcp.closeAll() } catch {}
  usageBudget.close()
  budgetControl.close()
  void cronRuntime?.close().catch((error) => logMsg('error', 'cron supervision shutdown failed', { error: String(error) }))
  // Stop the trigger clock first, then end the check runs still going (daemon-trigger-runs.ts).
  triggerRuns.stopTriggers()
  if (runtimeKeepTimer) { try { clearInterval(runtimeKeepTimer) } catch {} runtimeKeepTimer = null }
  // Close the cloud bridge first — a half-dead daemon must not keep looking
  // reachable from the phone. bridge.json survives for the successor.
  try { stopBridges() } catch {}

  // Embedded code-server: leave it running on a graceful production restart —
  // the successor adopts it via ~/.open-walnut/code-server/instance.json (same
  // philosophy as CLI session adoption). Isolated/test daemons have no
  // successor, so reap it like everything else (shouldReapOnExit below).
  if (shouldReapOnExit()) { try { codeServer.stopCodeServer() } catch {} }

  // Phase C change: preserve running sessions across a graceful daemon
  // restart. The next daemon's reconcileRegistry() will adopt them as
  // orphans via the 1s poll. Previously we killed everything on SIGTERM
  // which defeated the orphan-survival property the plan requires.
  //
  // We still stop the session-bound file tailers so the SSH tunnel can close
  // cleanly, but we leave the CLI process groups alive — the successor daemon
  // will adopt them and spin new watchers on first attach.
  //
  // EXCEPTION — isolated-dir daemons (sandbox/tests/demos): there is never a
  // successor daemon for these dirs, so "preserve for adoption" just leaks CLI
  // process groups forever (25 orphans up to 8 days old found 2026-07-25 — the
  // daemon-level leak fixed by the parent watchdog had moved down to the CLI
  // level via this path). See reapAllSessionGroupsSync + shouldReapOnExit.
  for (const [sid, session] of sessions) {
    stopSessionWatcher(sid)
    // The successor adopts this session: hand it the fold so far, so its boot
    // folds only what arrives after this line (fold-checkpoint-core.ts).
    try { checkpointSessionFold(session, true) } catch {}
    // C1: flush a pending coalesced snapshot BEFORE dropping subscribers — the
    // last state change of this daemon's life still reaches the connected
    // walnut instead of dying inside a 50ms timer.
    if (session.snapshotTimer) {
      try { pushSnapshot(sid, true) } catch {}
    }
    session.subscribers.clear()
    if (session.orphanPollTimer) {
      try { clearInterval(session.orphanPollTimer) } catch {}
    }
  }

  // Do we still own this daemon dir? A zombie exiting via the heartbeat
  // self-check finds daemon.pid naming its SUCCESSOR — it must touch neither
  // the dir's files nor (crucially) the session process groups the successor
  // has already adopted. Computed BEFORE the reap for exactly that reason.
  let ownsFiles = true
  try {
    const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (ownerPid > 0 && ownerPid !== process.pid) ownsFiles = false
  } catch {}

  if (ownsFiles && shouldReapOnExit()) reapAllSessionGroupsSync()

  // Flush the registry one more time so the successor daemon sees the latest
  // state. We do NOT delete the registry — the next daemon reads it. Synchronous:
  // a process may exit right after; a stop that just wrote it (registrySaved)
  // writes again only when something changed since. Only while the dir is ours: a zombie's old
  // inventory must never replace its successor's.
  if (ownsFiles) { try { persistRegistryNow({ unlessClean: opts.registrySaved === true }) } catch {} }

  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
  }
  // Remove port/pid/instance files (but NOT the sessions registry — successor needs it).
  // Instance file gets replaced by the successor's own id on the next --start.
  if (ownsFiles) {
    try { fs.unlinkSync(PORT_FILE) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    try { fs.unlinkSync(STAMP_FILE) } catch {}
    try { fs.unlinkSync(INSTANCE_ID_FILE) } catch {}
    try { fs.unlinkSync(SERVICE_FILE) } catch {}
    try { fs.unlinkSync(VERSION_FILE) } catch {}
    // Agent gateway artifacts — a zombie must never delete its successor's
    // live socket/shim, hence inside the ownsFiles guard.
    try { fs.unlinkSync(GATEWAY_SOCK_PATH) } catch {}
    try { fs.unlinkSync(GATEWAY_SHIM_PATH) } catch {}
    try { fs.unlinkSync(path.join(GATEWAY_SHIM_DIR, 'wn')) } catch {} // retired alias, older daemons wrote it
    // walnut-core (the stable copy of this artifact) is deliberately KEPT: the
    // size+version stamp makes the successor reuse it, which is what turns a
    // restart into a stat instead of a ~60MB copy. One file, bounded size — and
    // if the successor turns out not to need it, its writeWalnutShim reaps it
    // (reapShimCoreArtifacts), so this is never dead weight for long.
  }
  logMsg('info', 'daemon cleanup complete', { uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000) })
  // The process may exit right after: the queued log lines go now.
  logAppender?.flushSync()
}

// ── Handle disconnect for a WebSocket client ──
function handleDisconnect(ws: ServerWebSocket<WsData>) {
  featureRelay.disconnect(featureSocket(ws))
  wsClients.delete(ws)
  acp.removeSubscriber(ws)
  streamRelay.dropLink(ws)
  // A hub forward no primary link takes any more stops listening, so its port refuses.
  if (gatewayClientHomes.has(ws)) setTimeout(hubLinksChanged, 0)
  // Nobody reads a one-shot whose socket closed: end it.
  const droppedOneShots = oneShot.dropClient(ws)
  if (droppedOneShots > 0) logMsg('info', 'oneshot runs ended with their socket', { wsId: wsId(ws), runs: droppedOneShots })
  if (ws.data?.origin === 'lane' && ws.data.laneHome) laneClosedAt.set(ws.data.laneHome, Date.now())
  const followed = ws.data?.followerHome
  if (followed && followerSockets.get(followed) === ws) followerSockets.delete(followed)
  if (ws.data?.origin === 'follower') { followerGateway.dropSocket(ws); followerTriggers.dropSocket(ws) }
  // Phone sends handed to it and not answered move to the next client now.
  rerouteMessageRelays(ws)
  // So do `walnut` calls relayed on it, where they may go (gatewayRelaysSocketGone).
  gatewayRelaysSocketGone(ws)

  // DUP-DEBUG: count subscriber entries removed across all sessions for this
  // ws. If a subscriber leak shows up, this number tells us how many sids
  // were holding stale references to a now-closed ws.
  let removedFromSubs = 0
  const sidsWithRemoval: string[] = []
  // Remove this ws from every session's subscribers. The session-bound watcher
  // keeps running — it's independent of any ws. Next attach re-subscribes.
  for (const [sid, session] of sessions) {
    const had = session.subscribers.has(ws)
    if (had) {
      session.subscribers.delete(ws)
      removedFromSubs++
      sidsWithRemoval.push(sid)
    }
  }

  // Clean up agent subs for this client
  for (const [key, sub] of agentSubs) {
    if (sub.ws === ws) {
      if (sub.timer) clearInterval(sub.timer)
      if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
      agentSubs.delete(key)
    }
  }

  logMsg('info', 'client disconnected', {
    wsId: wsId(ws),
    clients: wsClients.size,
    removedFromSubs,
    sidsWithRemoval,
  })
}

// ── Cloud bridge: daemon dials OUT to the cloud companion (daemon-cloud-bridge.ts) ──
// Bun 1.4.4 and later: a ws:// bridge rides a TCP socket the daemon opens itself (openBridgeClient there says why).
const BRIDGE_OWN_TCP = Bun.semver.satisfies(Bun.version, '>=1.4.4')
const cloudBridge = createDaemonCloudBridge({ daemonEnv, DAEMON_DIR, HOOKS_DIR, TRIGGER_STATE_DIR, TRIGGERS_BASE_DIR, WORKSPACE_STATE_DIR, DAEMON_VERSION,
  DAEMON_INSTANCE_ID, BRIDGE_CAPABILITIES, BRIDGE_OWN_TCP, walnutScope, sessions, wsClients, gatewayClientHomes, socketWalnut, wsId, isJournalSid, journaledIds,
  forgetJournaledSids, sessionStartHomeOf, handleCommand, handleDisconnect, setTimeout, setInterval, clearTimeout, clearInterval,
  logMsg, sendOk, sendError, sendFrame })
const { BRIDGE_FILE, bridgeLinks, bridgeFileFor, bridgeLinkOf, bridgeLinkFor, servesBridgeHome, bridgeHearsSession, bridgeSpeaksFor, bridgeHomeOf,
  loadBridgeConfig, startBridges, stopBridges, bridgeConfigKey, cmdBridgeConfigure, stopBridge, startBridge, cmdBridgePeer, cmdBridgeStatus } = cloudBridge

// ── Bridge relays: STT, launch, control, message, mobile events (daemon-bridge-relays.ts) ──
const bridgeRelays = createDaemonBridgeRelays({ walnutScope, gatewayClientHomes, pickTrustedClient, noPrimaryError, answersForOtherWalnut, bridgeHomeOf, bridgeLinkFor,
  wsId, setTimeout, clearTimeout, logMsg, sendOk, sendError, sendEvent, sendFrame })
const { sttRelayPending, launchRelayPending, controlRelayPending, messageRelayPending, rerouteMessageRelays, cmdSttRelay, cmdSttResult, cmdLaunchRelay,
  cmdLaunchResult, cmdControlRelay, cmdControlResult, cmdMessageRelay, cmdMessageResult, cmdMobileEvent } = bridgeRelays

// ── Main ──
/** What a daemon answers a plain HTTP request on its port with, since the first daemon. */
const DAEMON_HTTP_ANSWER = 'walnut-daemon ok'

/**
 * Whether a daemon answers on 127.0.0.1:`port` within `timeoutMs`: a plain GET
 * gets `walnut-daemon ok` back. Any other listener (a reused port) is no daemon.
 */
function loopbackDaemonAnswers(port: number, timeoutMs: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let seen = ''
    let settled = false
    const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'))
    socket.on('data', (chunk: Buffer) => {
      seen = (seen + chunk.toString('latin1')).slice(-4096)
      if (seen.includes(DAEMON_HTTP_ANSWER)) done(true)
    })
    socket.once('end', () => done(seen.includes(DAEMON_HTTP_ANSWER)))
    socket.once('close', () => done(seen.includes(DAEMON_HTTP_ANSWER)))
    socket.once('error', () => done(false))
  })
}

/**
 * The pid daemon.pid names, or null: no file, not a plain number, or 0, 1 or
 * below (kill(-1) signals every process of the user, kill(0) the caller's group).
 */
function readDaemonPidFile(): number | null {
  let raw: string
  try { raw = fs.readFileSync(PID_FILE, 'utf-8').trim() } catch { return null }
  if (!/^\d+$/.test(raw)) return null
  const pid = Number(raw)
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null
}

/** Alive in the kill(0) sense; EPERM is another user's process, which a daemon of this user never is
 *  (unlike the module's pidAlive, where EPERM counts as alive). */
function ownPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** `pid`'s command line (Linux /proc, ps elsewhere), '' when it is gone, null when nothing could tell. */
function commandLineOf(pid: number): string | null {
  if (fs.existsSync('/proc/self/cmdline')) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean).join(' ') } catch { return '' }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    return (error as { status?: number }).status === 1 ? '' : null
  }
}

/**
 * Whether `pid` is this dir's daemon: the instance lock names it (every daemon
 * since the lock), or, for an older one, its command line runs a daemon file of
 * this dir the way the Mac starts one (the rule buildDaemonStopCmd applies).
 */
async function isThisDirsDaemon(pid: number): Promise<boolean> {
  const owner = await readDaemonInstanceOwner({ runtimeDir: DAEMON_DIR, uid: os.userInfo().uid, deadlineMs: 2000 })
  if (owner) return owner.pid === pid
  const line = commandLineOf(pid)
  if (!line) return false
  // Every file the Mac may have started here (daemon-start-cmd.ts DAEMON_BINARY_NAMES), built
  // from its parts: a literal name is what the cross-platform ratchet refuses in this file.
  const names = ['linux', 'darwin'].flatMap((osName) => ['x64', 'arm64'].map((arch) => `daemon-${osName}-${arch}`)).concat('daemon.cjs')
  return names.some((name) => ` ${line}`.endsWith(` ${DAEMON_DIR}/${name} --start`))
}

/** `--stop`: what it prints, and 0. */
async function cliStop(): Promise<number> {
  // Only a pid that is this dir's daemon is signalled: a pid file may name
  // another process now (a reused pid), or hold -1, which kill() reads as every process.
  const pid = readDaemonPidFile()
  if (pid === null || pid === process.pid || !ownPidAlive(pid)) {
    console.log('daemon not running')
  } else if (!(await isThisDirsDaemon(pid))) {
    console.log('daemon not running (daemon.pid names pid ' + pid + ', which is not this daemon)')
  } else {
    try {
      process.kill(pid, 'SIGTERM')
      console.log('daemon stopped (pid=' + pid + ')')
    } catch {
      console.log('daemon not running')
    }
  }
  return 0
}

/** `--status`: one JSON line, and 0. */
async function cliStatus(): Promise<number> {
  // Running means the pid is alive AND a daemon answers on the port file's port:
  // a dead daemon's files stay, and its pid may name another process by now.
  const pid = readDaemonPidFile()
  let port = NaN
  try { port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10) } catch {}
  if (pid !== null && ownPidAlive(pid) && await loopbackDaemonAnswers(port, 3000)) {
    let instanceId: string | undefined
    try { instanceId = fs.readFileSync(INSTANCE_ID_FILE, 'utf-8').trim() } catch {}
    console.log(JSON.stringify({ running: true, pid, port, instanceId }))
  } else {
    console.log(JSON.stringify({ running: false }))
  }
  return 0
}

/** `--prewarm-folds`: background work for a running daemon's replacement; one JSON line, and 0. */
function cliPrewarmFolds(): number {
  console.log(JSON.stringify(prewarmFoldCheckpoints()))
  return 0
}

/** start()'s run, while it runs (stop() waits for it). */
let starting: Promise<unknown> | null = null
/** start()'s result, for a second call. */
let startRun: ReturnType<typeof startDaemon> | null = null
/** The daemon's WebSocket server, once it listens (a start() that threw after it is stopped by stop()). */
let listeningServer: { stop(closeActive?: boolean): void } | null = null
/** The stop a started daemon makes (drain, save, release): set once start() got that far. */
let stopStarted: (() => Promise<number>) | null = null

async function startDaemon(): Promise<{ kind: 'started'; port: number } | { kind: 'existing'; port: string }> {
  if (SERVICE_MODE && (!DAEMON_STATE_DIR || !path.isAbsolute(DAEMON_STATE_DIR))) {
    throw new Error('--service requires an absolute WALNUT_DAEMON_STATE_DIR')
  }
  if (SERVICE_MODE) {
    // A runtime inside the host's one Walnut service starts no beat: that server writes the launcher's marks (serve-launcher-beat.ts).
    if (LISTEN) launcherBeat = startLauncherBeat({ dir: daemonEnv.WALNUT_LAUNCHER_DIR, warn: (message) => logMsg('warn', message), execFile: childUse.execFile })
    // Its own: a daemon or service started below this one must never write this launcher's marks.
    delete daemonEnv.WALNUT_LAUNCHER_DIR
    // The handover and the adoption below can take long on a big registry: no stall until it serves.
    launcherBeat?.busy(600)
  }
  // A test server's daemon never runs as, or in the place of, the production one.
  if (ISOLATED_FOR && (IS_PROD_DAEMON_DIR || SERVICE_MODE)) {
    throw new Error('isolated daemon: refusing to start it in the production daemon dir or as a service (WALNUT_DAEMON_ISOLATED_FOR names a test server)')
  }
  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  // A daemon started from a session's shell or terminal is no session's: what it spawns
  // (an editor server, a helper) would be listed as that session's servers (port-scan-core.ts).
  // Each session and terminal it starts gets its own value.
  delete daemonEnv.WALNUT_SESSION_ID
  delete daemonEnv.WALNUT_TERMINAL_SESSION_ID
  // Build directories are retired while detached daemons are still running. A process of its
  // own moves its cwd here (options.chdir) and its children inherit it, healed as always
  // (healDaemonCwd); a runtime in another process gives its children this dir instead.
  if (options.chdir) options.chdir(DAEMON_DIR)
  else childCwd = DAEMON_DIR
  const acquire = () => acquireDaemonInstanceLock({
    runtimeDir: DAEMON_DIR, uid: os.userInfo().uid, pid: process.pid, instanceId: DAEMON_INSTANCE_ID,
    // A service install reads it to refuse a dir a server holds (refuseInProcessOwner); the host's
    // one Walnut service says it is the launcher's service, which an update may hand over.
    inProcess: !LISTEN,
    service: SERVICE_MODE && !LISTEN,
    ...(!LISTEN && options.serverHome ? { home: options.serverHome } : {}),
  })
  let lock = await acquire()
  // A stand-in an update's tail started outside launchd (daemon-update-standin.ts, its pid in
  // daemon.standin) holds the dir: launchd's own daemon waits for the handback instead of
  // exiting. Exiting made KeepAlive start the job again every 5 s, and a job that never stays
  // up reads as inactive, so every later update was refused (2026-11-04 review). The handback
  // ends the stand-in; this daemon then takes the dir and adopts its sessions.
  // A daemon.standin left by a stand-in that was killed (a SIGKILL, a power loss) may name a pid
  // another daemon of this dir has now: a stand-in runs the service's own program, `--service`
  // in its command line (2026-11-04 review). Where the command line cannot be read, the file decides.
  const standInHolds = (pid: number): boolean => {
    try { if (Number(fs.readFileSync(path.join(DAEMON_DIR, 'daemon.standin'), 'utf8').trim()) !== pid) return false } catch { return false }
    let args = ''
    try {
      args = fs.existsSync(`/proc/${pid}/cmdline`) ? fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
        : execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { /* cannot tell */ }
    return !args.trim() || args.split(/\s+/).includes('--service')
  }
  if (SERVICE_MODE && lock.kind === 'existing' && standInHolds(lock.owner.pid)) {
    logMsg('info', 'a stand-in daemon serves this dir; waiting for its handback', { pid: lock.owner.pid })
    while (lock.kind === 'existing' && standInHolds(lock.owner.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      lock = await acquire()
    }
  }
  if (lock.kind === 'existing') {
    if (SERVICE_MODE || lock.owner.wsPort === null) throw new Error('An existing daemon owns this runtime directory; service handover is required')
    return { kind: 'existing', port: String(lock.owner.wsPort) }
  }
  daemonInstanceLock = lock
  if (SERVICE_MODE) {
    fs.mkdirSync(DAEMON_STATE_DIR!, { recursive: true, mode: 0o700 })
    daemonBootId = await readCronBootId(process.platform, AbortSignal.timeout(5000), childUse)
    if (!daemonBootId) throw new Error('Host boot identity is unavailable')
  }
  // Old versions have no kernel lock, so the handover must still yield to them; winning the new lock alone is not enough to start.
  let legacyPid: number | null = null
  try { legacyPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (legacyPid && legacyPid > 1 && legacyPid !== process.pid) {
    let alive = true
    try { process.kill(legacyPid, 0) } catch (error) {
      // EPERM: another user's process, which a daemon of this user never is.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH' || code === 'EPERM') alive = false
      else throw error
    }
    // A live pid is a legacy daemon only when a daemon answers on its port: after a
    // restart (a container's above all) a dead daemon's pid file may name another
    // process, and yielding to it left the dir with no daemon.
    let legacyPort = ''
    try { legacyPort = fs.readFileSync(PORT_FILE, 'utf8').trim() } catch { /* no port file: no daemon to yield to */ }
    if (alive && !(await loopbackDaemonAnswers(Number(legacyPort), 1500))) {
      logMsg('warn', 'daemon.pid names a live process that is no daemon here (no daemon answers on its port): starting', { pid: legacyPid, port: legacyPort || null })
      alive = false
    }
    if (alive) {
      if (SERVICE_MODE) throw new Error('A legacy daemon is running; service handover is required')
      return { kind: 'existing', port: legacyPort }
    }
  }
  if (SERVICE_MODE) {
    await consumeDaemonServiceHandover({ stateDir: DAEMON_STATE_DIR!, uid: os.userInfo().uid, platform: process.platform as 'linux' | 'darwin', childProcess: childUse })
  }
  loadDaemonHooksAtBoot()
  // Armed triggers survive a daemon restart on their own: the next
  // triggers.configure replaces the set, but until it arrives the checks keep
  // polling (the server may be the thing that is down).
  loadTriggersAtBoot()
  ensureOwnerOnlyStorage()

  // Move dead-session stream files from the legacy /tmp location into the
  // reboot-surviving HOME dir. MUST run before reconcileRegistry: adopted
  // sessions resolve their files by the registry's absolute paths, and the
  // pgid scan below walks STREAMS_DIR.
  try { migrateLegacyStreams() } catch (err) {
    logMsg('error', 'legacy streams migration failed', { error: (err as Error).message })
  }

  // Phase C: startup reconcile — adopts live orphans (1s poll) and reaps
  // any entries whose pids are gone or recycled. Runs BEFORE the legacy
  // cleanup sweep so the registry's "known good" pids aren't misclassified
  // as orphan process groups to kill.
  try { cronMetadataConfig = await readCronCliConfig(HOME_DIR, daemonEnv, AbortSignal.timeout(5000)) } catch {}
  logMsg('info', 'startup: reconcile begin', { registryFile: REGISTRY_FILE, streamsDir: STREAMS_DIR })
  await budgetStopsReady.catch(() => {})
  // The registry's temp files a dead daemon left mid-write (sessions.json.<pid>.tmp and
  // .<pid>.sync.tmp, one per crash): older than an hour, so never a live writer's. Not awaited.
  void fsWrite.sweepStaleWriteTemps(path.dirname(REGISTRY_FILE), path.basename(REGISTRY_FILE) + '.')
  try { await reconcileRegistry() } catch (err) {
    logMsg('error', 'reconcileRegistry failed', { error: (err as Error).message })
    if (SERVICE_MODE) throw err
  }
  logMsg('info', 'startup: reconcile done', {
    adoptedFromRegistry: sessions.size,
    sids: [...sessions.keys()],
  })

  // ACP startup repair: workers from a previous daemon life are dead by
  // definition (in-process model). Sweep stragglers + close un-ended turns /
  // un-answered permissions in every ACP journal so the UI never shows a
  // stuck spinner. See acp-daemon.ts startupRepair.
  try { acp.startupRepair() } catch (err) {
    logMsg('error', 'acp startupRepair failed', { error: (err as Error).message })
  }

  // Clean up orphaned process groups from a previous daemon crash. reconcile()
  // already handled everything in sessions.json; this picks up .pgid files
  // that were never registered (e.g. half-spawned sessions from E13 window).
  cleanupOrphanedProcessGroups()
  for (const [sid] of sessions) ensureWatcher(sid)
  void recordAdoptedOwners()
  try { backfillSpawnJournal() } catch (err) {
    logMsg('warn', 'spawn journal backfill failed', { error: (err as Error).message })
  }
  followerEntry.recoverPendingAsks()
  logMsg('info', 'startup: complete — sessions ready', {
    totalSessions: sessions.size,
    sids: [...sessions.keys()],
    // Process start to sessions ready: the new daemon's share of an upgrade swap.
    bootMs: Math.round(process.uptime() * 1000),
  })

  if (SERVICE_MODE) {
    cronRuntime = await createDaemonCronRuntime({
      stateDir: DAEMON_STATE_DIR!, home: HOME_DIR, platform: process.platform, env: daemonEnv,
      childProcess: childUse,
      gate: sessionStartGate,
      sessions: () => [...sessions].map(([sid, session]) => ({
        sid, pid: session.pid, startTime: session.startTime, bootId: session.bootId, cwd: session.cwd, args: session.args,
        mode: session.mode, cliVersion: session.cliVersion,
        cronCandidate: Object.keys(session.foldState.cronIds).length > 0,
      })),
      hooksHash: (sid) => persistedHooksHashFor(sid),
      start: async (sid, launch, isCurrent) => {
        const result = await startSessionProcess({ sid, args: launch.args, cwd: launch.cwd, mode: launch.mode, resume: true }, isCurrent)
        return { pid: result.pid, startTime: sessions.get(sid)?.startTime ?? null }
      },
      changed: (record) => {
        for (const ws of wsClients) if (followerHears(ws, record.sid)) sendEvent(ws, 'cron-supervision', {
          sid: record.sid, enabled: record.enabled, state: record.state,
          reason: record.reason, generation: record.generation, retryAt: record.retryAt,
        })
      },
      error: (error) => logMsg('error', 'cron supervision observation failed', { error: String(error) }),
    })
  }

  // Supervision must exist before recovery can disable it, including stopped sessions.
  void usageBudget.recover().catch(error => logMsg('error', 'budget recovery failed', { error: String(error) }))

  // The door (daemon-door.ts): a program's always; a runtime inside a server's process opens it when asked.
  const server = !DOOR ? null : openDaemonDoor<ServerWebSocket<WsData>>({
    open(ws) {
      heardFrom(ws)
      wsClients.add(ws)
      if (ws.data) ws.data.connectedAt = Date.now()
      // DUP-DEBUG: a stable wsId so later logs tell each socket's activity apart; paired with the
      // close log. A sid still subscribed by a wsId already closed means the GC of dead subscribers broke.
      logMsg('info', 'client connected', { wsId: wsId(ws), clients: wsClients.size })
    },
    message(ws, text) {
      heardFrom(ws)
      handleCommand(ws, text)
    },
    heard: (ws) => heardFrom(ws),
    // Socket buffer drained: flush what Bun dropped (send() === 0) while saturated (safeSend/enqueueForDrain).
    drain: (ws) => flushSendQueue(ws),
    close: (ws) => handleDisconnect(ws),
  }, () => ({} as WsData))

  // Keepalive for trusted clients: every trusted
  // client is pinged once a beat and one nothing was heard from (no frame, ping
  // or pong) for CLIENT_KEEPALIVE_MISSED beats in a row is closed. An SSH
  // forward that died on the far side while sshd keeps this end open ACKs every
  // byte and never resets, so nothing else ever closes it; Bun's idleTimeout
  // cannot either, since every send, these pings included, restarts it. Bound:
  // closed on the 8th silent beat, 120 to 135 s after its last frame at the
  // 15 s beat, long enough that a Mac asleep a minute or two keeps its links
  // (matrix M3, 90 s). Beats are counted, not wall time, so a daemon that was
  // itself suspended does not drop its clients on wake. The bridge adapter is
  // not a trusted client: it has its own watchdog.
  const CLIENT_KEEPALIVE_MISSED = 8
  const clientKeepalive = new WeakMap<ServerWebSocket<WsData>, { heardAt: number | undefined; missed: number }>()
  const clientKeepaliveExpired = (ws: ServerWebSocket<WsData>): boolean => {
    const heardAt = ws.data?.lastHeardAt
    const prev = clientKeepalive.get(ws)
    const missed = prev && prev.heardAt === heardAt ? prev.missed + 1 : 0
    if (ws.data) ws.data.missedBeats = missed
    if (missed < CLIENT_KEEPALIVE_MISSED) {
      clientKeepalive.set(ws, { heardAt, missed })
      return false
    }
    logMsg('warn', 'client silent, closing it', { wsId: wsId(ws), silentMs: heardAt != null ? Date.now() - heardAt : null, missed })
    clientKeepalive.delete(ws)
    try { ws.terminate() } catch { try { ws.close() } catch {} }
    return true
  }
  setInterval(() => {
    for (const ws of wsClients) {
      if (ws.data?.origin === 'bridge') continue
      if (clientKeepaliveExpired(ws)) continue
      try { ws.ping() } catch {}
    }
  }, TRUSTED_CLIENT_BEAT_MS).unref?.()

  listeningServer = server
  const port = server?.port ?? 0
  listeningPort = server && typeof port === 'number' ? port : null
  daemonInstanceLock?.publish(listeningPort)
  // daemon.pid and daemon.port (daemon-door.ts). A runtime inside a server on the leader's own machine
  // writes no daemon.pid: its pid is that server's, never a daemon's to signal, and every stopper and
  // liveness check that reads daemon.pid then finds nothing to signal; the dir's instance lock still
  // keeps any second daemon out.
  // daemon.stamp (the pid's start time) goes with daemon.pid: a leader trusts the pid by it, whatever its command line.
  publishDoorFiles(fs, { pidFile: PID_FILE, portFile: PORT_FILE, stampFile: STAMP_FILE }, { pid: WRITES_PID_FILE ? process.pid : null, port: DOOR ? Number(port) : null }, { procStart: (pid) => readProcStartTime(fs, pid), execFile: execFile as never, env: daemonEnv })
  // The host network runs once this daemon answers on its port (net-v1): with no door walnut-net could not reach it.
  if (DOOR) netSupervisor.start()
  // Hub forwards listen once the links they ride can come (hub-forward-v1).
  hubForwards.start()
  // daemon.pid names us now: the journal writes are ours (journal v2 migration), then the minute sweep.
  hostJournal.migrate()
  // Agent gateway: second (unix-socket) listener + on-PATH `walnut` shim. Both
  // additive: failures log a warning and never abort daemon startup. Started after the
  // migration: no session's write is journaled ahead of the
  // older v1 records the migration adds.
  startGatewayListener()
  writeWalnutShim()
  // The socket listens and bin/walnut is there: calls that waited out the restart go now.
  try { fs.unlinkSync(RESTART_MARK_FILE) } catch {}
  fs.writeFileSync(VERSION_FILE, DAEMON_VERSION)
  servedWalnuts.write()
  // Instance ID file — lets clients detect PID recycling / daemon swap by
  // comparing the on-disk value against what `hello` returns. Stable for the
  // lifetime of this daemon; removed on graceful cleanup().
  fs.writeFileSync(INSTANCE_ID_FILE, DAEMON_INSTANCE_ID)
  if (SERVICE_MODE) fs.writeFileSync(SERVICE_FILE, DAEMON_INSTANCE_ID)
  else { try { fs.unlinkSync(SERVICE_FILE) } catch {} }
  // Sessions adopted and the port listening: the launcher may commit this version.
  // Ready only once the core flow answers over its own port: hello as itself, status of a session it adopted.
  if (launcherBeat && listeningPort) {
    const ask = askOwnPort(listeningPort, WebSocket as unknown as Parameters<typeof askOwnPort>[1])
    void adoptionSettled.then(() => launcherBeat?.ready({ exe: process.execPath, instance: DAEMON_INSTANCE_ID },
      () => daemonServesCheck(ask, { instanceId: DAEMON_INSTANCE_ID, version: DAEMON_VERSION, sid: sessions.keys().next().value }))).then(() => launcherBeat?.idle())
  }
  // The servers an earlier daemon kept running here: adopt or start them, now
  // that the port file they connect through is written.
  // A host server connects through the port file; a runtime with no door starts none.
  if (DOOR) { try { hostServers.boot() } catch (err) { logMsg('warn', 'host server: boot failed', { error: (err as Error).message }) } }
  // Their specs read: the record drops the key an older build filed their data dirs under.
  // No socket is served between the write above and this one (one synchronous block): no hello
  // or push sees the record before the specs are read, and a leader that reads the file meanwhile
  // still sees only itself (daemon-shared.ts thisWalnutSharedVerdict).
  servedWalnuts.write()
  // The plugin jobs an earlier daemon ran here (plugin-jobs-core.ts): adopt, schedule or start them.
  try { pluginJobs.boot() } catch (err) { logMsg('warn', 'plugin jobs: boot failed', { error: (err as Error).message }) }
  hostVitals.start()
  if (LISTEN) options.onListening?.(port) // the process entry prints it for its parent
  logMsg('info', 'daemon started', {
    port,
    pid: process.pid,
    startedAt: DAEMON_START_TS,
    // Where the user part of PATH came from: login-shell (clean env), rc
    // (fallback, inherited env) or none.
    pathSource: bootPath.source,
    // Retry policy is read from the env ONCE at boot, so log it here: this line
    // is the only way to answer "is this daemon actually retrying, and with what
    // budget?" without shell access to its environ.
    turnRetry: TURN_RETRY_CFG.enabled
      ? { budgetMs: TURN_RETRY_CFG.budgetMs, maxAttempts: TURN_RETRY_CFG.maxAttempts,
          backoffBaseMs: TURN_RETRY_CFG.backoffBaseMs, backoffMaxMs: TURN_RETRY_CFG.backoffMaxMs }
      : false,
  })

  // Periodic fold checkpoints, so even a crash hands the successor a recent
  // fold (checkpointSessionFold).
  setInterval(() => {
    for (const session of sessions.values()) {
      if (session.state !== 'running') continue
      try { checkpointSessionFold(session, false) } catch {}
    }
  }, FOLD_CHECKPOINT_SWEEP_MS).unref?.()

  void cronRuntime?.tick().catch((error) => logMsg('error', 'cron supervision startup failed', { error: String(error) }))

  // Start session idle scanner (every 60s)
  setInterval(scanIdleSessions, SESSION_IDLE_SCAN_MS)

  // A cron job's next run passing is not a CLI line; republish on the clock.
  setInterval(() => cronMetadata.refresh(), SESSION_SCAN_INTERVAL_MS)

  // walnut-trigger clock. Tracked (unlike the timers above) because cleanup()
  // must stop it: a tick that starts a check while the daemon is exiting would
  // outlive the process as an orphaned process group.
  triggerRuns.startTriggers()

  // Dead-stream retention: hourly sweep of >7d-idle files for sids with no
  // live session/process. First pass shortly after startup (not immediately —
  // let reconcile finish adopting before judging liveness by the map).
  setTimeout(sweepDeadStreams, 60_000)
  setInterval(sweepDeadStreams, STREAM_RETENTION_SWEEP_MS)
  // Stream compaction (its first pass also removes what a dead daemon left).
  setTimeout(() => { void compactIdleStreams() }, Math.min(STREAM_COMPACT_SWEEP_MS, 120_000))
  setInterval(() => { void compactIdleStreams() }, STREAM_COMPACT_SWEEP_MS)
  setInterval(() => releaseIdleChangesState(), Math.min(10 * 60_000, Math.max(500, CHANGES_RELEASE_AFTER_MS / 2)))
  // The temp cleanup removes this daemon's own files from its dir while it runs
  // (keepRuntimeFiles, daemon-core.ts).
  runtimeKeepTimer = setInterval(() => {
    const files = [
      ...(DOOR ? [{ file: PORT_FILE, text: String(port) }] : []),
      ...(WRITES_PID_FILE ? [{ file: PID_FILE, text: String(process.pid) }] : []),
      { file: VERSION_FILE, text: DAEMON_VERSION }, { file: INSTANCE_ID_FILE, text: DAEMON_INSTANCE_ID },
      ...(SERVICE_MODE ? [{ file: SERVICE_FILE, text: DAEMON_INSTANCE_ID }] : []),
    ]
    const restored = keepRuntimeFiles({ fs, pid: process.pid, pidFile: PID_FILE, files, touch: [path.join(DAEMON_DIR, 'daemon.owner'), STAMP_FILE, SERVES_FILE, BRIDGE_FILE, ...[...bridgeLinks.keys()].filter(Boolean).map(bridgeFileFor)], touchDirs: [{ dir: GATEWAY_SHIM_DIR, match: /^walnut/ }, { dir: DAEMON_DIR, match: /\.(cjs|mjs|js)$|^daemon-(darwin|linux)-[a-z0-9-]+$|^dtach-/ }], registryFile: REGISTRY_FILE, persistRegistry: () => persistRegistry(), now: new Date() })
    if (restored.length > 0) logMsg('warn', 'runtime files written back', { restored })
  }, Number(daemonEnv.WALNUT_RUNTIME_KEEP_MS) > 0 ? Number(daemonEnv.WALNUT_RUNTIME_KEEP_MS) : RUNTIME_KEEP_MS)
  runtimeKeepTimer.unref?.()

  // Cloud bridge self-heal: a persisted bridge.json re-dials without waiting
  // for the Mac to push bridge.configure again.
  loadBridgeConfig()
  startBridges('startup')

  // Heartbeat: one JSON line every 30s with daemon vitals. Absence = wedged
  // daemon (event loop blocked, OOM, etc). Cheap to emit, huge diagnostic
  // value: `tail -F daemon-*.log | grep heartbeat` tells you a daemon is
  // alive even when it has no sessions.
  setInterval(() => {
    const mem = process.memoryUsage()
    logMsg('info', 'heartbeat', {
      sessions: sessions.size,
      wsClients: wsClients.size,
      agentSubs: agentSubs.size,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    })
    // Single-instance self-check: if daemon.pid no longer names US, a newer
    // daemon has taken over this dir and we are a zombie — two daemons sharing
    // one registry/streams dir corrupt each other (the loser keeps running
    // idle-kill timers against sessions it no longer owns; observed as a
    // 9-day-old parallel daemon). The PID file is authoritative: exit
    // gracefully and leave CLI processes alive for the winner to adopt.
    // Missing/unreadable file is NOT a takeover (could be transient fs error
    // or manual cleanup) — only a DIFFERENT live pid means we lost the dir.
    try {
      const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (ownerPid > 0 && ownerPid !== process.pid) {
        logMsg('warn', 'self-check: daemon.pid taken over by another instance — exiting', {
          ourPid: process.pid, ownerPid,
        })
        cleanup()
        endSelf(0)
      }
    } catch {}
    // Parent-liveness watchdog: isolated-dir daemons (tests, sandbox, demos)
    // are spawned with WALNUT_DAEMON_PARENT_PID and serve exactly one walnut
    // process — when it's gone we're an orphan burning RAM. 300+ leaked test
    // daemons once starved the whole machine (2026-07-23). Production daemons
    // never get the var (parentWatchdogEnv in local-daemon.ts), so surviving
    // server restarts is unaffected.
    if (WATCHDOG_PARENT_PID && !SERVICE_MODE) {
      let parentAlive = true
      try { process.kill(WATCHDOG_PARENT_PID, 0) } catch { parentAlive = false }
      if (!parentAlive) {
        logMsg('warn', 'parent-liveness watchdog: parent process gone — exiting', {
          parentPid: WATCHDOG_PARENT_PID,
        })
        cleanup()
        endSelf(0)
      }
    }
    // A test server's isolated daemon on a remote host: its server is on another
    // machine, so no pid to watch; no server socket for the lease's length ends it,
    // and its root goes with it (the server's remote-isolation.ts).
    if (ISOLATED_ORPHAN_EXIT_MS && !SERVICE_MODE) {
      const now = Date.now()
      for (const client of wsClients) if (client.readyState === 1 && isServerClient(client)) isolatedServerSeenAt = now
      if (now - isolatedServerSeenAt > ISOLATED_ORPHAN_EXIT_MS) {
        const root = isolatedOwnRoot()
        logMsg('warn', 'isolated daemon: no test server for the lease, exiting', { isolatedFor: ISOLATED_FOR, leaseMs: ISOLATED_ORPHAN_EXIT_MS, root })
        cleanup()
        if (root) {
          try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* /tmp is swept anyway */ }
          try { fs.rmSync(DAEMON_DIR + '-images', { recursive: true, force: true }) } catch { /* same */ }
        }
        endSelf(0)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  // What ends this daemon once it ran: the heartbeat's own exits (endSelf) and stop.
  // Its socket closes and its timers end with it; the process entry then exits.
  function endSelf(code: number): void {
    try { server?.stop(true) } catch {}
    const released = daemonInstanceLock?.release().catch(() => {})
    clearRuntimeTimers()
    if (LISTEN) { exitRuntime(code); return }
    // Inside a server's process its clients close only once the lock is free (review R2-N4): a
    // client that dials again at once starts the next runtime, which must find the dir unheld.
    // Bounded: a release that never settles does not keep the clients open.
    let bound: ReturnType<typeof setTimeout> | undefined
    void Promise.race([released, new Promise<void>((resolve) => { bound = setTimeout(resolve, END_SELF_LOCK_RELEASE_MS) })])
      .finally(() => { clearTimeout(bound); exitRuntime(code) })
  }
  let shutdown: Promise<number> | null = null
  const stopDaemon = (): Promise<number> => {
    shutdown ??= (async () => {
      // The longest it waits for work in flight below the 60 s a
      // service stop waits. WALNUT_DAEMON_SHUTDOWN_DRAIN_MS is for TESTS ONLY.
      const SHUTDOWN_DRAIN_MAX_MS = Number(daemonEnv.WALNUT_DAEMON_SHUTDOWN_DRAIN_MS) > 0 ? Number(daemonEnv.WALNUT_DAEMON_SHUTDOWN_DRAIN_MS) : 45_000
      // A Claude Code install may run 45 minutes (a slow line): stop it now, or close()
      // waits for it. Its download stays and the next Install resumes it.
      try { hostFix.cancel() } catch (error) { logMsg('warn', 'host fix cancel failed', { error: String(error) }) }
      // A resumable host_exec run only waits: its process group is its own, so it would outlive this
      // daemon with no deadline while its caller starts the next. End it, its log saying to run it
      // again. Every other run is left as before (it keeps running without this daemon).
      try { hostExec.endForUpdate(RESUMABLE_RUN_ENDED, 'resumable') } catch (error) { logMsg('warn', 'ending resumable host_exec runs failed', { error: String(error) }) }
      // Before any call is turned away: the mark is what tells it to wait for the successor.
      noteRestarting()
      releaseGatewayWaiters()
      // Bounded: a session command that never settles cannot keep the daemon half shut (its
      // intake closed, never exiting) for good; the CLI sessions are not this process's to wait for.
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      const drainCap = new Promise<'cap'>((resolve) => { drainTimer = setTimeout(() => resolve('cap'), SHUTDOWN_DRAIN_MAX_MS) })
      // The resumable runs it ended answer the reads waiting on them before the sockets close.
      const settled = await Promise.race([Promise.allSettled([daemonCommands.close(), cronRuntime?.close(), netSupervisor.stop(), hostExec.untilEnded(3_000)]), drainCap])
      clearTimeout(drainTimer)
      if (settled === 'cap') logMsg('warn', 'daemon shutdown: work still running after the drain limit; exiting without it', { limitMs: SHUTDOWN_DRAIN_MAX_MS })
      const drained = settled === 'cap' ? [] : settled
      const failed = drained.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') logMsg('error', 'daemon shutdown drain failed', { error: String(failed.reason) })
      // Answers that came while it drained went out; the rest are told now.
      releaseGatewayRelays()
      // An isolated dir's CLIs end with it: waited for here without blocking (reapAllSessionGroups),
      // only while daemon.pid is ours or gone (ownsDaemonDir, cleanup()'s own rule: a successor's sessions are never touched).
      if (shouldReapOnExit() && ownsDaemonDir()) {
        await core.holdRegistryForExit()
        await reapAllSessionGroups()
      }
      // Past the drain cap the file pool may be wedged: written here. A write that fails is
      // logged and the exit cleanup tries once more; the stop always goes on. Only while daemon.pid
      // is ours or gone (cleanup()'s ownsFiles rule): a zombie's stop never writes its inventory
      // over its successor's registry.
      let registrySaved = true
      if (ownsDaemonDir()) {
        try {
          if (settled === 'cap') persistRegistryNow()
          else await persistRegistryDurable()
        } catch (error) { registrySaved = false; logMsg('error', 'daemon shutdown: registry write failed', { error: String(error) }) }
      }
      cleanup({ registrySaved })
      server?.stop(true)
      await daemonInstanceLock?.release()
      // Work still stuck in a file call (a FIFO no one reads) holds a pool thread, and a normal
      // exit joins those threads: it would never return Its state is saved; end hard.
      // Under the launcher, the update exit is no crash, the hard end at the drain cap included (service-launcher-beat.ts).
      if (serviceUpdateRequested) launcherBeat?.leaving('prepared for a service update')
      // A process ends hard here (options.hardExit: SIGKILL); a runtime inside another one just returns.
      if (settled === 'cap') options.hardExit?.()
      //itself hard here (exitDaemon) when a host_exec file look is
      // stuck in node's thread pool, whose exit waits for it; bun's exit does not, so this one exits as is.
      return failed || serviceUpdateRequested ? 1 : 0
    })().catch((error) => { logMsg('error', 'daemon shutdown failed', { error: String(error) }); return 1 })
    return shutdown
  }
  stopStarted = stopDaemon
  // A signal, a trial's end, a service update or handover: stop, then the process exits.
  // Asked twice (a second signal), it still exits once.
  let exitAsked = false
  requestDaemonShutdown = () => { if (exitAsked) return; exitAsked = true; void stopDaemon().then((code) => exitRuntime(code)) }
  return { kind: 'started', port }
}

/** The clients inside this process (connect(), daemon-in-process-client.ts): stop() closes them. */
const inProcessClients = new Set<{ close(): void }>()
function inProcessClient(onFrame: (frame: DaemonFrame) => void, onClose?: () => void): DaemonClient {
  return openInProcessClient(onFrame, onClose).client
}
function openInProcessClient(onFrame: (frame: DaemonFrame) => void, onClose?: () => void) {
  const made = createInProcessClient<ServerWebSocket<WsData>>({
    handleCommandFrame: (socket, frame) => handleCommandFrame(socket, frame),
    // A command the runtime answers by function is called, not sent (callCommand).
    direct: { has: (cmd) => answerFnOf(cmd) !== null, call: (socket, frame) => callCommand(socket, frame) },
    register: (socket) => { wsClients.add(socket); inProcessClients.add(socket) },
    unregister: (socket) => { inProcessClients.delete(socket); handleDisconnect(socket) },
    heardFrom: (socket) => heardFrom(socket),
    warn: (msg, data) => logMsg('warn', msg, data),
    checkFrames: daemonEnv.WALNUT_IN_PROCESS_FRAME_CHECK === '1',
  }, onFrame, onClose)
  return { client: made.client, ws: made.ws as unknown as ServerWebSocket<WsData> }
}

/**
 * The follower server of a host's one Walnut service, which holds this runtime in its own process
 * (follower-link.ts createDirectFollowerLink). `attach` is cmdFollowerHello without the frame and
 * the token (the process IS the server the daemon would have started): the client's socket becomes
 * the follower socket of `home`, so streams, `gateway-request` and `trigger-delivery` events and
 * the owner scope of its reads are the ones a follower socket has. The calls are the entry's
 * functions in the lane and under the drain admission that handleCommand gives the same command.
 */
const followerSeat: FollowerSeat = (() => {
  // The home a call names is the Walnut's first home here, as adoptCommandHome makes it for a
  // follower socket's command (review A3b S56-L5: a server that moved called with its new home).
  type HomeCall<A extends unknown[], R> = (home: string, ...args: A) => R
  const admitted = <A extends unknown[], R>(call: HomeCall<A, R>): HomeCall<A, R> => (home, ...args) => daemonCommands.admit(() => call(walnutScope.canonical(home), ...args))
  const inLane = <A extends unknown[], R>(call: HomeCall<A, R>): HomeCall<A, R> => (home, ...args) => daemonCommands.admit(() => daemonCommands.run(() => call(walnutScope.canonical(home), ...args)))
  const entry = followerEntry
  /** Each attached client's socket, for seatedAs. */
  const seats = new WeakMap<DaemonClient, ServerWebSocket<WsData>>()
  return {
    view: admitted(entry.view),
    sessions: admitted(entry.sessions),
    slice: admitted(entry.slice),
    triggers: admitted(entry.triggers),
    triggerTest: admitted(entry.triggerTest),
    pending: admitted(entry.pending),
    send: inLane(entry.send),
    permission: inLane(entry.permission),
    peer: inLane(entry.peer),
    op: inLane(entry.op),
    start: inLane(entry.start),
    attach(named, hello, onFrame, onClose) {
      const home = walnutScope.canonical(named)
      const { client, ws } = openInProcessClient(onFrame, onClose)
      seats.set(client, ws)
      seatSockets.add(ws)
      if (ws.data) {
        ws.data.origin = 'follower'; ws.data.followerHome = home; ws.data.answersLocal = hello.answersLocal === true
        ws.data.deliversTriggers = hello.deliversTriggers === true; ws.data.answersOnline = hello.answersOnline === true
        ws.data.callSocket = hello.answersLocal === true ? hostCallTokens.socketOf(hello.callSocket) : undefined
      }
      followerSockets.set(home, ws)
      followerSaidOnline.set(home, hello.answersOnline === true)
      followerWaitMissed.delete(home)
      logMsg('info', 'follower: the server in this process follows its leader', { wsId: wsId(ws), home, answersLocal: hello.answersLocal === true, deliversTriggers: hello.deliversTriggers === true })
      // Calls that wait for it go once this attach returns (the seat's client is not handed back yet).
      setTimeout(wakeWaitingCalls, 0)
      return client
    },
    seatedAs(client) {
      const ws = seats.get(client)
      // A declared move moves the socket's home (foldAliasedHome): the home it holds the seat of now.
      const home = ws?.data?.followerHome
      return ws && home && followerSockets.get(home) === ws ? home : null
    },
  }
})()

/** What start() made: stopped the way a SIGTERM always stopped it; before that, what creating it started. */
async function stopRuntime(): Promise<number> {
  if (starting) await starting.catch(() => {})
  let code = 0
  if (stopStarted) {
    code = await stopStarted()
  } else {
    // Never started, or start() threw part way: give back what it got that far (the lock first
    // seen by the next runtime of this dir, the port, the socket), as a crash's exit would.
    try { listeningServer?.stop(true) } catch {}
    try { netSupervisor.stop().catch(() => {}) } catch {}
    try { await daemonInstanceLock?.release() } catch {}
    try { oneShot.disposeAll() } catch {}
    try { hostMcp.closeAll() } catch {}
    try { usageBudget.close() } catch {}
    try { budgetControl.close() } catch {}
  }
  listeningServer = null
  daemonInstanceLock = null
  releaseWhatAnExitWould()
  return code
}

/**
 * The runtime ended itself (its heartbeat saw another daemon take the dir, a stop it was asked
 * for). A program then exits; inside a server's process the exit is a callback, so what the exit
 * would have given back is given back here too: the in-process clients are closed (their server
 * sees the close and dials again), the gateway listener, the threads and the clocks end.
 */
function exitRuntime(code: number): void {
  options.exit(code)
  if (!LISTEN) releaseWhatAnExitWould()
}

/** What a process gives back only by exiting: its listeners, its in-process clients, its threads, its own clocks. */
function releaseWhatAnExitWould(): void {
  try { gatewayListener?.stop(true) } catch {}
  gatewayListener = null
  for (const client of [...inProcessClients]) client.close()
  try { hubForwards.stop() } catch {}
  try { hostVitals.stop() } catch {}
  try { launcherBeat?.stop() } catch {}
  launcherBeat = null
  try { historyReadyExecutor.close() } catch {}
  try { spawnPool?.close() } catch {}
  clearRuntimeTimers()
}

return {
  dir: DAEMON_DIR,
  version: DAEMON_VERSION,
  instanceId: DAEMON_INSTANCE_ID,
  start: () => {
    if (startRun) return startRun
    const run = startDaemon()
    starting = run
    startRun = run.finally(() => { if (starting === run) starting = null })
    return startRun
  },
  stop: stopRuntime,
  saveNow: () => {
    try { persistRegistryNow() } catch (error) { logMsg('error', 'saveNow: registry write failed', { error: String(error) }) }
    for (const session of sessions.values()) { try { checkpointSessionFold(session, true) } catch { /* the next boot folds from the last one */ } }
    logAppender?.flushSync()
  },
  requestStop: () => {
    if (!requestDaemonShutdown) return false
    requestDaemonShutdown()
    return true
  },
  connect: inProcessClient,
  follower: followerSeat,
  cli: { stop: cliStop, status: cliStatus, prewarmFolds: cliPrewarmFolds },
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => logMsg(level, msg, data),
}
}

// ── The daemon as a program of its own (`bun daemon-standalone.ts --start`, `walnut __daemon`) ──
// Everything that belongs to the whole process is done here, never in the runtime: the umask,
// the cwd, the signal and crash handlers, stdin, argv and exit.

// A working directory deleted under this daemon is never handed to what it
// starts: it moves to the home directory, at start and once a minute (2026-11-03:
// a server whose cwd was a deleted build clone could not start the voice model).
//healCwd in src/core/login-session.ts.
function healDaemonCwd(): void {
  try {
    const here = fs.statSync('.')
    const there = fs.statSync(process.cwd())
    if (here.ino === there.ino && here.dev === there.dev) return
  } catch { /* gone: move */ }
  for (const dir of [process.env.HOME, os.homedir(), os.tmpdir(), '/']) {
    if (!dir) continue
    try { process.chdir(dir); return } catch { /* next */ }
  }
}

/** Runs the daemon program for `argv` (`--start`, `--service`, `--stop`, `--status`, `--prewarm-folds`, `walnut ...`). */
export async function runDaemonProcess(argv: string[] = process.argv): Promise<void> {
  const action = argv[2]
  process.umask(0o077)

  // CLI argv is user text (op call payloads) — it must never trigger the version
  // fast-path (e.g. `walnut tools call session_send '…"--version"…'`). Both
  // dispatch keywords are excluded, the legacy `wn` included: field shims still
  // pass it, and a payload containing `--version` must not print the version.
  if (argv.includes('--version') && !isDaemonCliKeyword(action)) {
    console.log(DAEMON_VERSION)
    process.exit(0)
  }
  // `walnut __daemon --service-roles`: the roles this file can take as a host's one Walnut service
  // (service-roles.ts; the launcher's good version is asked this way). An older file prints its usage.
  if (action === SERVICE_ROLES_FLAG) {
    console.log(programServiceRoles(singleFile() !== null).join(' '))
    process.exit(0)
  }

  // This binary run again as wait_for's matcher (host-exec-matcher.ts): a job's output lines are
  // tested here, in a process the daemon can kill when a pattern runs too long on one line.
  if (action === '--wait-matcher') {
    await runWaitMatcher()
    process.exit(0)
  }

  const known = isDaemonCliKeyword(action) || ['--start', '--service', '--stop', '--status', '--prewarm-folds'].includes(action ?? '')
  if (!known) {
    console.error('Usage: bun daemon-standalone.ts --start | --service | --prewarm-folds | --stop | --status | --version | walnut <args...>')
    process.exit(1)
  }

  // CLI mode: the same binary doubles as the on-host walnut CLI (zero extra
  // deploy artifacts — the on-PATH `walnut` is a 2-line shim exec'ing this
  // binary). BOTH keywords dispatch here: `walnut` is canonical, `wn` is a
  // deprecated compat alias that MUST stay because shims written by daemons
  // already deployed in the field pass `wn`, and a shim is only rewritten when
  // its own daemon next boots (see DAEMON_CLI_KEYWORD_LEGACY in gateway-core.ts).
  // Before the runtime is created: a CLI is no daemon, and the runtime's setup writes its
  // log, machine id and adoption files in the default runtime dir, another Walnut's when a
  // service set's install runs `<daemon> walnut daemon install --walnut <id>` (2026-11-24 drill).
  // Dynamic import keeps the daemon startup path free of CLI code; bun bundles
  // the literal specifier into the compiled binary.
  if (isDaemonCliKeyword(action)) {
    healDaemonCwd()
    // The login-shell PATH the runtime used to set first, for the service commands (daemon-cli-path.ts).
    applyCliLoginPath(argv.slice(3), process.env, { execFile: rawExecFile, execFileSync: rawExecFileSync })
    const { runWalnutCli } = await import('./wn-cli.js')
    process.exit(await runWalnutCli(argv.slice(3)))
  }

  let runtime: DaemonRuntime | null = null
  // A trial run's hard lifetime (daemon-boot-proof.ts, daemon-trial-cmd.ts): it exits by itself
  // after its proof window, so a trial whose prover died (the CLI, the server, the SSH session)
  // never stays for good; a --service trial has no parent watchdog (2026-11-04 review). Unset:
  // no limit, as for every real daemon.
  const TRIAL_LIFETIME_MS = (() => {
    const seconds = parseInt(process.env.WALNUT_DAEMON_LIFETIME_SECONDS || '', 10)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  })()
  // Armed at load, not once startup is done: a trial that hangs on its way up ends too (2026-11-04
  // review). It is asked to stop the normal way; a stop that hangs, or a daemon not that far yet,
  // exits 15 s later at the latest.
  if (TRIAL_LIFETIME_MS && (action === '--start' || action === '--service')) {
    globalThis.setTimeout(() => {
      try { runtime?.log('warn', 'trial lifetime reached; exiting', { lifetimeMs: TRIAL_LIFETIME_MS }) } catch { /* no logger yet */ }
      globalThis.setTimeout(() => process.exit(1), 15_000).unref()
      if (!runtime?.requestStop()) process.exit(1)
    }, TRIAL_LIFETIME_MS).unref()
  }

  healDaemonCwd()
  globalThis.setInterval(healDaemonCwd, 60_000).unref?.()

  // Registered before the runtime exists, so even a startup-phase crash (reconcile,
  // migration) leaves a breadcrumb. exit(1), never limp on: after an arbitrary
  // throw the in-memory session state is unknowable, and a clean respawn
  // re-adopts every live CLI from the registry (Phase C reconcile).
  // The crash handlers go on once the runtime hands its reporter over (onCrashReporter below),
  // where the daemon always registered them: a crash before that prints its stack and exits 1.
  const onCrashReporter = (report: (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => void): void => {
    process.on('uncaughtException', (err) => { report('uncaughtException', err); process.exit(1) })
    process.on('unhandledRejection', (reason) => { report('unhandledRejection', reason); process.exit(1) })
  }

  runtime = await createDaemonRuntime({
    env: process.env,
    mode: action === '--service' ? 'service' : 'start',
    program: { script: argv[1] || '' },
    // This process's own umask is 077 already (above): every child inherits it.
    childUmask: null,
    chdir: (dir) => process.chdir(dir),
    exit: (code) => process.exit(code),
    hardExit: () => { process.kill(process.pid, 'SIGKILL') },
    onListening: (port) => console.log(port), // Print port for parent to capture
    onCrashReporter,
    onExitFlush: (flush) => { process.once('exit', flush) },
  })

  if (action === '--prewarm-folds') {
    // Background work for a running daemon's replacement: below the daemon it serves.
    try { os.setPriority(10) } catch {}
    process.exit(runtime.cli.prewarmFolds())
  }
  if (action === '--stop') process.exit(await runtime.cli.stop())
  if (action === '--status') process.exit(await runtime.cli.status())

  // --start / --service
  const started = await runtime.start()
  if (started.kind === 'existing') {
    console.log(started.port)
    process.exit(0)
  }
  // Handle signals
  const stop = () => { runtime!.requestStop() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  // Detach from terminal (close stdin so SSH doesn't hold)
  if (process.stdin.isTTY === false) {
    process.stdin.resume()
    process.stdin.on('end', () => {}) // Don't exit on stdin close
  }
}

// Run as a program (`bun daemon-standalone.ts --start`, the compiled daemon binary); imported, it
// only defines the runtime (the compiled walnut file calls runDaemonProcess for `__daemon`).
if (import.meta.main) await runDaemonProcess()
