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
import type { ChildProcess } from 'node:child_process'
import type { ServerWebSocket } from 'bun'
import {
  createDaemonCore,
  defaultReadStartTime,
  defaultReadStartTimes,
  readProcStartTime,
  createAsyncStartTimeReader,
  boundedExecFile,
  argvNamesSession,
  shouldAutoRespond,
  buildControlResponse,
  decideBridgeRestart,
  bridgeRedialStep,
  armsBridgeFastWindow,
  envTimerMs,
  BRIDGE_WATCHDOG,
  detectCronFires,
  hasDiskCronInterest,
  durableCronDenyMessage,
  durableCronCorrectionMessage,
  cronFireMarkerText,
  stripCronTaskById,
  parseTurnErrorLine,
  resolveTurnRetryConfig,
  decideTurnRetry,
  applyTurnRetry,
  clearTurnRetryStreak,
  newTurnRetryState,
  turnRetryMessage,
  turnRetryMarkerText,
  turnRetryGiveUpText,
  type TurnRetryState,
  type CoreSessionData,
  type RegistryEntry as CoreRegistryEntry,
  type SessionMode,
  type PendingCtrl,
  type UserMarkerInput,
  lockLiveFifo,
  LIVE_FIFO_MODE,
  keepRuntimeFiles,
  RUNTIME_KEEP_MS,
  MODE_CLI, observedPermissionMode,
  BUDGET_CHECKING_TEXT,
  type BudgetGate,
} from './daemon-core.js'
import { setRuntimeTreesDirOf } from './service-set.js'
import { applyCliLoginPath, installHomeBin, withInstallHomeBin } from './daemon-cli-path.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { buildClaudeArgv } from './claude-session-argv.js'
import { claudeRetryEnv } from './engine-turn-watch.js'
import { PS_TREE_ARGS, claimedSidVerdict, parentName, parseProcessTree, proofFor, shortProgram, type ProcRow } from './caller-proof-core.js'
import { socketPeerPid, socketPeerPidReady } from './socket-peer-pid.js'
import { findDeliveryMarkers, validMarkerIds } from './marker-find-core.js'
import { createHostRuntime, NODE_DISCOVERY_SHELL } from './host-runtime-core.js'
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
import { createHostResume } from './host-resume-core.js'
import { lineUuidOf } from './line-fate-core.js'
import { createCliOwner } from './cli-owner-core.js'
import { createCliArgvFiles } from './cli-argv-files-core.js'
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
import {
  foldLine,
  initialFoldState,
  assembleSnapshot,
  snapshotDiffers,
  type FoldState,
  type SessionSnapshot,
} from './daemon-fold.js'
import { createFoldCheckpoint } from './fold-checkpoint-core.js'
import { createStreamCompact } from './stream-compact-core.js'
import { createStreamFold, type StreamFoldResult } from './stream-fold-core.js'
import { createAcpDaemon, type AcpStartParams } from './acp-daemon.js'
import { ACP_HOST_FILES, ACP_HOST_WORKER } from './acp-host-artifacts.js'
import { singleFile } from '../lib/single-file.js'
import { knownAccount, primeAccount } from '../lib/account.js'
import { resolveAgentCommand } from './agent-command-map.js'
import { createDaemonGit } from './daemon-git.js'
import { createDaemonSkills } from './daemon-skills.js'
import { createDaemonFsRead } from './daemon-fs-read.js'
import { createDaemonFsWrite } from './daemon-fs-write.js'
import { createDaemonChanges } from './daemon-changes.js'
import { createDaemonTranscripts } from './daemon-transcripts.js'
import { createDaemonHooks } from './daemon-hooks.js'
import { createDaemonTriggerStore } from './daemon-trigger-store.js'
import { createDaemonTriggerRuns } from './daemon-trigger-runs.js'
import { createDaemonTriggerSet } from './daemon-trigger-set.js'
import { createDaemonTriggerCommands } from './daemon-trigger-commands.js'
import { createDaemonHostTransfer } from './daemon-host-transfer.js'
import { createDaemonHostServices } from './daemon-host-services.js'
import { createDaemonProcessGroups } from './daemon-process-groups.js'
import { Worker as ThreadWorker } from 'node:worker_threads'
import { createHistoryReady, createReadyWorkerExecutor, readyWorkerEntries, type ReadyWorkerLike } from './history-ready-core.js'
import { validateTriggerDef, checkGatewayCall, createCheckCallers, withoutTriggerCaller } from './trigger-check-core.js'
import { START_TASK_TOKEN } from './trigger-clock-core.js'
import { archiveTranscripts, bunTranspilerCacheDirs, ensureTaskDir, gitRunnerWith, liveTranscriptIdsFromPs, listTaskDirs, pruneHostCaches, pruneTaskBuilds, pruneTaskDirs, readOpenPaths, removeTaskDirs, restoreSessionAnywhere, restoreForStart, resumeSourceId, setArchiveLog, setRemoteFetcher, RemoteHistoryError, taskDirInUse, taskDirRoot, taskDirSizes, type HostWork } from './task-dir-core.js'
import { ensurePwSilencePreloadAsync, pwSilenceDir, pwSilenceSessionEnv } from './pw-silence-core.js'
import { createLogAppender, type LogAppender } from './log-appender-core.js'
import { armFilePoolDeadline } from './file-pool-deadline.js'
import { createHostExec, runWaitMatcher, shellQuote } from './host-exec-core.js'
import { buildSessionPreamble, createShellSetupStore, pickSessionShell, runsAsShell } from './session-shell.js'
import { createHostMcp } from './host-mcp-core.js'
import { createHostHttp } from './host-http-core.js'
import { createUsageBudgetRuntime, type BudgetPrices, type BudgetVerdict } from './usage-budget-runtime.js'
import { createBudgetControl } from './usage-budget-control.js'
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
  type GatewayErrorCode,
  type GatewayRequest,
  type GatewayResponse,
} from './gateway-core.js'
import type { DaemonRuntimeOptions, DaemonFrame, DaemonClient, DaemonRuntime, FollowerSeat } from './daemon-runtime-types.js'
import { createRuntimeTimers } from './daemon-runtime-timers.js'
import { createInProcessClient } from './daemon-in-process-client.js'
import { createSessionTailer, type SessionTailer } from './session-tailer.js'
import { prepareSpawnFiles } from './session-spawn-files.js'
import { agentReadSize, takeAgentLines, type AgentFileState } from './agent-file-chunk.js'
import { DAEMON_STAMP_NAME, openDaemonDoor, publishDoorFiles } from './daemon-door.js'
import { createSpawnPool } from './spawn-pool.js'
import { containListeners, createDaemonChildSpawn, type ChildProcessUse } from './daemon-child-spawn.js'
import { DaemonSessionGate, createDaemonCronRuntime, persistCronHooks, processStartedAtMs, readCronCliConfig, cliOneShotTime, nextCliCronMinute, CRON_PROMPT_LIMIT } from './daemon-cron-runtime.js'
import { createCronMetadataTracker, readCronMetadataStream } from './daemon-cron-metadata.js'
import { readCronBootId } from './daemon-cron-host.js'
import { askOwnPort, daemonServesCheck, startLauncherBeat, type LauncherBeat } from './service-launcher-beat.js'
import { createServiceRolesReader, programServiceRoles, SERVICE_ROLES_FLAG, withGoodRoles } from './service-roles.js'
import { spawnBehindRegistry } from './daemon-spawn-barrier.js'
import { acquireDaemonInstanceLock, readDaemonInstanceOwner, type DaemonInstanceLockOwner } from './daemon-instance-lock.js'
import { createDaemonCommandDrain } from './daemon-command-drain.js'
import { createDemoDaemonQuiesce } from './demo-daemon-quiesce-core.js'
import { prepareDaemonServiceHandover, consumeDaemonServiceHandover } from './daemon-service-handover.js'
import { RESTART_MARK_NAME, restartMarkText } from './daemon-restart-mark.js'
import { createBridgeUplink, createLoopDriftProbe } from './bridge-uplink-core.js'

// ── Version ──
// Baked in at compile time via `bun build --define` (see scripts/build-daemon.sh).
const DAEMON_VERSION = process.env.DAEMON_VERSION || 'dev'

// The runtime's options and its surface: daemon-runtime-types.ts (a server that creates one reads them there).
export type { DaemonRuntimeOptions, DaemonFrame, DaemonClient, DaemonRuntime } from './daemon-runtime-types.js'

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

// ── Spawn journal ───────────────────────────────────────────────────────────
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
//readSpawnJournal in
// external-session-scan-core.ts.
const SPAWN_JOURNAL = daemonEnv.WALNUT_SPAWN_JOURNAL
  || path.join(daemonEnv.HOME || HOME_DIR, '.open-walnut', 'local', 'spawn-journal.jsonl')
// Before the journal: one empty file per session id (2026-09-23 to 09-26).
const LEGACY_SPAWN_LEDGER_DIR = path.join(daemonEnv.HOME || HOME_DIR, '.open-walnut', 'tmp', 'spawned-sessions')
// The walnut file's runtime place a session keeps: a set's own (service-set.ts), never a deploy stage's.
const SESSION_RUNTIME_DIR = setRuntimeTreesDirOf(daemonEnv, fs.realpathSync)
const SPAWN_JOURNAL_LINE_MAX = 4096
interface SpawnInfo { kind: 'new' | 'fork' | 'resume'; parent?: string; cwd?: string; home?: string; task?: string; walnut?: string }
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
  if (!journaledIds().has(sid)) journaledSids = null
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
  const legacy = daemonEnv.WALNUT_SPAWN_JOURNAL || ISOLATED_FOR ? [] : list(LEGACY_SPAWN_LEDGER_DIR)
  for (const name of legacy) appendSpawnJournal(name, { kind: 'backfill', from: 'ledger' })
  for (const name of list(STREAMS_DIR)) {
    if (name.endsWith('.jsonl')) appendSpawnJournal(name.slice(0, -6), { kind: 'backfill', from: 'streams' })
  }
  const ids = journaledIds()
  if (legacy.length > 0 && legacy.every((name) => !isJournalSid(name) || ids.has(name))) {
    try { fs.rmSync(LEGACY_SPAWN_LEDGER_DIR, { recursive: true, force: true }) } catch { /* retried next start */ }
  }
}

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
// L2: per-session background-task state. `resourceVersion` = byte offset of the latest
// applied event (monotonic, rebuildable from the jsonl). Served on `getState`.
interface TaskStateEntry { status: string; v: number; t: number; description?: string; isBackgrounded?: boolean; toolUseId?: string }
interface TaskState {
  tasks: Record<string, TaskStateEntry>
  resourceVersion: number
  updatedAt: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string; v: number; t: number }>
}

// A session's subscribers, remembering when someone last watched it (watchedAt): when the set
// was made (a start or an adoption, before the leader attaches) and whenever its last subscriber
// left. The idle scan counts idleness from the later of the last output and watchedAt, so a
// leader that restarts or a link that drops for a moment stops no session (2026-11-23: a Mac
// deploy dropped the leader's link for 10 s and the next scan stopped 17 sessions idle 2 to 4
// hours that it was about to subscribe to again).
class Subscribers<T> extends Set<T> {
  watchedAt = Date.now()
  delete(ws: T): boolean { const had = super.delete(ws); if (had && this.size === 0) this.watchedAt = Date.now(); return had }
  clear(): void { if (this.size > 0) this.watchedAt = Date.now(); super.clear() }
}

interface SessionData {
  proc: ChildProcess | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  offset: number
  // L2: daemon-authoritative background-task state, materialized from task_* events in the
  // watcher loop and served on the `getState` RPC. Rebuilt from jsonl on adopt/discover.
  taskState: TaskState
  // Session-bound file tailer. Lifecycle = session process lifetime. NOT tied
  // to any WebSocket. Closed only by reapSession or daemon shutdown.
  watcher: { pollTimer: ReturnType<typeof setInterval>; offset: number; tailer?: SessionTailer } | null
  // Clients currently receiving push events. Add on cmdAttach/cmdStart,
  // remove on ws.close. Watcher is unaffected by subscriber churn — this
  // replaces the old per-ws watcher Map that tied file-tailing to WS
  // lifetime and caused "no watchers after reconnect" streaming loss.
  subscribers: Subscribers<ServerWebSocket<WsData>>
  exitCode: number | null
  // Phase B/C additions: daemon is the single source of truth for CLI/FIFO
  // lifecycle. `state` is the authoritative flag; `exitCode !== null` was
  // previously the only death signal but 3 different code paths toggled it,
  // which made idempotent cleanup hard. `parented=false` means the session
  // was adopted from the on-disk registry (e.g. across daemon restarts).
  state: 'running' | 'dead'
  exitReason: string | null
  exitedAt: number | null
  parented: boolean
  cliVersion?: string
  bootId?: string
  cronMetadataLoaded?: boolean
  cronMetadataLoading?: boolean
  cronMetadataOrigin?: import('./daemon-cron-metadata.js').CronMetadataOrigin
  startTime: string | null  // /proc/<pid>/stat start_time snapshot (Linux)
  cwd: string
  args: string[]
  orphanPollTimer: ReturnType<typeof setInterval> | null
  mode: SessionMode
  pendingCtrl: PendingCtrl | null
  // Epoch ms at which somebody DELIBERATELY asked this session to stop — our
  // own idle scanner, or any `stop` RPC (cmdStop). Stamped before the first
  // signal is sent (the death lands asynchronously, usually via orphan-poll
  // ESRCH, by which point the reason is gone) so reapSession can report a clean
  // exit code for a deliberate stop instead of a red error.
  // See daemon-core.ts CoreSessionData.intentionalStopAt.
  intentionalStopAt?: number | null
  // C1: incremental fold of the stream file → authoritative SessionSnapshot
  // (docs/plan/session-snapshot-source-of-truth.md §4). Maintains its own v
  // and bg map — coexists with taskState L2 (retirement is C4's call).
  foldState: FoldState
  // Last snapshot pushed to subscribers — change detection ignores bare v advance.
  lastPushedSnapshot?: SessionSnapshot | null
  // 50ms coalesce timer for snapshot pushes (death pushes skip it).
  snapshotTimer?: ReturnType<typeof setTimeout> | null
  spawnTs?: number   // latency instrumentation: CLI spawn ts
  sawInit?: boolean  // latency instrumentation: first init line seen
  spawnInfo?: SpawnInfo  // what the spawn journal records once init names the id
  // Scheduled-task (CLI cron) fire detection — see daemon-core detectCronFires.
  // Dedup map `${taskId}:${lastFiredAt}` → detectedAtMs; in-memory only.
  cronWarned?: Record<string, number>
  lastCronCheckTs?: number
  // Disk-side cron interest cache for the idle scan (60s scans × N sessions
  // would otherwise re-read scheduled_tasks.json every minute forever).
  diskCronCache?: { at: number; armed: boolean; reason: 'creator' | 'lock_holder' | null }
  // durable:true CronCreate corrections already injected, keyed by tool_use id.
  durableCronNudged?: Record<string, number>
  // Tailer self-heal: last forced watcher rebuild ts. Session-level (not watcher
  // closure) so the rebuilt watcher inherits the cooldown — a persistent error
  // (EMFILE) can't thrash rebuild every few seconds.
  lastWatcherHealAt?: number
  // Identity of the stream FILE (dev:ino:birthtimeMs, computed at spawn/adopt).
  // Rides every snapshot so walnut can tell "same file, higher v" from "the
  // file was recreated and v restarted at 0" (incident 019a7fe5). null when
  // stat failed; recomputed lazily by streamEpochOf.
  streamEpoch?: string | null
  // foldState.v of the last fold checkpoint written for this session.
  foldCheckpointV?: number
  /** The epoch of the file a stream compaction replaced with this one (stream-compact-core.ts). */
  rewrittenFrom?: string | null
  // Turn-error auto-retry (see daemon-core decideTurnRetry). Streak bookkeeping
  // persists in the registry so a daemon restart can't reset a 12h budget to 0.
  turnRetry?: TurnRetryState
  // Pending retry timer — cleared by any real send (the human took over) and by
  // reapSession, so a resume can never fire behind a user's back or after death.
  turnRetryTimer?: ReturnType<typeof setTimeout> | null
}

interface AgentSub {
  files: Map<string, AgentFileState>
  timer: ReturnType<typeof setInterval> | null
  rediscoverTimer: ReturnType<typeof setInterval> | null
  ws: ServerWebSocket<WsData>
  sid: string
  agent: string
  team?: string
}

interface WsData {
  /** A client in this process (connect()): frames go to it as objects, never as JSON text. */
  deliverFrame?: (frame: Record<string, unknown>) => void
  /** Per-socket FIFO of payloads Bun refused to send (backpressure). Flushed on drain. */
  sendQueue?: string[]
  /** Total bytes currently held in sendQueue (for the overflow guard). */
  sendQueueBytes?: number
  /**
   * 'bridge' = the cloud dial-out socket. The cloud box is a semi-trusted
   * PUBLIC relay, so its inbound frames are restricted to the phone-proxy
   * command set (BRIDGE_ALLOWED_COMMANDS) — the full privileged RPC surface
   * (fs.write/start/bridge.configure/…) is reachable ONLY over the trusted
   * SSH-tunneled client path. Absent = trusted local/SSH client.
   *
   * 'follower' = a Walnut server on THIS host that follows the leader (the host
   * server, docs/plan/walnut-servers-everywhere.md), after `follower.hello`. It
   * reads (FOLLOWER_ALLOWED_COMMANDS) and is never taken for the leader: its
   * frames are not the primary heard, and no relay, gateway call, trigger or
   * cron note is ever sent to it.
   *
   * 'lane' = a second link of the leader's, for byte streams only, after
   * `stream.lane` ('stream-lane-v1'): it rides its own SSH connection, so a
   * stream's bytes never share the one the leader's sessions use, and the
   * session link outlives a connection a large stream broke. Streams only
   * (LANE_ALLOWED_COMMANDS); like a follower, never taken for the leader.
   *
   * 'probe' = a test server (an ephemeral one attached read only to a host it
   * shares with the real Walnut) after `client.role` ('client-role-v1'). It keeps
   * every command it had, but it is not a Walnut server of this host: it is never
   * taken for the leader, and no relay, gateway call, trigger event, phone request
   * or cron note is sent to it. Before this, whichever server's socket came first
   * got an env-less `walnut` call, and a test server answered the real one's
   * (2026-11-02: trigger_list said every trigger was off).
   */
  origin?: 'bridge' | 'follower' | 'lane' | 'probe'
  /** A follower's Walnut (the leader's data dir), set by follower.hello. */
  followerHome?: string
  /** That follower answers this host's `walnut` calls while its leader is away ('follower-gateway-v1'). */
  answersLocal?: boolean
  /** That follower also takes a same-host message while its leader answers (replica/away-sends.ts; 'follower-peer-v1'). */
  answersOnline?: boolean
  /** That follower delivers this host's unclaimed trigger fires while its leader is away ('follower-trigger-delivery-v1'). */
  deliversTriggers?: boolean
  /** That follower's host call entry socket ('host-call-entry-v1'), given to the sessions and jobs this daemon starts. */
  callSocket?: string
  /** A lane's Walnut, set by stream.lane. */
  laneHome?: string
  /** The Walnut this socket configured triggers for ('' = a push that named none); its fires go here. */
  triggerScope?: string
  /** A bridge link's Walnut ('' = an older server's link), set when it opens. */
  bridgeHome?: string
  /** When this socket last sent anything (a frame, a ping, a pong). See heardFrom. */
  lastHeardAt?: number
  /** When this socket was last told the companion leads its Walnut (see heardFrom). */
  leaderNudgedAt?: number
  /** Keepalive beats in a row this trusted socket stayed silent (0 once heard again). */
  missedBeats?: number
  /** The server process behind this socket, from its hello (`run`): a relay goes again only to the run it went to. */
  serverRun?: string
  /** When its hello named that run and said its server binds: until it does, a moment of grace (gatewayCandidates). */
  helloAt?: number
  /** When it opened: one that has named no run yet is `fresh` for the same grace (gatewayCandidates). */
  connectedAt?: number
  /** The ops that server names read-only (its hello's `readOps`): a relay of one may go to it from another run. */
  readOps?: Set<string>
}

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

// ── Shell helpers ──

/**
 * The user's login shell in passwd: a service a launcher starts has SHELL=/bin/sh, and the
 * sessions should still get the user's own shell and its rc file (session-shell.ts). Read ahead
 * at the runtime's start, without blocking the thread (lib/account.ts: bun's os.userInfo()
 * answers $SHELL, not passwd); a start waits for that read at most PASSWD_WAIT_MS, then starts
 * as before. A read that could not run (a slow moment at boot) is read again at a later start,
 * at most once every PASSWD_RETRY_MS; an answer (an entry, or none) is kept for good.
 */
const PASSWD_WAIT_MS = 3000
const PASSWD_RETRY_MS = 60_000
let passwdSettled = false
let passwdFailed = false
let passwdReadAt = 0
let passwdRead: Promise<unknown> = readPasswd()
function readPasswd(): Promise<unknown> {
  passwdReadAt = Date.now()
  passwdSettled = false
  const read: Promise<unknown> = primeAccount(childUse).catch(() => null).then((found) => {
    // primeAccount answers null both for no entry and for a lookup that could not run; only
    // the second leaves knownAccount() unknown and the cache open for another try.
    if (read === passwdRead) { passwdSettled = true; passwdFailed = found === null && knownAccount() === null }
    return found
  })
  return read
}
function loginShell(): string | null {
  return knownAccount()?.shell || null
}
function passwdReady(): Promise<unknown> {
  if (passwdSettled && passwdFailed && Date.now() - passwdReadAt >= PASSWD_RETRY_MS) passwdRead = readPasswd()
  if (passwdSettled) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([passwdRead, new Promise((resolve) => { timer = setTimeout(resolve, PASSWD_WAIT_MS) })]).finally(() => clearTimeout(timer))
}

/**
 * The shell sessions start under (session-shell.ts pickSessionShell): the daemon's $SHELL, the
 * user's bash or zsh from passwd when that $SHELL is a plain sh or unset, else bash, else sh.
 */
function sessionShell(): string {
  const runs = (file: string) => runsAsShell(fs, file)
  return pickSessionShell({ envShell: daemonEnv.SHELL, loginShell: loginShell(), runs })
}

/**
 * The last shell_setup each Walnut's leader sent with a start ('start-shell-setup-v1'), for the
 * starts this host decides itself. Only a trusted client's `start` carries the field (the bridge
 * and a follower cannot send `start`); it is private to this user (session-shell.ts).
 */
const shellSetupStore = createShellSetupStore({
  fs, path, crypto,
  dir: path.join(SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR, 'shell-setup'),
  log: (level, msg, data) => logMsg(level, msg, data),
})

/**
 * The file of the shell_setup a start runs: the one its leader sent with it (kept first, so the
 * preamble names the file and never holds the text), else the last one that Walnut's leader
 * sent; '' runs none. An older leader sends none, and then none runs, as before.
 */
function shellSetupOfStart(cmd: Record<string, unknown>, sid: string): string {
  const origin = cmd.origin && typeof cmd.origin === 'object' ? cmd.origin as { home?: unknown } : {}
  const walnut = typeof origin.home === 'string' && origin.home ? walnutOfHome(origin.home) : sessionHomeOf(sid)
  return typeof cmd.shellSetup === 'string' ? shellSetupStore.remember(walnut, cmd.shellSetup) : shellSetupStore.recall(walnut)
}


/**
 * The preamble a session's CLI starts under: the rc file of its shell, the host's shell_setup,
 * the fallback tool dirs and a node that runs (session-shell.ts buildSessionPreamble, the one
 * builder; host.preflight asks through it too, as hostRuntime's spawnPreamble).
 */
function buildSpawnPreamble(o: { nodeDir?: string; gatewayFirst?: boolean; shellSetupFile?: string } = {}): string {
  return buildSessionPreamble({ shimDir: GATEWAY_SHIM_DIR, installHomeBin: INSTALL_HOME_BIN, fallbackPathStep: spawnFallbackPath(), ...o })
}

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

/**
 * Whether a session's `walnut` is this daemon's gateway shim, first on its PATH. A session its
 * Walnut gave no OPEN_WALNUT_API_URL (the env of its `--settings`, or of an ACP worker) reaches
 * that Walnut only through this daemon: every session on a host other than its server's
 * (self-api-root.ts). A machine that joined with a Walnut of its own has that Walnut's `walnut`
 * on PATH ahead of the appended shim, and it would send the session's calls to the other
 * Walnut's server.
 */
function walnutThroughGateway(env: Record<string, unknown> | undefined): boolean {
  return sessionWalnutApiUrl(env) === undefined
}

/**
 * The OPEN_WALNUT_API_URL a session's process env carries: exactly the one its Walnut named
 * (its `--settings` env, or an ACP worker's env), else none. Never this daemon's own: a
 * daemon started before its server listened has none, one started later has whichever server
 * started it, so the CLI process saw an address its settings did not name, or none where they
 * named one (a VP of a Walnut on another port, 2026-11-20).
 */
function sessionWalnutApiUrl(env: Record<string, unknown> | undefined): string | undefined {
  const url = env?.OPEN_WALNUT_API_URL
  return typeof url === 'string' && url.trim() ? url.trim() : undefined
}

/** A session PATH with the shim dir first or, for a session that reaches its Walnut over HTTP, last. */
function sessionPathWithShim(base: string, throughGateway: boolean): string {
  return throughGateway ? GATEWAY_SHIM_DIR + path.delimiter + base : base + path.delimiter + GATEWAY_SHIM_DIR
}

/** The env of a CLI's inline `--settings` (claude-code-session.ts sends it inline), if any. */
function settingsEnvOf(args: string[]): Record<string, unknown> | undefined {
  let raw: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') raw = args[i + 1]
    else if (args[i].startsWith('--settings=')) raw = args[i].slice(11)
  }
  if (!raw || !raw.trimStart().startsWith('{')) return undefined
  try {
    const env = (JSON.parse(raw) as { env?: unknown }).env
    return env && typeof env === 'object' ? env as Record<string, unknown> : undefined
  } catch { return undefined }
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
let cronMetadataReplay: Promise<void> = Promise.resolve()
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

// ── L2: daemon-authoritative per-session task state (the k8s `.status` object) ──
// The daemon sits closest to the CLI and persists every event in the append-only jsonl, so
// it is the natural source of truth for background-task state. It materializes `taskState`
// by applying task_* events with the SAME idempotent, terminal-is-terminal rules Walnut uses
// (so the two never disagree), and serves it on the `getState` RPC. Walnut PULLs it to
// reconcile a lost-terminal event WITHOUT guessing liveness. `resourceVersion` = the event's
// byte offset `v` — monotonic, and rebuildable from the jsonl after a daemon restart.
// See docs/plan/daemon-source-of-truth-versioned-events.md.
const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed'])
const BG_TRANSITION_CAP = 50 // recentTransitions ring buffer bound

function emptyTaskState(): TaskState {
  return { tasks: {}, resourceVersion: 0, updatedAt: 0, derivedRunning: 0, recentTransitions: [] }
}

// GATING count: tasks the CLI flagged is_backgrounded are excluded — the CLI's own
// turn-end does not wait for them (it emits result+idle while they run), so a daemon
// derivedRunning that counted one would veto Walnut's turn-over convergence for the
// task's whole lifetime (incident 07fffbe5: a 16-min backgrounded grep).
function runningTaskCount(ts: TaskState): number {
  let n = 0
  for (const id in ts.tasks) {
    if (ts.tasks[id].isBackgrounded) continue
    if (!BG_TERMINAL_STATUSES.has(ts.tasks[id].status)) n++
  }
  return n
}

// Apply one parsed jsonl line to the task state. Idempotent: duplicate / out-of-order /
// new-kind events all converge. `v` is the line's byte-offset version; `now` is wall-clock.
// Returns true if a task transition was recorded (for logging). Mirrors Walnut's four handlers.
function applyTaskEvent(ts: TaskState, parsed: Record<string, unknown>, v: number, now: number): boolean {
  if (parsed.type !== 'system') return false
  const subtype = parsed.subtype as string | undefined
  const taskId = parsed.task_id as string | undefined
  if (!subtype || !taskId) return false
  const existing = ts.tasks[taskId]
  const toolUseId = typeof parsed.tool_use_id === 'string' && parsed.tool_use_id.length > 0 ? parsed.tool_use_id : undefined
  const differentInvocation = !!(toolUseId && existing?.toolUseId && existing.toolUseId !== toolUseId)
  if (differentInvocation && subtype !== 'task_started') return false
  const prev = differentInvocation ? undefined : existing
  let nextStatus: string | undefined
  let isBackgrounded = prev ? prev.isBackgrounded === true : false
  if (subtype === 'task_started') {
    if (parsed.is_backgrounded === true) isBackgrounded = true
    // Terminal is terminal: a late/duplicate start can't revive a finished task, except the CLI
    // starting the same call again (a parked background subagent goes on: bg-task-resume.ts).
    const resumed = parsed.is_backgrounded === true && !!toolUseId && toolUseId === prev?.toolUseId
    nextStatus = !resumed && prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_progress') {
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_updated') {
    const patch = parsed.patch as Record<string, unknown> | undefined
    const ps = patch?.status as string | undefined
    nextStatus = ps ?? prev?.status ?? 'running'
    // Sticky: is_backgrounded=true detaches the task from turn-over gating forever
    // (no CLI path un-backgrounds a task). See runningTaskCount.
    if (patch?.is_backgrounded === true) isBackgrounded = true
  } else if (subtype === 'task_notification') {
    nextStatus = (parsed.status as string | undefined) ?? prev?.status ?? 'running'
  } else {
    return false
  }
  const wasTerminal = prev ? BG_TERMINAL_STATUSES.has(prev.status) : false
  const isTerminal = BG_TERMINAL_STATUSES.has(nextStatus)
  ts.tasks[taskId] = { status: nextStatus, v, t: now, description: (parsed.description as string | undefined) ?? prev?.description, isBackgrounded: isBackgrounded || undefined, toolUseId: toolUseId ?? prev?.toolUseId }
  if (v > ts.resourceVersion) ts.resourceVersion = v
  ts.updatedAt = now
  // Only this entry changed, so the count moves by its own change: the same
  // number as a recount, without walking every task the session ever ran. The
  // recount per event made a rebuild quadratic in a long session's tasks
  // (2026-10-27: a 2.5 GB resume held the daemon for 214 s).
  // runningTaskCount's rule, for one entry.
  const gates = (t: TaskStateEntry | undefined): number => (t && !t.isBackgrounded && !BG_TERMINAL_STATUSES.has(t.status) ? 1 : 0)
  ts.derivedRunning = (ts.derivedRunning || 0) + gates(ts.tasks[taskId]) - gates(existing)
  // Record only genuine transitions into a terminal state (the bookend that matters for recovery).
  if (!wasTerminal && isTerminal) {
    ts.recentTransitions.push({ taskId, status: nextStatus, v, t: now })
    if (ts.recentTransitions.length > BG_TRANSITION_CAP) ts.recentTransitions.shift()
    return true
  }
  return false
}

// Rebuild task state from scratch by replaying the whole jsonl. Used on adopt/discover (a new
// daemon generation has no in-memory state) — the jsonl is the durable log, so this recovers
// the exact state the previous generation held, including any terminal events Walnut's live
// stream missed. `v` is computed identically to the watcher (end-of-line byte offset).
//
// STREAMED, never readFileSync: the old whole-file read materialized a whale
// jsonl (156MB observed) as one string + a split() array on every
// attach/resume/adopt — RSS 104MB→789MB in ~30s before a silent Bun death
// (the 2026-08-13 phone-send data-loss family). Same 1MB-chunk + byte-carry
// shape as rebuildFoldStateFromJsonl; the '"task_' substring pre-filter means
// almost no line is ever decoded.
const TASK_LINE_MARKER = Buffer.from('"task_')

// Fold checkpoints (fold-checkpoint-core.ts): both rebuilds below resume from
// one, so a restart does not replay a whale stream from byte 0 before the
// daemon listens.
const foldCheckpoint = createFoldCheckpoint({
  fs, createHash: crypto.createHash, pid: process.pid,
  log: (level, msg, meta) => logMsg(level, msg, meta),
})
// A live session re-checkpoints after this much growth (see checkpointFolds).
const FOLD_CHECKPOINT_EVERY_BYTES = 32 * 1024 * 1024
const FOLD_CHECKPOINT_SWEEP_MS = 5 * 60_000

/** Checkpoint where this session's fold stands. `force` skips the growth
 *  threshold (shutdown, death) and skips an unchanged fold only while its
 *  checkpoint is still on disk (something else may have deleted it). */
function checkpointSessionFold(session: SessionData, force: boolean): void {
  const v = session.foldState.v
  const last = session.foldCheckpointV ?? 0
  if (v <= last && (!force || fs.existsSync(foldCheckpoint.pathFor(session.jsonlPath)))) return
  if (!force && v - last < FOLD_CHECKPOINT_EVERY_BYTES) return
  if (foldCheckpoint.write(session.jsonlPath, session.foldState, session.taskState, streamEpochOf(session))) {
    session.foldCheckpointV = v
  }
}

function rebuildTaskStateFromJsonl(jsonlPath: string, now: number): TaskState {
  // Resume from the fold checkpoint when it still describes this file.
  const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
  const ts = ck?.task ? foldCheckpoint.restampTaskState(ck.task, now) : emptyTaskState()
  let fd: number
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return ts }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = ck?.task ? ck.boundary : 0
    let v = filePos
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        // Byte-level pre-filter on JUST this line's slice (no copy): only
        // task_* lines are ever decoded to a string.
        else if (chunk.subarray(start, nl).includes(TASK_LINE_MARKER)) {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim() && line.includes('"task_')) {
            try { applyTaskEvent(ts, JSON.parse(line), v, now) } catch {}
          }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'task rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch { /* partial rebuild is still safe — recent state wins on the live stream */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return ts
}

// ── C1: session-snapshot fold (docs/plan/session-snapshot-source-of-truth.md §4) ──
// The daemon folds the stream file line-by-line into an authoritative
// SessionSnapshot (foldLine/assembleSnapshot from daemon-fold.ts) and pushes
// {ev:'snapshot'} to subscribers on change. Coexists with taskState L2 —
// retirement of L2 is C4's call.
const SNAPSHOT_COALESCE_MS = 50

// Upper bound on the tailer's in-memory torn-tail carry (see ensureWatcher).
// A single stream line larger than this cannot be assembled, so we log and
// realign rather than growing the buffer without limit.
const TAILER_CARRY_MAX = 32 * 1024 * 1024
// At most this much is read in one tailer tick. A large gap (a stalled loop, a
// session that wrote while no tailer ran) is then read over several ticks instead
// of in one allocation: stream files reach 3 GB, and the whole gap was one Buffer.
const TAILER_TICK_READ_MAX = 8 * 1024 * 1024

// Result of a fold rebuild: the folded state PLUS the byte offset of the last
// COMPLETE-line boundary it stopped at. Every adopt/attach/resume site must seed
// the watcher from `boundary`, never from a raw stat().size (contract §4
// "Rebuild boundary rule").
interface FoldRebuild {
  state: FoldState
  /** Absolute offset after the last complete (newline-terminated) line. */
  boundary: number
}

// Stream the whole jsonl through foldLine, from byte 0. Used by every rebuild
// site (daemon start / adopt / attach-discover / resume / unknown-sid getState).
// Reads in 1MB chunks and carries the torn tail as BYTES (a UTF-8 char split
// across chunks must not be decoded twice) so whale files never materialize as
// one string.
//
// A final unterminated segment (the CLI was mid-write when we read) is NOT
// folded and NOT counted in `boundary` — same rule as the live tailer's carry.
// Folding it would (a) parse a fragment as a whole line and (b) advance `v` past
// the real line end, so when the newline finally arrives the tailer's
// `v > foldState.v` guard skips the COMPLETE line forever. Reporting `boundary`
// (rather than stat().size) is what lets the caller start the watcher on a line
// boundary so the torn region is simply re-read.
//
// Carry cap: identical to the tailer's. A single line larger than the cap can't
// be assembled, so we drop it and realign on the next newline instead of
// re-concatenating an unbounded buffer (the old loop grew it with O(n²) copying).
const FOLD_REBUILD_CHUNK = 1024 * 1024
function rebuildFoldStateFromJsonl(jsonlPath: string): FoldRebuild {
  // A valid checkpoint IS the fold of every byte before its boundary, so the
  // rebuild continues from there (fold-checkpoint-core.ts).
  const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
  let state = ck ? ck.fold : initialFoldState(0)
  let fd: number
  // Running end-of-line byte offset — same coordinate as the tailer's v. Only
  // ever advanced past COMPLETE lines, so it doubles as the boundary.
  let v = ck ? ck.boundary : 0
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return { state: initialFoldState(0), boundary: 0 } }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = v
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start) // '\n'
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim()) state = foldLine(state, line, v)
        }
        start = nl + 1
      }
      // Copy the torn tail — `buf` is reused by the next readSync.
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
    // A trailing unterminated fragment is deliberately left unfolded — see above.
  } catch { /* partial fold is still monotone-safe — serve what we have */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return { state, boundary: v }
}

