/**
 * The session daemon's host services: the servers a session started ('ports-v1'), the host
 * network ('net-v1'), hub forwards ('hub-forward-v1'), the secrets the user shared with this
 * host ('secrets-v1') and task workspaces ('workspace-v1').
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose dispatcher calls
 * cmdHubStatus, cmdWorkspace and the cores returned here; its session start reads the secrets, its
 * hello the machine id. The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import type { PortSocket, createStreamRelay } from './stream-relay-core.js'
import { createHubForwards, parseHubForwards } from './hub-forward-core.js'
import { createWorkspaceCore, type WorkspaceCoreDeps } from './workspace-core.js'
import { createDaemonPorts, defaultPortScanIo } from './port-scan-core.js'
import { createNetSupervisor, netStateDir, resolveNetBinary } from './net-core.js'
import { machineIdOf } from './machine-id-core.js'
import { createSecretStore, secretsRoot } from './secrets-core.js'
import { resolveCallerSid } from './gateway-core.js'
import type { createLeaderBook } from './leader-core.js'
import type { createAcpDaemon } from './acp-daemon.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { createDaemonCommandDrain } from './daemon-command-drain.js'
import type { ChildProcessFns, ChildProcessUse } from './daemon-child-spawn.js'
import type { RuntimeTimers } from './daemon-runtime-timers.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonHostServicesDeps<W extends object> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  HOME_DIR: string
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  /** The production daemon dir (its network state lives under HOME). */
  IS_PROD_DAEMON_DIR: boolean
  /** The service set this runtime is, '' for the default one. */
  SET_ID: string
  /** The daemon's port file (walnut-net reads it). */
  PORT_FILE: string
  /** The runtime's spawn (its children get the runtime's env and umask), and its child-process use. */
  spawn: ChildProcessFns['spawn']
  childUse: ChildProcessUse
  /** The runtime's sessions, read only: each running CLI is a root of the port scan. */
  sessions: Map<string, { pid?: number | null; state: string }>
  /** The ACP workers, the other roots of the port scan. */
  acp: Pick<ReturnType<typeof createAcpDaemon<W>>, 'workers'>
  /** A renamed session's old sid, to its new one. */
  gatewaySidAliases: Map<string, string>
  /** The primary links a hub stream may take, and the Walnut each one leads. */
  freshLeaderLinks: () => Array<{ link: W; home: string; heardAt: number }>
  leaderBook: Pick<ReturnType<typeof createLeaderBook>, 'recordOf'>
  streamRelay: Pick<ReturnType<typeof createStreamRelay<W>>, 'openOut'>
  isServerClient: (ws: W) => boolean
  /** Each Walnut's own dir under the runtime's (one workspace allowlist per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  /** Workspace commands but a job poll ride the command drain. */
  daemonCommands: ReturnType<typeof createDaemonCommandDrain>
  /** The runtime's own interval timers (the hub forwards' clock). */
  setInterval: RuntimeTimers['setInterval']
  clearInterval: RuntimeTimers['clearInterval']
  logMsg: DaemonLog
}