// ── Fold prewarm (`--prewarm-folds`, fold-checkpoint-core.ts) ──
// Run by the server with the NEW binary before it replaces a running daemon of
// another version, while that daemon still serves. Each registered session's
// stream is folded once (both states in one pass, from the best checkpoint) and
// saved as `<stream>.jsonl.fold.next`, so the new daemon's adopt folds only what
// was written since. 2026-10-26: a checkpoint format change made the new daemon
// fold 8.8 GB before it listened (7 min with no local sessions). Never touches a
// session, the instance lock or a port.
//
// Progress is saved every FOLD_PREWARM_PROGRESS_BYTES and at the deadline the
// server passes (WALNUT_FOLD_PREWARM_DEADLINE, epoch ms), so a run cut short
// still leaves the next one, or the new daemon's adopt, less to fold.
const FOLD_PREWARM_PROGRESS_BYTES = parseInt(daemonEnv.WALNUT_FOLD_PREWARM_PROGRESS_BYTES || '', 10) || 256 * 1024 * 1024
const foldPrewarmDeadline = (): number => parseInt(daemonEnv.WALNUT_FOLD_PREWARM_DEADLINE || '', 10) || Infinity
/** 'done' at the end of the file, 'cut' at the deadline (progress saved), 'failed' otherwise. */
function prewarmFoldOne(jsonlPath: string, now: number): 'done' | 'cut' | 'failed' {
  const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
  const resume = ck && ck.task ? ck : null
  let state = resume ? resume.fold : initialFoldState(0)
  const ts = resume && resume.task ? foldCheckpoint.restampTaskState(resume.task, now) : emptyTaskState()
  let fd: number
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return 'failed' }
  // The epoch of the file actually folded: a stream recreated meanwhile under
  // the same path must not be described by this fold.
  let epoch: string
  try {
    const st = fs.fstatSync(fd)
    epoch = st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs)
  } catch { try { fs.closeSync(fd) } catch {} return 'failed' }
  const deadline = foldPrewarmDeadline()
  let cut = false
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = resume ? resume.boundary : 0
    let v = filePos
    let saved = filePos
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    for (;;) {
      if (state.v - saved >= FOLD_PREWARM_PROGRESS_BYTES || Date.now() >= deadline) {
        if (foldCheckpoint.write(jsonlPath, state, ts, epoch, { next: true })) saved = state.v
        if (Date.now() >= deadline) { cut = true; break }
      }
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim()) {
            state = foldLine(state, line, v)
            if (line.includes('"task_')) {
              try { applyTaskEvent(ts, JSON.parse(line), v, now) } catch {}
            }
          }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'prewarm carry overflow, dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch {
    // A read that failed mid-pass: keep only the progress already saved.
    return 'failed'
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
  if (cut) return 'cut'
  return foldCheckpoint.write(jsonlPath, state, ts, epoch, { next: true }) ? 'done' : 'failed'
}

function prewarmFoldCheckpoints(): { sessions: number; written: number; cut: number; ms: number } {
  const startedAt = Date.now()
  let sessions = 0
  let written = 0
  let cut = 0
  // Largest first: a deadline then cuts the cheap ones, not the whale.
  const streams: Array<{ jsonlPath: string; size: number }> = []
  for (const entry of Object.values(readRegistry())) {
    const jsonlPath = entry && entry.jsonlPath
    if (typeof jsonlPath !== 'string' || !jsonlPath) continue
    sessions++
    try {
      const size = fs.statSync(jsonlPath).size
      if (size >= foldCheckpoint.minBytes) streams.push({ jsonlPath, size })
    } catch {}
  }
  streams.sort((a, b) => b.size - a.size)
  for (const { jsonlPath } of streams) {
    const outcome = prewarmFoldOne(jsonlPath, Date.now())
    if (outcome === 'done') written++
    else if (outcome === 'cut') { cut++; break }
  }
  const result = { sessions, written, cut, ms: Date.now() - startedAt }
  logMsg('info', 'fold prewarm done', result)
  return result
}


// ── Stream compaction (stream-compact-core.ts) ──
// A stopped session's stream file loses the token deltas of its finished turns
// (about 60% of its bytes), once nothing has written it for IDLE_MS. The copy is
// folded as it is written, so the swap re-seats the fold, the task state and a
// fresh checkpoint for the new file at once, and a later resume reads from the
// checkpoint instead of folding the file again. One file at a time, smallest
// first. Env overrides are TEST-ONLY.
const STREAM_COMPACT_IDLE_MS = parseInt(daemonEnv.WALNUT_STREAM_COMPACT_IDLE_MS || '', 10) || 30 * 60_000
const STREAM_COMPACT_SWEEP_MS = parseInt(daemonEnv.WALNUT_STREAM_COMPACT_SWEEP_MS || '', 10) || 10 * 60_000
const streamCompact = createStreamCompact({
  fs, now: Date.now, pid: process.pid, maxLineBytes: TAILER_CARRY_MAX,
  minBytes: parseInt(daemonEnv.WALNUT_STREAM_COMPACT_MIN_BYTES || '', 10) || undefined,
  chunkBytes: parseInt(daemonEnv.WALNUT_STREAM_COMPACT_CHUNK || '', 10) || undefined,
  log: (level, msg, meta) => logMsg(level, msg, meta),
})
let streamCompactRunning = false

// ── Async stream fold + rotation on resume (stream-fold-core.ts) ──
// A resume or a discovering attach folds the stream file without holding the
// thread (2026-10-27: a 2.5 GB fold froze this daemon for 214 s), and a resume
// of a file of STREAM_ROTATE_BYTES or more whose Claude transcript exists starts
// a fresh file instead of reading it. The env override is TEST-ONLY.
const streamRotateEnv = parseInt(daemonEnv.WALNUT_STREAM_ROTATE_BYTES || '', 10)
const streamFold = createStreamFold<FoldState, TaskState>({
  fs, path, foldLine, initialFoldState, emptyTaskState, applyTaskEvent,
  checkpoint: foldCheckpoint, maxLineBytes: TAILER_CARRY_MAX, now: Date.now,
  log: (level, msg, meta) => logMsg(level, msg, meta),
  rotateBytes: Number.isFinite(streamRotateEnv) ? streamRotateEnv : undefined,
})
/** The CLI's config dir, as every CLI this daemon spawns inherits it (host-local transcript readers). */
const CLAUDE_CONFIG_HOME = daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude')
/** Where the CLI keeps transcripts; a rotation needs the session's to exist. */
const CLAUDE_PROJECTS_DIRS = Array.from(new Set([
  path.join(CLAUDE_CONFIG_HOME, 'projects'),
  path.join(HOME_DIR, '.claude', 'projects'),
]))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** No process can write this stream file: the session is dead here and its group is gone. */
function streamWriterGone(sid: string): boolean {
  const s = sessions.get(sid)
  if (s && (s.state !== 'dead' || (s.pid && isProcessGroupAlive(s.pid)))) return false
  try {
    const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, sid + '.pgid'), 'utf-8').trim(), 10)
    if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) return false
  } catch {}
  return true
}

async function compactIdleStreams(): Promise<void> {
  if (streamCompactRunning) return
  streamCompactRunning = true
  try {
    let names: string[] = []
    try { names = fs.readdirSync(STREAMS_DIR) } catch { return }
    const now = Date.now()
    // Temp files a dead daemon left, and marks whose stream file is gone.
    streamCompact.sweepStale(STREAMS_DIR, pidAlive)
    const due: Array<{ sid: string; jsonlPath: string; size: number }> = []
    for (const f of names) {
      if (!streamCompact.isStreamFile(f)) continue
      const sid = f.slice(0, -'.jsonl'.length)
      const jsonlPath = path.join(STREAMS_DIR, f)
      let st: fs.Stats
      try { st = fs.statSync(jsonlPath) } catch { continue }
      if (now - st.mtimeMs < STREAM_COMPACT_IDLE_MS) continue
      if (!streamCompact.due(jsonlPath, st) || !streamWriterGone(sid)) continue
      due.push({ sid, jsonlPath, size: st.size })
    }
    due.sort((a, b) => a.size - b.size)
    for (const c of due) await compactOneStream(c.sid, c.jsonlPath)
  } catch (err) {
    logMsg('warn', 'stream compaction sweep failed', { error: (err as Error).message })
  } finally {
    streamCompactRunning = false
  }
}

async function compactOneStream(sid: string, jsonlPath: string): Promise<void> {
  // A CLI this daemon does not know (no registry entry, no .pgid) may still
  // hold the file: the owner record and the process table say so.
  if (await cliOwner.holderOf(sid)) {
    logMsg('info', 'stream compaction skipped', { sid, reason: 'live-elsewhere' })
    return
  }
  const t0 = Date.now()
  let fold = initialFoldState(0)
  const task = emptyTaskState()
  const prepared = await streamCompact.compact(jsonlPath, {
    aborted: () => !streamWriterGone(sid),
    minDropBytes: streamCompact.minBytes / 4,
    // The same steps as rebuildFoldStateFromJsonl and rebuildTaskStateFromJsonl.
    onKeptLine: (buf, v) => {
      const line = buf.toString('utf-8')
      if (line.trim()) fold = foldLine(fold, line, v)
      if (buf.includes(TASK_LINE_MARKER) && line.includes('"task_')) {
        try { applyTaskEvent(task, JSON.parse(line), v, t0) } catch {}
      }
    },
  })
  if ('skipped' in prepared) {
    if (prepared.skipped === 'aborted' || prepared.skipped === 'line-too-long') logMsg('info', 'stream compaction skipped', { sid, reason: prepared.skipped })
    return
  }
  // The swap runs in the start gate: a spawn of this sid waits for it, and a
  // spawn that won the race leaves a changed file or a live session behind.
  await sessionStartGate.run(sid, async () => {
    if (!streamWriterGone(sid) || !streamCompact.commit(jsonlPath, prepared)) {
      streamCompact.discard(jsonlPath)
      logMsg('info', 'stream compaction skipped', { sid, reason: 'changed' })
      return
    }
    // A new inode: every offset restarted, so re-seat what the daemon holds.
    foldCheckpoint.discard(jsonlPath)
    const s = sessions.get(sid)
    if (s && s.jsonlPath === jsonlPath) {
      s.foldState = fold
      s.taskState = task
      s.rewrittenFrom = streamCompact.rewrittenFrom(jsonlPath, fs.statSync(jsonlPath))
      s.streamEpoch = null
      s.offset = fold.v
      if (s.watcher) s.watcher.offset = fold.v
      s.lastPushedSnapshot = null
      s.foldCheckpointV = foldCheckpoint.write(jsonlPath, fold, task, streamEpochOf(s)) ? fold.v : 0
      pushSnapshot(sid, true)
    } else {
      foldCheckpoint.write(jsonlPath, fold, task, null)
    }
    logMsg('info', 'stream compacted', {
      sid, before: prepared.size, after: prepared.after, droppedBytes: prepared.droppedBytes,
      droppedLines: prepared.droppedLines, ms: Date.now() - t0,
    })
  })
}

// ── C18: synchronous pre-death fold drain ──
// The CLI writes its final `result` + companion `idle` lines microseconds before
// exiting, and the tailer's 100ms poll does nothing once `state !== 'running'`
// (reapSession flips that first). Without this drain the death snapshot — and
// every later getState pull, which just re-assembles the same frozen fold —
// reports turnActive=true for a turn that provably ended on disk.
//
// Reads from the last complete-line boundary the watcher published (its in-memory
// carry died with it, so the torn region is simply re-read) to EOF, folds every
// COMPLETE line, and re-publishes the boundary. Bounded by the same carry cap.
// Before the exit event clears subscribers, re-send the complete lines the watcher has not delivered yet.
function drainSessionFold(session: SessionData, sid: string): void {
  const from = session.watcher ? session.watcher.offset : (session.offset || 0)
  let size = 0
  try { size = fs.statSync(session.jsonlPath).size } catch { return }
  if (size <= from) return
  const boundary = drainFoldRange(session, from, size, (line, v) => {
    // Task state reads the same lines the fold does (the tailer's L2 step), so a
    // checkpoint of both at foldState.v describes the same bytes.
    if (line.includes('"task_')) {
      try { applyTaskEvent(session.taskState, JSON.parse(line), v, Date.now()) } catch {}
    }
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) {
        try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
      } else {
        session.subscribers.delete(ws)
      }
    }
  })
  session.offset = boundary
  if (session.watcher) session.watcher.offset = boundary
}

// Fold [from, to) into session.foldState, honoring the `v > foldState.v` guard
// (bytes already folded out-of-band must not fold twice). Returns the new
// complete-line boundary.
// The fold may run ahead of delivery, so onLine is not bounded by foldState.v.
function drainFoldRange(session: SessionData, from: number, to: number, onLine?: (line: string, v: number) => void): number {
  let boundary = from
  let fd: number
  try { fd = fs.openSync(session.jsonlPath, 'r') } catch { return boundary }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = from
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    while (filePos < to) {
      const want = Math.min(FOLD_REBUILD_CHUNK, to - filePos)
      const n = fs.readSync(fd, buf, 0, want, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        boundary += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim()) {
            if (boundary > session.foldState.v) {
              session.foldState = foldLine(session.foldState, line, boundary)
            }
            if (onLine) { try { onLine(line, boundary) } catch {} }
          }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold drain carry overflow — dropping oversized partial line', {
          jsonlPath: session.jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        boundary = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch { /* partial drain is still monotone-safe */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return boundary
}

// Stream-file identity: dev:ino:birthtimeMs. Changes exactly when the FILE is
// recreated (reboot wiped /tmp, manual delete) — the event that resets v to 0
// and invalidates every consumer-side watermark. Cached on the session; a
// failed stat leaves null (walnut treats null as "epoch unknown, no reset").
function streamEpochOf(session: SessionData): string | null {
  if (session.streamEpoch) return session.streamEpoch
  try {
    const st = fs.statSync(session.jsonlPath)
    session.streamEpoch = `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
  } catch {
    session.streamEpoch = null
  }
  return session.streamEpoch
}

// Combine the pure fold with imperatively-tracked daemon facts. exitCode is
// already normalized by reapSession (isTurnCompleteExit) by the time state
// flips to 'dead'.
function assembleSessionSnapshot(session: SessionData): SessionSnapshot {
  const ctrl = session.pendingCtrl
  const snap = assembleSnapshot({
    rewrittenFrom: session.rewrittenFrom,
    foldState: session.foldState,
    pendingCtrl: ctrl
      ? { requestId: ctrl.reqId, toolName: ctrl.toolName, sinceTs: ctrl.receivedAt }
      : null,
    dead: session.state === 'dead',
    pid: session.pid,
    exitCode: session.exitCode,
    streamEpoch: streamEpochOf(session),
  })
  // Disk-side durable crons arm cronActive too (fold only sees CronCreate in
  // THIS stream file — blind after wipe/--resume/adoption). One-way OR: the
  // walnut health monitor treats snapshot cronActive as arm-only, so a stale
  // cache never *unarms* anything. Cache is filled by the idle scan (60s).
  if (!snap.cronActive && session.diskCronCache && session.diskCronCache.armed) snap.cronActive = true
  return snap
}

// snapshotDiffers (the change-compare that ignores a bare v advance) is
// imported from daemon-fold.ts — it is pure + zero-dep, so it rides the same
// injection path into the source template instead of being hand-mirrored there.

function emitSnapshot(sid: string, session: SessionData): void {
  const snapshot = assembleSessionSnapshot(session)
  const prev = session.lastPushedSnapshot
  if (prev && !snapshotDiffers(prev, snapshot)) return
  session.lastPushedSnapshot = snapshot
  for (const ws of session.subscribers) {
    if (ws.readyState === 1) {
      try { sendEvent(ws, 'snapshot', { sid, snapshot }) } catch {}
    }
  }
}

// Push entry point: coalesce within a 50ms window; death snapshots skip the
// coalesce (immediate=true) so a dead session is never reported late.
function pushSnapshot(sid: string, immediate: boolean): void {
  const session = sessions.get(sid)
  if (!session) return
  if (immediate) {
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
    emitSnapshot(sid, session)
    return
  }
  if (session.snapshotTimer) return // window already open — coalesce
  session.snapshotTimer = setTimeout(() => {
    session.snapshotTimer = null
    // Generation guard: cmdStart may have replaced the session under this sid.
    if (sessions.get(sid) !== session) return
    emitSnapshot(sid, session)
  }, SNAPSHOT_COALESCE_MS)
}

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
  const sent = frame as Record<string, unknown>
  // Valid JSON ≠ a command frame: "null"/"42"/"\"x\"" parse fine but the
  // destructure below would THROW on null (a poison frame that predates the
  // dispatch guard — one bad client frame killed the whole daemon).
  if (!sent || typeof sent !== 'object') return sendError(ws, null, 'invalid JSON')
  // From here on a command names its Walnut by its first home on this host (adoptCommandHome).
  const cmd = adoptCommandHome(ws, sent)
  // Refused and answered (another data dir speaks as this Walnut here).
  if (!cmd) return
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
    return sendError(ws, id as number, 'command not permitted over bridge: ' + cmd.cmd)
  }
  // A named bridge link reaches only its own Walnut's sessions (or one whose Walnut
  // is not recorded, as before).
  if (ws.data?.origin === 'bridge' && BRIDGE_SESSION_COMMANDS.has(cmd.cmd as string)
    && typeof cmd.sid === 'string' && !bridgeHearsSession(ws, cmd.sid)) {
    return sendError(ws, id as number, `${cmd.cmd}: a session of another Walnut`, { errorKind: 'not_owner' })
  }
  // A follower (the host server) reads; the leader alone writes this host's state.
  if (ws.data?.origin === 'follower' && !FOLLOWER_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    logMsg('warn', 'follower: refused a command only the leader sends', { cmd: cmd.cmd, id })
    return sendFrame(ws, { id, ok: false, error: 'only the leader sends ' + cmd.cmd, errorKind: 'follower_refused' })
  }
  // Owner scope (replica-reads-v1, follower-reads-core.ts): a follower reads its own Walnut only.
  if (ws.data?.origin === 'follower' && followerScope(ws, id as number, cmd)) return
  // A lane carries the leader's streams and nothing else.
  if (ws.data?.origin === 'lane' && !LANE_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    return sendFrame(ws, { id, ok: false, error: 'a stream lane carries streams only, not ' + cmd.cmd, errorKind: 'lane_refused' })
  }

  // One command must never kill the daemon: a throw anywhere in a handler
  // (the pre-guard era: a whale-file rebuild OOM inside cmdAttach took the
  // whole process down MID phone-send — marker written, message lost) becomes
  // an error reply to the caller. Async handlers (fs.*) return promises — a
  // rejection there would otherwise surface as unhandledRejection and trip
  // the fatal guard above, so it is caught here too.
  const replyError = (err: unknown) => {
    logMsg('error', 'handleCommand: handler threw — replying with error instead of dying', {
      cmd: cmd.cmd, id, sid,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    sendError(ws, id as number, 'internal daemon error handling ' + cmd.cmd + ': '
      + (err instanceof Error ? err.message : String(err)))
  }
  // demo.quiesce runs outside the drain (it waits for the drain); once it fenced, only reads and stops.
  if (cmd.cmd === 'demo.quiesce') {
    void demoQuiesce.quiesce(ws.data?.origin, cmd).then((reply) => {
      if (reply.ok) sendOk(ws, id as number, reply)
      else sendError(ws, id as number, reply.error, reply)
    }, replyError)
    return
  }
  if (!demoQuiesce.allows(cmd.cmd)) {
    return sendError(ws, id as number, 'Demo is stopping; no new work is accepted', { errorKind: 'demo_stopping' })
  }
  try {
    // An answer to a relay is not new work: it is taken while the daemon pauses or drains,
    // so a call the server finished in those seconds gets its result (releaseGatewayRelays).
    const work = () => dispatchCommand(ws, id as number, cmd)
    // A read of a resumable host_exec run (one that only waits; it holds no update) neither holds a
    // handover's pause nor is turned away by it: its caller reads again from the next daemon.
    const free = cmd.cmd === 'gateway-result' || (cmd.cmd === 'exec.read' && hostExec.resumableJob(cmd.jobId))
    const out = (free ? work() : daemonCommands.admit(work)) as unknown
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      (out as Promise<unknown>).catch(replyError)
    }
    return
  } catch (err) {
    return replyError(err)
  }
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
    case 'fs.read': return fsRead.cmdFsRead(ws, id as number, cmd)
    case 'fs.readImage': return fsRead.cmdFsReadImage(ws, id as number, cmd)
    case 'fs.readBounded': return fsRead.cmdFsReadBounded(ws, id as number, cmd)
    // File writes are drained before a swap like session commands: a cut writeFile leaves a truncated file.
    case 'image.save': return daemonCommands.run(() => fsWrite.cmdImageSave(ws, id as number, cmd))
    case 'fs.write': return daemonCommands.run(() => fsWrite.cmdFsWrite(ws, id as number, cmd))
    case 'fs.mkdir': return daemonCommands.run(() => fsWrite.cmdFsMkdir(ws, id as number, cmd))
    // Mutation family ('fs-mutate-v1'). NOT in BRIDGE_ALLOWED_COMMANDS — see
    // the note there: a compromised cloud box must never move/delete host files.
    case 'fs.rename': return daemonCommands.run(() => fsWrite.cmdFsRename(ws, id as number, cmd))
    case 'fs.rm': return daemonCommands.run(() => fsWrite.cmdFsRm(ws, id as number, cmd))
    case 'fs.copy': return daemonCommands.run(() => fsWrite.cmdFsCopy(ws, id as number, cmd))
    case 'fs.ls': return fsRead.cmdFsLs(ws, id as number, cmd)
    case 'fs.find': return fsRead.cmdFsFind(ws, id as number, cmd)
    case 'fs.stat': return fsRead.cmdFsStat(ws, id as number, cmd)
    case 'fs.resolvePath': return fsRead.cmdFsResolvePath(ws, id as number, cmd)
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
    // A command for a task on another host (host-exec-v1, host-exec-core.ts). NOT in
    // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: it runs anything the user
    // can, so only the trusted walnut socket asks, after the server checked the
    // user's grant.
    case 'exec.run': return replyTransfer(ws, id as number, 'exec.run', () => hostExec.run(cmd), false)
    case 'exec.read': return replyTransfer(ws, id as number, 'exec.read', () => hostExec.read(cmd), false)
    case 'exec.kill': return replyTransfer(ws, id as number, 'exec.kill', () => hostExec.kill(cmd), false)
    case 'exec.list': return replyTransfer(ws, id as number, 'exec.list', () => hostExec.list(cmd), false)
    // A plugin's short script (host-script-v1, host-script-core.ts): the same rule as exec.*.
    case 'exec.script': return replyTransfer(ws, id as number, 'exec.script', () => hostExec.script(cmd), false)
    // A task on another host calling this host's MCP servers and web services (host-mcp-v1,
    // host-http-v1). The same rule as exec.*: only the trusted walnut socket asks, after the
    // server checked the user's grant.
    case 'mcp.list': return replyTransfer(ws, id as number, 'mcp.list', () => hostMcp.list(cmd), false)
    // The host network (net-v1, net-core.ts). NOT in BRIDGE_ALLOWED_COMMANDS or
    // FOLLOWER_ALLOWED_COMMANDS: it decides who may reach this daemon, so only the
    // trusted walnut socket asks.
    // The servers a session started (ports-v1, port-scan-core.ts). NOT in
    // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: ports.stop signals host
    // processes.
    case 'ports.list': return replyTransfer(ws, id as number, 'ports.list', () => daemonPorts.list(cmd), false)
    case 'ports.stop': return replyTransfer(ws, id as number, 'ports.stop', () => daemonPorts.stop(cmd), false)
    // This machine's hub forwards ('hub-forward-v1', hub-forward-core.ts).
    case 'hub.status': return hostServices.cmdHubStatus(ws, id as number)
    case 'net.status': return replyTransfer(ws, id as number, 'net.status', () => netSupervisor.status(), false)
    case 'net.identity': return replyTransfer(ws, id as number, 'net.identity', async () => ({ endpointId: await netSupervisor.identity() }), false)
    case 'net.configure': return replyTransfer(ws, id as number, 'net.configure', () => netSupervisor.configure(cmd), false)
    case 'net.forward': return replyTransfer(ws, id as number, 'net.forward', () => netSupervisor.forward(cmd), false)
    case 'net.probe': return replyTransfer(ws, id as number, 'net.probe', () => netSupervisor.probe(cmd), false)
    case 'net.invites': return replyTransfer(ws, id as number, 'net.invites', () => netSupervisor.invites(cmd), false)
    case 'net.join': return replyTransfer(ws, id as number, 'net.join', () => netSupervisor.join(cmd), false)
    case 'mcp.tools': return replyTransfer(ws, id as number, 'mcp.tools', () => hostMcp.tools(cmd), false)
    case 'mcp.call': return replyTransfer(ws, id as number, 'mcp.call', () => hostMcp.call(cmd), false)
    case 'mcp.result': return replyTransfer(ws, id as number, 'mcp.result', () => hostMcp.result(cmd), false)
    case 'http.request': return replyTransfer(ws, id as number, 'http.request', () => hostHttp.request(cmd), false)
    // The secrets the user shared with this host (secrets-v1, secrets-core.ts). NOT in
    // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: only the Mac's trusted socket
    // writes or lists them, and no reply ever carries a value.
    case 'secrets.list': return replyTransfer(ws, id as number, 'secrets.list', async () => secretStore.list(), false)
    // A write names its Walnut (the owner a sync prunes by); never another's on a bound socket.
    case 'secrets.put': case 'secrets.remove': case 'secrets.sync': {
      if (walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return sendError(ws, id, `${cmd.cmd}: this socket speaks for another Walnut`, { code: 'not_owner' })
      const op = cmd.cmd === 'secrets.put' ? secretStore.put : cmd.cmd === 'secrets.remove' ? secretStore.remove : secretStore.sync
      return replyTransfer(ws, id as number, String(cmd.cmd), async () => op(cmd), false)
    }
    case 'fs.grep': return fsRead.cmdFsGrep(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: starts a process — only the trusted
    // SSH-tunneled walnut socket may ask, never the public cloud bridge.
    case 'vscode.ensure': return fsWrite.cmdVscodeEnsure(ws, id as number, cmd)
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
    case 'fs.readRange': return fsRead.cmdFsReadRange(ws, id as number, cmd)
    case 'git.diff': return git.cmdGitDiff(ws, id as number, cmd)
    // 'git-status-v1': the glanceable state (branch, changed files, +/- lines,
    // unpushed commits) of the repos some directories sit in. Read-only, but
    // NOT in BRIDGE_ALLOWED_COMMANDS: it reads arbitrary host paths.
    case 'git.status': return git.cmdGitStatus(ws, id as number, cmd)
    // 'git-compare-v1': branches + recent commits for the Changed tab's compare
    // picker (git-diff-core.ts). Same bridge rule as git.diff.
    case 'git.refs': return git.cmdGitRefs(ws, id as number, cmd)
    // File-history family ('git-file-history-v1'). NOT in BRIDGE_ALLOWED_COMMANDS:
    // it reads arbitrary host paths, which the cloud bridge must never reach.
    case 'git.fileLog': return git.cmdGitFileLog(ws, id as number, cmd)
    case 'git.fileShow': return git.cmdGitFileShow(ws, id as number, cmd)
    // 'git-exclude-v1': writes ONLY .git/info/exclude; same bridge rule as above.
    case 'git.ensureExcluded': return git.cmdGitEnsureExcluded(ws, id as number, cmd)
    // 'git-commit-v1' (git-commit-core.ts): commit / push / PR of one session's
    // hunks. NOT in BRIDGE_ALLOWED_COMMANDS: it writes refs and publishes.
    case 'git.commitPlan': return sessionChanges.cmdGitCommitPlan(ws, id as number, cmd)
    case 'git.commitStart': return sessionChanges.cmdGitCommitStart(ws, id as number, cmd)
    case 'git.commitJob': return sendOk(ws, id as number, { job: sessionChanges.gitCommit.job(cmd.jobId) })
    // 'fs-write-part-v1' / 'transfer-v1' / 'host-facts-v1' (transfer-core.ts,
    // transfer-pack-core.ts, host-facts-core.ts): moving a workspace to another
    // host. NOT in BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: they
    // write host files, run ssh/scp, or (host.facts) read what this host is,
    // which only the trusted walnut socket asks, like host.preflight.
    // A private write ('transfer-private-v1') is authorized by this socket's own
    // binding (leader.configure / leader.claim), never by a field of the command.
    // 'upload-part-v1': a phone's attachment, bridge-reachable (see BRIDGE_ALLOWED_COMMANDS).
    case 'upload.part': return replyTransfer(ws, id as number, 'upload.part', () => {
      const root = uploadsRootFor(cmd, ws.data?.origin === 'bridge')
      return transferCore.uploadPart(cmd, root, root === uploadsOwnerlessRoot())
    }, false)
    case 'fs.writePart': return replyTransfer(ws, id as number, 'fs.writePart', () => transferCore.writePart(cmd, { boundHome: boundLocationOf(ws), origin: ws.data?.origin ?? null }), false)
    case 'transfer.pack': return replyTransfer(ws, id as number, 'transfer.pack', () => transferPack.pack(cmd), true)
    case 'transfer.reach': return replyTransfer(ws, id as number, 'transfer.reach', () => transferCore.reach(cmd), false)
    case 'transfer.fetch': return replyTransfer(ws, id as number, 'transfer.fetch', () => transferCore.fetch(cmd), true)
    case 'transfer.realpath': return replyTransfer(ws, id as number, 'transfer.realpath', () => transferCore.realpath(cmd), false)
    case 'host.facts': return replyTransfer(ws, id as number, 'host.facts', () => hostFacts.facts(cmd), false)
    case 'host.load': return replyTransfer(ws, id as number, 'host.load', () => hostFacts.load(cmd), false)
    case 'host.endpoint': return replyTransfer(ws, id as number, 'host.endpoint', () => hostFacts.endpoint(cmd), false)
    case 'transfer.scan': return replyTransfer(ws, id as number, 'transfer.scan', () => transferPack.scan(cmd), false)
    case 'transfer.apply': return replyTransfer(ws, id as number, 'transfer.apply', () => transferPack.apply(cmd), true)
    case 'transfer.clear': return replyTransfer(ws, id as number, 'transfer.clear', () => transferPack.clear(cmd), true)
    case 'transfer.recent': return replyTransfer(ws, id as number, 'transfer.recent', () => transferPack.recent(cmd), false)
    // 'host-vitals-v1' (host-vitals-core.ts): now (CPU, load, memory, uptime) and the
    // ledger fold (up and linked minutes, outages, boots). Read-only, like host.facts.
    case 'host.vitals': return replyTransfer(ws, id as number, 'host.vitals', () => hostVitals.vitals(cmd) as unknown as Promise<Record<string, unknown>>, false)
    case 'desktop.updateStatus': return replyTransfer(ws, id as number, 'desktop.updateStatus', () => desktopUpdate.status(), false)
    case 'desktop.restart': return replyTransfer(ws, id as number, 'desktop.restart', () => desktopUpdate.restart(cmd.token, cmd.force), true)
    // 'oneshot-v1' (oneshot-core.ts): the hidden one-shot claude runs. NOT in
    // BRIDGE_ALLOWED_COMMANDS or FOLLOWER_ALLOWED_COMMANDS: they start processes.
    case 'oneshot.run': return replyOneShot(ws, id as number, 'oneshot.run', () => oneShot.run(ws, cmd))
    case 'oneshot.prewarm': return replyOneShot(ws, id as number, 'oneshot.prewarm', () => oneShot.prewarm(cmd))
    case 'oneshot.cancel': return replyOneShot(ws, id as number, 'oneshot.cancel', () => oneShot.cancel(cmd))
    case 'usage.scan': return sessionChanges.cmdUsageScan(ws, id as number, cmd)
    case 'usage.costState': return sessionChanges.cmdUsageCostState(ws, id as number, cmd)
    case 'usage.sessionCost': return sessionChanges.cmdUsageSessionCost(ws, id as number, cmd)
    case 'usage.codexOutside': return sessionChanges.cmdUsageCodexOutside(ws, id as number, cmd)
    case 'usage.budget.get': return cmdUsageBudget(ws, id as number, cmd, false)
    case 'usage.budget.configure': return cmdUsageBudget(ws, id as number, cmd, true)
    case 'usage.budget.list': return cmdUsageBudgetList(ws, id as number, cmd)
    case 'changes.compute': return sessionChanges.cmdChangesCompute(ws, id as number, cmd)
    case 'changes.file': return sessionChanges.cmdChangesFile(ws, id as number, cmd)
    case 'transcript.rewindProbe': return transcripts.cmdTranscriptRewindProbe(ws, id as number, cmd)
    // 'history-ready-v1' (history-ready-core.ts): a session's first-paint view, parsed here.
    // Trusted socket only (not in the bridge or follower allowlists).
    case 'history.readyView': return transcripts.cmdHistoryReadyView(ws, id as number, cmd)
    case 'history.readyKeys': return transcripts.cmdHistoryReadyKeys(ws, id as number, cmd)
    // 'turn-snapshot-v1' (turn-snapshot-core.ts, turn-guard-core.ts). NOT in
    // BRIDGE_ALLOWED_COMMANDS: they read and write host files.
    case 'turns.list':
    case 'turns.diff':
    case 'turns.restore':
    case 'turns.guard':
    case 'turns.configure': return transcripts.cmdTurns(ws, id as number, cmd)
    // 'workspace-v1' (workspace-core.ts): a task's isolated working copy. NOT in
    // BRIDGE_ALLOWED_COMMANDS: it runs providers and removes folders on this host.
    case 'workspace.configure':
    case 'workspace.detect':
    case 'workspace.create':
    case 'workspace.job':
    case 'workspace.status':
    case 'workspace.repos':
    case 'workspace.remove':
    // 'workspace-scripts-v1': a repository's scripts file and a script run in a workspace.
    case 'workspace.scriptsFile':
    case 'workspace.runScript': return hostServices.cmdWorkspace(ws, id as number, cmd)
    case 'list': return cmdList(ws, id as number)
    case 'sessions.discoverExternal': return transcripts.cmdDiscoverExternalSessions(ws, id as number, cmd)
    case 'sessions.describeExternal': return transcripts.cmdDescribeExternalSessions(ws, id as number, cmd)
    case 'bridge.configure': return cmdBridgeConfigure(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: rule content may only arrive over the
    // trusted SSH-tunneled walnut socket, never from the public cloud bridge.
    case 'hooks.configure': return daemonCommands.run(() => hooks.cmdHooksConfigure(ws, id as number, cmd))
    // walnut-trigger ('triggers-v1'). NOT in BRIDGE_ALLOWED_COMMANDS: a check is
    // an arbitrary shell command on this host, and a fire carries host data — the
    // whole family belongs to the trusted SSH-tunneled walnut socket only.
    case 'triggers.configure': return daemonCommands.run(() => triggerSet.cmdTriggersConfigure(ws, id as number, cmd))
    case 'triggers.test': return triggerCommands.cmdTriggersTest(ws, id as number, cmd)
    case 'triggers.run': return daemonCommands.run(() => triggerCommands.cmdTriggersRun(ws, id as number, cmd))
    case 'triggers.ack': return daemonCommands.run(() => triggerCommands.cmdTriggersAck(ws, id as number, cmd))
    case 'triggers.claim': return daemonCommands.run(() => triggerCommands.cmdTriggersClaim(ws, id as number, cmd))
    // trigger-state-snapshot-v1: read-only, still trusted-socket only (host data).
    case 'triggers.state.snapshot': return daemonCommands.run(() => triggerCommands.cmdTriggersStateSnapshot(ws, id as number, cmd))
    // trigger-state-seed-v1: writes only a file nothing holds, trusted-socket only.
    case 'triggers.state.seed': return daemonCommands.run(() => triggerCommands.cmdTriggersStateSeed(ws, id as number, cmd))
    case 'skills.sync': return skills.cmdSkillsSync(ws, id as number, cmd)
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
  if (!journaledIds().has(sid)) journaledSids = null
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
const BUDGET_DIR = path.join(path.dirname(RESUME_RECORD_DIR), 'usage-budgets')
type BudgetStopProof = { pid: number; startTime: string; bootId: string; members?: Array<{ pid: number; startTime: string }> }
const budgetStopGroups = new Map<string, BudgetStopProof>()
const budgetStopFile = path.join(BUDGET_DIR, 'stops.map')
const budgetBoot = readCronBootId(process.platform, AbortSignal.timeout(5000), childUse).catch(() => '')
const budgetStopsReady = (async () => {
  let text: string
  try { text = await fs.promises.readFile(budgetStopFile, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const [sid, proof] of Object.entries(JSON.parse(text) as Record<string, BudgetStopProof>)) {
    if (!isJournalSid(sid) || !proof || !Number.isSafeInteger(proof.pid) || proof.pid <= 1 || typeof proof.startTime !== 'string' || typeof proof.bootId !== 'string'
      || (proof.members !== undefined && (!Array.isArray(proof.members) || proof.members.some(member => !member || !Number.isSafeInteger(member.pid) || member.pid <= 1 || typeof member.startTime !== 'string')))) throw new Error('budget stop proof is invalid')
    budgetStopGroups.set(sid, proof)
  }
})()
void budgetStopsReady.catch(error => logMsg('error', 'budget stop proofs could not be read', { error: String(error) }))
let budgetStopWrites: Promise<void> = Promise.resolve()
function persistBudgetStops(): Promise<void> {
  const work = budgetStopWrites.catch(() => {}).then(async () => {
    await ensureUsageBudgetDirectory(BUDGET_DIR)
    const temp = budgetStopFile + '.' + crypto.randomUUID() + '.tmp'
    try {
      const handle = await fs.promises.open(temp, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(Object.fromEntries(budgetStopGroups))); await handle.sync() } finally { await handle.close() }
      await fs.promises.rename(temp, budgetStopFile)
      const directory = await fs.promises.open(BUDGET_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { await directory.sync() } finally { await directory.close() }
    } finally { await fs.promises.unlink(temp).catch(() => {}) }
  })
  budgetStopWrites = work
  return work
}
async function budgetGroupMembers(pgid: number): Promise<Array<{ pid: number; startTime: string }>> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'lstart='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...daemonEnv, LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
  })
  const members: Array<{ pid: number; startTime: string }> = []
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (match && Number(match[2]) === pgid && Number(match[1]) > 1) members.push({ pid: Number(match[1]), startTime: match[3] })
  }
  return members
}
async function continueBudgetGroupStop(sid: string, proof: BudgetStopProof): Promise<void> {
  if (!isProcessGroupAlive(proof.pid)) return
  const boot = await budgetBoot
  if (!boot || boot !== proof.bootId) throw new Error('budget pause: process group boot identity is unknown')
  const current = await budgetGroupMembers(proof.pid)
  const confirmed = current.some(member => proof.members?.some(old => old.pid === member.pid && old.startTime === member.startTime))
  if (!confirmed) throw new Error('budget pause: no surviving owned process group member is confirmed')
  // The original leader may have exited on interrupt. A same-group birth proof still owns the remaining group.
  killProcessGroup(proof.pid, 'SIGTERM')
  const deadline = Date.now() + 2500
  while (isProcessGroupAlive(proof.pid) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 200))
  if (isProcessGroupAlive(proof.pid)) throw new Error('budget pause: process group did not exit after SIGTERM')
  logMsg('info', 'budget pause: remaining owned process group stopped', { sid })
}
async function budgetStopPending(sid: string): Promise<boolean> {
  await budgetStopsReady
  const proof = budgetStopGroups.get(sid)
  if (!proof) return false
  const boot = await budgetBoot
  if (!(boot && proof.bootId && boot !== proof.bootId) && isProcessGroupAlive(proof.pid)) return true
  budgetStopGroups.delete(sid)
  await persistBudgetStops()
  return false
}
const budgetControl = createBudgetControl({
  timeoutMs: 2_000,
  writeRaw: async (sid, raw) => { const result = await core.handleSendRawCommand(sid, raw); return 'ok' in result && result.ok === true },
})
const usageBudget = createUsageBudgetRuntime({
  dir: BUDGET_DIR,
  projectsDir: path.join(daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'), 'projects'),
  codexHome: daemonEnv.CODEX_HOME || path.join(HOME_DIR, '.codex'),
  pause: (sid, engine, runtimeId) => engine === 'claude' ? pauseBudgetSession(sid) : pauseAcpBudgetSession(runtimeId ?? sid),
  active: (sid, engine, runtimeId) => engine === 'claude' ? sessions.get(sid)?.state === 'running' : acp.hasWorker(runtimeId ?? sid),
  log: (message, fields) => logMsg('warn', message, fields),
  childProcess: childUse,
})

/** An ACP worker (Codex, OpenCode) over its budget: stop it; its sends are refused in cmdAcpOp. */
async function pauseAcpBudgetSession(runtimeId: string): Promise<void> {
  if (acp.hasWorker(runtimeId)) await acp.acpStop(runtimeId)
}

/** 'ok', or why a send is refused: 'budget_paused', or 'budget_checking' (not decided yet; the server sends it again). */
async function budgetAllowance(sid: string): Promise<BudgetGate> {
  if (await budgetStopPending(sid)) return 'budget_paused'
  const verdict = budgetGate(await usageBudget.allow(sid))
  if (verdict !== 'ok') return verdict
  return await budgetStopPending(sid) ? 'budget_paused' : 'ok'
}
function budgetGate(verdict: BudgetVerdict): BudgetGate {
  return verdict === 'ok' ? 'ok' : verdict === 'paused' ? 'budget_paused' : 'budget_checking'
}
function budgetRefusal(reason: 'budget_paused' | 'budget_checking'): Error & { code: string } {
  return Object.assign(new Error(reason), { code: reason === 'budget_paused' ? 'BUDGET_PAUSED' : 'BUDGET_CHECKING' })
}
async function requireBudgetAllowance(sid: string): Promise<void> {
  const verdict = await budgetAllowance(sid)
  if (verdict !== 'ok') throw budgetRefusal(verdict)
}

async function pauseBudgetSession(sid: string): Promise<void> {
  cancelTurnRetry(sid, 'budget-paused')
  await budgetStopsReady
  if (cronRuntime?.get(sid)) await cronRuntime.disable(sid)
  const session = sessions.get(sid)
  if (!session || session.state !== 'running' || !session.pid) {
    if (await budgetStopPending(sid)) {
      await continueBudgetGroupStop(sid, budgetStopGroups.get(sid)!)
      budgetStopGroups.delete(sid)
      await persistBudgetStops()
    }
    return
  }
  const pid = session.pid
  sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
  const owner = journaledHome(sid)
  const refusal = stopOwnerRefusal(sid, { home: owner, strict: true, initiator: 'automatic' })
  if (!owner || refusal) throw new Error('budget pause: session ownership is not confirmed')
  let pgid = NaN
  try { pgid = Number(fs.readFileSync(session.pgidPath, 'utf8').trim()) } catch {}
  if (pgid !== session.pid) throw new Error('budget pause: process group ownership is not confirmed')
  if ((SERVICE_MODE && session.bootId !== daemonBootId) || !session.startTime || await readStartTimeAsync(session.pid) !== session.startTime) throw new Error('budget pause: process identity is not confirmed')
  const proof = { pid, startTime: session.startTime, bootId: await budgetBoot, members: await budgetGroupMembers(pid) }
  budgetStopGroups.set(sid, proof)
  await persistBudgetStops()
  if (sessions.get(sid) !== session) throw new Error('budget pause: process identity changed')
  session.intentionalStopAt = Date.now()
  session.budgetGracefulStop = true
  persistRegistry()
  const ids = Object.keys(session.taskState.tasks).filter(id => !BG_TERMINAL_STATUSES.has(session.taskState.tasks[id].status))
  const [stoppedTasks, interrupted] = await Promise.all([
    Promise.all(ids.map(task_id => budgetControl.ask(sid, { subtype: 'stop_task', task_id }))),
    budgetControl.ask(sid, { subtype: 'interrupt', cancel_queued: true }),
  ])
  if (stoppedTasks.some(ok => !ok) || !interrupted) logMsg('warn', 'budget pause: control acknowledgement missing; confirming the whole owned process group', { sid })
  if (sessions.get(sid) !== session) throw new Error('budget pause: process identity changed')
  if (!session.pid && isProcessGroupAlive(pid)) await continueBudgetGroupStop(sid, proof)
  let reply: Record<string, unknown> | undefined
  const sink = { data: {}, readyState: 1, send(raw: string) { reply = JSON.parse(raw); return 1 }, close() {} } as unknown as ServerWebSocket<WsData>
  await stopSessionProcess(sink, 0, sid)
  if (isProcessGroupAlive(pid)) await continueBudgetGroupStop(sid, proof)
  if (!reply || (reply.stopped !== true && isProcessGroupAlive(pid))) throw new Error(String(reply?.error || 'budget pause: process stop was not confirmed'))
  if (sessions.get(sid) === session && session.state === 'running') { reapSession(sid, 0, 'budget-stop-confirmed', true); persistRegistry() }
  budgetStopGroups.delete(sid)
  await persistBudgetStops()
}

async function cmdUsageBudget(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, configure: boolean) {
  if (refuseForeignHome(ws, id, cmd, configure ? 'usage.budget.configure' : 'usage.budget')) return
  const sid = cmd.sid
  const engine = typeof cmd.engine === 'string' ? cmd.engine : 'claude'
  const known = (s: string) => sessions.has(s) || journaledIds().has(s)
  // An ACP session is keyed by its provider id, which this daemon may not know while it is
  // stopped; the server names its engine.
  if (!isJournalSid(sid) || (!known(sid) && engine === 'claude')) return sendError(ws, id, 'usage.budget: session not found', { code: 'NOT_FOUND' })
  // A Claude Code session here is budgeted (and its owner checked) as one, whatever engine the asker names.
  if (known(sid) && engine !== 'claude') return sendError(ws, id, 'usage.budget: the session runs Claude Code', { code: 'BAD_REQUEST' })
  if (configure) {
    if (!isServerClient(ws)) return sendError(ws, id, 'usage.budget.configure: trusted clients only', { code: 'NOT_OWNED' })
    if (typeof cmd.home !== 'string' || !cmd.home) return sendError(ws, id, 'usage.budget.configure: home must name the asking Walnut', { code: 'BAD_REQUEST' })
    if (engine === 'claude') {
      const refusal = stopOwnerRefusal(sid, { ...cmd, strict: true, initiator: 'automatic' })
      if (refusal) return sendError(ws, id, 'usage.budget.configure: session ownership is not confirmed', { code: 'NOT_OWNED' })
    }
  }
  try {
    const result = configure
      ? await usageBudget.configure(sid, { limitUsd: cmd.limitUsd as number | null, revision: cmd.revision as number, engine, home: cmd.home as string,
        ...(typeof cmd.cwd === 'string' ? { cwd: cmd.cwd } : {}), ...(typeof cmd.runtimeId === 'string' ? { runtimeId: cmd.runtimeId } : {}),
        ...(cmd.prices ? { prices: cmd.prices as BudgetPrices } : {}) })
      : await usageBudget.read(sid)
    return sendOk(ws, id, { result })
  } catch (error) { return sendError(ws, id, String(error instanceof Error ? error.message : error), { code: (error as { code?: string }).code }) }
}

/** usage.budget.list: every configured budget here, with the hash of the price list it holds. */
async function cmdUsageBudgetList(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (!isServerClient(ws)) return sendError(ws, id, 'usage.budget.list: trusted clients only', { code: 'NOT_OWNED' })
  try {
    if (cmd.prices) await usageBudget.setPrices(cmd.prices as BudgetPrices)
    const runtimeIds = cmd.runtimeIds && typeof cmd.runtimeIds === 'object' ? cmd.runtimeIds as Record<string, string> : undefined
    const home = typeof cmd.home === 'string' && cmd.home ? cmd.home : undefined
    return sendOk(ws, id, { result: { budgets: await usageBudget.list(runtimeIds, home), pricesHash: usageBudget.pricesHash() } })
  } catch (error) { return sendError(ws, id, String(error instanceof Error ? error.message : error)) }
}

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

// ── Host resume for a trigger fire (trigger-host-resume-v1) ──
// A fire no server claimed whose task's session is stopped on this host: start
// that session again with the fire as its first message, with the command it
// last ran (resumeArgs). Proof first: the spawn journal names this Walnut as the
// one that started it, and its transcript is here. At most two start at once,
// one per session every 10 minutes (a CLI that dies at once is not started again
// every minute), none while 20 sessions here are mid-turn.
const HOST_RESUME_MAX_STARTING = 2
const HOST_RESUME_COOLDOWN_MS = 10 * 60_000
const HOST_RESUME_MAX_BUSY = 20
let hostResumesStarting = 0
const hostResumedAt = new Map<string, number>()

async function resumeForTrigger(home: string, sid: string, text: string, messageId: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isJournalSid(sid)) return { ok: false, reason: 'not a session id' }
  // The journal's first line decides when it names a Walnut. A line backfilled
  // from the older ledger names none (every session started before 2026-09-26),
  // and then the Walnut that asked for its latest spawn decides (below).
  // livedHere first: it reads the journal again on a miss, so the owner below is the file's as it is now.
  if (!livedHere(sid)) return { ok: false, reason: 'no transcript of that session on this host' }
  const journaled = journaledHome(sid)
  if (journaled !== undefined && journaled !== walnutOfHome(home)) return { ok: false, reason: 'that session was started on this host for another Walnut' }
  // trigger-resume-once: a try of a fire that already reached the session (a daemon killed
  // after the write, before the ack mark) starts nothing: the stream and its write records
  // are on disk, so they say so across a restart (core.lineReachedBefore).
  const uuid = fireLineUuid(messageId)
  const went = await core.lineReachedBefore(path.join(STREAMS_DIR, sid + '.jsonl'), uuid, [messageId])
  if (went) {
    logMsg('info', 'trigger: the fire already reached that session; it is not resumed again', { sid, taskId, messageId, ...went })
    return { ok: true }
  }
  const now = Date.now()
  for (const [k, at] of hostResumedAt) if (now - at >= HOST_RESUME_COOLDOWN_MS) hostResumedAt.delete(k)
  if (hostResumedAt.has(sid)) return { ok: false, reason: 'this host resumed that session moments ago' }
  if (hostResumesStarting >= HOST_RESUME_MAX_STARTING) return { ok: false, reason: 'other sessions are starting on this host' }
  let busy = 0
  for (const s of sessions.values()) if (s.state === 'running' && s.foldState?.turnActive) busy++
  if (busy >= HOST_RESUME_MAX_BUSY) return { ok: false, reason: 'this host is busy' }
  const spawn = spawnRecordOf(sid)
  if (!spawn) return { ok: false, reason: 'no spawn record of that session on this host' }
  if (journaled === undefined && walnutOfHome(spawn.home ?? '') !== walnutOfHome(home)) return { ok: false, reason: 'this host has no record of starting that session for this Walnut' }
  if (!fs.existsSync(spawn.cwd)) return { ok: false, reason: 'its folder is gone from this host' }
  const args = hostResume.resumeArgs(spawn.args, sid, spawn.mode)
  hostResumedAt.set(sid, now)
  hostResumesStarting++
  const stopVersion = sessionStopVersions.get(sid) ?? 0
  const current = () => (sessionStopVersions.get(sid) ?? 0) === stopVersion
    && (!cronRuntime || cronRuntime.deliveryAllowed(sid, undefined))
  try {
    await sessionStartGate.run(sid, async () => {
      if (!current()) throw new Error('a stop request superseded this start')
      // Started with no line, then the fire as one delivery, as the server's own resume
      // sends a marked message (deferMessage): its write record goes on disk before the
      // line's first byte and after its newline, and its turn-start marker (the CLI never
      // echoes stdin, so without one the fire never shows in the chat) sits before that
      // newline. So no crash point leaves a line the CLI can run with no record of it.
      await startSessionProcess({ cmd: 'start', sid, args, cwd: spawn.cwd, message: '', deferMessage: true, resume: true, mode: spawn.mode, origin: { home, task: taskId } }, undefined, current)
      const sent = await core.handleSendCommand(sid, text, uuid, [{ message: text, messageId }], { fromHost: true, bootWait: true })
      if (!('ok' in sent) || !sent.ok) {
        throw new Error('the fire did not go into the resumed session (' + String('reason' in sent ? sent.reason : (sent as { error?: string }).error) + ')')
      }
    })
    logMsg('info', 'trigger: resumed a stopped session on this host', { sid, taskId, messageId, mode: spawn.mode })
    return { ok: true }
  } catch (err) {
    logMsg('warn', 'trigger: host resume failed', { sid, taskId, messageId, error: (err as Error).message })
    return { ok: false, reason: (err as Error).message }
  } finally {
    hostResumesStarting--
  }
}

// ── Bridge-safe resume: respawn a dead session with --resume <sid> ──
// Unlike `start` (which takes arbitrary argv from the caller — unsafe over
// the public bridge), `bridgeResume` only accepts {sid, message, cwd?, model?}
// and builds the argv itself: the session's last spawn command (spawnRecordOf,
// turned into a resume of this sid by resumeArgs) or, when there is none, a
// fixed default `claude --resume` command. Gated on the session's jsonl
// existing in STREAMS_DIR, which proves the session genuinely lived on this
// host, so a compromised cloud box still can't run arbitrary commands, only
// wake conversations that were here.
function cmdBridgeResume(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message, cwd: cwdHint, model } = cmd as {
    sid: string; message: string; cwd?: string; model?: string
  }
  if (!sid || !message) {
    return sendError(ws, id, 'bridgeResume: missing sid or message')
  }

  const session = sessions.get(sid)

  if (session && session.state === 'running' && cmd.autoRetry !== true) {
    // Already alive — just send the message directly.
    return cmdSend(ws, id, { cmd: 'send', sid, message, stopFence: cmd.stopFence })
  }

  // Proof of residence: its stream file, or the spawn journal once retention dropped the file.
  if (!livedHere(sid)) {
    return sendError(ws, id, 'bridgeResume: session not found: ' + sid)
  }
  // livedHere may have read the journal again: the session's Walnut is judged on what it read.
  if (ws.data?.origin === 'bridge' && !bridgeHearsSession(ws, sid)) {
    return sendError(ws, id, 'bridgeResume: a session of another Walnut', { errorKind: 'not_owner' })
  }

  const spawn = spawnRecordOf(sid)
  // cwd: the spawn record → caller's projection hint. --resume only finds the
  // conversation when the cwd matches the original, so a wrong hint just
  // yields a "No conversation found" turn error, not a security problem.
  // The folder it last ran in, unless that is gone and the server names another
  // (Walnut moved the session out of a deleted folder).
  const cwd = spawn && (fs.existsSync(spawn.cwd) || !cwdHint) ? spawn.cwd : cwdHint
  if (!cwd) {
    return sendError(ws, id, 'bridgeResume: no cwd known for session (record lost, no hint)')
  }

  const mode = spawn ? spawn.mode : (session?.mode ?? 'default')
  const args: string[] = spawn
    ? hostResume.resumeArgs(spawn.args, sid, mode)
    // The spawn record is lost: the same frame every session starts with (claude-session-argv.ts),
    // with no settings of its own (they were in the lost record).
    : buildClaudeArgv({
      command: 'claude',
      env: daemonEnv,
      session: ['--permission-mode', MODE_CLI[mode as SessionMode] || 'default', ...(model ? ['--model', model] : []), '--resume', sid],
      settings: {},
    })

  logMsg('info', 'bridgeResume: respawning dead session', {
    sid, cwd, recordLost: !spawn,
  })
  // cmdStart is async (FIFO write continuation) — return the promise so the
  // dispatcher's rejection handler owns any throw.
  return cmdStart(ws, id, {
    cmd: 'start',
    sid,
    args,
    cwd,
    message,
    resume: true,
    mode,
    stopFence: cmd.stopFence,
    autoRetry: cmd.autoRetry === true,
  })
}

// ── STT relay: bridge audio → the connected walnut server's local engine ──
// The daemon has no transcription engine of its own. A bridge `stt` request
// is relayed as an `stt-request` event to a TRUSTED (non-bridge) client — the
// walnut server holding this daemon's WS — which runs its configured engine
// and answers with an `stt-result` command carrying the same relayId. No
// trusted client connected (Mac down) → fail fast so the cloud box falls back
// to its own OpenAI path. Audio payloads are never logged.

const STT_RELAY_TIMEOUT_MS = 90_000
let sttRelayCounter = 0
const sttRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
  /** The Walnut whose bridge link asked ('' = an older server's link). */
  home: string
}>()

function cmdSttRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { audio, format, language } = cmd as { audio?: string; format?: string; language?: string }
  if (!audio || !format) {
    return sendError(ws, id, 'stt: missing audio or format')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  const home = bridgeHomeOf(ws)
  const target = pickTrustedClient(home).client
  if (!target) {
    return sendError(ws, id, 'stt: no transcription host connected')
  }
  const relayId = ++sttRelayCounter
  const timer = setTimeout(() => {
    sttRelayPending.delete(relayId)
    sendError(ws, id, 'stt: transcription timed out')
  }, STT_RELAY_TIMEOUT_MS)
  sttRelayPending.set(relayId, { ws, id, timer, home })
  logMsg('info', 'stt: relaying to transcription host', { relayId, format, audioB64Len: audio.length })
  sendEvent(target, 'stt-request', { relayId, audio, format, language })
}

function cmdSttResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, text, durationMs, error } = cmd as {
    relayId?: number; text?: string; durationMs?: number; error?: string
  }
  const pending = typeof relayId === 'number' ? sttRelayPending.get(relayId) : undefined
  if (pending && answersForOtherWalnut(ws, pending.home)) return sendError(ws, id, 'stt-result: not this Walnut\'s relay')
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  sttRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (typeof text === 'string' && !error) {
    logMsg('info', 'stt: relay complete', { relayId, chars: text.length, durationMs })
    sendOk(pending.ws, pending.id, { text, durationMs: durationMs ?? 0 })
  } else {
    sendError(pending.ws, pending.id, 'stt: ' + (error ?? 'transcription failed'))
  }
  sendOk(ws, id, {})
}

// ── Launch relay: bridge session-create request → the connected walnut server ──
// The daemon has no session-record store — records live on the walnut server
// (session-tracker), and quickStartSession is the only correct creation core.
// A bridge `session.launch` request is relayed as a `launch-request` event to
// a TRUSTED (non-bridge) client — the walnut server holding this daemon's WS
// — which validates + creates and answers with a `launch-result` command
// carrying the same relayId. The daemon spawns NOTHING here; a compromised
// cloud box gets exactly one verb: "ask the primary to run its own launch
// validation". No trusted client (walnut server down) → fail fast.

const LAUNCH_RELAY_TIMEOUT_MS = 45_000
let launchRelayCounter = 0
const launchRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
  /** The Walnut whose bridge link asked ('' = an older server's link). */
  home: string
}>()

function cmdLaunchRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { action, params } = cmd as { action?: string; params?: Record<string, unknown> }
  if (!action) {
    return sendError(ws, id, 'session.launch: missing action')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  const home = bridgeHomeOf(ws)
  const picked = pickTrustedClient(home)
  const target = picked.client
  if (!target) {
    return sendError(ws, id, noPrimaryError('session.launch: no primary server connected', picked))
  }
  const relayId = ++launchRelayCounter
  const timer = setTimeout(() => {
    launchRelayPending.delete(relayId)
    sendError(ws, id, 'session.launch: primary server timed out')
  }, LAUNCH_RELAY_TIMEOUT_MS)
  launchRelayPending.set(relayId, { ws, id, timer, home })
  logMsg('info', 'session.launch: relaying to primary server', { relayId, action })
  sendEvent(target, 'launch-request', { relayId, action, params: params ?? {} })
}

function cmdLaunchResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind, details } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string; details?: unknown
  }
  const pending = typeof relayId === 'number' ? launchRelayPending.get(relayId) : undefined
  if (pending && answersForOtherWalnut(ws, pending.home)) return sendError(ws, id, 'launch-result: not this Walnut\'s relay')
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  launchRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.launch: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind (and a host gate's details: host, headline, hint,
    // allowOverride) through so the cloud route maps the precise 4xx.
    sendFrame(pending.ws, {
      id: pending.id, ok: false,
      error: error ?? 'launch failed',
      errorKind: errorKind ?? 'internal',
      ...(details && typeof details === 'object' ? { details } : {}),
    })
  }
  sendOk(ws, id, {})
}

// ── Control relay: bridge session-control request → the connected walnut server ──
// Mirror of the launch relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough) for model/effort/fork/model-options. The
// daemon executes NOTHING here — the walnut server re-validates and runs the
// shared session-controls core, answering with a `control-result` command
// carrying the same relayId.

const CONTROL_RELAY_TIMEOUT_MS = 45_000
let controlRelayCounter = 0
const controlRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
  /** The Walnut whose bridge link asked ('' = an older server's link). */
  home: string
}>()

function cmdControlRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { action, sid, sessionId, params } = cmd as {
    action?: string; sid?: string; sessionId?: string; params?: Record<string, unknown>
  }
  if (!action) {
    return sendError(ws, id, 'session.control: missing action')
  }
  const targetSid = sessionId ?? sid
  if (!targetSid) {
    return sendError(ws, id, 'session.control: missing sessionId')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  const home = bridgeHomeOf(ws)
  const picked = pickTrustedClient(home)
  const target = picked.client
  if (!target) {
    return sendError(ws, id, noPrimaryError('session.control: no primary server connected', picked))
  }
  const relayId = ++controlRelayCounter
  const timer = setTimeout(() => {
    controlRelayPending.delete(relayId)
    sendError(ws, id, 'session.control: primary server timed out')
  }, action === 'server.voice.archive' && params?.operation === 'transcribe' ? 900_000 : CONTROL_RELAY_TIMEOUT_MS)
  controlRelayPending.set(relayId, { ws, id, timer, home })
  logMsg('info', 'session.control: relaying to primary server', { relayId, action, sid: targetSid })
  sendEvent(target, 'control-request', { relayId, action, sessionId: targetSid, params: params ?? {} })
}

function cmdControlResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind, errorCode } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string; errorCode?: string
  }
  const pending = typeof relayId === 'number' ? controlRelayPending.get(relayId) : undefined
  if (pending && answersForOtherWalnut(ws, pending.home)) return sendError(ws, id, 'control-result: not this Walnut\'s relay')
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  controlRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.control: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind/errorCode through so the cloud route maps the precise 4xx.
    sendFrame(pending.ws, {
      id: pending.id, ok: false,
      error: error ?? 'control failed',
      errorKind: errorKind ?? 'internal',
      ...(errorCode ? { errorCode } : {}),
    })
  }
  sendOk(ws, id, {})
}

// ── Message relay: bridge phone send → the connected walnut server's durable queue ──
// Mirror of the control relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough). The daemon writes NOTHING itself — the
// walnut server enqueues the message into the SAME durable queue web sends
// use (sendMessageToSession), so a daemon/CLI death anywhere after the
// enqueue converts to delayed redelivery instead of loss (the 2026-08-13
// phone-send data-loss family). messageId (qm-mobile-*) rides through for
// end-to-end idempotence.

const MESSAGE_RELAY_TIMEOUT_MS = 45_000
let messageRelayCounter = 0
const messageRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
  /** The trusted client it was handed to, the request as sent, and how often it moved. */
  target: ServerWebSocket<WsData>; request: Record<string, unknown>; hops: number
  /** The Walnut whose bridge link asked ('' = an older server's link); a reroute keeps to it. */
  home: string
}>()
/** How many times one relay may move to another client after its target closed. */
const MESSAGE_RELAY_MAX_HOPS = 4
/** Its target closed and no other client can take it. Worded as a timeout on
 *  purpose: the request was written, so it may have arrived, and the companion
 *  must ask the Mac before it sends the message any other way. */
const MESSAGE_RELAY_TARGET_LOST = 'session.message: primary server timed out (its link closed with the message on it)'

/**
 * A trusted client closed: each phone send handed to it and not answered yet
 * goes to the next client at once, the same request (the walnut server's queue
 * takes a message id once, so a second copy is answered as the first was). A
 * dead forward the daemon had not noticed yet closes the moment a relay is
 * written to it, and each such relay used to wait out its whole 45s timeout
 * (matrix L5, 2026-10-03: three in a row, while the Mac's fresh links sat
 * idle). With no client left it answers at once.
 */
function rerouteMessageRelays(closed: ServerWebSocket<WsData>): void {
  for (const [relayId, pending] of messageRelayPending) {
    if (pending.target !== closed) continue
    const next = pending.hops < MESSAGE_RELAY_MAX_HOPS ? pickTrustedClient(pending.home).client : null
    if (next) {
      pending.target = next
      pending.hops += 1
      logMsg('info', 'session.message: its target closed, relaying again', { relayId, from: wsId(closed), to: wsId(next), hops: pending.hops })
      sendEvent(next, 'message-request', pending.request)
      continue
    }
    messageRelayPending.delete(relayId)
    clearTimeout(pending.timer)
    logMsg('warn', 'session.message: its target closed and no other client can take it', { relayId, from: wsId(closed), hops: pending.hops })
    sendError(pending.ws, pending.id, MESSAGE_RELAY_TARGET_LOST)
  }
}

function cmdMessageRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, sessionId, message, messageId } = cmd as {
    sid?: string; sessionId?: string; message?: string; messageId?: string
  }
  const targetSid = sessionId ?? sid
  if (!targetSid || typeof message !== 'string' || message === '' || !messageId) {
    return sendError(ws, id, 'session.message: missing sessionId, message, or messageId')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  const home = bridgeHomeOf(ws)
  const picked = pickTrustedClient(home)
  const target = picked.client
  if (!target) {
    return sendError(ws, id, noPrimaryError('session.message: no primary server connected', picked))
  }
  const relayId = ++messageRelayCounter
  const timer = setTimeout(() => {
    messageRelayPending.delete(relayId)
    sendError(ws, id, 'session.message: primary server timed out')
  }, MESSAGE_RELAY_TIMEOUT_MS)
  const request = { relayId, sessionId: targetSid, message, messageId, stopFence: cmd.stopFence ?? null }
  messageRelayPending.set(relayId, { ws, id, timer, target, request, hops: 0, home })
  logMsg('info', 'session.message: relaying to primary server', { relayId, sid: targetSid, messageId, to: wsId(target) })
  sendEvent(target, 'message-request', request)
}

function cmdMessageResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string
  }
  const pending = typeof relayId === 'number' ? messageRelayPending.get(relayId) : undefined
  if (pending && answersForOtherWalnut(ws, pending.home)) return sendError(ws, id, 'message-result: not this Walnut\'s relay')
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  messageRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.message: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind through so the cloud route maps the precise 4xx/503.
    sendFrame(pending.ws, {
      id: pending.id, ok: false,
      error: error ?? 'message enqueue failed',
      errorKind: errorKind ?? 'internal',
    })
  }
  sendOk(ws, id, {})
}

// ── Mobile events relay: walnut server → cloud bridge (reverse direction) ──
// The primary's mobile events feed (src/web/routes/events-v1.ts) pushes slim
// `{kind, data}` frames here; the daemon forwards them verbatim to the cloud
// bridge as `{ev:'mobile-event', ...}` so phones connected to the cloud box
// get the same live feed. Fire-and-forget: no bridge = ack-and-drop (the
// phone's snapshot frame on reconnect heals the gap). Trusted clients only —
// this case is deliberately NOT in BRIDGE_ALLOWED_COMMANDS (a compromised
// cloud box must not be able to inject fake feed events back at itself, and
// the direction is walnut → daemon → bridge, never bridge → daemon).

function cmdMobileEvent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { kind, data } = cmd as { kind?: string; data?: unknown }
  if (typeof kind !== 'string' || !kind) {
    return sendError(ws, id, 'mobile-event: missing kind')
  }
  // The pushing server's own Walnut's link: the home it names, else the one its
  // socket speaks for ('' = an older server's link). Never another Walnut's companion.
  if (walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return sendError(ws, id, 'mobile-event: this socket speaks for another Walnut')
  const link = bridgeLinkFor(walnutScope.askedHome(cmd) || (gatewayClientHomes.get(ws) ?? ''))
  const uplink = link?.adapter ? link.uplink : null
  if (!link || !uplink) {
    return sendOk(ws, id, { relayed: false })
  }
  // Truthful ack: `queued` means paced behind unconfirmed bytes, `relayed:
  // false` means the uplink refused it (closing or over its queue cap).
  const outcome = uplink.send(JSON.stringify({ ev: 'mobile-event', kind, data: data ?? null }))
  sendOk(ws, id, {
    relayed: outcome !== 'dropped',
    queued: outcome === 'queued',
    queuedBytes: uplink.queuedBytes,
    connId: link.connId,
  })
}

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
  if (!walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return false
  logMsg('warn', 'refused: the command names another Walnut than its socket', { what, walnut: walnutScope.label(walnutScope.askedHome(cmd)) })
  sendError(ws, id, `${what}: this socket speaks for another Walnut`, { errorKind: 'not_owner' })
  return true
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
function adoptCommandHome(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>): Record<string, unknown> | null {
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
  if (!HOME_IS_A_PLACE.has(cmd.cmd as string) && refuseMovedHome(ws, cmd, home)) return null
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
 * here (`walnut_home_busy` with where the Walnut is now). True when it was refused.
 */
function refuseMovedHome(ws: ServerWebSocket<WsData>, cmd: Record<string, unknown>, home: string): boolean {
  const refusal = isServerClient(ws) ? walnutScope.refusalOf(home, cmd.walnutId, (h) => leaderBook.recordOf(h)?.walnutId ?? null) : null
  if (!refusal) return false
  const key = walnutScope.keyOf(home)
  const taken = refusal.errorKind === 'walnut_home_taken'
  logMsg('warn', taken ? 'walnut home: refused, another Walnut used this data dir and moved' : 'walnut home: refused, this Walnut moved to another data dir', { cmd: cmd.cmd, walnut: key, home: walnutScope.pathKeyOf(home) })
  sendError(ws, typeof cmd.id === 'number' ? cmd.id : null, `${taken ? 'another Walnut used this data dir here and moved to another one' : 'this Walnut moved to another data dir'}: ${key}`, { errorKind: refusal.errorKind, movedTo: refusal.movedTo }, 'warn')
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
  kept: (home) => followerKept(home),
  // The companion leading takes what the follower refuses for want of a leader: relayed to it on its
  // link, held for the Mac when it takes nothing either (follower-gateway-core.ts askElsewhere).
  leaderElsewhere: (home) => leaderBook.backupLead(home) !== null,
  relayElsewhere: (call, answer, timeoutMs) => forwardToBackup(call.home, call.capability, call.callerSid, call.payload, answer, timeoutMs),
  holdForLeader: (call) => offlineHost.holdWrite(call.home, call.callerSid, call.capability, call.payload) as FollowerGatewayResponse | null,
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

/**
 * This host has a follower for `home` that answers its calls: the fact the gateway routes by, so the
 * daemon's own away answers serve only a host with none (no follower configured, below the floors of
 * core/host-server/eligibility.ts, or turned off by its person: the leader then sends no spec). Its
 * linked socket's word when it is linked; else the spec the leader configured and this daemon keeps
 * (hostServers.answersCalls). Never "linked right now": a follower restarting, or not linked yet
 * after a boot, is still this host's.
 */
function followerKept(home: string | undefined): boolean {
  if (!home) return false
  const ws = followerSockets.get(home)
  if (ws) return ws.data?.answersLocal === true
  return hostServers.answersCalls(home)
}

/**
 * The follower of `home` may answer by `by`: linked (it waits for the leader's quiet window to
 * end), its server starting or running (booting, linking), or restarting before then.
 */
function followerDueBy(home: string, by: number): boolean {
  if (followerSockets.get(home)) return true
  const st = hostServers.status(home)
  return st.state === 'starting' || st.state === 'running' || (st.state === 'retrying' && typeof st.nextRetryAt === 'number' && st.nextRetryAt < by)
}

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
  ownAnswerUsed: () => followerGateway.noteOwnAnswer('trigger_delivery', 'handed_back'),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (level, msg, data) => logMsg(level, msg, data),
})

/** The daemon's own delivery of a fire (follower-trigger-delivery-core.ts `own`): a stopping Demo delivers nothing. */
function deliverFireOwn(fire: TriggerFire): Promise<TriggerDeliveryResult> {
  if (demoQuiesce.fenced) return Promise.resolve({ ok: false, reason: 'demo_stopping' })
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
  socketFor: (home) => { const ws = followerSockets.get(home) ?? followerSockets.get(walnutOfHome(home)); return ws?.data?.answersLocal === true ? ws.data.callSocket : undefined },
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
    sendOk(ws, id, { status: hostServers.configure(home, spec ?? null, { freshLink: freshServerLink(ws) }) })
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
  return offlineHost.ownerOf(callerSid) || sessionHomeOf(callerSid) || undefined
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
function followerScope(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>): boolean {
  const d = followerReads.gate(followerHomeOf(ws), cmd)
  if ('pass' in d) {
    // The handler's answer is cut to this Walnut's scope on its way out (sendOk).
    if (d.scope) followerReads.hold(ws, id, d.scope)
    return false
  }
  if ('answer' in d) sendOk(ws, id, d.answer)
  // An ordinary not_found (the core logged it at info): no 'command error' line.
  else if ('refuse' in d) sendFrame(ws, { errorKind: 'not_found', id, ok: false, error: d.refuse })
  else sendError(ws, id, d.error)
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
  plan: GatewayCallPlan & { ownServerAsked?: boolean; ownAnswerNoted?: boolean; followerBy?: number } = gatewayCallPlan(undefined, gatewayHubTimeoutMs(), Date.now()),
) {
  const home = gatewayOwnerHome(callerSid)
  // Why a server is passed over is logged on a call's first look, not on each look of a wait.
  const target = gatewayTargetFor(home, plan.followerBy === undefined ? { callerSid, op: payload.name } : undefined)
  const deadline = plan.deadline
  // A relayed read this host can answer from its copy does not end in a timeout:
  // nothing is applied twice by reading.
  const readable = !!home && capability === 'tools.call' && offlineHost.hasHome(home) && offlineHost.answersRead(payload.name, home)
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
    if (followerGateway.handOff({ home, capability, callerSid, payload, deadline, readable, fallback, left }, (r) => respond(r as GatewayResponse))) return
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
    if (!home || plan.never || plan.ownServerAsked || !followerKept(home)) return false
    const now = Date.now()
    if (plan.followerBy === undefined && now - (followerWaitMissed.get(home) ?? -Infinity) < FOLLOWER_MISS_HOLD_MS) return false
    const by = plan.followerBy ?? now + FOLLOWER_WAIT_MS
    const room = Math.min(by, deadline - FOLLOWER_WAIT_SPARE_MS) - now
    if (room <= 0 || !followerDueBy(home, now + room)) {
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
    // What this host's follower said: it is linked, or kept here and away.
    const kept = followerKept(home)
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
  call.attempts += 1
  call.readOnly = serverReadsOp(target, call)
  entry.timer = setTimeout(() => relayAttemptEnded(relayId), relayAttemptMs(call.deadline, Date.now(), gatewayHubTimeoutMs()))
  logMsg('info', call.attempts === 1 ? 'gateway: relaying to primary server' : 'gateway: relaying to primary server again', {
    relayId, capability: call.capability, callerSid: call.callerSid, attempt: call.attempts, to: wsId(target),
  })
  // The instance id makes (instance, relayId) unique across daemon restarts: the server runs a relay once by it.
  // `busyAgain`: this host asks a busy call again; it paid its write at its first ask (capability-router.ts).
  // `caller`: the plugin job that made it, the field the follower gets (follower-gateway-core.ts GatewayCaller).
  sendEvent(target, 'gateway-request', {
    relayId, instanceId: DAEMON_INSTANCE_ID, capability: call.capability, callerSid: call.callerSid, payload: call.payload,
    ...(call.busyAgain ? { busyAgain: call.busyAgain } : {}),
    ...(call.caller ? { caller: call.caller } : {}),
  })
}

/** Less time left than this, a relay is not sent again. */
const GATEWAY_RESEND_MIN_MS = 2_000

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
  if (call.readable && call.home) {
    logMsg('info', 'gateway: primary timed out, reading from the copy', { relayId, callerSid: call.callerSid, op: call.payload.name, attempts: call.attempts })
    // The daemon's own answer although this host has a follower: that server's reads go to the same
    // leader while it answers, so it would be as late (replica/dispatch.ts), and it refuses a call
    // while it sees the leader answer (replica/local-calls.ts `leader_answers`). Counted.
    if (followerKept(call.home)) followerGateway.noteOwnAnswer(call.payload.name, 'read_late', call.callerSid)
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
    // A backup leading: neither the leader nor this host's server will take it, so no wait.
    if (caller && !leaderBook.backupLead(home)) {
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
    return sendGatewayRequest(req.op, EXTERNAL_CALLER_SID, call.args, answer, gatewayCallPlan(req.waitMs, gatewayHubTimeoutMs(), Date.now()))
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
    // keyword. GATEWAY_SHIM_DIR is APPENDED to the PATH of a session that reaches
    // its Walnut over HTTP, so on the hub the real npm walnut still wins, and put
    // FIRST for every other session (walnutThroughGateway), where this shim IS the
    // walnut command. The retired `wn` file is removed, not rewritten.
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

// ── ACP session commands (engine=codex etc; see acp-daemon.ts) ──
// sid here is the Walnut runtimeId; journal = STREAMS_DIR/<sid>.acp.jsonl.

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
    if (!journaledIds().has(sid)) journaledSids = null
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
  const home = offlineHost.ownerOf(sid) || sessionHomeOf(sid) || gatewayOwnerHome(EXTERNAL_CALLER_SID) || undefined
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

async function cmdAcpStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const params = cmd as unknown as AcpStartParams
  if (!params.sid || !params.cwd) return sendError(ws, id, 'acpStart: missing sid/cwd')
  // A resumed session's budget learns its new worker before the worker can take a turn.
  if (isJournalSid(params.providerSessionId)) {
    try { await usageBudget.bindRuntime(params.providerSessionId, params.sid) }
    catch (error) { return sendFrame(ws, { id, ok: false, error: 'acpStart: the session budget could not record this worker; not started yet', errorKind: 'budget_checking', code: 'BUDGET_CHECKING' }) }
  }
  // Agent gateway for ACP sessions: same wiring the native `claude` spawn gets.
  // WALNUT_SESSION_ID arrives hub-side (the runtimeId; acp.hasWorker() vouches
  // for it in handleGatewayLine); the daemon owns the socket path and the `walnut`
  // shim dir, so those are injected here, not hub-side. PATH is overridden (not
  // appended in-shell like the native spawn) because ACP workers don't run
  // through the RC-sourcing shell wrapper.
  const taskDir = ensureTaskDir(TASK_DIR_ROOT, (cmd as { taskId?: unknown }).taskId, (cmd as { home?: unknown }).home)
  const throughGateway = walnutThroughGateway(params.env)
  params.env = {
    ...secretsSessionEnv(),
    ...params.env,
    WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
    PATH: sessionPathWithShim(daemonEnv.PATH || '', throughGateway),
    // The task's durable working directory, as for the native spawn (task-dir-core.ts);
    // '' unsets one this daemon inherited (mergeAcpSpawnEnv drops empty values).
    WALNUT_TASK_DIR: taskDir ?? '',
    WALNUT_SECRETS_DIR: SECRETS_ROOT,
    // The page silencer, as for the native spawn (pw-silence-core.ts).
    // An engine's env that names NODE_OPTIONS or BUN_OPTIONS (null or '' = cleared) wins over the daemon's own.
    ...pwSilenceAcpOptions(params.env, await pwSilenceFile()),
    // The address its Walnut named, or none ('' unsets this daemon's own): sessionWalnutApiUrl.
    OPEN_WALNUT_API_URL: sessionWalnutApiUrl(params.env) ?? '',
    // host-call-entry-v1, as for the native spawn ('' unsets): the worker's own WALNUT_SESSION_ID is the caller.
    WALNUT_CALL_SOCKET: '',
    WALNUT_CALL_TOKEN: '',
    ...hostCallTokens.envFor((cmd as { home?: unknown }).home, typeof params.env?.WALNUT_SESSION_ID === 'string' && params.env.WALNUT_SESSION_ID ? params.env.WALNUT_SESSION_ID : params.sid),
  }
  return sessionStartGate.run(params.sid, async () => {
    if (!params.providerSessionId && fs.existsSync(cancelledStartPath(params.sid))) throw new Error('Initial start was cancelled; retry task_start on the same task')
    if (demoQuiesce.fenced) throw new Error('acpStart: Demo is stopping; no new worker starts')
    const resp = await acp.acpStart(ws, params)
    if (resp.ok) sendOk(ws, id, resp.result ?? {})
    else sendFrame(ws, { id, ok: false, error: resp.error, errorKind: resp.errorKind })
  })
}

async function cmdAcpOp(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, op: string) {
  const { sid, ...params } = cmd as { sid?: string; cmd?: string; budgetSid?: string }
  if (!sid) return sendError(ws, id, op + ': missing sid')
  const budgetSid = (params as { budgetSid?: unknown }).budgetSid
  delete (params as Record<string, unknown>).budgetSid
  // A session over its budget takes no new turn (mirrors the Claude FIFO gate). The server
  // names the session a turn belongs to, so a worker started again is gated from its first turn.
  if (op === 'prompt' || op === 'steer') {
    let verdict: BudgetGate = 'budget_checking'
    try {
      if (isJournalSid(budgetSid)) await usageBudget.bindRuntime(budgetSid, sid)
      verdict = budgetGate(await usageBudget.allowRuntime(sid))
    } catch (error) { logMsg('warn', 'budget gate failed; turn held', { sid, error: String(error) }) }
    if (verdict === 'budget_paused') {
      return sendFrame(ws, { id, ok: false, error: 'Not sent: the session budget is paused. Raise or remove the limit to continue.', errorKind: 'budget_paused', code: 'BUDGET_PAUSED' })
    }
    if (verdict === 'budget_checking') {
      return sendFrame(ws, { id, ok: false, error: BUDGET_CHECKING_TEXT, errorKind: 'budget_checking', code: 'BUDGET_CHECKING' })
    }
  }
  delete (params as Record<string, unknown>).cmd
  delete (params as Record<string, unknown>).id
  delete (params as Record<string, unknown>).traceId
  return acp.acpOp(sid, op, params as Record<string, unknown>).then((resp) => {
    if (resp.ok) sendOk(ws, id, { result: resp.result })
    else sendFrame(ws, { id, ok: false, error: resp.error?.message ?? 'acp op failed', errorKind: resp.error?.kind })
  })
}

function cmdAcpStop(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid?: string }
  if (!sid) return sendError(ws, id, 'acpStop: missing sid')
  return acp.acpStop(sid).then(() => sendOk(ws, id, { stopped: true }))
}

function cmdAcpSubscribe(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, fromOffset } = cmd as { sid?: string; fromOffset?: number }
  if (!sid) return sendError(ws, id, 'acpSubscribe: missing sid')
  const ok = acp.subscribe(ws, sid, typeof fromOffset === 'number' ? fromOffset : 0)
  if (ok) sendOk(ws, id, { subscribed: true })
  else sendFrame(ws, { id, ok: false, error: 'no live ACP worker for ' + sid, errorKind: 'no_worker' })
}

function cancelledStartPath(sid: string): string {
  return path.join(DAEMON_DIR, 'cancelled-starts', Buffer.from(sid).toString('hex'))
}

async function cmdCancelPendingStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid
  if (typeof sid !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(sid)) return sendError(ws, id, 'cancelPendingStart: invalid sid')
  return sessionStartGate.run(sid, async () => {
    if (acp.hasWorker(sid)) return sendOk(ws, id, { cancelled: false, alive: true })
    const session = sessions.get(sid)
    if (session?.state === 'running' && session.pid) {
      try {
        process.kill(session.pid, 0)
        return sendOk(ws, id, { cancelled: false, alive: true, pid: session.pid })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const file = cancelledStartPath(sid)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, '', { flag: 'a', mode: 0o600 })
    return sendOk(ws, id, { cancelled: true, alive: false })
  })
}

// ── Start a Claude session ──
async function cmdStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid as string
  if (!sid) return sendError(ws, id, 'start: missing sid')
  // A start's long arguments may come by hash (start-arg-refs-v1, cli-argv-files-core.ts): put
  // them back from this host's copies, and keep copies of what came in full.
  if (cmd.argRefs === true && Array.isArray(cmd.args)) {
    const refs = cliArgvFiles.resolveRefs(cmd.args.map(String))
    if (refs.missing.length) {
      logMsg('info', 'start: no copy of some arguments, asked for them in full', { sid, missing: refs.missing.length })
      return sendOk(ws, id, { ok: false, code: 'ARG_REFS_MISSING', missingRefs: refs.missing, error: 'start: this host has no copy of some of its arguments; send them in full' })
    }
    cmd = { ...cmd, args: refs.args }
    cliArgvFiles.rememberRefs(refs.args)
  }
  const stopVersion = sessionStopVersions.get(sid) ?? 0
  const current = () => (sessionStopVersions.get(sid) ?? 0) === stopVersion
    && (!cronRuntime || (cronRuntime.deliveryAllowed(sid, cmd.stopFence) && (cmd.autoRetry !== true || !cronRuntime.get(sid))))
  const result = await sessionStartGate.run(sid, () => {
    if (!cmd.resume && fs.existsSync(cancelledStartPath(sid))) throw new Error('Initial start was cancelled; retry task_start on the same task')
    if (!current()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
    return startSessionProcess(cmd, undefined, current)
  })
    .catch((error) => {
      if (error?.code === 'SESSION_STOP_SUPERSEDED') return null
      // A host that cannot run claude answers with the reason itself, not an
      // "internal daemon error".
      if (error?.code === 'BUDGET_PAUSED') return Object.assign(error as Error, { errorKind: 'budget_paused' })
      if (error?.code === 'BUDGET_CHECKING') return Object.assign(error as Error, { errorKind: 'budget_checking' })
      if (error?.code === 'CLAUDE_RUNTIME') return error as Error & { errorKind?: string }
      // Another CLI of this session runs on this host (cli-owner-core.ts).
      if (error?.code === 'SESSION_LIVE' || error?.code === 'SESSION_NOT_OURS') return error as Error & { errorKind?: string }
      throw error
    })
  if (!result) return sendOk(ws, id, { ok: false, reason: 'session_stopped', error: 'start: a stop request superseded this start' })
  if (result instanceof Error) return sendError(ws, id, result.message, { errorKind: result.errorKind, ...(result.errorKind === 'budget_paused' ? { reason: 'budget_paused', code: 'BUDGET_PAUSED' } : result.errorKind === 'budget_checking' ? { reason: 'budget_checking', code: 'BUDGET_CHECKING' } : result.errorKind === 'session_live' ? { reason: 'session_live', code: 'SESSION_LIVE' } : result.errorKind === 'session_other_walnut' ? { reason: 'session_other_walnut', code: 'SESSION_NOT_OURS' } : {}) })
  addSubscriber(ws, sid, result.offset)
  return sendOk(ws, id, result)
}

/**
 * Resolve how to launch the CLI, or throw the precise reason it cannot run
 * (error code CLAUDE_RUNTIME, errorKind claude_missing | claude_needs_node).
 * The spawn shell gets a second opinion before a refusal: its rc files may
 * reach a claude or node the daemon PATH does not, and such a spawn must still
 * start. When a node dir is prepended, the RESOLVED claude path runs, so the
 * prepended dir cannot shadow the user's claude with another copy.
 */
async function gateClaudeLaunch(args: string[], shellSetupFile: string): Promise<{ args: string[]; nodeDir?: string }> {
  const command = args[0] || 'claude'
  const gate = await hostRuntime.ensureClaude(command, daemonEnv.PATH || '')
  if (gate.ok) {
    return gate.nodeDir ? { args: [gate.path, ...args.slice(1)], nodeDir: gate.nodeDir } : { args }
  }
  // An absolute node in the shebang cannot be supplied by the shell either.
  if (!gate.fixedInterpreter) {
    const seen = await hostRuntime.shellCanRun(sessionShell(), buildSpawnPreamble({ shellSetupFile }), command)
    if (gate.code === 'claude_missing' ? seen.hasCmd : seen.hasNode) return { args }
  }
  logMsg('warn', 'spawn gate: claude cannot run on this host', { code: gate.code, command })
  throw Object.assign(new Error(gate.message), { code: 'CLAUDE_RUNTIME', errorKind: gate.code })
}

async function startSessionProcess(cmd: Record<string, unknown>, isCurrent?: () => boolean, canStart?: () => boolean) {
  // A template's hook texts (hook-files-v1) go back into its settings: the registry keeps the inline
  // form an older daemon re-spawns after a rollback (cli-argv-files-core.ts inlineArgs).
  if (Array.isArray(cmd.args)) cmd = { ...cmd, args: cliArgvFiles.inlineArgs(cmd.args.map(String)) }
  const { sid, args, cwd, message, resume, mode, uuid } = cmd as {
    sid: string; args: string[]; cwd: string; message?: string; resume?: boolean
    mode?: string
    /** Optional pre-assigned v4 uuid for the INITIAL message's user line. Absent
     *  on every older client ⇒ envelope unchanged. */
    uuid?: string
  }
  const initialUuid = typeof uuid === 'string' && uuid ? uuid : undefined
  // An empty message only resumes the process without injecting a user turn; the CLI may not send init until a schedule fires.
  if (!isJournalSid(sid) || !args || !cwd) throw new Error('start: missing required fields (sid, args, cwd)')
  await requireBudgetAllowance(sid)
  if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
  if (isCurrent && !isCurrent()) throw new Error('start: supervision request was superseded')
  // Every native start comes here (commands, turn retries, host resumes, offline asks).
  if (demoQuiesce.fenced) throw new Error('start: Demo is stopping; no new session starts')

  // Validate cwd exists before spawning — prevents misleading ENOENT on /bin/bash
  // when the real issue is a non-existent working directory (e.g. local Mac path
  // sent to a remote Linux host).
  if (!fs.existsSync(cwd)) {
    throw new Error(`start: cwd does not exist on this host (${os.hostname()}): ${cwd}`)
  }

  // If a session with this sid already exists (e.g. adopted orphan still
  // running, or previous turn's process not yet reaped), clean it up BEFORE
  // overwriting sessions.set() below. Otherwise the old orphanPollTimer's
  // captured pid lingers and will misfire `pid-recycled` against our new pid
  // ~1s after spawn, killing every --resume-spawned process in a loop.
  const existing = sessions.get(sid)
  if (isCurrent && existing?.pid && existing.bootId === daemonBootId) {
    try {
      process.kill(existing.pid, 0)
      if (existing.state !== 'running') throw new Error('start: an unadopted process may still own this session')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  if (existing) {
    // Live-adopt guard: a resume-with-message against a STILL-RUNNING CLI means
    // the caller lost track of the process (walnut restart race, stale hasPipe),
    // not that the process needs replacing. Killing it here aborts whatever the
    // CLI is doing mid-turn (observed: a 369K-token compaction). Deliver the
    // message to the live FIFO and adopt instead — exactly what cmdSend would
    // have done had the caller known the process was alive. An explicit restart
    // (reinitialize) sends message='' and still takes the respawn path below.
    if (resume && (message || cmd.deferMessage === true || isCurrent) && existing.state === 'running' && existing.pid) {
      let oldAlive = false
      try { process.kill(existing.pid, 0); oldAlive = true } catch (error) {
        if (isCurrent && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      if (oldAlive) {
        if (isCurrent && (!existing.startTime || existing.startTime !== await readStartTimeAsync(existing.pid))) {
          throw new Error('start: live process identity is unknown')
        }
        // Live-adopt: the start's initial message is delivered through the FIFO
        // instead of a respawn, so it must carry the same pre-assigned uuid.
        // A deferred delivery is not a restart: adopt first, and the ordered send writes the body afterwards.
        const sendResult = message
          ? await core.handleSendCommand(sid, message, initialUuid)
          : { ok: true } as const
        if (sendResult.ok) {
          if (mode) existing.mode = mode as SessionMode
          // Hand out a COMPLETE-line boundary, never a raw stat().size: this
          // value becomes the client's cursor AND addSubscriber's replay start,
          // and a mid-line start fans a JSON fragment to the client (contract §4
          // boundary rule). The live watcher already publishes the boundary.
          const curSize = existing.watcher ? existing.watcher.offset : statSizeOrZero(existing.jsonlPath)
          logMsg('info', 'cmdStart: adopted live session — message delivered via FIFO, respawn skipped', {
            sid, pid: existing.pid, offset: curSize,
          })
          ensureWatcher(sid)
          return { pid: existing.pid, outputFile: existing.jsonlPath, offset: curSize, adopted: true }
        }
        if (sendResult.reason === 'budget_paused' || sendResult.reason === 'budget_checking') throw budgetRefusal(sendResult.reason)
        // Delivery failed. Only fall through to respawn if handleSendCommand
        // actually reaped the session (ENXIO / precheck-dead / partial-write).
        // A transient EAGAIN (pipe full, process alive) must NOT kill the CLI —
        // fail the start; the message stays queued and the caller retries.
        const afterSend = sessions.get(sid)
        if (afterSend && afterSend.state === 'running') {
          logMsg('warn', 'cmdStart: live-adopt delivery failed but process alive — refusing respawn', {
            sid, pid: existing.pid, reason: sendResult.reason ?? sendResult.error,
          })
          throw new Error(`start: session ${sid} is alive but FIFO delivery failed (${sendResult.reason ?? sendResult.error}); retry send`)
        }
        logMsg('warn', 'cmdStart: live-adopt delivery failed — falling back to respawn', {
          sid, reason: sendResult.reason ?? sendResult.error,
        })
      }
    }
  }

  // Spawn gate: name the exact reason a CLI cannot start (not installed, or the
  // npm build with no working node) instead of an exit 127 after the spawn.
  // It runs BEFORE the replaced session is torn down: a refusal must leave a
  // live CLI exactly as it was, never killed and replaced by nothing.
  const shellSetupFile = shellSetupOfStart(cmd, sid)
  // The login shell sessionShell() picks comes from passwd, read ahead at the runtime's start.
  await passwdReady()
  const launch = await gateClaudeLaunch(args, shellSetupFile)
  await requireBudgetAllowance(sid)
  if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })

  // One CLI per session id on this host, whichever daemon asks (cli-owner-core.ts):
  // a live CLI of this transcript that is not the one replaced below, or another
  // daemon's spawn in flight, refuses the start. Before the teardown, so a refusal
  // leaves everything as it was.
  const ownedSid = cliOwner.transcriptIdOf(args)
  const replacedPid = existing && existing.state === 'running' && existing.pid ? existing.pid : undefined
  const askingHome = (cmd.origin as { home?: unknown } | undefined)?.home
  const ownerHome = typeof askingHome === 'string' && askingHome ? askingHome : undefined
  // A resume by its args too, whatever the flag says (a fork is a new transcript).
  const resumesTranscript = !!resume || (args.includes('--resume') && !args.includes('--fork-session'))
  const notOurs = ownedSid ? strictStartRefusal(ownedSid, cmd, ownerHome, resumesTranscript) : null
  if (notOurs) throw notOurs
  // An archived transcript comes back plain before the CLI resumes it, or forks it: the source a
  // fork reads is its --resume id, not the new transcript it owns (transcript-archive.ts). A fresh
  // start under an id is checked the same way: history of that id archived here and not brought
  // back (remote storage refused) refuses the start, never a new conversation in its place.
  const archivedSource = resumeSourceId(args) ?? ownedSid
  if (archivedSource) await restoreForStart(CLAUDE_PROJECTS_DIRS, archivedSource)
  // A start that a stop or a newer supervision request overtook ends here.
  const superseded = () => (!!canStart && !canStart()) || (!!isCurrent && !isCurrent())
  const stopIfSuperseded = () => {
    if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
    if (isCurrent && !isCurrent()) throw new Error('start: supervision request was superseded')
  }
  // A resumed stream is folded once before the transcript is claimed: a big
  // file without a checkpoint folds for longer than a claim may sit
  // unconfirmed (cli-owner-core.ts CLAIM_TTL_MS), and the fold below then
  // reads only what this one's checkpoint left (stream-fold-core.ts).
  if (resume) {
    await streamFold.foldFile(path.join(STREAMS_DIR, sid + '.jsonl'), Date.now(), { aborted: superseded })
    stopIfSuperseded()
  }

  const ownerClaim = ownedSid ? await cliOwner.claim(ownedSid, { exceptPid: replacedPid, home: ownerHome }) : null
  let ownerCommitted = false
  try {

  if (existing) {
    logMsg('warn', 'cmdStart: replacing existing session', {
      sid,
      oldPid: existing.pid,
      oldState: existing.state,
      oldHasOrphanPoll: !!existing.orphanPollTimer,
      resume: !!resume,
    })
    if (existing.orphanPollTimer) {
      try { clearInterval(existing.orphanPollTimer) } catch {}
      existing.orphanPollTimer = null
    }
    // Stop the old session's watcher BEFORE sessions.set() replaces the entry.
    // The poll timer looks up sessions.get(sid) fresh each tick — once the new
    // session lands under the same sid (state='running'), the old timer passes
    // the state guard and tails the same jsonl at its own closure offset:
    // TWO watchers fanning every line twice (doubled blocks after respawn),
    // and the old timer leaks forever because nothing else clears it.
    stopSessionWatcher(sid)
    // If the old pid is still alive, kill its process group. This is the old
    // adopted orphan; we must not leave it running while we point `sessions`
    // at a different pid, or the orphan becomes permanently un-reapable.
    if (existing.state === 'running' && existing.pid) {
      let oldAlive = false
      try { process.kill(existing.pid, 0); oldAlive = true } catch {}
      if (oldAlive) {
        logMsg('warn', 'cmdStart: killing old-session process group before respawn', {
          sid, oldPid: existing.pid,
        })
        killProcessGroup(existing.pid, 'SIGTERM')
      }
    }
    // Mark dead so any late callbacks (subscribers, watchers) don't act on it.
    const stoppedPid = existing.state === 'running' ? existing.pid : null
    existing.state = 'dead'
    existing.exitReason = 'replaced-by-cmdstart'
    existing.exitedAt = Date.now()
    // The new CLI must not start on the transcript while the old one still writes it.
    if (stoppedPid && !await waitForStoppedProcess(stoppedPid)) {
      throw new Error(`start: the previous CLI of this session (pid ${stoppedPid}) has not exited; not starting a second one`)
    }
  }

  fs.mkdirSync(STREAMS_DIR, { recursive: true })
  // Journal the id now when the args name it; a new or forked session's id is
  // journaled from its init line (the tailer below).
  const spawnInfo = spawnInfoFor(args, cwd, !!resume, (cmd as Record<string, unknown>).origin)
  appendSpawnJournal(namedSessionId(args), spawnInfo)
  // The task's durable working directory: made here, on the host the session
  // runs on, and handed to the CLI as WALNUT_TASK_DIR. A supervision respawn
  // carries no origin, so the task comes from the resume record.
  const resumeRec = spawnInfo.task ? null : hostResume.recall(sid)
  const taskDir = ensureTaskDir(TASK_DIR_ROOT, spawnInfo.task ?? resumeRec?.task, spawnInfo.home ?? resumeRec?.home)

  const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  const stderrPath = jsonlPath + '.err'
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')

  // Record offset before spawn (for resume — only stream new data).
  // C1: on resume the fold is rebuilt from the surviving jsonl, and the watcher
  // offset comes from THAT rebuild's complete-line boundary — never a raw
  // stat().size, which can sit mid-line if the previous CLI died mid-write
  // (contract §4 "Rebuild boundary rule").
  let offset = 0
  let resumeFold: StreamFoldResult<FoldState, TaskState> | null = null
  if (resume) {
    // Async, so every other session keeps its daemon while a big file folds
    // (from the checkpoint the fold before the claim left). A file over the
    // cap is then left for a fresh one (stream-fold-core.ts).
    resumeFold = await streamFold.foldFile(jsonlPath, Date.now(), { aborted: superseded })
    offset = resumeFold.boundary
    stopIfSuperseded()
    const rotation = streamWriterGone(sid) ? await streamFold.rotateReason(jsonlPath, ownedSid, CLAUDE_PROJECTS_DIRS, resumeFold.fold) : null
    stopIfSuperseded()
    if (rotation && streamFold.rotate(jsonlPath, [foldCheckpoint.pathFor(jsonlPath), foldCheckpoint.nextPathFor(jsonlPath), streamCompact.markPathFor(jsonlPath)], resumeFold ? resumeFold.fold : null)) {
      logMsg('info', 'stream rotated', { sid, bytes: rotation.size })
      // The dead process's turn and background tasks went with it.
      resumeFold = null
      offset = 0
    }
  }

  // The FIFO, the stream and the stderr log the CLI starts on (session-spawn-files.ts): made and
  // opened asynchronously, the stream O_APPEND (the daemon appends its marker lines too), a fresh
  // start's stream a new inode (a new streamEpoch: the 019a7fe5 class).
  const { pipeFd, outputFd, stderrFd, cronStartOffset, stderrStartOffset } = await prepareSpawnFiles({
    fs,
    execFile: (file, args, options, callback) => execFile(file, args, options, (error) => callback(error)),
    lockFifo: (p) => lockLiveFifo(fs, p),
    discardCheckpoint: (p) => foldCheckpoint.discard(p),
    warn: (msg, data) => logMsg('warn', msg, data),
  }, { sid, pipePath, jsonlPath, stderrPath, resume: !!resume, checkCurrent: stopIfSuperseded })
  const cronStartedAt = Date.now()

  // Spawn Claude through the user's shell, its rc file and the host's shell_setup, to activate
  // nvm/pyenv/volta and the sign-in variables they set, even on hosts where nvm binaries need a
  // newer GLIBC than the system provides.
  const preamble = buildSpawnPreamble({ nodeDir: launch.nodeDir, gatewayFirst: walnutThroughGateway(settingsEnvOf(launch.args)), shellSetupFile })
  // Content arguments go to files: the shell's and the CLI's argv carry paths (cli-argv-files-core.ts).
  const escapedArgs = cliArgvFiles.toFiles(launch.args).map((a: string) => shellQuote(a)).join(' ')
  const shellCmd = `${preamble}; exec ${escapedArgs}`

  // Use the user's actual shell to spawn sessions. Hardcoding /bin/bash caused
  // .zshrc to be sourced from bash (via the preamble's `case "$SHELL"`), which
  // fails or partially executes — zsh-specific syntax errors are silently
  // swallowed by `2>/dev/null`, but PATH modifications before the error point
  // can clobber the inherited PATH, losing /usr/bin and other system dirs.
  // Using $SHELL ensures RC files are sourced by the correct shell interpreter.
  // Empirical verification: bash -c 'source .zshrc' on clouddev produces 0 /usr/bin
  // matches, while zsh -c 'source .zshrc' produces 2 matches, proving the bug.
  const userShell = sessionShell()
  // CLAUDE_CODE_MAX_RETRIES: harden against upstream Bedrock degradation windows.
  // Forensics found degradation windows of 10-103 min; the CLI's default 10 API
  // retries only cover a ~3min budget, so a turn dies with "Request timed out"
  // mid-outage. The persistent-retry env (CLAUDE_CODE_UNATTENDED_RETRY) is compiled
  // OUT of external CLI builds, so we raise the finite retry ceiling instead.
  // Retries past 10 back off ~35s each, so 60 covers roughly a 30-min outage.
  // Precedence: respect an explicit process-env override; else WALNUT_CLI_MAX_RETRIES;
  // else default '60'.
  const cliMaxRetries =
    daemonEnv.CLAUDE_CODE_MAX_RETRIES ?? daemonEnv.WALNUT_CLI_MAX_RETRIES ?? '60'
  const spawnOptions = {
    detached: true,
    stdio: [pipeFd, outputFd, stderrFd] as [number, number, number],
    cwd: cwd,
    // MCP_CONNECTION_NONBLOCKING=1 makes the CLI emit its `init` event immediately
    // instead of blocking up to 5s for MCP servers to connect (they keep connecting
    // in the background). This is the dominant time-to-init cost for Walnut sessions:
    // measured ~6.9s → ~2.9s with no loss of MCP functionality. The CLI only honors
    // this via env (no CLI flag); the daemon's spawn env is the single inject point.
    // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1: opt into the authoritative
    // session_state_changed (running/idle/requires_action) stream events. idle is
    // the only reliable turn-over signal; a dynamic-workflow turn emits MANY result
    // events (one per background subagent finishing), so result is NOT a turn
    // boundary.
    //
    // We intentionally DO NOT set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: background
    // Bash tasks (run_in_background) are a useful capability and there's no reason to
    // amputate them. The original orphan-process worry doesn't hold: the CLI is
    // spawned detached (pid === PGID) and reapSession() kills the whole process group
    // (SIGTERM→SIGKILL), so any background shell is cleaned up with the CLI. Verified
    // by live capture that enabling it leaves the running→idle turn-completion signal
    // intact.
    // CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1: the CLI takes a file checkpoint
    // per user message ONLY when file history is enabled, and in non-interactive
    // (print) mode that is gated behind this env var alone — no CLI flag exists.
    // It is what makes Rewind's file half possible (rewind_files control_request,
    // see core/sessions/session-rewind.ts); without it every rewind answers "File
    // rewinding is not enabled." Backups are hardlinked and capped at 100
    // snapshots per session by the CLI, so the disk cost is bounded.
    // WALNUT_DISABLE_FILE_CHECKPOINTS=1 on the daemon opts a host out.
    env: {
      ...daemonEnv,
      // The secrets the user let this host's sessions have (secrets-core.ts), before
      // every Walnut variable so none of those can be replaced.
      ...secretsSessionEnv(),
      // The shell it starts in (sessionShell), so the CLI's Bash tool runs the same one.
      SHELL: userShell,
      MCP_CONNECTION_NONBLOCKING: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      // line-answer-v1: Walnut sends a line Claude Code took and never answered once more
      // itself; the CLI's own auto-resume of that turn (an empty value is off) would answer
      // it twice. Keep in sync with the other twin.
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '',
      CLAUDE_CODE_MAX_RETRIES: cliMaxRetries,
      // Its unattended retry mode (CLAUDE_CODE_RETRY_WATCHDOG, a user setting) otherwise retries
      // with no limit while the session reads Running: the same bound as every engine (engine-turn-watch.ts).
      ...claudeRetryEnv(daemonEnv),
      ...(daemonEnv.WALNUT_DISABLE_FILE_CHECKPOINTS === '1'
        ? {}
        : { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' }),
      // Agent gateway (peer sessions): the `walnut` CLI inside this session reads
      // these two to reach the on-host gateway socket. The sid may be a fresh
      // spawn's tmp id — gatewaySidAliases (cmdRename) resolves it to the
      // current sid on every request.
      WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
      WALNUT_SESSION_ID: sid,
      // host-call-entry-v1: this host's own Walnut server's call entry socket and this run's token,
      // when its follower said a socket (hostCallTokens.envFor); unset otherwise, never inherited.
      WALNUT_CALL_SOCKET: undefined,
      WALNUT_CALL_TOKEN: undefined,
      ...hostCallTokens.envFor(walnutOfHome(spawnInfo.home ?? resumeRec?.home ?? ''), sid),
      // Unset when the task has none, so a value this daemon inherited (it was
      // started from inside a session) never names another task's directory.
      WALNUT_TASK_DIR: taskDir ?? undefined,
      // Where the secrets the user shared with this host are, one file each.
      WALNUT_SECRETS_DIR: SECRETS_ROOT,
      // The address its Walnut named in its settings, or none (never this daemon's own):
      // sessionWalnutApiUrl.
      OPEN_WALNUT_API_URL: sessionWalnutApiUrl(settingsEnvOf(launch.args)),
      // The page silencer, first in NODE_OPTIONS (pw-silence-core.ts).
      ...pwSilenceOptions(daemonEnv.NODE_OPTIONS, daemonEnv.BUN_OPTIONS, await pwSilenceFile()),
      // Never let OUR watchdog pid leak into the CLI's env. A CLI session that
      // runs `npm run dev:prod` would otherwise hand this stale pid to the
      // PRODUCTION daemon, whose watchdog would trip on the long-dead pid and
      // (with the isolated-dir reap) kill live prod sessions. Same env-carrier
      // chain as the VITEST_* leak.
      WALNUT_DAEMON_PARENT_PID: undefined,
      // Same for the keep-sessions switch (the cloud tunnel daemon's): it is this
      // daemon's own exit policy, and a CLI that starts a daemon of its own must
      // not hand it on.
      WALNUT_DAEMON_KEEP_SESSIONS: undefined,
      // And the service state dir: a daemon a CLI starts (a test, a sandbox) is isolated,
      // and with this var it could reach the service daemon's journals and state.
      WALNUT_DAEMON_STATE_DIR: undefined,
      // A test server's isolated daemon (remote-isolation.ts) is this daemon's own identity: a
      // daemon a CLI starts (a nested test server's) must not claim it. Keep in sync with the twin.
      WALNUT_DAEMON_ISOLATED_FOR: undefined,
      WALNUT_DAEMON_ORPHAN_EXIT_MS: undefined,
      WALNUT_INSTALL_HOME: undefined,
      // And the compiled file's runtime dir (src/binary/runtime-tree.ts): it names the
      // SERVING stage's runtime/, which a later deploy deletes. A walnut CLI the session runs
      // would unpack there or, after that deploy, mkdir it back inside a dead stage; without
      // it a compiled walnut uses its own default tree. A service set's own dir stays: it is
      // its install root's, which no deploy deletes, and without it every `walnut` of the
      // set's sessions unpacked into, and pruned, the default Walnut's data home.
      WALNUT_RUNTIME_DIR: SESSION_RUNTIME_DIR,
    },
  }
  let barrier: ReturnType<typeof spawnBehindRegistry> | null = null
  let proc: ReturnType<typeof spawn>
  try {
    // Last synchronous point before the CLI exists: a fence set during the awaits above wins.
    if (demoQuiesce.fenced) throw new Error('start: Demo is stopping; no new session starts')
    barrier = SERVICE_MODE ? spawnBehindRegistry(userShell, ['-c', shellCmd], spawnOptions, childUse) : null
    // Every launch is issued here, synchronously after the fence read. Inside another program the
    // pool's thread starts it (spawn-pool.ts posts the request at once) and its pid comes back after.
    const launched = barrier?.process
      ?? (spawnPool ? spawnPool.spawnDetached(userShell, ['-c', shellCmd], spawnOptions) : spawn(userShell, ['-c', shellCmd], spawnOptions))
    proc = launched instanceof Promise ? containListeners(await launched, runtimeTimers.contain) as unknown as ReturnType<typeof spawn> : launched
  } catch (error) {
    fs.closeSync(pipeFd); fs.closeSync(outputFd); fs.closeSync(stderrFd)
    throw error
  }
  try {
  // Detect spawn failure immediately — proc.pid is undefined when posix_spawn fails.
  // This catches cwd-doesn't-exist, shell-not-found, and other synchronous spawn errors
  // BEFORE we send ok:true back to the client.
  if (!proc.pid) {
    logMsg('error', 'spawn failed: no PID (likely bad cwd or missing shell)', { sid, cwd })
    // Clean up files we just created
    try { fs.closeSync(pipeFd) } catch {}
    try { fs.closeSync(outputFd) } catch {}
    try { fs.closeSync(stderrFd) } catch {}
    try { fs.unlinkSync(pipePath) } catch {}
    if (!resume) {
      try { fs.unlinkSync(jsonlPath) } catch {}
      try { fs.unlinkSync(stderrPath) } catch {}
    }
    // Drain the async error event to prevent unhandled rejection
    proc.on('error', () => {})
    throw new Error(`spawn failed: process could not start on ${os.hostname()} (cwd: ${cwd})`)
  }
  // line-answer-v1: where this process's output begins, so a line an earlier process
  // took is never answered by this one's output (line-fate-core.ts lineFateScan). Silent
  // (no words, no uuid, no session_id). Written before the CLI boots. walnutTurn: this process starts on the message below: the fold
  // counts the turn as open from here, not from the init the CLI prints once it booted
  // (daemon-fold.ts; 2026-11-05: a 25s boot read as an ended turn). Not for a
  // deferMessage start (its line may never be written; its send's marker anchors),
  // nor for a resume (the CLI may skip a line its transcript already has, by its uuid).
  const turnOnSpawn = typeof message === 'string' && message.length > 0 && !resumesTranscript
  try { fs.writeSync(outputFd, JSON.stringify({ type: 'system', subtype: 'walnut_process', walnutPid: proc.pid, ...(turnOnSpawn ? { walnutTurn: true } : {}) }) + '\n') } catch {}

  // Handle late spawn errors (shouldn't happen after pid is set, but defensive)
  proc.on('error', (err) => {
    logMsg('error', 'spawn error (post-start)', { sid, error: err.message })
  })

  // Write initial message to FIFO — only when one was provided. An empty message
  // means "spawn idle" (restart-to-reinitialize): the CLI still opens stdin and
  // emits its init event, but runs no turn. We keep the pipeFd open across the
  // O_RDWR lifetime like the send path, so the FIFO survives until the first real
  // message; closing it here (as the message path does after writing) is fine
  // because the CLI already holds its own read end.
  // Deliver only after registry ownership exists, through the guarded FIFO serializer.
  fs.closeSync(pipeFd)

  // Close fds in parent
  fs.closeSync(outputFd)
  fs.closeSync(stderrFd)

  // Save PID
  const pid = proc.pid
  proc.unref()
  try { fs.writeFileSync(pgidPath, String(pid)) } catch {}

  logStateTransition(sid, 'none', 'running', resume ? 'spawn-resume' : 'spawn-fresh', 'cmdStart', { pid })
  logMsg('info', 'session started', { sid, pid, resume: !!resume })

  // Track session
  const sessionData: SessionData = {
    proc,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    offset,
    // Fresh spawn → empty; resume → the fold of the existing jsonl (its tasks may still be live).
    taskState: resumeFold ? resumeFold.task : emptyTaskState(),
    // C1: fresh spawn (or a rotated file) starts an empty fold; resume folds the surviving jsonl.
    foldState: resumeFold ? resumeFold.fold : initialFoldState(0),
    foldCheckpointV: resumeFold ? resumeFold.checkpointV : undefined,
    watcher: null,
    subscribers: new Subscribers(),
    exitCode: null,
    state: 'running',
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: readStartTime(pid),
    bootId: daemonBootId,
    cwd,
    args,
    orphanPollTimer: null,
    mode: (mode as SessionMode) || 'default',
    pendingCtrl: null,
    cronMetadataLoaded: !resume,
    spawnTs: Date.now(),     // latency instrumentation: CLI spawn → first init line
    sawInit: false,
    spawnInfo,
  }

  ownerClaim?.commit(pid, sessionData.startTime)
  ownerCommitted = true

  proc.on('exit', runtimeTimers.contain('session exit handler', (code: number | null) => {
    // SIGCHLD is the fastest (near-0ms) death signal for parented sessions.
    // All cleanup funnels through reapSession so the exit path, missed-exit
    // fallback, and cmdSend-ENXIO path all produce the same side effects.
    //
    // Generation guard: if cmdStart REPLACED this sid (killing this process),
    // the map now holds the replacement session. reapSession(sid) re-resolves
    // by sid, so without this check the OLD process's death reaps the NEW
    // session ~100ms after its spawn (observed live: respawn under the same
    // sid died instantly with "proc-exit code 1").
    if (sessions.get(sid) !== sessionData) return
    reapSession(sid, code ?? 1, 'proc-exit')
  }))

  // What this process writes starts here (reapSession reads only that).
  sessionData.outputStartOffset = cronStartOffset
  sessionData.stderrStartOffset = stderrStartOffset
  sessionData.cronMetadataOrigin = { identity: cronProcess(sessionData).identity, offset: cronStartOffset, startedAt: cronStartedAt, fresh: !resume }
  sessions.set(sid, sessionData)
  // The command to start it again with, for a host resume (host-resume-core.ts).
  hostResume.remember(sid, { args, cwd, mode: sessionData.mode, home: spawnInfo.home, task: spawnInfo.task })
  // The tree before this session's first recorded turn, when it has none yet.
  try { turnSnapshots.onTurnStart(sid, cwd) } catch { /* never the spawn's problem */ }
  cronMetadata.configure(sid, cronProcess(sessionData), cronMetadataConfig)
  cronMetadata.state(sid, cronProcess(sessionData), false, !resume)
  // Write-ahead: flush registry before returning ok to caller so a crash-after-
  // spawn doesn't orphan the CLI without daemon knowledge. Awaited: the write
  // runs off the thread, the answer waits for it.
  try { await persistRegistryDurable() } catch (error) {
    if (SERVICE_MODE) throw error
  }

  await requireBudgetAllowance(sid)
  barrier?.release()
  broadcastSessionState(sid, 'running', { pid })
  ensureWatcher(sid)
  if (message) {
    // bootWait (send-boot-wait-v1): the client waits long enough for a CLI still booting.
    const sent = await core.handleSendCommand(sid, message, initialUuid, undefined, { bootWait: cmd.bootWait === true })
    if (sent.reason === 'budget_paused' || sent.reason === 'budget_checking') throw budgetRefusal(sent.reason)
    if (!sent.ok) throw new Error(`start: initial message not delivered (${sent.reason ?? sent.error})`)
  }
  return { pid, outputFile: jsonlPath, offset }
  } catch (error) {
    barrier?.abort()
    throw error
  }
  } catch (error) {
    if (!ownerCommitted) await ownerClaim?.release()
    throw error
  }
}

// ── File watching for JSONL streaming ──
//
// Lifecycle: session-bound (NOT ws-bound). One poll timer per session reads
// the JSONL and fans new lines out to every currently-subscribed ws. ws
// connect/disconnect does not affect the watcher. See the SessionData
// interface comment for the full rationale.

// Idempotent: if the session already has a watcher, does nothing.
// ── Scheduled-task (CLI cron) fire detection ──
// A cron fire in headless mode delivers its prompt STRAIGHT to the model —
// nothing appears in the stream-json stdout except a bare turn start
// (session_state_changed{running} + init), so neither the Mac nor the UI can
// see it happened. The daemon is the only component with the cwd + the files,
// so it checks {cwd}/.claude/scheduled_tasks.json on turn-start lines
// (30s-throttled) and, when a recently-fired task was created by a DIFFERENT
// session (directory-scoped lock adoption — upstream #50300/#66509):
//   1. appends a scheduled_task_fire system marker to the stream file
//      (history + live UI render it), and
//   2. injects a provenance warning into the FIFO so the MODEL knows the
//      prompt is an adopted cron, not the human.
// Same-session fires get only the marker (normal /loop operation).
const CRON_CHECK_THROTTLE_MS = 30_000

// ── Daemon hooks (daemon-hooks.ts): the declarative rules each Walnut pushes ──
const hooks = createDaemonHooks({ daemonEnv, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, walnutScope, gatewayClientHomes, sessionHomeOf, logMsg, sendOk, sendError })
const { hookActions, HOOKS_DIR, daemonHooksByHome, loadDaemonHooksAtBoot, persistedHooksHashFor, handoverHooks } = hooks

// ── walnut-trigger: the daemon owns the clock and runs the check; clock routines (clock-routine-v1) ──
// The store (daemon-trigger-store.ts), the runs and the clock (daemon-trigger-runs.ts), the set
// (daemon-trigger-set.ts) and the other commands (daemon-trigger-commands.ts).
const triggerStore = createDaemonTriggerStore({ daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, walnutScope, gatewayClientHomes, wsClients, isServerClient, sendEvent, logMsg })
const { TRIGGERS_BASE_DIR, TRIGGER_STATE_DIR, armedTriggers, drainingTriggers, hostDeliveriesInFlight, triggerChecksRunning, triggerScopes, triggerScopeOf, persistTriggersFile } = triggerStore
const triggerRuns = createDaemonTriggerRuns({ daemonEnv, triggerStore, demoQuiesce, childUse, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, followerTriggers, clockHostStart, setInterval, clearInterval, logMsg })
const { demoTriggerChecks, demoTriggerCheckPids } = triggerRuns
const triggerSet = createDaemonTriggerSet({ triggerStore, triggerRuns, offlineHost, walnutScope, gatewayClientHomes, sendEvent, logMsg, sendOk, sendError })
const { loadTriggersAtBoot, effectiveTriggerDefs, armTriggerSet, triggerHoldsChanged } = triggerSet
const triggerCommands = createDaemonTriggerCommands({ triggerStore, triggerRuns, demoQuiesce, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, clockHostStart, walnutScope, gatewayClientHomes, refuseForeignHome, logMsg, sendOk, sendError })
const { runTriggerTest } = triggerCommands
// keepRuntimeFiles clock; cleanup() stops it, so a dying daemon never writes its files back.
let runtimeKeepTimer: ReturnType<typeof setInterval> | null = null

// ── skills.sync (daemon-skills.ts): Walnut's skills in this host's engine stores ──
const skills = createDaemonSkills({ daemonEnv, HOME_DIR, KEEPS_SESSIONS, SET_ID, OFFLINE_HOST_DIR, logMsg, sendOk, sendError })

// Hook point cron.created: a bypassPermissions session never emits a
// can_use_tool control_request, so the cron.create deny can't fire — the job
// is already on disk by the time the tool_use echoes in the stream. The only
// available action is `inject` (fixed corrective text — the model is asked to
// CronDelete + recreate non-durable; it may decline, which is why the hook
// set pairs this with cron.fire evict). Once per tool_use id so a re-read of
// the same line can't nag in a loop; `durableCronNudged` is in-memory only (a
// respawn re-nudges, which is correct — the durable task is still on disk).
function checkDurableCronCreate(sid: string, session: SessionData, line: string, parseLine?: () => unknown) {
  let parsed: Record<string, unknown>
  try { parsed = (parseLine ? parseLine() : JSON.parse(line)) as Record<string, unknown> } catch { return }
  if (parsed.type !== 'assistant') return
  const content = (parsed.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use') continue
    if ((block.name as string | undefined) !== 'CronCreate') continue
    const actions = hookActions('cron.created', { input: block.input, mode: session.mode, sid })
    if (actions.includes('log')) {
      logMsg('info', 'hook log: cron.created', { sid, input: block.input, mode: session.mode })
    }
    if (!actions.includes('inject')) continue
    const key = String(block.id ?? 'unknown')
    if (!session.durableCronNudged) session.durableCronNudged = {}
    if (session.durableCronNudged[key]) continue
    session.durableCronNudged[key] = Date.now()
    // Task id isn't in the tool_use (the CLI mints it) — the model knows it
    // from its own tool_result, so the message asks it to delete "that task id".
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: durableCronCorrectionMessage(undefined) },
    })
    void core.handleSendRawCommand(sid, payload).then(result => {
      logMsg(result.ok ? 'warn' : 'error', 'hook inject: durable CronCreate correction delivery', { sid, toolUseId: key, mode: session.mode, result })
    })
  }
}
// ── Turn-error auto-retry (policy in daemon-core: decideTurnRetry) ──
//
// Read ONCE at boot: the Mac sets these in the daemon spawn env from user
// config, so a config change takes effect on the next daemon restart (same
// contract as WALNUT_ENFORCE_SESSION_CRON — see DAEMON_RESTART_NOTE).
const TURN_RETRY_CFG = resolveTurnRetryConfig(daemonEnv)

/**
 * A turn ended with is_error. Decide whether to resume it, and if so schedule
 * the resume after a backoff.
 *
 * Called from the tailer on every `result` line. Two jobs:
 *   - a CLEAN result clears the failure streak (so the 12h budget bounds ONE
 *     outage, not the session's lifetime), and
 *   - an ERROR result runs the policy and either schedules a resume or writes a
 *     "gave up" marker for the human.
 *
 * The retry is delivered as a normal FIFO user message when the CLI is still
 * alive, and as a --resume respawn when it died — reusing the exact paths a
 * human "continue" would take, so no delivery invariant is special-cased.
 */
async function checkTurnRetry(sid: string, session: SessionData, line: string, v: number, parseLine?: () => unknown) {
  if (daemonCommands.stopping || !TURN_RETRY_CFG.enabled || cronRuntime?.get(sid) || session.budgetGracefulStop) return
  const checkVersion = (retryCheckVersions.get(sid) ?? 0) + 1
  retryCheckVersions.set(sid, checkVersion)
  if (await budgetAllowance(sid) !== 'ok' || retryCheckVersions.get(sid) !== checkVersion || sessions.get(sid) !== session || session.state !== 'running' || session.intentionalStopAt != null) return
  const { isTurnError, text } = parseTurnErrorLine(line, parseLine)

  if (!isTurnError) {
    // Clean turn-over → the streak is over. Only persist when something changed.
    if (line.includes('"type":"result"') && session.turnRetry) {
      cancelTurnRetry(sid, 'turn-succeeded')
      if (clearTurnRetryStreak(session.turnRetry)) {
        logMsg('info', 'turn-retry streak cleared by a successful turn', { sid })
        persistRegistry()
      }
    }
    return
  }

  if (!session.turnRetry) session.turnRetry = newTurnRetryState()
  const now = Date.now()
  const decision = decideTurnRetry({ errorText: text, state: session.turnRetry, cfg: TURN_RETRY_CFG, nowMs: now, v })

  if (!decision.retry) {
    if (decision.reason === 'duplicate-line') return
    logMsg('warn', 'turn-retry declined', {
      sid, reason: decision.reason, errorText: text,
      attempts: session.turnRetry.attempts,
    })
    // Only tell the human when we actually STOPPED a retry cycle we had begun,
    // or when the error was retryable-looking but out of budget. A plain
    // terminal error on a session that never retried needs no extra row: the
    // CLI's own error is already in the timeline.
    if (decision.reason !== 'terminal' || session.turnRetry.attempts > 0) {
      appendSystemMarker(sid, session, 'turn_retry_stopped', turnRetryGiveUpText(decision.reason, text))
    }
    return
  }

  applyTurnRetry(session.turnRetry, now, v)
  persistRegistry()
  logMsg('warn', 'turn-retry scheduled', {
    sid, attempt: decision.attempt, delayMs: decision.delayMs,
    elapsedMs: decision.elapsedMs, budgetMs: TURN_RETRY_CFG.budgetMs, errorText: text,
  })
  appendSystemMarker(sid, session, 'turn_retry', turnRetryMarkerText({
    attempt: decision.attempt, delayMs: decision.delayMs, errorText: text,
    budgetMs: TURN_RETRY_CFG.budgetMs, elapsedMs: decision.elapsedMs,
  }))

  // Replace any pending timer — the newest failure owns the schedule.
  if (session.turnRetryTimer) { clearTimeout(session.turnRetryTimer); session.turnRetryTimer = null }
  const attempt = decision.attempt
  session.turnRetryTimer = setTimeout(() => {
    session.turnRetryTimer = null
    void fireTurnRetry(sid, attempt, text).catch((err) => {
      logMsg('error', 'turn-retry fire threw', { sid, error: (err as Error).message })
    })
  }, decision.delayMs)
}

/**
 * Deliver the retry.
 *
 * Re-resolves the session from the map rather than closing over it: across a
 * 10-minute backoff the entry can be reaped and REPLACED (a new CLI for the
 * same sid), and nudging a stale object would write to a dead FIFO.
 */
async function fireTurnRetry(sid: string, attempt: number, errorText: string | null) {
  if (cronRuntime?.get(sid)) return
  const session = sessions.get(sid)
  if (!session) {
    logMsg('info', 'turn-retry aborted — session gone', { sid, attempt })
    return
  }
  if (daemonCommands.stopping) return
  if (daemonCommands.closed) {
    if (session.turnRetryTimer) clearTimeout(session.turnRetryTimer)
    session.turnRetryTimer = setTimeout(() => {
      session.turnRetryTimer = null
      if (sessions.get(sid) !== session) return
      void fireTurnRetry(sid, attempt, errorText).catch((err) => {
        logMsg('error', 'turn-retry fire threw', { sid, error: (err as Error).message })
      })
    }, 1000)
    return
  }
  const message = turnRetryMessage(attempt, errorText)
  await daemonCommands.run(() => cmdBridgeResume(RETRY_WS_SINK, 0, { cmd: 'bridgeResume', sid, message, autoRetry: true }))
}

/**
 * A retry is daemon-initiated, so there is no client socket to answer. The
 * command handlers all take a ws to reply on, so give them a sink that drops
 * the reply but still records failures — a silent drop would hide a broken
 * resume for 12 hours.
 */
const RETRY_WS_SINK = {
  readyState: 1,
  send: (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      if (parsed?.error) logMsg('error', 'turn-retry resume returned an error', { error: parsed.error })
    } catch { /* non-JSON reply — nothing to report */ }
    return 1
  },
  close: () => {},
} as unknown as ServerWebSocket<WsData>

/** Append a `type:"system"` marker to the stream file so the session timeline
 *  shows what the daemon did. Same pattern as the cron-fire marker: stream file
 *  only, never the canonical JSONL. */
function appendSystemMarker(sid: string, session: SessionData, subtype: string, content: string) {
  try {
    const marker = JSON.stringify({
      type: 'system', subtype, content,
      uuid: crypto.randomUUID(), session_id: sid,
      timestamp: new Date().toISOString(),
    }) + '\n'
    fs.appendFileSync(session.jsonlPath, marker)
  } catch (err) {
    logMsg('warn', 'system marker append failed', { sid, subtype, error: (err as Error).message })
  }
}

/** Cancel a pending retry. Called when a REAL send arrives (the human took over
 *  — never inject behind them) and from the death funnel. */
function cancelTurnRetry(sid: string, reason: string) {
  retryCheckVersions.set(sid, (retryCheckVersions.get(sid) ?? 0) + 1)
  const session = sessions.get(sid)
  if (!session?.turnRetryTimer) return
  clearTimeout(session.turnRetryTimer)
  session.turnRetryTimer = null
  logMsg('info', 'turn-retry canceled', { sid, reason })
}

function checkCronFires(sid: string, session: SessionData) {
  const now = Date.now()
  if (session.lastCronCheckTs && now - session.lastCronCheckTs < CRON_CHECK_THROTTLE_MS) return
  session.lastCronCheckTs = now
  if (!session.cwd) return
  const base = path.join(session.cwd, '.claude')
  let tasksJson: string | null = null
  let lockJson: string | null = null
  try { tasksJson = fs.readFileSync(path.join(base, 'scheduled_tasks.json'), 'utf-8') } catch { return }
  try { lockJson = fs.readFileSync(path.join(base, 'scheduled_tasks.lock'), 'utf-8') } catch {}
  if (!session.cronWarned) session.cronWarned = {}
  const fires = detectCronFires({ sid, tasksJson, lockJson, nowMs: now, warned: session.cronWarned })
  for (const fire of fires) {
    logMsg(fire.foreign ? 'warn' : 'info', 'scheduled-task fire detected', {
      sid, taskId: fire.taskId, foreign: fire.foreign,
      createdBySessionId: fire.createdBySessionId, lastFiredAt: fire.lastFiredAt,
    })
    // 1. Hook point cron.fire — evaluated BEFORE the marker so the marker can
    // report what actually happened. The interesting action is `evict` on a
    // FOREIGN fire: an orphaned durable cron just hijacked this session, and
    // nobody in this process will ever CronDelete it — removing the row is
    // the only thing that ends the loop. Deliberately NO model-visible
    // message here: the injected warning this replaced cost a turn + context
    // every hour and could not stop anything (a model verifiably ignored one,
    // 2026-08-11). The stream marker below tells the HUMAN.
    let evicted = false
    {
      const actions = hookActions('cron.fire', {
        foreign: fire.foreign, taskId: fire.taskId,
        createdBySessionId: fire.createdBySessionId ?? null, sid,
      })
      if (actions.includes('log')) {
        logMsg('info', 'hook log: cron.fire', { sid, taskId: fire.taskId, foreign: fire.foreign })
      }
      if (actions.includes('evict')) {
        try {
          const tasksPath = path.join(base, 'scheduled_tasks.json')
          const strip = stripCronTaskById(tasksJson, fire.taskId)
          if (strip.changed && strip.text != null) {
            const tmp = tasksPath + '.walnut-' + String(process.pid) + '.tmp'
            fs.writeFileSync(tmp, strip.text, { mode: 0o600 })
            fs.renameSync(tmp, tasksPath)
            evicted = true
            logMsg('warn', 'hook evict: removed orphaned foreign cron', {
              sid, taskId: fire.taskId, createdBySessionId: fire.createdBySessionId, tasksPath,
            })
          }
        } catch (err) {
          logMsg('warn', 'hook evict failed', { sid, taskId: fire.taskId, error: (err as Error).message })
        }
      }
    }
    // 2. Stream-file marker — same append pattern as handleAppendUserMarker
    // (never the canonical JSONL). The tailer folds it (unknown system subtype
    // = v-only, safe) and fans it out; session-history renders
    // scheduled_task_fire as a system info row.
    try {
      const marker = JSON.stringify({
        type: 'system',
        subtype: 'scheduled_task_fire',
        content: cronFireMarkerText(fire, { evicted }),
        cron_task_id: fire.taskId,
        cron_created_by: fire.createdBySessionId ?? null,
        cron_foreign: fire.foreign,
        uuid: crypto.randomUUID(),
        session_id: sid,
        timestamp: new Date(now).toISOString(),
      }) + '\n'
      fs.appendFileSync(session.jsonlPath, marker)
    } catch (err) {
      logMsg('warn', 'scheduled-task fire: marker append failed', { sid, error: (err as Error).message })
    }
  }
}

/**
 * After a result: the last 4 KB of the CLI's stderr to every subscriber, so MCP failures and CLI
 * bails are visible without a shell on the host. Read asynchronously, off the tailer's clock.
 */
async function pushStderrTail(sid: string, s: SessionData, stderrPath: string): Promise<void> {
  let tail = ''
  try {
    const { size } = await fs.promises.stat(stderrPath)
    if (size <= 0) return
    const readLen = Math.min(size, 4096)
    const handle = await fs.promises.open(stderrPath, 'r')
    try {
      const ebuf = Buffer.alloc(readLen)
      const { bytesRead } = await handle.read(ebuf, 0, readLen, Math.max(0, size - readLen))
      tail = ebuf.subarray(0, bytesRead).toString('utf-8').trim()
    } finally { await handle.close() }
  } catch { return }
  if (!tail || sessions.get(sid) !== s) return
  // DUP-DEBUG: stderr_tail is once-per-result. Always log fan-out size + recipient wsIds to
  // confirm whether the daemon is sending to one ws or several.
  const recipientWsIds: number[] = []
  for (const ws of s.subscribers) {
    if (ws.readyState === 1) {
      recipientWsIds.push(wsId(ws))
      try { sendEvent(ws, 'stderr_tail', { sid, tail }) } catch {}
    }
  }
  logMsg('info', 'stderr_tail fan-out', { sid, subscriberCount: s.subscribers.size, recipientWsIds })
}

function ensureWatcher(sid: string) {
  const session = sessions.get(sid)
  if (!session) return
  if (session.watcher) return // already running
  if (session.state !== 'running') return
  if (!session.cronMetadataLoaded && (session.cronMetadataOrigin || Object.keys(session.foldState.cronIds).length > 0)) {
    session.cronMetadataLoaded = true
    session.cronMetadataLoading = true
    const process = cronProcess(session)
    cronMetadata.configure(sid, process, cronMetadataConfig)
    cronMetadata.replay(sid, process, true)
    cronMetadataReplay = cronMetadataReplay.then(async () => {
      if (sessions.get(sid) !== session) return
      let start = process.attributeByTime ? 0 : process.startOffset ?? 0
      cronMetadata.state(sid, process, Object.keys(session.foldState.cronIds).length > 0, process.fresh)
      // A by-time adopt reads the whole stream once (measured 4.1s for a 1GB
      // stream, 2.0M lines, on the host that owns the biggest one), so it gets a
      // budget that fits the file instead of the per-turn one a spawn needs.
      const signal = AbortSignal.timeout(process.attributeByTime ? 120_000 : 10_000)
      for (;;) {
        const end = session.watcher?.offset ?? session.offset
        // The watcher starts before this process's first byte (a rotated file's
        // carry line, a dead CLI's cut last line): nothing of it was read yet,
        // and the watcher observes its lines live once loading ends.
        if (end < start) break
        await readCronMetadataStream(session.jsonlPath, start, end, signal, (line, offset) => {
          if (sessions.get(sid) === session) cronMetadata.observe(sid, process, line, true, offset)
        }, {
          processBoundary: start === process.startOffset,
          expectedEpoch: streamEpochOf(session) ?? undefined,
          onGap: () => { if (sessions.get(sid) === session) cronMetadata.replay(sid, process, true, true) },
          pendingIds: () => cronMetadata.pendingIds(sid),
        })
        if (sessions.get(sid) !== session) return
        start = end
        if (start === (session.watcher?.offset ?? session.offset)) break
      }
      cronMetadata.replay(sid, cronProcess(session), false)
    }).catch((error) => {
      logMsg('warn', 'cron metadata replay failed', { sid, error: String(error) })
      if (sessions.get(sid) === session) cronMetadata.replay(sid, cronProcess(session), false, true)
    }).finally(() => { if (sessions.get(sid) === session) session.cronMetadataLoading = false })
  }

  const stderrPath = session.jsonlPath + '.err'
  // Tailer self-heal (incident 6c8428ac): a per-read error (EMFILE, ...) once froze the read
  // cursor while the CLI kept writing, and Walnut showed idle for a running session. Sustained
  // failure = a stalled tailer: logged (rate-limited), then rebuilt from the last complete line.
  let lastErrorLogTs = 0
  const STALL_ERRORS_BEFORE_HEAL = 50 // ~5s of 100ms ticks failing back-to-back
  const HEAL_COOLDOWN_MS = 60_000

  // The file is read off the main thread's clock, a read at a time (session-tailer.ts); this is
  // the per-line work, on the complete lines of each read.
  const tailer = createSessionTailer({
    path: session.jsonlPath,
    startOffset: session.offset || 0,
    maxReadBytes: TAILER_TICK_READ_MAX,
    carryMaxBytes: TAILER_CARRY_MAX,
    timers: { setInterval, clearInterval },
    active: () => { const s = sessions.get(sid); return !!s && s.state === 'running' && s.watcher?.pollTimer === tailer.timer },
    // Publish the last COMPLETE-line boundary (not the read cursor) so replay/attach never hand a
    // client a mid-line offset.
    onBoundary: (boundary) => { const s = sessions.get(sid); if (s?.watcher) s.watcher.offset = boundary },
    onLines: (batch, { overflowed: cronMetadataGap, carryBytes, cursor }) => {
    const s = sessions.get(sid)
    if (!s) return
    if (cronMetadataGap) logMsg('error', 'tailer carry overflow — dropping oversized partial line', {
      sid, carryBytes, cap: TAILER_CARRY_MAX, offset: cursor,
    })
    let sawResult = false
    // The cron tracker's view of this process, once per slice (cronProcess builds it anew each call).
    const cronProc = cronProcess(s)
    cronMetadata.configure(sid, cronProc, cronMetadataConfig)
    for (const { line, v, parse } of batch) {
      if (!line.trim()) continue

      // A rebuilt watcher can read a range again: dedupe on the line's true v.
      const modeLineFresh = v > s.foldState.v
      if (v > s.foldState.v) s.foldState = foldLine(s.foldState, line, v, parse)

      if (!s.cronMetadataLoading) cronMetadata.observe(sid, cronProc, line, false, undefined, parse)
      if (modeLineFresh && line.includes('"permissionMode"')) {
        try { const actual = observedPermissionMode(parse() as Parameters<typeof observedPermissionMode>[0]); if (actual) s.mode = actual } catch {}
      }

      // Evidence is observed before a result can schedule another billable turn.
      if (line.includes('"assistant"') || line.includes('"system"') || line.includes('"result"') || line.includes('"control_response"')) {
        try { const parsed = parse() as Parameters<typeof usageBudget.observe>[1]; usageBudget.observe(sid, parsed); budgetControl.noteResponse(sid, parsed as Parameters<typeof budgetControl.noteResponse>[1]) } catch {}
      }

      // ── Latency instrumentation: time from CLI spawn → first init line ──
      // Pure CLI cold-start (incl. MCP connect) as the daemon sees it, directly
      // comparable to running `claude` by hand. Logged once per session.
      if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
        try {
          const init = parse() as any
          if (init.type === 'system' && init.subtype === 'init') appendSpawnJournal(init.session_id, s.spawnInfo ?? { kind: 'new' })
          // A fork or an unnamed new session: its own id is known only now (cli-owner-core.ts).
          if (init.type === 'system' && init.subtype === 'init' && typeof init.session_id === 'string' && s.pid && !namedSessionId(s.args)) {
            void cliOwner.adopt(init.session_id, s.pid, s.startTime ?? null, s.spawnInfo?.home)
          }
          if (init.type === 'system' && init.subtype === 'init' && typeof init.claude_code_version === 'string') {
            s.cliVersion = init.claude_code_version
            if (SERVICE_MODE) persistRegistry()
          }
        } catch {}
        s.sawInit = true
        logMsg('info', 'first init line from CLI', {
          sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
        })
      }

      // ── TTFT instrumentation (inc-1786665503510): send → first output ──
      // Anchored by handleSendCommand (ttftSendTs). Two one-shot lines per
      // turn: first stream_event of any kind (model started answering — the
      // Bedrock TTFB proxy), and first text_delta (user-visible prose began).
      // A huge sendToFirstTextMs with a normal sendToFirstLineMs = the model
      // spent the gap thinking/tooling (upstream behavior, not a walnut bug).
      // Substring gates keep the hot path parse-free; cleared at result.
      if (s.ttftSendTs && line.includes('"type":"stream_event"')) {
        if (!s.ttftSawFirstLine) {
          s.ttftSawFirstLine = true
          logMsg('info', 'ttft: first stream_event after send', {
            sid, sendToFirstLineMs: Date.now() - s.ttftSendTs,
          })
        }
        if (line.includes('"text_delta"')) {
          logMsg('info', 'ttft: first text_delta after send', {
            sid, sendToFirstTextMs: Date.now() - s.ttftSendTs,
          })
          s.ttftSendTs = null // one-shot: only the FIRST text of the turn
        }
      }

      // ── Scheduled-task fire detection (see checkCronFires) ──
      // A cron fire's ONLY stream evidence is a bare turn start: the CLI
      // re-emits init + session_state_changed{running} with no user line.
      // Check the on-disk scheduled_tasks.json on those lines (30s throttle
      // inside makes this cheap; substring gate keeps the hot path free).
      if (line.includes('"init"') || line.includes('"session_state_changed"')) {
        try { checkCronFires(sid, s) } catch {}
      }

      // ── Durable-cron invariant, corrective half (see checkDurableCronCreate) ──
      if (line.includes('CronCreate')) {
        try { checkDurableCronCreate(sid, s, line, parse) } catch {}
      }

      // ── Turn-error auto-retry (see checkTurnRetry) ──
      // Gate on the result-line substring only; the parse + is_error check
      // lives in the policy. Clean results come through too, because a
      // successful turn is what clears the failure streak.
      if (line.includes('"type":"result"')) {
        s.ttftSendTs = null // turn over — a stale TTFT anchor must not leak into replays
        void checkTurnRetry(sid, s, line, v, parse).catch(err => {
          logMsg('warn', 'turn-retry check threw', { sid, error: (err as Error).message })
        })
        // A reply request this host owns ends with this turn (offline-host-core.ts).
        void offlineHost.onResult(sid, line, v, parse).catch(() => {})
        // The working tree as this turn left it (turn-snapshot-core.ts): returns at once.
        try { turnSnapshots.onTurnEnd(sid, s.cwd, v) } catch { /* never the tailer's problem */ }
      }

      // ── L2: materialize daemon-authoritative task state ──
      // Cheap substring pre-filter (task_* events are `"type":"system"` lines carrying a
      // `task_` subtype) so we JSON.parse only the relevant ~1% of lines. The applied state
      // is served on `getState` so Walnut can reconcile a lost-terminal event without guessing.
      if (line.includes('"task_')) {
        try {
          const parsed = parse() as Record<string, unknown>
          if (applyTaskEvent(s.taskState, parsed, v, Date.now())) {
            logMsg('info', 'task transition', {
              sid, bgTaskId: parsed.task_id, status: s.taskState.tasks[parsed.task_id as string]?.status,
              derivedRunning: s.taskState.derivedRunning, v,
            })
          }
        } catch { /* malformed line — skip */ }
      }

      // ── Permission policy intercept ──
      if (line.includes('"control_request"') || line.includes('"control_response"')
        || line.includes('"control_cancel_request"')) {
        try {
          const parsed = parse() as Record<string, unknown>
          // The CLI's answer to a model or effort change this daemon wrote (leader.settings).
          if (parsed.type === 'control_response') liveSettings.noteResponse(sid, parsed)
          if (parsed.type === 'control_request' && parsed.request_id
            && (parsed.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
            const req = parsed.request as Record<string, unknown>
            const toolName = req.tool_name as string | undefined
            // ── Hook point cron.create (see daemon-core.ts) ──
            // Evaluated BEFORE the auto-allow check: a bypass-mode session
            // would otherwise be waved through, and a durable job outlives
            // this session to fire inside a stranger sharing the directory.
            if (toolName === 'CronCreate') {
              const actions = hookActions('cron.create', { input: req.input, mode: s.mode, sid })
              if (actions.includes('log')) {
                logMsg('info', 'hook log: cron.create', { sid, input: req.input, mode: s.mode })
              }
              if (actions.includes('deny')) {
                const resp = buildControlResponse(
                  parsed.request_id as string, req, false, durableCronDenyMessage(),
                )
                if (writeFifoRaw(s.pipePath, resp)) {
                  s.pendingCtrl = null
                  try { persistRegistry() } catch {}
                  logMsg('warn', 'hook deny: durable CronCreate refused (session-scoped crons only)', {
                    sid, mode: s.mode,
                  })
                  continue
                }
                // Deliberate fall-through: a failed deny write proceeds to
                // shouldAutoRespond (a bypass session then auto-allows the
                // durable cron). Blocking the turn forever would be worse —
                // cron.fire evict + session.reap strip still cover the row.
                logMsg('error', 'hook deny: response could not be written to FIFO', { sid })
              }
            }
            if (shouldAutoRespond(s.mode, toolName)) {
              // The answer is Walnut's business only when it could not be given:
              // pending until the write lands (handleSendRawCommand clears it), and
              // the prompt reaches Walnut late only when the write was refused (a
              // paused budget, a dead pipe), so the human can still answer it.
              const reqId = parsed.request_id as string
              s.pendingCtrl = { reqId, toolName: toolName ?? 'unknown', request: req, receivedAt: Date.now() }
              try { persistRegistry() } catch {}
              const resp = buildControlResponse(reqId, req, true)
              void core.handleSendRawCommand(sid, resp).then(result => {
                if (result.ok) {
                  logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode })
                  return
                }
                logMsg('warn', 'auto-allow not delivered; the prompt goes to Walnut', { sid, tool: toolName, mode: s.mode, result })
                if (s.pendingCtrl?.reqId !== reqId) return
                for (const ws of s.subscribers) {
                  if (ws.readyState === 1) { try { sendEvent(ws, 'jsonl', { sid, line, v }, parsedFor(ws, parse)) } catch {} }
                }
                pushSnapshot(sid, false)
              })
              continue
            }
            s.pendingCtrl = {
              reqId: parsed.request_id as string,
              toolName: toolName ?? 'unknown',
              request: req,
              receivedAt: Date.now(),
            }
            try { persistRegistry() } catch {}
          } else if (parsed.type === 'control_response' && s.pendingCtrl) {
            const resp = parsed.response as Record<string, unknown> | undefined
            if (resp?.request_id === s.pendingCtrl.reqId) {
              s.pendingCtrl = null
              try { persistRegistry() } catch {}
            }
          } else if (parsed.type === 'control_cancel_request' && s.pendingCtrl) {
            // CLI withdrew the request (turn aborted / restart). Without this
            // branch pendingCtrl stays set forever → snapshot waiting=true and
            // the UI shows a permanent Waiting badge (incident a172ce49).
            if (parsed.request_id === s.pendingCtrl.reqId) {
              s.pendingCtrl = null
              try { persistRegistry() } catch {}
              logMsg('info', 'control_cancel_request cleared pendingCtrl', { sid, requestId: parsed.request_id })
            }
          }
        } catch { /* parse failed, fall through to normal push */ }
      }

      // Fan out to all current subscribers, GC dead ones opportunistically.
      // DUP-DEBUG: only log fan-out when subscribers > 1 (the duplicate
      // smoking gun) AND only for tool_use lines (cheap to detect via
      // substring). High-frequency text deltas would spam the log.
      const fanCount = s.subscribers.size
      const isToolUseLine = fanCount > 1 && line.includes('"type":"tool_use"')
      const recipientWsIds: number[] = []
      for (const ws of s.subscribers) {
        if (ws.readyState === 1) {
          if (isToolUseLine) recipientWsIds.push(wsId(ws))
          // `v` MUST ride every live line (same as the replay path below):
          // without it the client falls back to relative
          // byte accounting, which drifts on skipped control lines → replay
          // windows + duplicate blocks on reattach.
          try { sendEvent(ws, 'jsonl', { sid, line, v }, parsedFor(ws, parse)) } catch {}
        } else {
          logMsg('info', 'GC dead subscriber from watcher fan-out', {
            sid, wsId: wsId(ws), readyState: ws.readyState,
          })
          s.subscribers.delete(ws)
        }
      }
      if (isToolUseLine) {
        logMsg('info', 'jsonl fan-out (tool_use, multi-subscriber)', {
          sid,
          subscriberCount: fanCount,
          recipientWsIds,
          lineSnippet: line.slice(0, 120),
        })
      }
      if (!sawResult && line.includes('"type":"result"')) sawResult = true
    }
    if (cronMetadataGap) cronMetadata.replay(sid, cronProcess(s), !!s.cronMetadataLoading, true)
    // ── C1: after each tailer batch, push the snapshot if it changed (this
    // also covers pendingCtrl set/clear — both happen inside this loop).
    pushSnapshot(sid, false)
    // After a result event, push stderr tail so MCP failures / CLI bails are
    // visible without SSH. Fan to all subscribers.
    if (sawResult) void pushStderrTail(sid, s, stderrPath)
    },
    onError: (err, consecutiveErrors) => {
      const s = sessions.get(sid)
      if (!s) return
      // NO-SILENT-FAILURES: log (rate-limited, this fires every 100ms while the error persists)
      // and self-heal after sustained failure.
      const now = Date.now()
      if (now - lastErrorLogTs > 10_000) {
        lastErrorLogTs = now
        logMsg('error', 'watcher poll tick failed', {
          sid, consecutiveErrors, offset: tailer.cursor,
          err: err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err),
        })
      }
      if (consecutiveErrors >= STALL_ERRORS_BEFORE_HEAL
        && now - (s.lastWatcherHealAt ?? 0) > HEAL_COOLDOWN_MS) {
        // Generation guard: only heal if this is still the session's tailer.
        if (!s.watcher || s.watcher.pollTimer !== tailer.timer) {
          logMsg('warn', 'stalled watcher is orphaned (session replaced) — clearing self', { sid })
          tailer.stop()
          return
        }
        s.lastWatcherHealAt = now
        logMsg('error', 'watcher stalled — forcing rebuild', { sid, offset: tailer.cursor, carryStartV: tailer.boundary, consecutiveErrors })
        // The last COMPLETE-line boundary (NOT the read cursor): the carry dies with this tailer,
        // so the rebuilt one re-reads the torn region (append-only file; client `v` dedup absorbs any overlap).
        s.offset = tailer.boundary
        stopSessionWatcher(sid)
        ensureWatcher(sid)
      }
    },
  })

  session.watcher = { pollTimer: tailer.timer, offset: tailer.boundary, tailer }
}

// Stop the session-bound watcher. Only called from reapSession (session died)
// or daemon shutdown. NEVER called from ws.close.
function stopSessionWatcher(sid: string) {
  const session = sessions.get(sid)
  if (!session || !session.watcher) return
  // Save offset back to session so a subsequent ensureWatcher() resumes from
  // here instead of re-streaming the entire jsonl file from byte 0. Matters
  // for cmdRename, where we intentionally tear down + re-create the watcher.
  session.offset = session.watcher.offset
  try { if (session.watcher.tailer) session.watcher.tailer.stop(); else clearInterval(session.watcher.pollTimer) } catch {}
  session.watcher = null
}

// Most bytes one catch-up replay reads. An offset of 0, or one taken from
// another file, against a whale stream (1.79 GB seen live) would otherwise
// allocate and split the whole gap on the daemon's one thread.
const REPLAY_BACKFILL_MAX_BYTES = 8 * 1024 * 1024

// Add ws to the session's subscribers and catch-up-push bytes
// [fromOffset, currentOffset) to this one ws so reconnecting clients see no gap.
// A gap over REPLAY_BACKFILL_MAX_BYTES replays only its newest lines, after a
// replay_truncated system line saying how many bytes were skipped.
function addSubscriber(ws: ServerWebSocket<WsData>, sid: string, fromOffset: number): boolean {
  const session = sessions.get(sid)
  if (!session) return false
  // DUP-DEBUG: capture the subscriber set BEFORE add so we can log who was
  // already attached. If `before` already contains this ws's wsId, we have a
  // double-add bug; if it contains other live wsIds for the same sid, every
  // subsequent push will fan out to all of them, doubling downstream events.
  const before = Array.from(session.subscribers).map((s) => ({
    wsId: wsId(s), readyState: s.readyState,
  }))
  session.subscribers.add(ws)
  ensureWatcher(sid)
  logMsg('info', 'addSubscriber: attached', {
    sid,
    wsId: wsId(ws),
    fromOffset,
    subscribersBefore: before,
    subscribersAfter: session.subscribers.size,
  })

  const currentOffset = session.watcher ? session.watcher.offset : 0
  const start = typeof fromOffset === 'number' && fromOffset >= 0 ? fromOffset : 0
  if (start < currentOffset) {
    const bytesToRead = currentOffset - start
    // Catch-up replay > 256KB is suspicious — it usually means the client
    // passed an offset from a DIFFERENT file (canonical vs stream mismatch),
    // and we're about to spam them with a huge replay that looks like "UI is
    // replaying the whole conversation". Log before doing it so we can trace.
    if (bytesToRead > 256 * 1024) {
      logMsg('warn', 'addSubscriber: large catch-up replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      })
    } else {
      logMsg('info', 'addSubscriber: replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      })
    }
    try {
      // Over the cap, read one byte before the window so the cut can land on a line start.
      const capped = bytesToRead > REPLAY_BACKFILL_MAX_BYTES
      const readFrom = capped ? currentOffset - REPLAY_BACKFILL_MAX_BYTES - 1 : start
      const fd = fs.openSync(session.jsonlPath, 'r')
      const buf = Buffer.alloc(currentOffset - readFrom)
      let got = 0
      try { got = fs.readSync(fd, buf, 0, buf.length, readFrom) } finally { fs.closeSync(fd) }
      let bytes = buf.subarray(0, got)
      // L1: stamp `v` (end-of-line byte offset) identically to the live watcher so the
      // client dedupes a replayed line against the same `v` it may already have seen live.
      let lineStartV = start
      if (capped) {
        const nl = bytes.indexOf(10)
        lineStartV = nl === -1 ? readFrom + got : readFrom + nl + 1
        bytes = bytes.subarray(nl === -1 ? got : nl + 1)
        const skippedBytes = lineStartV - start
        logMsg('warn', 'addSubscriber: catch-up capped', {
          sid, fromOffset: start, currentOffset, skippedBytes, cap: REPLAY_BACKFILL_MAX_BYTES,
        })
        // Same shape as appendSystemMarker's lines, but sent to this ws only and
        // never written to the file. Its v is where the replay resumes.
        const marker = JSON.stringify({
          type: 'system',
          subtype: 'replay_truncated',
          content: 'Catch-up replay skipped ' + skippedBytes + ' bytes of earlier output (limit '
            + REPLAY_BACKFILL_MAX_BYTES + ' bytes).',
          skipped_bytes: skippedBytes,
          from_offset: start,
          resume_offset: lineStartV,
          uuid: crypto.randomUUID(),
          session_id: sid,
          timestamp: new Date().toISOString(),
        })
        if (ws.readyState === 1) {
          try { sendEvent(ws, 'jsonl', { sid, line: marker, v: lineStartV }) } catch {}
        }
      }
      const text = bytes.toString('utf-8')
      for (const line of text.split('\n')) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1
        lineStartV = v
        if (!line.trim() || ws.readyState !== 1) continue
        // Skip transient permission-protocol lines on replay. control_request/
        // control_response are RPC handshake lines, not session history; replaying
        // them resurrects stale permission prompts in the UI. A genuinely-pending
        // request is recovered out-of-band via `pendingCtrl` (returned on attach),
        // NOT via replay — so dropping all control lines here loses nothing.
        // Prefix match: '"control_request"' misses control_request_progress
        // (heartbeats for in-flight side_question requests, inc-1786165723472)
        // and any future control_* variant — the whole family is plumbing.
        if (line.includes('"type":"control_')) continue
        try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
      }
    } catch {}
  } else {
    logMsg('info', 'addSubscriber: no replay (future-only)', {
      sid, fromOffset: start, currentOffset,
    })
  }
  return true
}

// ── Attach to existing session ──
// An attach for a sid this daemon does not hold: build its session from the
// stream file another daemon left.
async function discoverSessionFromFiles(sid: string, mode: string | undefined): Promise<SessionData> {
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')
  const pipePath = path.join(STREAMS_DIR, sid + '.pipe')

  const discovered = await streamFold.foldFile(jsonlPath, Date.now())
  let pid: number | null = null
  let alive = false
  try {
    pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
    process.kill(pid, 0) // check alive
    alive = true
  } catch { pid = null; alive = false }

  // A FIFO an earlier daemon made may still be readable (LIVE_FIFO_MODE).
  if (alive) lockLiveFifo(fs, pipePath)
  const session: SessionData = {
    proc: null,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    // Watcher starts at the fold rebuild's COMPLETE-line boundary — same rule
    // as adopt. Catch-up for [fromOffset, end) is addSubscriber's job (it reads
    // the file directly). Using the client's fromOffset here is wrong both
    // ways: 0 re-fans the whole file; MAX_SAFE_INTEGER (future-only
    // sentinel) freezes the watcher forever (stat.size <= offset). And a raw
    // stat().size would sit mid-line whenever the CLI is writing during
    // attach — the rebuild consumed the fragment's first half, so the
    // completed line would never be folded whole (contract §4 boundary rule).
    offset: discovered.boundary,
    taskState: discovered.task,
    foldState: discovered.fold,
    foldCheckpointV: discovered.checkpointV,
    watcher: null,
    subscribers: new Subscribers(),
    exitCode: alive ? null : 0,
    state: alive ? 'running' : 'dead',
    exitReason: alive ? null : 'attach-discovered-dead',
    exitedAt: alive ? null : Date.now(),
    parented: false,  // discovered, not spawned
    startTime: pid && alive ? await readStartTimeAsync(pid) : null,
    cwd: '',
    args: [],
    orphanPollTimer: null,
    mode: (mode as SessionMode) || 'default',
    pendingCtrl: null,
  }
  sessions.set(sid, session)
  if (alive && pid) {
    // Discovered an orphan — start the 1s tight poll so we detect death
    // within a second (Phase D, layer 3.2).
    startOrphanPoll(sid)
    void cliOwner.adopt(sid, pid, session.startTime ?? null)
  }
  return session
}

async function cmdAttach(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, fromOffset, mode } = cmd as { sid: string; fromOffset?: number; mode?: string }
  if (!sid) return sendError(ws, id, 'attach: missing sid')

  let session = sessions.get(sid)

  if (!session) {
    // Try to discover from files
    if (!fs.existsSync(path.join(STREAMS_DIR, sid + '.jsonl'))) {
      return sendError(ws, id, 'attach: session not found: ' + sid)
    }
    // The fold is async (a big file must not hold the thread), so it runs in
    // the start gate: a start or send of this sid waits for it, and a second
    // attach finds the session the first one made.
    session = await sessionStartGate.run(sid, async () => sessions.get(sid) ?? await discoverSessionFromFiles(sid, mode))
  }
  // Update mode if provided (walnut re-sends mode on reconnect)
  if (mode && session.state === 'running') {
    session.mode = mode as SessionMode
  }

  const offset = fromOffset || 0
  // Hot-path fresh check to avoid lying to a client whose prior daemon state
  // is stale (race with reaper/SIGCHLD).
  let alive = session.state === 'running' && session.pid !== null
  if (alive && session.pid) {
    try { process.kill(session.pid, 0) } catch {
      reapSession(sid, -1, 'attach-kill-check')
      alive = false
    }
  }

  // Subscribe this ws to the session-bound watcher. Does NOT create a new
  // watcher if one exists. Catches up from fromOffset to the watcher's
  // current offset so reconnecting clients see no gap.
  if (alive) addSubscriber(ws, sid, offset)

  sendOk(ws, id, {
    pid: session.pid,
    alive,
    state: session.state,
    exitCode: session.exitCode,
    outputFile: session.jsonlPath,
    currentOffset: session.watcher ? session.watcher.offset : 0,
    pendingCtrl: session.pendingCtrl,
  })
}

// Read-only recovery query. Not reachable from bridge, follower or lane sockets.
async function cmdLineFate(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  sendOk(ws, id, await core.handleLineFateQuery(cmd.sid, cmd.uuid, cmd.messageIds))
}

// ── Send message ──
// Logic lives in daemon-core.handleSendCommand (strict-ack). This wrapper
// only maps the SendResult envelope onto the WS reply format.
async function cmdSend(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid as string
  if (!sid) return sendError(ws, id, 'send: missing sid')
  const stopVersion = sessionStopVersions.get(sid) ?? 0
  return sessionStartGate.run(sid, () => {
    if ((sessionStopVersions.get(sid) ?? 0) !== stopVersion || (cronRuntime && !cronRuntime.deliveryAllowed(sid, cmd.stopFence))) {
      return sendOk(ws, id, { ok: false, reason: 'session_stopped' })
    }
    return sendSessionMessage(ws, id, cmd)
  })
}

async function sendSessionMessage(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  // `uuid` (optional): the pre-assigned v4 uuid the client wants the CLI to
  // persist this user line under. Older clients never send it and the envelope is
  // then unchanged.
  const { sid, message, uuid } = cmd as { sid: string; message: string; uuid?: string }
  // markers (send-markers-v1): the daemon writes them between the body and the newline; core validates them.
  const markers = (cmd as { markers?: UserMarkerInput[] }).markers
  cancelTurnRetry(sid, 'superseded-by-send')
  // dedupe (send-dedupe-v1): a resend after an unanswered send; core writes it only if this CLI lacks it.
  // lostPid (send-lost-line-v1): the server proved this CLI read past the line; core writes it again.
  // bootWait (send-boot-wait-v1): the first line after a start; a CLI still booting gets until its boot deadline.
  const result = await core.handleSendCommand(sid, message, typeof uuid === 'string' ? uuid : undefined, markers, { dedupe: cmd.dedupe === true, lostPid: typeof cmd.lostPid === 'number' ? cmd.lostPid : null, bootWait: cmd.bootWait === true, answers: cmd.answers === true })
  // `written`: how much of the line went in before the write failed (daemon-core.ts SendResult).
  if ('error' in result) return sendError(ws, id, result.error, result.written ? { written: result.written } : undefined)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Send raw (permission-prompt-tool control_response passthrough) ──
// Same strict-ack protocol as cmdSend; the FIFO receives `raw` verbatim.
async function cmdSendRaw(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, raw } = cmd as { sid: string; raw: string }
  const result = await core.handleSendRawCommand(sid, raw)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Append turn-start user marker to the stream file ──
// Logic lives in daemon-core.handleAppendUserMarker.
function cmdAppendUserMarker(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message, messageId } = cmd as { sid: string; message: string; messageId: string }
  const result = core.handleAppendUserMarker(sid, message, messageId)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Set session mode ──
function cmdSetMode(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, mode } = cmd as { sid: string; mode: string }
  if (!sid || !mode) return sendError(ws, id, 'setMode: missing sid or mode')
  const session = sessions.get(sid)
  if (!session) return sendError(ws, id, 'setMode: session not found: ' + sid)
  const oldMode = session.mode
  applyModePolicy(session, sid, mode as SessionMode)
  sendOk(ws, id, { oldMode, newMode: mode })
}

/** The session's auto-answer policy follows its mode; a prompt the new mode allows is answered now. */
function applyModePolicy(session: SessionData, sid: string, mode: SessionMode): void {
  session.mode = mode
  // A chosen mode survives a resume (host-resume-core.ts pinMode).
  if (session.args.length > 0) session.args = hostResume.pinMode(session.args, mode)
  if (session.args.length > 0 && session.cwd) {
    hostResume.remember(sid, { args: session.args, cwd: session.cwd, mode, home: session.spawnInfo?.home, task: session.spawnInfo?.task })
  }
  if (session.pendingCtrl && shouldAutoRespond(session.mode, session.pendingCtrl.toolName)) {
    const resp = buildControlResponse(session.pendingCtrl.reqId, session.pendingCtrl.request, true)
    const toolName = session.pendingCtrl.toolName
    void core.handleSendRawCommand(sid, resp).then(result => {
      logMsg(result.ok ? 'info' : 'warn', 'setMode: pending control_response delivery', { sid, tool: toolName, mode, result })
    })
  }
  try { persistRegistry() } catch {}
}

// ── Stop session ──
// A refused stop request must not cancel a start that is already queued.
async function cmdStop(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'stop: missing sid')
  if (cmd.stopRequestId !== undefined && (typeof cmd.stopRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cmd.stopRequestId))) {
    return sendError(ws, id, 'stop: invalid stopRequestId')
  }
  if (cmd.reason !== undefined && !['user', 'maintenance', 'idle', 'orphan'].includes(cmd.reason as string)) {
    return sendError(ws, id, 'stop: invalid reason')
  }
  // owner-home-v1: a stop the server decided on names the asking Walnut, and a
  // session the spawn journal records for another Walnut is refused
  // (stopOwnerRefusal). Checked before anything changes, so a refused stop
  // disables no supervision and fences no start. 'orphan' has its own, stricter
  // proof below.
  if (cmd.reason !== 'orphan') {
    const ownerRefusal = stopOwnerRefusal(sid, cmd)
    if (ownerRefusal) {
      logMsg('info', 'cmdStop: stop refused for a session another Walnut started', { sid, reason: cmd.reason, initiator: cmd.initiator, ...ownerRefusal })
      return sendOk(ws, id, { stopped: false, ...ownerRefusal })
    }
  }
  // 'orphan' (orphan-stop-v1): a server found a record saying this session was
  // deliberately ended while its pid still answers. A server never signals a
  // pid it read from its database: the pid proves nothing about which daemon
  // spawned the process (2026-09-26, an ephemeral test server holding a copy of
  // the production database SIGTERM'd the user's live CLIs). It asks the owner,
  // and the owner decides with first-hand evidence (orphanStopRefusal).
  // Supervision is never touched: a supervised session is refused.
  if (cmd.reason === 'orphan') {
    return sessionStartGate.run(sid, async () => {
      const refusal = orphanStopRefusal(sid, cmd.expectPid, cmd.home)
      if (refusal) {
        logMsg('info', 'cmdStop: orphan stop refused', { sid, expectPid: cmd.expectPid, ...refusal })
        return sendOk(ws, id, { stopped: false, ...refusal })
      }
      logMsg('warn', 'cmdStop: ending an orphaned session this daemon owns', { sid, pid: cmd.expectPid })
      sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
      return stopSessionProcess(ws, id, sid)
    })
  }
  // Supervision may be re-enabled while queued, so an idle reap must re-check inside the gate.
  if (cmd.reason === 'idle') {
    return sessionStartGate.run(sid, async () => {
      const supervised = cronRuntime?.get(sid)
      if (supervised?.enabled && supervised.state !== 'inactive') {
        return sendOk(ws, id, { stopped: false, reason: 'cron_supervised' })
      }
      sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
      return stopSessionProcess(ws, id, sid)
    })
  }
  // Invalidate any in-flight recovery first, then wait on persistence and the process gate; do not wait for the recovery to finish before recording the stop.
  sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
  if (cronRuntime && cmd.reason !== 'maintenance') await cronRuntime.disable(sid, cmd.stopRequestId as string | undefined)
  return sessionStartGate.run(sid, () => stopSessionProcess(ws, id, sid))
}