export function createDaemonHostServices<W extends object>(deps: DaemonHostServicesDeps<W>) {
  const { daemonEnv, DAEMON_DIR, HOME_DIR, SERVICE_MODE, DAEMON_STATE_DIR, IS_PROD_DAEMON_DIR, SET_ID, PORT_FILE, spawn, childUse, sessions, acp, gatewaySidAliases, freshLeaderLinks, leaderBook, streamRelay, isServerClient, walnutScope, gatewayClientHomes, daemonCommands, setInterval, clearInterval, logMsg, sendOk, sendError } = deps

  // ── The servers a session started (capability 'ports-v1', port-scan-core.ts) ──
  // PARITY: NOT in BRIDGE_ALLOWED_COMMANDS or
  // FOLLOWER_ALLOWED_COMMANDS: ports.stop signals host processes, so only the trusted
  // walnut socket asks. The roots are each running session's CLI and each ACP worker;
  // a WALNUT_SESSION_ID a renamed session's CLI still carries resolves to its new sid.
  const daemonPorts = createDaemonPorts({
    agentPids: () => {
      const pids = new Map<number, string>()
      for (const [sid, s] of sessions) if (s.pid && s.pid > 1 && s.state === 'running') pids.set(s.pid, sid)
      // proc is absent on a worker adopted after a restart: this throws then, as it always did (not type-checked in the runtime's body).
      for (const [rid, w] of acp.workers) if (w.state === 'running' && w.proc!.pid && w.proc!.pid > 1) pids.set(w.proc!.pid, rid)
      return pids
    },
    resolveSid: (raw) => resolveCallerSid(raw, sessions, gatewaySidAliases) ?? raw,
    daemonPid: process.pid,
    io: defaultPortScanIo(childUse),
  })

  // ── The host network (capability 'net-v1') ──
  // PARITY: The logic is net-core.ts: this twin hands it
  // spawn, the net state dir (never under the synced data dir) and where walnut-net lives:
  // $WALNUT_NET_BIN (tests and a hand-built one), beside this executable, beside the daemon,
  // or the release build net-core.ts downloads into the net state.
  // A service set's daemon has a network identity of its own, inside its set (net-config-core.ts).
  const NET_STATE_DIR = netStateDir({ serviceStateDir: SERVICE_MODE ? DAEMON_STATE_DIR : null, prodDaemon: IS_PROD_DAEMON_DIR, daemonDir: DAEMON_DIR, home: HOME_DIR, setId: SET_ID })
  // This machine's stable id for hello (machine-id-core.ts), seeded from the data dir's older id;
  // null when it can be neither read nor made.
  const DAEMON_MACHINE_ID: string | null = (() => {
    try {
      return machineIdOf({ home: HOME_DIR, dataHome: daemonEnv.OPEN_WALNUT_HOME || null, fs, join: path.join, randomHex: () => crypto.randomBytes(16).toString('hex'), log: (level, msg, data) => logMsg(level, msg, data) })
    } catch (e) { logMsg('warn', 'machine id unavailable', { error: String(e) }); return null }
  })()
  const netSupervisor = createNetSupervisor({
    spawn: (command, args, opts) => spawn(command, args, opts),
    stateDir: NET_STATE_DIR,
    portFile: PORT_FILE,
    bin: () => resolveNetBinary({ dirs: [path.dirname(process.execPath), DAEMON_DIR, path.join(NET_STATE_DIR, 'bin')] }),
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  // ── Hub forwards (capability 'hub-forward-v1', hub-forward-core.ts) ──
  // PARITY: This machine's own file (beside its network
  // key) names the 127.0.0.1 ports whose connections go to one port on the primary's loopback;
  // nothing the primary sends writes it.
  const HUB_FORWARDS_FILE = path.join(NET_STATE_DIR, 'hub-forwards.json')
  /** The primary links a hub stream may take (freshLeaderLinks), each with its Walnut's id. */
  function hubLinks(): Array<{ link: W; home: string; walnutId: string | null; heardAt: number }> {
    return freshLeaderLinks().filter((l) => l.home).map((l) => ({ ...l, walnutId: leaderBook.recordOf(l.home)?.walnutId ?? null }))
  }
  const hubForwards = createHubForwards<W, net.Socket>({
    file: HUB_FORWARDS_FILE,
    read: () => { try { return fs.readFileSync(HUB_FORWARDS_FILE, 'utf8').slice(0, 64 * 1024) } catch { return null } },
    parse: parseHubForwards,
    listen: (port, host, onConnection, ready) => {
      const srv = net.createServer({ allowHalfOpen: true }, (sock) => { sock.on('error', () => {}); onConnection(sock) })
      let up = false
      // Before it listens, an error is why it cannot; after (an accept failing), the listener is
      // closed and reported down, so the next read of the file binds the port again.
      srv.on('error', (err) => {
        if (up) { up = false; try { srv.close() } catch { /* not listening */ } }
        ready(err)
      })
      srv.listen(port, host, () => { up = true; ready(null) })
      return { close: () => { up = false; try { srv.close() } catch { /* not listening */ } } }
    },
    links: hubLinks,
    openOut: (link, sock, meta, hooks) => streamRelay.openOut(link, sock as unknown as PortSocket, meta, hooks),
    log: (level, msg, data) => logMsg(level, msg, data),
    now: () => Date.now(),
    every: (ms, fn) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t) },
  })
  /** A leader link bound or closed: each forward listens only while one would take it. Deferred by its callers (after start-up). */
  function hubLinksChanged(): void {
    hubForwards.linksChanged()
  }
  /** `hub.status`: this machine's forwards and how each is doing. Its primary and its own local clients (the CLI); never the bridge, a follower, a lane or a probe. */
  function cmdHubStatus(ws: W, id: number) {
    if (!isServerClient(ws)) return sendError(ws, id, 'hub.status: not for this socket')
    sendOk(ws, id, hubForwards.status())
  }

  // ── The secrets the user shared with this host (capability 'secrets-v1') ──
  // PARITY: The logic is secrets-core.ts.
  const SECRETS_ROOT = secretsRoot(daemonEnv, HOME_DIR)
  const secretStore = createSecretStore(SECRETS_ROOT)
  /** A session's share of them; a store that cannot be read gives none, never a failed spawn. */
  function secretsSessionEnv(): Record<string, string> {
    try { return secretStore.sessionEnv() } catch { return {} }
  }

  // ── Task workspaces (host-local, capability 'workspace-v1') ──
  // PARITY: The logic is workspace-core.ts
  // (shared with the source twin); this twin only hands it the host's spawn/fs.
  const WORKSPACE_STATE_DIR = SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR
  const workspaceCore = createWorkspaceCore({
    spawn: spawn as unknown as WorkspaceCoreDeps['spawn'],
    fs: fs as unknown as WorkspaceCoreDeps['fs'],
    path, homedir: () => HOME_DIR, env: daemonEnv,
    stateDir: WORKSPACE_STATE_DIR,
    // One allowlist per Walnut, its adapters under that Walnut's dir.
    scopeDir: (home) => walnutScope.dirFor(WORKSPACE_STATE_DIR, home),
    randomId: () => crypto.randomBytes(6).toString('hex'),
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal as NodeJS.Signals) },
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  function cmdWorkspace(ws: W, id: number, cmd: Record<string, unknown>) {
    const name = String(cmd.cmd)
    // Every workspace command speaks for one Walnut (its allowlist, its jobs); '' = an older server.
    const scope = walnutScope.resolve(cmd, gatewayClientHomes.get(ws), name)
    if (!scope.ok) return sendError(ws, id, scope.error, { code: 'not_owner' })
    const work = () => workspaceCore.handle(name, cmd, scope.home).then(
      (r) => { if (r.ok) sendOk(ws, id, r); else sendError(ws, id, r.error, r) },
      (err) => sendError(ws, id, name + ' failed: ' + (err as Error).message, { code: 'failed' }),
    )
    // A job poll is a read and must answer during a shutdown; everything else is
    // admitted through the drain so a stopping daemon starts no new provider run.
    if (name === 'workspace.job') return work()
    try {
      return daemonCommands.run(work)
    } catch (err) {
      sendError(ws, id, name + ' refused: ' + (err as Error).message, { code: 'daemon_stopping' })
    }
  }

  return {
    daemonPorts, DAEMON_MACHINE_ID, netSupervisor, hubForwards, hubLinksChanged, cmdHubStatus,
    SECRETS_ROOT, secretStore, secretsSessionEnv,
    WORKSPACE_STATE_DIR, cmdWorkspace,
  }
}