/**
 * owner-home-v1: why this daemon will NOT carry out a stop the server decided
 * on (reason user, maintenance or idle), or null when it may.
 *
 * A pid or a sid in a server's database proves nothing about which Walnut
 * started the session: an ephemeral test server over a copy of the production
 * data holds the user's session ids, and a remote host's daemon is shared by
 * every Walnut that reaches it. So a stop names the asking Walnut (`home`, its
 * data dir) and the spawn journal's first line for the sid decides:
 *  - it names a Walnut: only that one may stop the session, for any reason;
 *  - it names none (first spawned before the journal recorded homes, or not
 *    journaled at all): `strict` (an ephemeral server, which never started such
 *    a session) is refused; otherwise a session with a journal line keeps
 *    today's behaviour, and an unjournaled one may only be stopped by a person
 *    (`initiator: 'human'`), never by a reaper or sweep.
 * A session one Walnut started stays that Walnut's even after another one
 * resumes it: the second is refused here (fail closed), and this daemon's own
 * idle reaper still ends the process.
 * A request with no `home` comes from a server older than owner-home-v1 and
 * keeps today's behaviour. stopSessionProcess still checks the registry and the
 * process start time before any signal.
 */
function stopOwnerRefusal(sid: string, cmd: Record<string, unknown>): { reason: string; detail?: string } | null {
  const home = cmd.home
  if (home === undefined) return null
  if (typeof home !== 'string' || !home) return { reason: 'bad_request', detail: 'home must name the asking Walnut' }
  const served = servedStopRefusal(sid, home)
  if (served) return served
  const owner = journaledHome(sid)
  if (owner) return owner === walnutOfHome(home) ? null : { reason: 'not_owned', detail: 'other_walnut' }
  const journaled = journaledIds().has(sid)
  const detail = journaled ? 'no_journaled_walnut' : 'not_journaled'
  if (cmd.strict === true) return { reason: 'not_owned', detail }
  if (journaled) return null
  const human = cmd.initiator === 'human' || (cmd.initiator === undefined && cmd.reason === 'user')
  return human ? null : { reason: 'not_owned', detail }
}

/**
 * Why this daemon will NOT end `sid` as an orphan, or null when it may.
 *
 * Ownership first, all first-hand: the sid is in THIS daemon's registry with
 * exactly the pid the server named, the .pgid file in this daemon's own streams
 * dir names the same group (written at spawn by this daemon, or by the earlier
 * daemon on the same dir it adopted the session from), and the host's spawn
 * journal records the sid as started for the asking Walnut (`home`, its data
 * dir). A remote host's daemon is shared by every Walnut that reaches it, so
 * "this daemon spawned it" alone would let a server end another server's
 * session. A process that fails any of these belongs to someone else:
 * 'not_owned'. Then liveness, with the same keep-alive rules the idle scanner
 * uses: recent output, a turn in flight, a cron, a team, a running background
 * task or a pending turn retry all refuse. stopSessionProcess then re-checks
 * the process identity (start time) before its first signal.
 *
 * Race window: cmdStop runs this and stopSessionProcess under the same per-sid
 * gate a start takes, and from here to the first SIGINT everything is
 * synchronous, so no other daemon command (a send included) can land between
 * the check and the signal. Only the CLI itself could start work in between
 * (a cron firing inside it), a window of microseconds.
 */
function orphanStopRefusal(sid: string, expectPid: unknown, home: unknown): { reason: string; detail?: string } | null {
  if (typeof expectPid !== 'number' || !Number.isSafeInteger(expectPid) || expectPid <= 1) {
    return { reason: 'bad_request', detail: 'expectPid must be an integer above 1' }
  }
  if (typeof home !== 'string' || !home) return { reason: 'bad_request', detail: 'home must name the asking Walnut' }
  const session = sessions.get(sid)
  if (!session) return { reason: 'not_owned', detail: 'not_in_registry' }
  const served = servedStopRefusal(sid, home)
  if (served) return served
  if (session.pid !== expectPid) return { reason: 'not_owned', detail: 'pid_mismatch' }
  if (SERVICE_MODE && session.bootId && session.bootId !== daemonBootId) return { reason: 'not_owned', detail: 'previous_boot' }
  if (session.state !== 'running' || session.exitCode !== null) return { reason: 'not_running' }
  let pgid = NaN
  try { pgid = parseInt(fs.readFileSync(session.pgidPath, 'utf-8').trim(), 10) } catch { /* no pgid file: not provable */ }
  if (pgid !== expectPid) return { reason: 'not_owned', detail: 'pgid_mismatch' }
  if (!journaledIds().has(sid)) return { reason: 'not_owned', detail: 'not_journaled' }
  const owner = journaledHome(sid)
  if (owner !== walnutOfHome(home)) return { reason: 'not_owned', detail: owner ? 'other_walnut' : 'no_journaled_walnut' }
  const now = Date.now()
  let mtimeMs: number
  try { mtimeMs = fs.statSync(session.jsonlPath).mtimeMs } catch { return { reason: 'protected', detail: 'no-stream-file' } }
  if (now - mtimeMs < SESSION_IDLE_WARNING_MS) return { reason: 'recent_output' }
  if (session.foldState && session.foldState.turnActive) return { reason: 'protected', detail: 'turn-active' }
  const prot = deriveSessionProtection(session, sid, now)
  if (prot.source) return { reason: 'protected', detail: prot.source }
  if (hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS)) return { reason: 'protected', detail: 'cron-debug-log' }
  return null
}

/**
 * A session whose spawn could not read its process's start time (a `ps` that
 * timed out under load) gets one now, when the live process's own command line
 * names this session (argvNamesSession). Without it the record stayed empty for
 * good, adopted that way again by every restart, and every stop of the process
 * was refused: 2026-10-28, one CLI, a refusal every 30 s for over a day. The
 * stop's own check then compares a second reading against this one.
 */
function recordMissingStartTime(sid: string, session: SessionData): boolean {
  const pid = session.pid
  if (session.startTime || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return false
  if (SERVICE_MODE && session.bootId !== daemonBootId) return false
  const startTime = readStartTime(pid)
  const argv = startTime ? commandLineOf(pid) : null
  if (!startTime || !argv || !argvNamesSession(argv, sid, session.args)) {
    logMsg('warn', 'process identity: no start time recorded, and the process does not prove it runs this session', {
      sid, pid, startTimeRead: !!startTime, commandLineRead: argv !== null && argv !== '',
    })
    return false
  }
  session.startTime = startTime
  persistRegistry()
  logMsg('info', 'process identity: recorded the missing start time (its command line names the session)', { sid, pid, startTime })
  return true
}

/**
 * True only when it is proven that the recorded process is not the one living under its pid:
 * the daemon already saw it die, a start time was recorded, the pid now has another readable start
 * time, and its command line (readable, not empty) names neither the session nor its argv files.
 * Anything unread is not proof.
 */
function pidNowRunsAnotherProgram(sid: string, session: SessionData, recordedStartTime: string | undefined): boolean {
  const pid = session.pid
  // Only a record whose death this daemon already saw: a live-looking record is never declared gone.
  if (session.state !== 'dead') return false
  if (!recordedStartTime || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return false
  if (sessions.get(sid) !== session || (SERVICE_MODE && session.bootId !== daemonBootId)) return false
  const now = readStartTime(pid)
  if (!now || now === recordedStartTime) return false
  const argv = commandLineOf(pid)
  if (argv === null || argv === '') return false
  // Loose on purpose: a live CLI runs its argv as files (cli-argv-files-core.ts), so any mention
  // of the session or of one of its argv files means it may still be ours.
  if (argv.includes(sid)) return false
  const files = Array.isArray(session.args) ? cliArgvFiles.namesIn(session.args.map(String)) : []
  return !files.some((name: string) => argv.includes(name))
}

/** The pid's own process is gone (ESRCH) while its process group still has members. */
function leaderGoneWithGroup(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' && isProcessGroupAlive(pid)
  }
}

function stopSessionProcess(ws: ServerWebSocket<WsData>, id: number, sid: string) {
  const session = sessions.get(sid)
  if (!session || !session.pid) {
    const saved = cronRuntime?.get(sid)?.process
    if (saved && saved.bootId === daemonBootId) {
      try {
        process.kill(saved.pid, 0)
        return sendError(ws, id, 'stop: saved process is still alive but not adopted; stop confirmation is pending')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return sendError(ws, id, 'stop: saved process liveness is unknown')
      }
    }
    logMsg('info', 'cmdStop: session not in registry (nothing to kill)', {
      sid, hasSession: !!session, hasPid: !!session?.pid,
    })
    return sendOk(ws, id, { stopped: true, noop: true, reason: 'not_in_registry' })
  }

  const pid = session.pid
  if (!Number.isSafeInteger(pid) || pid <= 1) return sendError(ws, id, 'stop: invalid process identity')
  if (SERVICE_MODE && session.bootId && session.bootId !== daemonBootId) {
    return sendOk(ws, id, { stopped: true, noop: true, reason: 'previous_boot' })
  }
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return sendError(ws, id, 'stop: process liveness is unknown; refusing to signal')
    if (isProcessGroupAlive(pid)) return sendError(ws, id, 'stop: process group still exists without its original leader; stop confirmation is pending')
    reapSession(sid, 0, 'stop-confirmed', true)
    return persistRegistryDurable().then(
      () => sendOk(ws, id, { stopped: true, noop: true, reason: 'already_exited' }),
      (failure) => sendError(ws, id, `stop: registry persistence failed: ${String(failure)}`),
    )
  }
  if (!session.startTime) recordMissingStartTime(sid, session)
  const originalStartTime = session.startTime
  const sameProcess = () => sessions.get(sid) === session && pid > 1
    && (!SERVICE_MODE || session.bootId === daemonBootId)
    && !!originalStartTime && readStartTime(pid) === originalStartTime
  if (!sameProcess() && pidNowRunsAnotherProgram(sid, session, originalStartTime)) {
    // The recorded CLI is gone and its pid belongs to another program now (2026-11-05: a CLI
    // stopped at 06:03 kept its record, the pid was reused, and a send to the session failed with
    // "process identity is unknown" until the new program ended). Nothing is signalled.
    logMsg('info', 'cmdStop: the recorded process is gone; its pid runs another program now (not signalled)', {
      sid, pid, recordedStartTime: originalStartTime ?? null, state: session.state,
    })
    return persistRegistryDurable().then(
      () => sendOk(ws, id, { stopped: true, noop: true, reason: 'pid_reused' }),
      (failure) => sendError(ws, id, `stop: registry persistence failed: ${String(failure)}`),
    )
  }
  if (!sameProcess()) {
    logMsg('warn', 'cmdStop: process identity is unknown; refusing to signal', {
      sid, pid, wsId: wsId(ws), recordedStartTime: originalStartTime ?? null,
    })
    return sendError(ws, id, 'stop: process identity is unknown; refusing to signal')
  }
  logMsg('info', 'cmdStop: stopping session (process group kill)', { sid, pid })

  // Nobody sends `stop` by accident, so record the intent BEFORE the first
  // signal: the death lands asynchronously (orphan poll → ESRCH → code -1) and
  // by then nothing remembers this was asked for. Without the stamp reapSession
  // falls back to the JSONL tail, which says "not a clean turn end" for any
  // session whose last line isn't a type:result, and the projection paints a red
  // Error. This path is how the SERVER's idle reaper kills (mgr.kill() → stop
  // RPC), not the daemon's own scan, so it needs its own stamp: a LOCAL session
  // auto-stopped after 2h idle surfaced as "Session ended unexpectedly and no
  // cause was recorded" (2026-09-03).
  session.intentionalStopAt = Date.now()

  // An explicit stop is a human decision — it must never be undone by a pending
  // auto-retry respawning the CLI a few minutes later. Cancel the timer AND
  // clear the streak so an in-flight `result` line can't re-arm one either.
  cancelTurnRetry(sid, 'session-stopped')
  if (session.turnRetry) clearTurnRetryStreak(session.turnRetry)

  return new Promise<void>((resolve) => {
    const reply = (error?: string) => {
      if (error) sendError(ws, id, error)
      else sendOk(ws, id, { stopped: true })
      resolve()
    }
    try { killProcessGroup(pid, 'SIGINT') } catch (error) {
      reply(`stop: ${(error as Error).message}`)
      return
    }
    let checks = 0
    const checkExit = () => {
      // The CLI itself may have exited on the SIGINT (and been reaped) while its children are still
      // leaving its group (2026-11-12: a Demo reset's stop answered "identity changed" 200 ms after the
      // CLI ended). With the leader gone and the group alive, no process can hold this pid (a group's
      // id is not reused while it has members), so the members are the CLI's own: keep waiting, with
      // the SIGTERM below. Only a live process whose identity changed is refused.
      // Identity is read BEFORE the group: on macOS readStartTime is a `ps` call, and the last member
      // leaving during it made a group read before it say alive and the one inside leaderGoneWithGroup
      // say empty, so a finished stop answered "identity changed" (2026-11-13, a flaky twins e2e).
      const ours = sameProcess() || leaderGoneWithGroup(pid)
      if (!isProcessGroupAlive(pid)) {
        if (sessions.get(sid) === session) {
          reapSession(sid, 0, 'stop-confirmed', true)
          persistRegistryDurable().then(() => reply(), (error) => reply(`stop: registry persistence failed: ${String(error)}`))
          return
        }
        return reply()
      }
      if (!ours) return reply('stop: process identity changed; no further signals sent')
      checks++
      if (checks === 25) {
        try { killProcessGroup(pid, 'SIGTERM') } catch (error) { return reply(`stop: ${String(error)}`) }
      }
      if (checks >= 35) return reply('stop: process did not exit after SIGTERM; automatic recovery remains disabled')
      setTimeout(checkExit, 200)
    }
    setTimeout(checkExit, 200)
  })
}

// ── Status ──
function cmdStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, includeArgs } = cmd as { sid: string; includeArgs?: boolean }
  if (!sid) return sendError(ws, id, 'status: missing sid')

  const session = sessions.get(sid)
  if (!session) return sendOk(ws, id, { exists: false })

  // If daemon already reaped it, trust that — don't go back to kill(pid,0).
  let alive = session.state === 'running'
  if (alive && session.pid) {
    // Hot-path verification: daemon may not have seen SIGCHLD yet for a
    // just-died parented session. A fresh kill(pid,0) closes that window.
    try { process.kill(session.pid, 0) } catch {
      reapSession(sid, -1, 'status-kill-check')
      alive = false
    }
  }

  let mtime: string | null = null, size = 0
  try {
    const stat = fs.statSync(session.jsonlPath)
    mtime = stat.mtime.toISOString()
    size = stat.size
  } catch {}

  sendOk(ws, id, {
    exists: true,
    alive,
    pid: session.pid,
    mtime,
    size,
    // send-markers-v1: a send's markers are written inside its delivery, so a
    // caller may hand them over with the send (direct-host-send.ts).
    sendMarkers: true,
    state: session.state,
    exitCode: session.exitCode,
    exitReason: session.exitReason,
    pendingCtrl: session.pendingCtrl,
    // Opt-in: the argv the live process was launched with (a fork copies it to
    // reproduce the parent's prompt-cache prefix). Off by default because the
    // health monitor polls status for every session and the argv carries the
    // multi-KB --append-system-prompt.
    ...(includeArgs && session.args && session.args.length > 0 ? { args: session.args } : {}),
  })
}

// ── L2: getState — daemon-authoritative background-task state (the PULL source of truth) ──
// Returns the materialized task state plus process liveness. Walnut PULLs this to reconcile a
// lost-terminal event: if the daemon (which persisted every event) says a task is terminal that
// Walnut still has 'running', Walnut adopts the daemon's truth and completes the withheld turn —
// no liveness guessing. If the session is unknown but its jsonl exists, rebuild from disk so a
// post-restart PULL still returns truth.
function cronSupervisionStatus(sid: string) {
  const record = cronRuntime?.get(sid)
  if (!record) return null
  return {
    enabled: record.enabled, state: record.state, reason: record.reason,
    generation: record.generation, retryAt: record.retryAt, updatedAt: record.updatedAt,
  }
}

async function cmdCronSupervision(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (!cronRuntime) return sendError(ws, id, 'cron supervision requires a managed daemon service')
  const sid = cmd.sid
  if (typeof sid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return sendError(ws, id, 'cron.supervision: invalid sid')
  if (cmd.enabled !== undefined) {
    if (typeof cmd.enabled !== 'boolean') return sendError(ws, id, 'cron.supervision: enabled must be boolean')
    if (!cronRuntime.deliveryAllowed(sid, cmd.stopFence)) return sendError(ws, id, 'cron.supervision: request superseded by a stop')
    if (cmd.enabled) await cronRuntime.enable(sid, cmd.stopFence)
    else await cronRuntime.disable(sid)
  }
  return sendOk(ws, id, { cronSupervision: cronSupervisionStatus(sid) })
}

// ── Cold getState: a sid with no session in memory ──
// The server pulls a stopped session's state every 5 minutes for a day, and
// most dead streams have no fold checkpoint. So this disk rebuild folds both
// states in one pass, hands the event loop back every COLD_STATE_SLICE_MS (the
// external session scan's pattern), reads at most the newest
// COLD_STATE_SCAN_MAX_BYTES, and is remembered until the stream file or its
// checkpoint changes. The adopt/attach/resume rebuilds are separate: they seed
// a live watcher and must stay exact.
const COLD_STATE_SCAN_MAX_BYTES = 32 * 1024 * 1024
const COLD_STATE_SLICE_MS = 8
const COLD_STATE_MEMO_MAX = 64
interface ColdState { state: FoldState; task: TaskState }
const coldStateMemo = new Map<string, { key: string; result: Promise<ColdState> }>()

function coldStateKey(jsonlPath: string, st: fs.Stats): string {
  let ck = 'none'
  try {
    const c = fs.statSync(foldCheckpoint.pathFor(jsonlPath))
    ck = c.size + ':' + c.mtimeMs
  } catch {}
  return st.ino + ':' + st.size + ':' + st.mtimeMs + ':' + ck
}

/** The rebuild of one stream file, shared by every caller until the file changes. */
function coldState(jsonlPath: string, st: fs.Stats): Promise<ColdState> {
  const key = coldStateKey(jsonlPath, st)
  const hit = coldStateMemo.get(jsonlPath)
  coldStateMemo.delete(jsonlPath)
  const entry = hit && hit.key === key ? hit : { key, result: scanColdState(jsonlPath, st.size) }
  coldStateMemo.set(jsonlPath, entry)
  if (coldStateMemo.size > COLD_STATE_MEMO_MAX) coldStateMemo.delete(coldStateMemo.keys().next().value as string)
  return entry.result
}

async function scanColdState(jsonlPath: string, size: number): Promise<ColdState> {
  const startedAt = Date.now()
  const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
  let from = ck && ck.task ? ck.boundary : 0
  const capped = size - from > COLD_STATE_SCAN_MAX_BYTES
  if (capped) from = size - COLD_STATE_SCAN_MAX_BYTES
  const resume = ck && ck.task && !capped ? ck : null
  let state = resume ? resume.fold : initialFoldState(0)
  const ts = resume && resume.task ? foldCheckpoint.restampTaskState(resume.task, startedAt) : emptyTaskState()
  // After a cap cut, start one byte early and drop through the first newline:
  // a cut that lands exactly on a line start keeps that line.
  let filePos = capped ? from - 1 : from
  let v = filePos
  let discardThroughNextNewline = capped
  let sliceStart = Date.now()
  let fd: number
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return { state, task: ts } }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let carry: Buffer = Buffer.alloc(0)
    while (filePos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(FOLD_REBUILD_CHUNK, size - filePos), filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim()) {
            state = foldLine(state, line, v)
            if (line.includes('"task_')) {
              try { applyTaskEvent(ts, JSON.parse(line), v, startedAt) } catch {}
            }
          }
        }
        start = nl + 1
        if (Date.now() - sliceStart >= COLD_STATE_SLICE_MS) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          sliceStart = Date.now()
        }
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'cold rebuild carry overflow, dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch { /* a partial fold is still safe to serve */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  logMsg(capped ? 'warn' : 'info', 'getState: cold rebuild', {
    jsonlPath, size, from, capped, cap: COLD_STATE_SCAN_MAX_BYTES,
    fromCheckpoint: !!resume, ms: Date.now() - startedAt,
  })
  return { state, task: ts }
}

async function getStateFromDisk(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, sid: string, cronSupervision: ReturnType<typeof cronSupervisionStatus>): Promise<void> {
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  let st: fs.Stats
  try { st = fs.statSync(jsonlPath) } catch { return sendOk(ws, id, { exists: false, cronSupervision }) }
  const coldFold = await coldState(jsonlPath, st)
  // The scan yields, so the session may have come alive meanwhile.
  if (sessions.has(sid)) return cmdGetState(ws, id, cmd)
  // The memo is shared: answer with a copy stamped now, as a rebuild would be.
  const taskState = foldCheckpoint.restampTaskState(JSON.parse(JSON.stringify(coldFold.task)) as TaskState, Date.now())
  // C1: disk-rebuild snapshot. No live process backs this sid (it would be in
  // the map), so it is dead, with no pendingCtrl and unknown pid/exitCode. The
  // epoch is stamped from the on-disk file so a pull against a dead session
  // still lets walnut detect a recreated file (incident 019a7fe5: this IS the
  // reconcile path).
  const snapshot = assembleSnapshot({
    foldState: coldFold.state,
    pendingCtrl: null,
    dead: true,
    pid: null,
    exitCode: null,
    streamEpoch: st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs),
    rewrittenFrom: streamCompact.rewrittenFrom(jsonlPath, st),
  })
  return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState, snapshot, cronSupervision })
}

function cmdGetState(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'getState: missing sid')

  const cronSupervision = cronSupervisionStatus(sid)
  const session = sessions.get(sid)
  if (session) {
    return sendOk(ws, id, {
      exists: true,
      alive: session.state === 'running',
      state: session.state,
      taskState: session.taskState,
      cronSupervision,
      // The reaper's OWN keep-alive verdict, with its source — so what a
      // debugger sees here is exactly what the kill path will use.
      protection: deriveSessionProtection(session, sid, Date.now()),
      // C1: assembled on demand — the PULL half of snapshot flow.
      snapshot: assembleSessionSnapshot(session),
      // Whether the CLI is between turns as this daemon sees it, a line its own same-host delivery
      // wrote included (ttftSendTs: set at each write, cleared at that turn's first text or end).
      // The server's prompt respawn asks it right before its stop (sessions/prompt-refresh-respawn.ts).
      quiet: {
        turnActive: session.foldState?.turnActive === true,
        lineAwaitingAnswer: session.ttftSendTs != null,
        promptOpen: !!session.pendingCtrl,
      },
    })
  }
  if (cmd.memoryOnly === true) return sendOk(ws, id, { snapshotAvailable: false, cronSupervision })
  // Unknown in memory — rebuild from the durable jsonl if it exists (post-restart PULL).
  return getStateFromDisk(ws, id, cmd, sid, cronSupervision)
}

// ── Rename session files ──
function cmdRename(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { oldSid, newSid } = cmd as { oldSid: string; newSid: string }
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid')
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true })

  const session = sessions.get(oldSid)
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid)

  // Derive from the session's ACTUAL file location, not STREAMS_DIR: a live
  // session spawned before the /tmp→HOME move still has its family in the
  // legacy dir (startup migration skips live pgids), and renaming against the
  // new dir would silently fail per-ext and then point jsonlPath at a
  // nonexistent file — the session would go deaf.
  const liveDir = path.dirname(session.jsonlPath)
  const oldBase = path.join(liveDir, oldSid)
  const newBase = path.join(liveDir, newSid)

  // C14: flush a pending coalesced snapshot BEFORE the re-key. pushSnapshot's
  // 50ms timer carries a generation guard (`sessions.get(sid) !== session`) that
  // is keyed on the OLD sid — after the delete/set below it can never match, so
  // the queued state change would be silently dropped and walnut would only
  // learn about it on the next 30s pull. Flush at the old sid (that is the sid
  // walnut's subscribers know right now) and clear the timer.
  if (session.snapshotTimer) {
    try { pushSnapshot(oldSid, true) } catch {}
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
  }

  try {
    for (const ext of ['.jsonl', '.jsonl.err', '.jsonl.fold', '.jsonl.fold.next', '.jsonl.lines', '.jsonl.compact', '.pipe', '.pgid', '.log']) {
      try { fs.renameSync(oldBase + ext, newBase + ext) } catch {}
    }
    session.jsonlPath = newBase + '.jsonl'
    session.pipePath = newBase + '.pipe'
    session.pgidPath = newBase + '.pgid'

    // The session-bound watcher's pollTimer closure captured the OLD sid and
    // looks up sessions.get(oldSid) each tick. After the re-key below, that
    // lookup returns undefined and the watcher silently stops fanning out
    // jsonl lines — users see the session "go deaf" mid-turn (UI stuck on
    // "Walnut is working…" until the whole session ends). Fix: stop the old
    // watcher before re-keying, then re-create it against the new sid so its
    // closure captures the right key. Subscribers stay put — they only hold
    // ws refs, not sid — so no re-attach is needed from the client side.
    stopSessionWatcher(oldSid)

    sessions.delete(oldSid)
    sessions.set(newSid, session)
    session.cronMetadataLoaded = cronMetadata.rename(oldSid, newSid, cronProcess(session))
    session.cronMetadataLoading = false
    persistRegistry()
    // Agent gateway: the CLI's WALNUT_SESSION_ID env still carries the OLD sid
    // (env is frozen at spawn). Record the alias so resolveCallerSid can chase
    // the chain to the current sid.
    gatewaySidAliases.set(oldSid, newSid)

    ensureWatcher(newSid)

    sendOk(ws, id, { renamed: true })
    logMsg('info', 'session renamed', { oldSid, newSid })
  } catch (err: unknown) {
    sendError(ws, id, 'rename failed: ' + (err as Error).message)
  }
}

// ── Read history ──
// Most bytes one read-history reply carries, main and subagents together: the
// same ceiling as the server's DaemonFileReader. A reply is one frame.
const READ_HISTORY_MAX_BYTES = 32 * 1024 * 1024

/** The newest `maxBytes` of a file; past a cut the partial first line is dropped. */
function readTailWindow(filePath: string, maxBytes: number): { text: string; bytes: number; size: number; cut: boolean } {
  const st = fs.statSync(filePath)
  const start = Math.max(0, st.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(st.size - start)
    const got = fs.readSync(fd, buf, 0, buf.length, start)
    let from = 0
    if (start > 0) {
      const nl = buf.subarray(0, got).indexOf(10)
      from = nl === -1 ? got : nl + 1
    }
    const kept = buf.subarray(from, got)
    return { text: kept.toString('utf-8'), bytes: kept.length, size: st.size, cut: start > 0 }
  } finally { fs.closeSync(fd) }
}

function cmdReadHistory(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, tailBytes } = cmd as { sid: string; tailBytes?: number }
  // A session id names a file in the streams dir and nothing else: the bridge
  // and a follower reach this command, and neither may read any other file.
  if (typeof sid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sid) || sid.includes('..')) return sendError(ws, id, 'read-history: missing or invalid sid')
  // A follower reads its own Walnut's sessions only.
  if (ws.data?.origin === 'follower' && followerReads.ownerOf(sid) !== ws.data.followerHome) return sendError(ws, id, 'read-history: not a session of this Walnut on this host', { errorKind: 'not_found' })

  try {
    // Read main JSONL. tailBytes > 0 = tail-only read (mobile transcript):
    // whale sessions (10MB+) must not ride the bridge as one frame when the
    // caller only renders the last ~200 rows. Without tailBytes the reply is
    // still capped at READ_HISTORY_MAX_BYTES, served as the newest window and
    // flagged `truncated` with the file's `size`.
    let mainContent = ''
    let mainBytes = 0
    let mainSize = 0
    let truncated = false
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const wantTail = typeof tailBytes === 'number' && tailBytes > 0
    const windowBytes = wantTail ? Math.min(tailBytes as number, READ_HISTORY_MAX_BYTES) : READ_HISTORY_MAX_BYTES
    try {
      const main = readTailWindow(jsonlPath, windowBytes)
      mainContent = main.text
      mainBytes = main.bytes
      mainSize = main.size
      if (main.cut && (!wantTail || (tailBytes as number) > windowBytes)) truncated = true
    } catch {}

    // Read subagents (skipped on tail reads — transcripts are main-lane only)
    // from what the main file left of the cap.
    const subagents: Record<string, string> = {}
    if (!wantTail) {
      let budget = READ_HISTORY_MAX_BYTES - mainBytes
      const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents'
      try {
        const files = fs.readdirSync(subagentDir)
        for (const f of files) {
          if (f.endsWith('.jsonl')) {
            if (budget <= 0) { truncated = true; continue }
            try {
              const sub = readTailWindow(path.join(subagentDir, f), budget)
              subagents[f] = sub.text
              budget -= sub.bytes
              if (sub.cut) truncated = true
            } catch {}
          }
        }
      } catch {}
    }

    if (truncated) {
      logMsg('warn', 'read-history: reply capped', { sid, size: mainSize, cap: READ_HISTORY_MAX_BYTES })
      return sendOk(ws, id, { main: mainContent, subagents, truncated: true, size: mainSize })
    }
    sendOk(ws, id, { main: mainContent, subagents })
  } catch (err: unknown) {
    sendError(ws, id, 'read-history failed: ' + (err as Error).message)
  }
}

// ── Delivery-marker lookup (marker-find-v1) ──
// Which of a session's phone messages reached its CLI: each delivery writes a
// marker carrying the message id into the session's stream. The search runs
// here, newest bytes first, so only the ids found cross the bridge
// (marker-find-core.ts). `ordered`: this daemon writes a send's markers inside
// the delivery (send-markers-v1).
async function cmdMarkersFind(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid
  if (typeof sid !== 'string' || !sid || sid.includes('/') || sid.includes('\\') || sid.includes('..')) {
    return sendError(ws, id, 'markers.find: missing or invalid sid')
  }
  const ids = validMarkerIds(cmd.ids)
  if (typeof ids === 'string') return sendError(ws, id, ids)
  const file = sessions.get(sid)?.jsonlPath || path.join(STREAMS_DIR, sid + '.jsonl')
  try {
    const result = await findDeliveryMarkers(file, ids)
    sendOk(ws, id, { ...result, ordered: true })
  } catch (err) {
    sendError(ws, id, 'markers.find failed: ' + (err as Error).message)
  }
}

// ── Subscribe to subagent ──
function cmdSubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent, team, offsets } = cmd as {
    sid: string; agent: string; team?: string; offsets?: Record<string, number>
  }
  if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent')

  const subKey = sid + ':' + agent

  // Unsubscribe existing
  const existing = agentSubs.get(subKey)
  if (existing) {
    if (existing.timer) clearInterval(existing.timer)
    if (existing.rediscoverTimer) clearInterval(existing.rediscoverTimer)
    agentSubs.delete(subKey)
  }

  const sub: AgentSub = {
    files: new Map(),
    timer: null,
    rediscoverTimer: null,
    ws,
    sid,
    agent,
    team,
  }

  // Discover agent JSONL files
  function discoverFiles() {
    try {
      // Look in session subagents dir
      const sessionDir = path.join(STREAMS_DIR, sid, 'subagents')
      try {
        const files = fs.readdirSync(sessionDir)
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue
          // Match by agent name in filename
          if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
            const fullPath = path.join(sessionDir, f)
            if (!sub.files.has(fullPath)) {
              const startOffset = (offsets && offsets[f]) || 0
              sub.files.set(fullPath, { offset: startOffset })
            }
          }
        }
      } catch {}
    } catch {}
  }

  // Poll for new data
  /** In process: the most one agent-file poll reads in a tick (pollData). */
  const AGENT_POLL_MAX_BYTES = 1024 * 1024
  function pollData() {
    for (const [filePath, fileState] of sub.files) {
      try {
        const stat = fs.statSync(filePath)
        // Inside a server's process one tick reads at most AGENT_POLL_MAX_BYTES, whole lines only
        // (agent-file-chunk.ts): a large backlog never holds every route at once. A daemon program
        // reads it all, as it always did.
        const bytes = agentReadSize(fileState, stat.size, LISTEN ? null : AGENT_POLL_MAX_BYTES)
        if (bytes > 0) {
          const fd = fs.openSync(filePath, 'r')
          const buf = Buffer.alloc(bytes)
          fs.readSync(fd, buf, 0, bytes, fileState.offset)
          fs.closeSync(fd)
          const lines = takeAgentLines(fileState, buf, stat.size)
          if (lines.length > 0) {
            sendEvent(ws, 'agent', {
              sid,
              agent,
              file: path.basename(filePath),
              lines,
            })
          }
        }
      } catch {}
    }
  }

  // Initial discovery + data send
  discoverFiles()
  pollData()

  // Start polling
  sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS)
  sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS)

  agentSubs.set(subKey, sub)
  sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] })
}

// ── Unsubscribe from subagent ──
function cmdUnsubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent } = cmd as { sid: string; agent: string }
  const subKey = sid + ':' + agent
  const sub = agentSubs.get(subKey)
  if (sub) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
    agentSubs.delete(subKey)
  }
  sendOk(ws, id, { unsubscribed: true })
}

// ── Write to team inbox ──
function cmdWriteInbox(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { team, agent, from, text, summary } = cmd as {
    team: string; agent: string; from?: string; text: string; summary?: string
  }
  if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields')

  const inboxPath = path.join(HOME_DIR, '.claude', 'teams', team, 'inboxes', agent + '.json')

  try {
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true })

    let inbox: unknown[] = []
    try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')) } catch {}
    if (!Array.isArray(inbox)) inbox = []

    inbox.push({
      from: from || 'walnut',
      text,
      summary: summary || text.slice(0, 100),
      timestamp: new Date().toISOString(),
      read: false,
    })

    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2))
    sendOk(ws, id, { written: true })
  } catch (err: unknown) {
    sendError(ws, id, 'write-inbox failed: ' + (err as Error).message)
  }
}

// ── File system operations (daemon-fs-read.ts, daemon-fs-write.ts) ──
const fsRead = createDaemonFsRead({ HOME_DIR, CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_DIRS, childUse, sendOk, sendError })
const fsWrite = createDaemonFsWrite({ daemonEnv, HOME_DIR, DAEMON_DIR, FALLBACK_DAEMON_DIR, codeServer, looksLikeImage: fsRead.looksLikeImage, logMsg, sendOk, sendError })

// ── Git read commands (daemon-git.ts): diff, status, refs, one file's history, exclude ──
const git = createDaemonGit({ daemonEnv, HOME_DIR, execFileCb, sendOk, sendError })

// ── Session changes, usage scans, session commit (daemon-changes.ts) ──
const sessionChanges = createDaemonChanges({ daemonEnv, HOME_DIR, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, CLAUDE_CONFIG_HOME, childUse, spawn, daemonCommands, sessions, logMsg, sendOk, sendError })
const { computeChangesCached, releaseIdleChangesState, CHANGES_RELEASE_AFTER_MS } = sessionChanges

// ── One-shot claude runs, workspace transfer, host facts (daemon-host-transfer.ts) ──
const hostTransfer = createDaemonHostTransfer({ daemonEnv, DAEMON_DIR, HOME_DIR, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, DAEMON_INSTANCE_ID, DAEMON_START_TS, TASK_DIR_ROOT, spawn, execFile, cliArgvFiles, sessions, hostResume, wsClients, isServerClient, daemonCommands, sendEvent, logMsg, sendOk, sendError })
const { oneShot, replyOneShot, transferCore, transferPack, desktopUpdate, hostFacts, hostVitals, uploadsOwnerlessRoot, uploadsRootFor, replyTransfer } = hostTransfer

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
const hostServices = createDaemonHostServices({ daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, PORT_FILE, spawn, childUse, sessions, acp, gatewaySidAliases, freshLeaderLinks, leaderBook, streamRelay, isServerClient, walnutScope, gatewayClientHomes, daemonCommands, setInterval, clearInterval, logMsg, sendOk, sendError })
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
const transcripts = createDaemonTranscripts({ daemonEnv, DAEMON_DIR, CLAUDE_CONFIG_HOME, execFileCb, walnutScope, gatewayClientHomes, sessionHomeOf, sessions, computeChangesCached, historyReady, logMsg, sendOk, sendError })
const { turnSnapshots } = transcripts

// ── List all sessions ──
function cmdList(ws: ServerWebSocket<WsData>, id: number) {
  const result: Array<{
    sid: string; pid: number | null; alive: boolean; mtime: string | null; size: number
  }> = []

  // Scan streams dir for PGID files
  try {
    const files = fs.readdirSync(STREAMS_DIR)
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue
      const sid = f.replace('.pgid', '')
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10)
        let alive = false
        try { process.kill(pid, 0); alive = true } catch {}

        let mtime: string | null = null, size = 0
        try {
          const stat = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl'))
          mtime = stat.mtime.toISOString()
          size = stat.size
        } catch {}

        result.push({ sid, pid, alive, mtime, size })
      } catch {}
    }
  } catch {}

  // Also include in-memory sessions not yet persisted
  for (const [sid, session] of sessions) {
    if (!result.find(r => r.sid === sid)) {
      // Prefer the authoritative state field; only fall back to kill(pid,0)
      // if we've never seen a death signal for this record.
      let alive = session.state === 'running' && session.pid !== null
      if (alive && session.pid) {
        try { process.kill(session.pid, 0) } catch { alive = false }
      }
      result.push({
        sid,
        pid: session.pid,
        alive,
        mtime: null,
        size: 0,
      })
    }
  }

  // A fenced Demo counts a session whose CLI exited while its group lives on (zero-signal probe), so its reset keeps the data.
  if (demoQuiesce.fenced) for (const row of result) if (!row.alive && row.pid && isProcessGroupAlive(row.pid)) row.alive = true
  sendOk(ws, id, { sessions: ws.data?.origin === 'follower' ? followerReads.ownRows(followerHomeOf(ws), result) : result })
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
  if (ws?.data?.origin === 'follower') data = followerReads.settle(ws, id, data) ?? data
  // The frame's id wins (a trigger's `id` never re-addresses the answer); a refusal sent here with
  // `ok: false` in its data keeps it (ARG_REFS_MISSING, session_stopped, session_dead).
   sendFrame(ws, { ok: true, ...data, id })
}

/** `level`: an expected refusal (a job restarting) is logged below error. */
function sendError(ws: ServerWebSocket<WsData>, id: number | null, error: string, data?: Record<string, unknown>, level: 'error' | 'warn' | 'info' = 'error') {
  if (ws?.data?.origin === 'follower') followerReads.settle(ws, id)
  logMsg(level, level === 'error' ? 'command error' : 'command refused', { id, error, ...(level !== 'error' && typeof data?.errorKind === 'string' ? { errorKind: data.errorKind } : {}) })
  sendFrame(ws, { ...data, id, ok: false, error })
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

// ── FIFO write logger ──
// Wraps writeFifoRaw so every FIFO write attempt is observable — essential
// for debugging "message sent but CLI never replied" bugs. Success, EAGAIN
// backpressure, and ENXIO (dead reader) are all distinct signals.
function logFifoWrite(sid: string, bytes: number, result: 'ok' | 'EAGAIN' | 'ENXIO' | 'error', err?: string) {
  logMsg(result === 'ok' ? 'debug' : 'warn', 'fifo_write', { sid, bytes, result, ...(err ? { err } : {}) })
}

// ── Session idle scanner ──
// Runs every 60s, kills orphaned sessions per the decision tree:
//   - Process already dead → cleanup process group (kill MCP residuals)
//   - Has client watching → skip (Mac health monitor manages it)
//   - JSONL < 5min old → skip (active)
//   - JSONL 5min-2hr old → log warning
//   - JSONL > 2hr old + no watcher → kill sequence

// 5min: long enough for model response delays (up to 120s) and MCP tool execution,
// short enough to detect stuck sessions promptly.
// The two windows below can be shortened by their WALNUT_SESSION_* variables (tests of the scan only).
const SESSION_IDLE_WARNING_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_WARNING_MS || '', 10) || 5 * 60 * 1000     // 5 minutes
// 2hr: conservative — gives plenty of time for legitimate background work (builds,
// long MCP ops, await_human_action), but eventually reclaims resources.
const SESSION_IDLE_KILL_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_KILL_MS || '', 10) || 2 * 60 * 60 * 1000   // 2 hours
// Cron-armed sessions (/loop): the CLI's in-process scheduler lives in THIS
// process's memory — killing it silently kills the loop. Extended, not
// disabled: the CLI auto-expires recurring crons after 7 days, so a session
// idle beyond that has a dead scheduler and is safe to reclaim.
const SESSION_CRON_IDLE_KILL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
// Sessions with a running background task (local_bash / local_agent /
// local_workflow): a wait-style bash task polls silently — its output goes to
// the task's output_file, NOT the JSONL — so the session looks "idle" for the
// task's whole lifetime (incident inc-1786222771315: a "wait for QA phase"
// bash task was killed at the 2h mark while derivedRunning was 1).
// PRINCIPLE: a session with running background work should never be reaped.
// The Mac-side health monitor implements exactly that (isBackgroundWorkActive
// → skip, unbounded). This daemon-side cap exists ONLY for the one edge case
// with no client to bail us out: a live CLI whose task framework wedged and
// will never emit a terminal event — indistinguishable from real work, and
// without a ceiling it's an immortal process on the remote host. 3 days of
// TOTAL JSONL silence (not task runtime) is far beyond any legitimate silent
// stretch; the Mac monitor protects real work long before this fires.
const SESSION_BG_IDLE_KILL_MS = 3 * 24 * 60 * 60 * 1000   // 3 days
const SESSION_SCAN_INTERVAL_MS = 60_000             // every 60s
// The idle scan's own cadence (WALNUT_SESSION_IDLE_SCAN_MS shortens it for a test of the scan).
const SESSION_IDLE_SCAN_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_SCAN_MS || '', 10) || SESSION_SCAN_INTERVAL_MS

// ── Last-resort cron evidence: the CLI scheduler's own debug log ──
// The fold's cronIds is a replay of the /tmp stream file — /tmp can be
// age-cleaned (systemd-tmpfiles `v /tmp 10d`) or hand-wiped, and a rebuild
// from a missing file yields an EMPTY fold that would strip a live loop's
// protection. The CLI writes `[ScheduledTasks] firing <id>` to
// ~/.claude/debug/<sid>.txt (HOME, not /tmp) in real time on every fire —
// first-hand, process-independent evidence. Before killing, check the tail
// of that file for a recent firing line; recent = within the kill threshold
// (a firing inside the window means the scheduler is alive regardless of
// what the fold thinks). Read is bounded (last 64KB) and only runs on the
// rare kill path, never on the per-minute scan of healthy sessions.
const CRON_DEBUG_TAIL_BYTES = 64 * 1024
function hasRecentSchedulerFiring(sid: string, withinMs: number): boolean {
  const debugPath = path.join(os.homedir(), '.claude', 'debug', sid + '.txt')
  let fd: number
  try { fd = fs.openSync(debugPath, 'r') } catch { return false }
  try {
    const size = fs.fstatSync(fd).size
    const readLen = Math.min(size, CRON_DEBUG_TAIL_BYTES)
    const buf = Buffer.alloc(readLen)
    fs.readSync(fd, buf, 0, readLen, size - readLen)
    const text = buf.toString('utf-8')
    const cutoff = Date.now() - withinMs
    // Lines look like: 2026-08-08T01:43:58.502Z [DEBUG] [ScheduledTasks] firing 018e22e9 (recurring)
    const re = /^(\S+) \[DEBUG\] \[ScheduledTasks\] (?:firing|scheduled) /gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const t = Date.parse(m[1])
      if (!Number.isNaN(t) && t >= cutoff) return true
    }
    return false
  } catch { return false } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

// ── Session keep-alive protection: ONE authoritative verdict, with a source ──
// Every "why is this idle session still alive?" decision flows through here,
// and the same verdict is exposed on getState so what a human sees while
// debugging IS what the kill path used. History: each cross-turn state the
// CLI keeps in-process became an incident when the reaper didn't know about
// it — /loop crons (2026-08-07), running bg tasks (inc-1786222771315), and
// teamActive was never wired daemon-side at all. New cross-turn state = add
// ONE branch here, nowhere else.
// PRINCIPLE: protected sessions are extended, never exempt — the ceilings
// below exist only as immortal-process backstops (wedged task framework /
// expired scheduler), not as work budgets.
interface SessionProtection {
  source: 'cron' | 'team' | 'bg-task' | 'turn-retry' | null
  killMs: number
  detail?: string
}

function deriveSessionProtection(session: SessionData, sid: string, now: number): SessionProtection {
  // Cron (7d = the CLI's own recurring-cron auto-expiry). TWO signals, either
  // arms: fold (CronCreate seen in THIS stream — covers session-only crons,
  // which never touch disk) or disk ({cwd}/.claude/scheduled_tasks.json —
  // durable crons; the fold goes blind on stream wipe/rebuild, on --resume
  // respawn (history replay re-arms the CLI scheduler with NO new CronCreate
  // line — lab 2026-08-10 P4b), and on adopted foreign tasks).
  const supervised = cronRuntime?.get(sid)
  if (supervised?.enabled && supervised.state !== 'inactive') {
    return { source: 'cron', killMs: Number.MAX_SAFE_INTEGER, detail: 'supervision:' + supervised.state }
  }
  if (supervised?.state !== 'inactive' && Object.keys(session.foldState.cronIds).length > 0) {
    return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'fold' }
  }
  if (session.cwd) {
    // 10-min TTL cache: scans run every 60s per session; staleness only
    // delays the *lift* of protection, never a kill.
    if (session.diskCronCache && now - session.diskCronCache.at < 10 * 60_000) {
      if (session.diskCronCache.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk-cache' }
      }
    } else {
      let tasksJson: string | null = null
      let lockJson: string | null = null
      try { tasksJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.json'), 'utf-8') } catch {}
      try { lockJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.lock'), 'utf-8') } catch {}
      const disk = hasDiskCronInterest({ sid, tasksJson, lockJson, nowMs: now })
      session.diskCronCache = { at: now, armed: disk.armed, reason: disk.reason }
      if (disk.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk:' + (disk.reason ?? '') }
      }
    }
  }
  // In-process team (Claude Code team mode): the lead session polls teammates
  // between turns with no JSONL output of its own. The Mac health monitor has
  // skipped team-active sessions since day one; the daemon reaper never knew.
  if (session.foldState.teamActive) {
    return { source: 'team', killMs: SESSION_BG_IDLE_KILL_MS }
  }
  // Running background task (daemon's OWN taskState — the same fold the
  // watcher feeds): wait-style bash tasks write to output_file, not the
  // stream, so the session looks idle for the task's whole lifetime
  // (inc-1786222771315). isBackgrounded tasks are already excluded by
  // runningTaskCount.
  if (session.taskState.derivedRunning > 0) {
    return { source: 'bg-task', killMs: SESSION_BG_IDLE_KILL_MS }
  }
  // Pending turn-retry: the session is deliberately SILENT during the backoff
  // (up to 10 min), which is exactly what "idle" looks like to the reaper. This
  // is cross-turn state the reaper must know about, or the 30-min idle kill
  // silently eats a session that was waiting out an upstream outage — the retry
  // would then fire against a corpse and the whole feature would look flaky.
  if (session.turnRetryTimer) {
    return { source: 'turn-retry', killMs: SESSION_BG_IDLE_KILL_MS, detail: 'backoff-pending' }
  }
  return { source: null, killMs: SESSION_IDLE_KILL_MS }
}

function scanIdleSessions() {
  if (daemonCommands.closed) return
  const now = Date.now()

  // Embedded code-server rides the same 60s scan: 2h untouched → reap.
  if (codeServer.reapIdleCodeServer(now)) logMsg('info', 'idle scan: reaped idle code-server', {})

  for (const [sid, session] of sessions) {
    const pid = session.pid
    if (!pid) continue

    // 1. Process already dead? Clean up process group (MCP residuals) and skip
    if (session.exitCode !== null) {
      // Ensure any MCP children are also dead
      if (!SERVICE_MODE && isProcessGroupAlive(pid)) {
        logMsg('info', 'idle scan: cleaning dead session process group', { sid, pid })
        killProcessGroup(pid, 'SIGKILL')
      }
      continue
    }

    // Check if process is actually alive (might have died without triggering exit event)
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (!alive) {
      // Process died but we missed the exit event — clean up via the central
      // reaper (handles FIFO unlink, broadcast, registry flush).
      reapSession(sid, -1, 'idle-scan-missed-exit')
      continue
    }

    // Feed the age-cleaner watchdog: .pgid is written once at spawn and never
    // touched again, so systemd-tmpfiles' 10-day /tmp age rule (`v /tmp 10d`
    // on typical Linux dev hosts) deletes it out from under a long-lived
    // session — the jsonl self-refreshes on every output, the pgid does not,
    // and without it a daemon restart cannot re-adopt the live CLI. Touch it
    // on every scan (60s) for every live session.
    try { const t = new Date(); fs.utimesSync(session.pgidPath, t, t) } catch {}

    // 2. Has at least one subscribed ws? Skip idle check — someone cares.
    if (session.subscribers.size > 0) continue

    // 3. Check JSONL file mtime
    let mtimeMs = 0
    try {
      const stat = fs.statSync(session.jsonlPath)
      mtimeMs = stat.mtimeMs
    } catch {
      continue  // Can't stat file — skip
    }

    // Idle since the later of its last output and the last time someone watched it (Subscribers).
    const idleMs = now - Math.max(mtimeMs, session.subscribers.watchedAt || 0)

    // ONE authoritative verdict with a source — see deriveSessionProtection.
    const prot = deriveSessionProtection(session, sid, now)

    if (idleMs < SESSION_IDLE_WARNING_MS) {
      // Active — skip
      continue
    } else if (idleMs < prot.killMs) {
      // Warning zone — log but don't kill
      const idleMinutes = Math.round(idleMs / 60_000)
      logMsg('warn', 'idle scan: session idle with no subscribers', {
        sid, pid, idleMinutes,
        protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
      })
    } else {
      // Kill zone — no subscribers + no output past threshold. FINAL CHECK
      // before the irreversible kill: the CLI scheduler's own debug log
      // (HOME, survives /tmp wipes). A recent firing/scheduled line means a
      // live loop the fold failed to see (stream file wiped + rebuild, or a
      // tool_result shape change) — refuse to kill, re-check next scan.
      if (prot.source !== 'cron' && hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS)) {
        logMsg('warn', 'idle scan: kill vetoed — CLI scheduler debug log shows recent cron firing', {
          sid, pid, idleMinutes: Math.round(idleMs / 60_000),
        })
        continue
      }
      const idleMinutes = Math.round(idleMs / 60_000)
      // idleMinutes counts from the later of the last output and the last subscriber; outputIdleMinutes from the output alone.
      logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', {
        sid, pid, idleMinutes, outputIdleMinutes: Math.round((now - mtimeMs) / 60_000), protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
      })
      // Record the intent BEFORE signalling: the reap arrives asynchronously
      // (the orphan poll sees ESRCH and reports 'orphan-poll-dead', code -1),
      // so by then nothing remembers that WE asked for this. Without the stamp
      // reapSession can only consult the JSONL tail, which says "not a clean
      // turn end" for any session whose last line isn't a type:result — and the
      // projection then shows a red Error for our own routine reclamation.
      session.intentionalStopAt = now
      killSessionProcessGroup(pid, sid)
    }
  }
}

/**
 * After the startup adoption: every CLI this daemon now runs gets its owner
 * record (a CLI an older daemon spawned has none), then records of CLIs that are
 * gone are removed (cli-owner-core.ts).
 */
async function recordAdoptedOwners(): Promise<void> {
  try {
    for (const [sid, session] of [...sessions]) {
      if (session.state !== 'running' || !session.pid) continue
      const owned = namedSessionId(session.args) ?? sid
      await cliOwner.adopt(owned, session.pid, session.startTime ?? null, session.spawnInfo?.home)
    }
    const removed = await cliOwner.prune()
    if (removed > 0) logMsg('info', 'cli owner: removed records of ended CLIs', { removed })
  } catch (err) {
    logMsg('warn', 'cli owner: startup records failed', { error: (err as Error).message })
  }
}

/**
 * Startup cleanup: scan .pgid files for process groups not registered in the
 * sessions map. Two outcomes per .pgid file:
 *   - Process alive, sid NOT in sessions map → legacy/half-spawned orphan
 *     (daemon was killed between writing .pgid and persisting sessions.json).
 *     Adopt it so the session survives across daemon restarts instead of
 *     being silently killed.'s post-fix behavior.
 *   - Process dead → stale pgid file, remove it.
 *
 * IMPORTANT: sids already present in `sessions` were adopted by
 * reconcileRegistry() — DO NOT touch them here. This check is the fix for the
 * bug where cleanup killed sessions that reconcile had just adopted.
 */
function cleanupOrphanedProcessGroups() {
  let scanned = 0
  let skippedAdopted = 0
  let adoptedLegacy = 0
  let removedStale = 0
  try {
    const files = fs.readdirSync(STREAMS_DIR)
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue
      scanned++
      const sid = f.replace('.pgid', '')

      // reconcileRegistry() already adopted this one with authoritative state.
      // Skipping here is load-bearing: without it, cleanup kills every session
      // reconcile just adopted (the bug that dropped 7 live clouddev sessions).
      if (sessions.has(sid)) {
        skippedAdopted++
        continue
      }

      if (SERVICE_MODE) continue
      try {
        const pgidPath = path.join(STREAMS_DIR, f)
        const pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
        if (isNaN(pid) || pid <= 0) {
          try { fs.unlinkSync(pgidPath) } catch {}
          removedStale++
          continue
        }

        if (isProcessGroupAlive(pid)) {
          // Live process with no sessions.json entry — legacy pgid-only
          // (daemon died mid-spawn before persistRegistry). Adopt instead of
          // kill: the Claude CLI and its JSONL are intact, only the registry
          // entry was lost. Orphan poll will reap it if the process later dies.
          const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
          const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
          logMsg('info', 'startup: adopting live session from previous daemon (legacy pgid-only)', { sid, pid })
          const legacyFold = rebuildFoldStateFromJsonl(jsonlPath)
          lockLiveFifo(fs, pipePath) // see LIVE_FIFO_MODE in daemon-core.ts
          sessions.set(sid, {
            proc: null,
            pipePath,
            jsonlPath,
            pgidPath,
            pid,
            // Watcher starts at the fold rebuild's COMPLETE-line boundary — same
            // rule as registry adopt and attach-discover. 0 here would live-fan
            // the entire multi-MB history to the first subscriber AND poison the
            // client cursor (attach reply currentOffset=0 adopted as valid); a
            // raw stat().size would start mid-line (contract §4 boundary rule).
            offset: legacyFold.boundary,
            taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
            foldState: legacyFold.state,
            watcher: null,
            subscribers: new Subscribers(),
            exitCode: null,
            state: 'running',
            exitReason: null,
            exitedAt: null,
            parented: false,
            startTime: readStartTime(pid),
            cwd: '',
            args: [],
            orphanPollTimer: null,
            mode: 'default',
            pendingCtrl: null,
          })
          startOrphanPoll(sid)
          adoptedLegacy++
        } else {
          // Process gone — clean up the stale pgid file
          logMsg('info', 'startup cleanup: removing stale pgid for dead session', { sid, pid })
          try { fs.unlinkSync(pgidPath) } catch {}
          removedStale++
        }
      } catch (err) {
        logMsg('warn', 'startup cleanup: error processing pgid file', { sid, error: (err as Error).message })
      }
    }
  } catch (err) {
    logMsg('warn', 'startup cleanup: readdir failed', { streamsDir: STREAMS_DIR, error: (err as Error).message })
  }
  logMsg('info', 'startup cleanup: done', {
    scanned, skippedAdopted, adoptedLegacy, removedStale,
    sessionsAfter: sessions.size,
  })
}

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

// ── Cloud bridge: daemon dials OUT to the cloud companion ──
//
// The bridge makes this daemon reachable from the cloud box WITHOUT the Mac
// relaying: phone → cloud → this socket → handleCommand(). The outbound
// socket is treated as just another authenticated client — inbound frames go
// through the same dispatch, jsonl fan-out reaches it via addSubscriber, so
// the command surface stays identical to the SSH-tunneled path.
//
// Config arrives via the `bridge.configure` RPC (pushed by the Mac after its
// capability handshake) and persists to bridge.json so a restarted daemon
// re-dials on its own — cloud reachability must not depend on the Mac being
// awake.

const BRIDGE_FILE = path.join(DAEMON_DIR, 'bridge.json')

// `scoped: 1` marks a file written since the per-Walnut split. An unnamed file
// without it is the one global copy an older daemon kept (see BridgeLink.inherited).
interface BridgeConfig { enabled: boolean; url: string; token: string; hostAlias: string; home?: string; scoped?: 1 }

/**
 * One cloud uplink per Walnut (2026-11-03): two Walnuts on this daemon each keep
 * their own link, and one's configure, re-push or enabled:false never touches the
 * other's (each re-push used to tear the other's link down). Keyed by the Walnut's
 * home (walnutScope); '' is a server older than the split, which keeps the legacy
 * bridge.json. A link's adapter carries its home (`data.bridgeHome`), so what
 * arrives on it acts for that Walnut only.
 */
interface BridgeLink {
  home: string
  config: BridgeConfig | null
  // An unnamed copy an older daemon left: a named configure of its Walnut takes it
  // over (takeOverInheritedBridge), so one Walnut never holds two links to one companion.
  inherited: boolean
  // The sockets that pushed this link's configure: they serve its relays before
  // (or without) binding their home, as a server pushes at connect.
  pushers: WeakSet<ServerWebSocket<WsData>>
  client: WebSocket | null
  adapter: ServerWebSocket<WsData> | null
  redialTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  dialTimer: ReturnType<typeof setTimeout> | null
  // When the in-flight dial started (null = no dial in flight). Feeds the
  // reconcile decision so an identical-config push can't kill a young dial.
  dialStartedAt: number | null
  backoffMs: number
  // When the pending redial is due (null = none pending). Lets the Mac's periodic
  // heal push preempt a far-away redial instead of waiting out backoff that was
  // earned while the network was down — see decideBridgeRestart in daemon-core.ts.
  redialDueAt: number | null
  // When the drop that armed the fast redial window happened (null = none is
  // armed), and whether any established link was lost yet (bridgeRedialStep and
  // armsBridgeFastWindow in daemon-core.ts).
  droppedAt: number | null
  hasDropped: boolean
  // Generation guard: every (re)start bumps this; stale socket callbacks and
  // queued redials check it and no-op, so an old dial can't fight a new config.
  generation: number
  lastInbound: number
  // Per-connection uplink (pacing + counters) and its identity in the logs; the
  // replica logs the same connId (it rides the hello).
  uplink: ReturnType<typeof createBridgeUplink> | null
  connId: string | null
  connOpenedAt: number
  lastError: string | null
  drift: ReturnType<typeof createLoopDriftProbe>
}
const bridgeLinks = new Map<string, BridgeLink>()
// An older server (no home) pushed since boot: another Walnut is here, so a
// leftover copy is never taken over just for being the only Walnut known.
let bridgeUnnamedPushed = false
let bridgeConnSeq = 0

function newBridgeLink(home: string): BridgeLink {
  return {
    home, config: null, inherited: false, pushers: new WeakSet(), client: null, adapter: null,
    redialTimer: null, pingTimer: null, dialTimer: null, dialStartedAt: null, backoffMs: 1000,
    redialDueAt: null, droppedAt: null, hasDropped: false, generation: 0, lastInbound: 0,
    uplink: null, connId: null, connOpenedAt: 0, lastError: null,
    drift: createLoopDriftProbe({ now: Date.now, setInterval, clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>) }),
  }
}

function bridgeFileFor(home: string): string {
  return home ? path.join(walnutScope.dirFor(DAEMON_DIR, home), 'bridge.json') : BRIDGE_FILE
}

/** The link `ws` is the live adapter of (null for any other socket). */
function bridgeLinkOf(ws: ServerWebSocket<WsData>): BridgeLink | null {
  if (ws.data?.origin !== 'bridge') return null
  const link = bridgeLinks.get(ws.data.bridgeHome ?? '')
  return link && link.adapter === ws ? link : null
}

/**
 * The link that carries `home`'s traffic: its own, else the unnamed one (an older
 * server's push names no home, while its leader socket does; or a copy an older
 * daemon left, until its Walnut's configure takes it over), unless that one names
 * another Walnut. A new server always pushes its own, so it never rides another's.
 */
function bridgeLinkFor(home: string): BridgeLink | null {
  const own = bridgeLinks.get(home)
  if (own || !home) return own ?? null
  const legacy = bridgeLinks.get('')
  return legacy && (!legacy.config?.home || legacy.config.home === home) ? legacy : null
}

/**
 * Whether trusted `client` is a server of the Walnut the link of `home` speaks
 * for. A named link: only sockets bound to that home. The unnamed link keeps the
 * old pick, minus servers whose Walnut has a link of its own.
 */
function servesBridgeHome(client: ServerWebSocket<WsData>, home: string): boolean {
  const bound = gatewayClientHomes.get(client)
  if (home) return bound === home || (!bound && bridgeLinks.get(home)?.pushers.has(client) === true)
  // An older server's unnamed link: never a socket of a Walnut whose own link is named
  // (its bulk channel speaks for it by its run, gateway-identity-core.ts).
  const walnut = bound || socketWalnut(client)
  return !walnut || !bridgeLinks.has(walnut)
}

/**
 * Whether bridge socket `client` may hear about session `sid`: a named link only
 * of its own Walnut's sessions, or of one whose Walnut is not recorded (as before).
 */
function bridgeHearsSession(client: ServerWebSocket<WsData>, sid: string): boolean {
  const own = bridgeHomeOf(client)
  if (!own) return true
  // Another daemon may have journaled it since this one read the journal: judge on the file as it is now.
  if (isJournalSid(sid) && !journaledIds().has(sid)) journaledSids = null
  const owner = sessionStartHomeOf(sid)
  return !owner || owner === own
}

/** Whether bridge socket `ws` may act for `home`: a named link for its own Walnut only. */
function bridgeSpeaksFor(ws: ServerWebSocket<WsData>, home: string): boolean {
  const own = bridgeHomeOf(ws)
  return !own || own === home
}

/** The home a bridge socket speaks for ('' = an older server's link, or not a bridge). */
function bridgeHomeOf(ws: ServerWebSocket<WsData>): string {
  return ws.data?.origin === 'bridge' ? ws.data.bridgeHome ?? '' : ''
}


const BRIDGE_BACKOFF_MAX_MS = 60_000
// The fast redial window after a healthy link drops: waits stop doubling at
// 5 s for 180 s. Armed only by a link that had been up 120 s (or the first one
// lost), so a flapping link redials on the plain backoff.
const BRIDGE_FAST_REDIAL_MAX_MS = 5_000
const BRIDGE_FAST_WINDOW_MS = 180_000
const BRIDGE_FAST_ARM_UPTIME_MS = 120_000
// The silence watchdog (onopen). Anything the replica sends counts as heard.
// After a ping interval with nothing heard the daemon pings (also an ack
// marker, bridge-uplink-core.ts), and when the BRIDGE_SILENT_PINGS-th ping is
// due with still nothing, the link is dead: torn down 45 to 50 s after the last
// inbound frame (a 75 s threshold checked every 30 s took 77 to 105 s, half of
// matrix H7's wait). Checked BRIDGE_CHECKS_PER_PING times an interval; checks
// are counted, not wall time, so a daemon that was itself suspended does not
// tear down on wake. A busy link stays heard: the replica answers the markers
// the uplink adds after every 64 KB, so after every chunk it moves. The
// numbers are BRIDGE_WATCHDOG in daemon-core.ts, which the bridge monitor is
// checked against. The env override is for tests.
const BRIDGE_PING_INTERVAL_MS = envTimerMs(daemonEnv.WALNUT_BRIDGE_PING_MS, BRIDGE_WATCHDOG.pingIntervalMs, 150)
const BRIDGE_CHECKS_PER_PING = BRIDGE_WATCHDOG.checksPerPing
const BRIDGE_SILENT_PINGS = BRIDGE_WATCHDOG.silentPings
// A dial that hasn't reached onopen within this window is wedged (TCP up but
// upgrade never completing) — abandon it and redial. Without this a socket
// stuck in CONNECTING was NEVER torn down (the silence watchdog only started
// in onopen), which held the bridge down for days. Env override is for tests.
const BRIDGE_DIAL_TIMEOUT_MS = envTimerMs(daemonEnv.WALNUT_BRIDGE_DIAL_TIMEOUT_MS, 20_000, 500)


function readBridgeFile(file: string): BridgeConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as BridgeConfig
    if (raw && typeof raw.url === 'string' && typeof raw.token === 'string'
      && typeof raw.hostAlias === 'string') return raw
  } catch { /* no bridge configured */ }
  return null
}

/** Every saved link: the unnamed one in bridge.json, each Walnut's under its scope dir. */
function loadBridgeConfig(): void {
  const legacy = readBridgeFile(BRIDGE_FILE)
  if (legacy) {
    const link = newBridgeLink('')
    link.config = legacy
    link.inherited = legacy.scoped !== 1
    bridgeLinks.set('', link)
  }
  for (const [, dir] of walnutScope.scopeDirs(fs, DAEMON_DIR)) {
    const cfg = readBridgeFile(path.join(dir, 'bridge.json'))
    // The dir name is a hash: the home inside names the Walnut.
    if (!cfg || typeof cfg.home !== 'string' || !cfg.home || bridgeFileFor(cfg.home) !== path.join(dir, 'bridge.json')) continue
    const link = newBridgeLink(cfg.home)
    link.config = cfg
    bridgeLinks.set(cfg.home, link)
  }
}

function startBridges(reason: string): void {
  for (const link of bridgeLinks.values()) startBridge(link, reason)
}

function stopBridges(): void {
  for (const link of bridgeLinks.values()) stopBridge(link)
}

/** No other Walnut is known here: no older server pushed, no other link, no socket bound to another home, no other Walnut's scope dir under any base. */
function onlyWalnutHere(home: string): boolean {
  if (bridgeUnnamedPushed) return false
  for (const h of bridgeLinks.keys()) if (h && h !== home) return false
  for (const client of wsClients) {
    const bound = gatewayClientHomes.get(client)
    if (bound && bound !== home) return false
  }
  // Another Walnut that ever pushed a named setting here left a scope dir under one of these.
  const key = walnutScope.keyOf(home)
  for (const base of new Set([DAEMON_DIR, HOOKS_DIR, TRIGGER_STATE_DIR, TRIGGERS_BASE_DIR, WORKSPACE_STATE_DIR])) {
    for (const [k] of walnutScope.scopeDirs(fs, base)) if (k !== key) return false
  }
  return true
}

/**
 * A named configure meeting the copy an older daemon kept, tried on every named
 * push while that copy exists (a disabled push names no url, and a later one finds
 * its own link made). The copy is this Walnut's when it names this home, has the
 * same companion host (a host alias counts only with it: two Walnuts may name the
 * host alike), or this is the only Walnut the daemon knows (almost every host);
 * one naming another home is that one's. With no link of its
 * own the link moves to this home as it is, so it is not torn down; with one, the
 * copy is closed. Either way the legacy file goes.
 */
function takeOverInheritedBridge(home: string, cmd: Record<string, unknown>, own: BridgeLink | null): BridgeLink | null {
  const legacy = bridgeLinks.get('')
  const cfg = legacy?.config
  if (!legacy || !legacy.inherited || !cfg) return null
  let mine = false
  if (cfg.home) mine = cfg.home === home
  else {
    let sameCompanion = false
    if (typeof cmd.url === 'string' && cmd.url) {
      try { sameCompanion = cmd.url === cfg.url || new URL(cmd.url).host === new URL(cfg.url).host } catch { sameCompanion = false }
    }
    mine = sameCompanion || onlyWalnutHere(home)
  }
  if (!mine) return null
  bridgeLinks.delete('')
  try { fs.unlinkSync(BRIDGE_FILE) } catch {}
  if (own) {
    stopBridge(legacy)
    logMsg('info', 'bridge: closed the link an older daemon kept, its Walnut has its own', { scope: walnutScope.label(home) })
    return own
  }
  legacy.home = home
  legacy.inherited = false
  if (legacy.adapter?.data) legacy.adapter.data.bridgeHome = home
  bridgeLinks.set(home, legacy)
  logMsg('info', 'bridge: a Walnut took over the link an older daemon kept', { scope: walnutScope.label(home) })
  return legacy
}

/** What decides a restart: the link's home is its key, so it never counts. */
function bridgeConfigKey(cfg: BridgeConfig | null): string {
  return cfg ? JSON.stringify([cfg.enabled, cfg.url, cfg.token, cfg.hostAlias]) : ''
}

function cmdBridgeConfigure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { url, token, hostAlias, enabled } = cmd as {
    url?: string; token?: string; hostAlias?: string; enabled?: boolean
  }
  if (enabled && (typeof url !== 'string' || typeof token !== 'string' || typeof hostAlias !== 'string')) {
    return sendError(ws, id, 'bridge.configure: url, token, hostAlias required when enabled')
  }
  const scope = walnutScope.resolve(cmd, gatewayClientHomes.get(ws), 'bridge.configure')
  if (!scope.ok) return sendError(ws, id, scope.error)
  const home = scope.home
  if (!home) bridgeUnnamedPushed = true
  let link = bridgeLinks.get(home) ?? null
  if (home) link = takeOverInheritedBridge(home, cmd, link) ?? link
  if (!link) { link = newBridgeLink(home); bridgeLinks.set(home, link) }
  // This socket serves the link's relays until (or without) binding its home.
  if (home) link.pushers.add(ws)
  const prev = link.config
  const next: BridgeConfig = {
    enabled: !!enabled,
    url: url ?? prev?.url ?? '',
    token: token ?? prev?.token ?? '',
    hostAlias: hostAlias ?? prev?.hostAlias ?? '',
    ...(home ? { home } : {}),
    scoped: 1,
  }
  const changed = bridgeConfigKey(next) !== bridgeConfigKey(prev)
  link.config = next
  // An older server's own push: its copy now, never one a named Walnut takes over.
  link.inherited = false
  try {
    const file = bridgeFileFor(home)
    if (home) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 })
  } catch (err) {
    logMsg('error', 'bridge: failed to persist bridge.json', { err: (err as Error).message })
  }
  // changed → restart ('configure'). Unchanged but bridge should be up and
  // nothing is working on it → restart ('reconcile') so the Mac's periodic
  // identical push heals a wedged dial. Decision logic: daemon-core.ts.
  const decision = decideBridgeRestart({
    enabled: next.enabled,
    changed,
    adapterConnected: link.adapter != null,
    redialPending: link.redialTimer != null,
    dialAgeMs: link.dialStartedAt != null ? Date.now() - link.dialStartedAt : null,
    dialTimeoutMs: BRIDGE_DIAL_TIMEOUT_MS,
    redialWaitRemainingMs: link.redialDueAt != null ? link.redialDueAt - Date.now() : null,
  })
  if (decision.restart) startBridge(link, decision.reason)
  logMsg('info', 'bridge: configured', {
    enabled: next.enabled, hostAlias: next.hostAlias, changed, scope: walnutScope.label(home),
    restarted: decision.restart ? decision.reason : false,
  })
  sendOk(ws, id, { applied: true, connected: link.adapter != null })
}

function stopBridge(link: BridgeLink): void {
  if (link.adapter) logBridgeConnClose(link, { code: null, reason: 'stopped', wasClean: true })
  link.generation++
  if (link.redialTimer) { clearTimeout(link.redialTimer); link.redialTimer = null }
  link.redialDueAt = null
  if (link.pingTimer) { clearInterval(link.pingTimer); link.pingTimer = null }
  if (link.dialTimer) { clearTimeout(link.dialTimer); link.dialTimer = null }
  link.dialStartedAt = null
  if (link.adapter) { try { handleDisconnect(link.adapter) } catch {} }
  if (link.client) { try { link.client.close() } catch {} }
  link.client = null
  link.adapter = null
}

function startBridge(link: BridgeLink, reason: string): void {
  stopBridge(link)
  if (!link.config?.enabled) return
  link.backoffMs = 1000
  logMsg('info', 'bridge: starting', { reason, url: link.config.url, hostAlias: link.config.hostAlias, scope: walnutScope.label(link.home) })
  dialBridge(link, link.generation)
}

function scheduleBridgeRedial(link: BridgeLink, gen: number): void {
  if (gen !== link.generation || !link.config?.enabled) return
  // One pending redial at a time — a dial-timeout teardown and a late onclose
  // from the same dead socket must not stack two timers.
  if (link.redialTimer) return
  const step = bridgeRedialStep({
    backoffMs: link.backoffMs, maxMs: BRIDGE_BACKOFF_MAX_MS, jitter: 0.75 + Math.random() * 0.5,
    sinceDropMs: link.droppedAt != null ? Date.now() - link.droppedAt : null,
    fastWindowMs: BRIDGE_FAST_WINDOW_MS, fastMaxMs: BRIDGE_FAST_REDIAL_MAX_MS,
  })
  const delay = step.delayMs
  link.backoffMs = step.nextBackoffMs
  // When this redial is due — lets a heal push preempt a far-away one instead
  // of waiting out backoff earned while the network was down (decideBridgeRestart).
  link.redialDueAt = Date.now() + delay
  link.redialTimer = setTimeout(() => {
    link.redialTimer = null
    link.redialDueAt = null
    dialBridge(link, gen)
  }, delay)
}

// A socket given up on is terminated, not closed: a close handshake on a slow
// or dead link keeps the stream draining what it had buffered, and behind one
// slow bottleneck those streams starve the new link. terminate() is the call
// whose contract is to end the socket at once; what Bun 1.3.9 really does with
// a client behind a path that stopped answering (measured 2026-10-05/06):
//   ws://   close() and terminate() both reset the socket (RST), which drops
//           what the kernel buffered.
//   wss://  neither ends it: no FIN, no RST. A bare client's socket stayed open
//           for the 330 s watched; terminate() leaves it CLOSING (readyState
//           2) with no close event. In the daemon, in a 70 s outage on a
//           4.5 KB/s link, the old stream went on until 160 to 170 s (131 to
//           137 s on the JS twin) and the new link was never dropped, but it
//           had less room: its largest inbound gap was 31.2 and 32.7 s here
//           and 19.0 to 22.2 s on the JS twins, against a silence watchdog
//           that gives up 45 to 50 s after the last inbound frame. That left
//           12 to 14 s of headroom here and 23 to 26 s on the JS twins.
// This twin cannot end an abandoned wss link. Bun's WebSocket exposes no
// socket, and the only Bun call that resets a TLS flow is terminate() on a
// Bun.connect({ tls }) socket (node:tls destroy() and resetAndDestroy() under
// Bun end nothing either), so doing it means owning the TLS transport under
// the WebSocket, which this twin does not.
//
// Bun 1.4.4 rewrote its WebSocket client (oven-sh/bun#45223), and terminate()
// now ends a ws:// socket with a FIN, after the kernel has sent what it
// buffered: the drain this call was chosen to avoid. The same release builds
// its `ws` on native transports and honours createConnection, so from 1.4.4 a
// ws:// bridge rides a TCP socket this daemon opens itself and is reset with
// resetAndDestroy() (measured 2026-10-23: a RST on
// 1.4.3 and 1.4.4; Bun's ws ignores createConnection before 1.4.4). Older Bun
// keeps the global WebSocket, whose terminate() resets; wss:// stays on it too.
const BRIDGE_OWN_TCP = Bun.semver.satisfies(Bun.version, '>=1.4.4')
const bridgeTcp = new WeakMap<object, { tcp?: net.Socket }>()

function openBridgeClient(url: string): WebSocket {
  if (!BRIDGE_OWN_TCP || !/^ws:/i.test(url)) return new WebSocket(url)
  const { WebSocket: WsClient } = require('ws') as { WebSocket: new (url: string, opts: object) => WebSocket }
  const holder: { tcp?: net.Socket } = {}
  const client = new WsClient(url, {
    createConnection: (opts: { host?: string; hostname?: string; port?: number | string }) => {
      const tcp = net.connect({ host: opts.host || opts.hostname, port: Number(opts.port) })
      // An 'error' nobody listens for ends the daemon; the client hears failures through ws.
      tcp.on('error', () => {})
      holder.tcp = tcp
      return tcp
    },
  })
  bridgeTcp.set(client, holder)
  return client
}

function abandonBridgeSocket(client: WebSocket) {
  const tcp = bridgeTcp.get(client)?.tcp
  if (tcp && !tcp.destroyed && !tcp.connecting) {
    try { tcp.resetAndDestroy(); return } catch {}
  }
  try {
    const t = (client as unknown as { terminate?: () => void }).terminate
    if (typeof t === 'function') t.call(client); else client.close()
  } catch {}
}

// Adapter: presents the outbound client WebSocket as a ServerWebSocket so
// handleCommand/addSubscriber/safeSend work unchanged. Every frame goes through
// the uplink, which paces it (bridge-uplink-core.ts). The return value follows
// Bun's send() contract: >0 written now, -1 buffered (the uplink delivers it).
// Never 0: safeSend would park it in a drain queue that no drain event ever
// flushes for a client socket, and everything after it would queue there too.
// A frame the uplink refused is reported where it matters (mobile-event's ack);
// the uplink closes the socket itself on overflow. `bridgeHome` names the Walnut
// whose link it is: what arrives on it acts for that Walnut only.
function makeBridgeAdapter(client: WebSocket, uplink: ReturnType<typeof createBridgeUplink>, home: string): ServerWebSocket<WsData> {
  const adapter = {
    data: { origin: 'bridge', bridgeHome: home } as WsData,
    get readyState() { return client.readyState },
    send(payload: string): number {
      return uplink.send(payload) === 'sent' ? payload.length : -1
    },
    close() { try { client.close() } catch {} },
  }
  return adapter as unknown as ServerWebSocket<WsData>
}

function cmdBridgePeer(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const link = bridgeLinkOf(ws)
  if (!link || !link.uplink) return sendError(ws, id, 'bridge.peer: not the bridge socket')
  const chunkBytes = link.uplink.setChunkBytes(cmd.chunkBytes)
  logMsg('info', 'bridge: peer reassembles chunks', { connId: link.connId, chunkBytes })
  sendOk(ws, id, { chunkBytes })
}

/** The asking Walnut's link: the home it names, else the one its socket speaks for. */
function cmdBridgeStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  if (walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return sendError(ws, id, 'bridge.status: this socket speaks for another Walnut')
  const link = bridgeLinkFor(walnutScope.askedHome(cmd) || (gatewayClientHomes.get(ws) ?? ''))
  sendOk(ws, id, {
    connected: link?.adapter != null,
    connId: link?.adapter != null ? link.connId : null,
    queuedBytes: link?.uplink?.queuedBytes ?? 0,
    inFlightBytes: link?.uplink?.inFlightBytes ?? 0,
  })
}

/** One `bridge-conn-close` line per opened connection (counts and sizes only). */
function logBridgeConnClose(link: BridgeLink, info: { code: number | null; reason: string; wasClean: boolean | null }): void {
  const uplink = link.uplink
  if (!uplink || !link.connId) return
  const snap = uplink.snapshot()
  const now = Date.now()
  logMsg('info', 'bridge-conn-close', {
    connId: link.connId,
    uptimeMs: now - link.connOpenedAt,
    code: info.code,
    reason: info.reason.slice(0, 120),
    wasClean: info.wasClean,
    lastError: link.lastError,
    bytesIn: snap.bytesIn, bytesOut: snap.bytesOut,
    framesIn: snap.framesIn, framesOut: snap.framesOut,
    maxOutFrameBytes: snap.maxOutFrameBytes, maxOutFrameKind: snap.maxOutFrameKind,
    bufferedAmountPeak: snap.bufferedAmountPeak, bufferedAmountAtClose: snap.bufferedAmountAtClose,
    lastInboundAgeMs: snap.lastInboundAt ? now - snap.lastInboundAt : null,
    rttMsP50: snap.rttMsP50, rttMsMax: snap.rttMsMax,
    loopDriftMax60sMs: link.drift.max60s(), loopDriftMax5sMs: link.drift.max5s(),
    chunkedFrames: snap.chunkedFrames, ackTimeouts: snap.ackTimeouts,
  })
  uplink.close()
  link.drift.stop()
  link.uplink = null
  link.connId = null
}

function dialBridge(link: BridgeLink, gen: number): void {
  if (gen !== link.generation || !link.config?.enabled) return
  const cfg = link.config
  let dialUrl: string
  try {
    // Token rides a query param: the browser-style WebSocket client (Bun
    // global + Node 22 global) can't set headers, and the cloud upgrade
    // handler accepts ?token= already.
    const u = new URL(cfg.url)
    u.searchParams.set('token', cfg.token)
    dialUrl = u.toString()
  } catch {
    logMsg('error', 'bridge: invalid url — disabling until reconfigured', { url: cfg.url })
    return
  }

  let client: WebSocket
  try {
    client = openBridgeClient(dialUrl)
  } catch (err) {
    logMsg('warn', 'bridge: dial failed', { err: (err as Error).message })
    scheduleBridgeRedial(link, gen)
    return
  }
  link.client = client
  link.dialStartedAt = Date.now()
  // NOTE: link.lastInbound is (re)set in onopen — the silence watchdog only
  // starts there; the pre-open window is covered by the dial timeout below.
  // Dial timeout: no onopen within the window → tear down + redial. A socket
  // wedged in CONNECTING fires neither onopen nor onclose, so without this
  // timer the bridge would stay down forever with zero log lines.
  link.dialTimer = setTimeout(() => {
    link.dialTimer = null
    if (gen !== link.generation || link.adapter != null) return
    logMsg('warn', 'bridge: dial timeout — abandoning socket', {
      dialMs: link.dialStartedAt != null ? Date.now() - link.dialStartedAt : null,
    })
    link.dialStartedAt = null
    if (link.client === client) link.client = null
    abandonBridgeSocket(client)
    // Don't rely on close() firing onclose for a wedged socket — schedule
    // directly. scheduleBridgeRedial dedupes if onclose does fire too.
    scheduleBridgeRedial(link, gen)
  }, BRIDGE_DIAL_TIMEOUT_MS)

  client.onopen = () => {
    if (gen !== link.generation) { try { client.close() } catch {}; return }
    if (link.dialTimer) { clearTimeout(link.dialTimer); link.dialTimer = null }
    const dialMs = link.dialStartedAt != null ? Date.now() - link.dialStartedAt : null
    link.dialStartedAt = null
    link.backoffMs = 1000
    link.lastInbound = Date.now()
    link.connId = `${DAEMON_INSTANCE_ID}.${++bridgeConnSeq}`
    link.connOpenedAt = Date.now()
    link.lastError = null
    const connId = link.connId
    const uplink = createBridgeUplink({
      write: (frame) => client.send(frame),
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      onOverflow: (queuedBytes) => {
        logMsg('error', 'bridge: uplink queue overflow, closing the socket', { connId, queuedBytes })
        link.lastError = 'uplink queue overflow (daemon closed)'
        abandonBridgeSocket(client)
      },
    })
    link.uplink = uplink
    const adapter = makeBridgeAdapter(client, uplink, link.home)
    link.adapter = adapter
    wsClients.add(adapter)
    link.drift.start()
    logMsg('info', 'bridge-conn-open', { connId, dialMs, wsClient: 'bun' })
    // hello registers this host in the cloud bridge registry (first frame).
    // `uplink: 1` tells the replica it may send bridge.peer and echo ackSeq.
    sendFrame(adapter, {
      ev: 'hello',
      hostAlias: cfg.hostAlias,
      version: DAEMON_VERSION,
      instanceId: DAEMON_INSTANCE_ID,
      sids: [...sessions.keys()],
      connId,
      uplink: 1,
      // What the companion may ask of this daemon ('bridge-stream-v1': its forward on a stream).
      capabilities: BRIDGE_CAPABILITIES,
    })
    logMsg('info', 'bridge: connected', { hostAlias: cfg.hostAlias, wsId: wsId(adapter), scope: walnutScope.label(link.home) })
    // The silence watchdog: see BRIDGE_SILENT_PINGS.
    let heardAt = link.lastInbound
    let silentChecks = 0
    link.pingTimer = setInterval(() => {
      if (gen !== link.generation) return
      if (link.lastInbound !== heardAt) { heardAt = link.lastInbound; silentChecks = 0; return }
      silentChecks++
      if (silentChecks % BRIDGE_CHECKS_PER_PING !== 0) return
      if (silentChecks >= BRIDGE_CHECKS_PER_PING * BRIDGE_SILENT_PINGS) {
        // Half-open link: the cloud stopped answering. Tear down and redial
        // here, as the dial timeout does: on a link that drops every byte the
        // close handshake may never finish, so onclose (and a redial hung off
        // it) may never come. onClose runs once per socket.
        logMsg('warn', 'bridge: inbound silence — tearing down', {
          silentMs: Date.now() - link.lastInbound,
          // The least silence this watchdog tears down at; the bridge monitor
          // tells a counted watchdog from the old wall-clock one by it.
          limitMs: BRIDGE_CHECKS_PER_PING * BRIDGE_SILENT_PINGS * Math.round(BRIDGE_PING_INTERVAL_MS / BRIDGE_CHECKS_PER_PING),
        })
        link.lastError = 'inbound silence (daemon closed)'
        onClose({ code: null, reason: 'inbound silence', wasClean: false })
        abandonBridgeSocket(client)
        return
      }
      // The keepalive is also an ack marker (bridge-uplink-core.ts).
      uplink.ping()
    }, Math.round(BRIDGE_PING_INTERVAL_MS / BRIDGE_CHECKS_PER_PING))
  }

  client.onmessage = (e: MessageEvent) => {
    // Not from a socket this daemon already gave up on (its adapter is gone).
    if (gen !== link.generation || !link.adapter || link.client !== client) return
    link.lastInbound = Date.now()
    const msg = typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString()
    link.uplink?.noteInbound(Buffer.byteLength(msg, 'utf8'))
    handleCommand(link.adapter, msg)
  }

  let closeHandled = false
  const onClose = (ev?: { code?: number | null; reason?: string; wasClean?: boolean | null }) => {
    if (gen !== link.generation || closeHandled) return
    // Late close from a socket the dial timeout already abandoned — a newer
    // dial may be in flight; don't clobber its state.
    // LOAD-BEARING with scheduleBridgeRedial's dedupe: after the dial timeout
    // sets link.client=null there is a window where this guard passes
    // (link.client===null) and the late close falls through to
    // scheduleBridgeRedial — only the "if (link.redialTimer) return" dedupe
    // stops a SECOND stacked redial then. Change either side only in tandem.
    if (link.client !== null && link.client !== client) return
    closeHandled = true
    if (link.dialTimer) { clearTimeout(link.dialTimer); link.dialTimer = null }
    link.dialStartedAt = null
    if (link.pingTimer) { clearInterval(link.pingTimer); link.pingTimer = null }
    if (link.adapter) {
      logBridgeConnClose(link, { code: ev?.code ?? null, reason: ev?.reason ?? '', wasClean: ev?.wasClean ?? null })
      try { handleDisconnect(link.adapter) } catch {}
      link.adapter = null
      link.droppedAt = armsBridgeFastWindow({ uptimeMs: Date.now() - link.connOpenedAt, firstDrop: !link.hasDropped, armUptimeMs: BRIDGE_FAST_ARM_UPTIME_MS }) ? Date.now() : null
      link.hasDropped = true
    }
    link.client = null
    logMsg('info', 'bridge: disconnected — redialing', { nextBackoffMs: link.backoffMs })
    scheduleBridgeRedial(link, gen)
  }
  client.onclose = onClose

  // onclose always follows; keep what the error said for the close line. A
  // socket already given up on must not overwrite the cause the next link's
  // close line reports.
  client.onerror = (e: Event) => {
    if (gen !== link.generation || link.client !== client) return
    const m = (e as { message?: unknown }).message
    link.lastError = typeof m === 'string' && m ? m.slice(0, 200) : e.type || 'error'
  }
}

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
    if (LISTEN) launcherBeat = startLauncherBeat({ dir: daemonEnv.WALNUT_LAUNCHER_DIR, warn: (message) => logMsg('warn', message) })
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
