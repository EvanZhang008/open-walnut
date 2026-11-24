/**
 * The shell a session's CLI starts under, and what it starts with: the user's login shell (read
 * ahead from passwd), the host's shell_setup each Walnut's leader sent, the preamble (rc file,
 * shell_setup, fallback tool dirs, a node that runs: session-shell.ts buildSessionPreamble, the
 * one builder the spawn and host.preflight share), the gateway shim on PATH, and the gate that
 * names why claude cannot run here (gateClaudeLaunch).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body (its passwd read starts there); the start (daemon-session-start.ts), the ACP
 * start, host.preflight (hostRuntime) and host_exec use what it returns. The fallback PATH step
 * (spawnFallbackPath) stays in the runtime. The code is the runtime's as it was; deps carry the
 * runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installHomeBin } from './daemon-cli-path.js'
import { knownAccount, primeAccount } from '../lib/account.js'
import { buildSessionPreamble, createShellSetupStore, pickSessionShell, runsAsShell } from './session-shell.js'
import type { ChildProcessUse } from './daemon-child-spawn.js'
import type { createHostRuntime } from './host-runtime-core.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

export interface DaemonSessionShellDeps {
  daemonEnv: DaemonEnv
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  DAEMON_DIR: string
  /** The `walnut` shim dir of the agent gateway. */
  GATEWAY_SHIM_DIR: string
  /** The install home's bin dir, when this daemon installed one (daemon-cli-path.ts). */
  INSTALL_HOME_BIN: string
  childUse: ChildProcessUse
  /** The host's runtime checks (host-runtime-core.ts): can claude, or node, run here. */
  hostRuntime: Pick<ReturnType<typeof createHostRuntime>, 'ensureClaude' | 'shellCanRun'>
  walnutOfHome: (home: string) => string
  /**
   * Whether a Walnut service of the Walnut of `home` runs on this host as its follower (a host
   * replica: its own HTTP root takes no call without a credential, and it said hello here).
   */
  followsHere: (home: string) => boolean
  sessionHomeOf: (sid: string) => string
  /** The fallback tool dirs and the shim dir, as a PATH step (the runtime's). */
  spawnFallbackPath: () => string
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  logMsg: DaemonLog
}

export function createDaemonSessionShell(deps: DaemonSessionShellDeps) {
  const { daemonEnv, SERVICE_MODE, DAEMON_STATE_DIR, DAEMON_DIR, GATEWAY_SHIM_DIR, INSTALL_HOME_BIN, childUse, hostRuntime, walnutOfHome, followsHere, sessionHomeOf, spawnFallbackPath, setTimeout, clearTimeout, logMsg } = deps

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

  /**
   * Whether a session's `walnut` is this daemon's gateway shim, first on its PATH: the one rule
   * every session spawn of this daemon asks (the native start and the ACP start).
   *
   * Shim first for every session but one whose Walnut named an address AND has no follower on
   * this host: the Mac hub's own sessions, whose installed hub CLI talks to that same server over
   * loopback and has the whole command surface (the shim answers tools, wait, approve, pass,
   * browser and guide only), so it stays first there, as it always was.
   *
   *  - No address (every session its Walnut started on a host other than its server's,
   *    self-api-root.ts): it reaches that Walnut only through this daemon. A machine that joined
   *    with a Walnut of its own has that Walnut's `walnut` on PATH ahead of an appended shim, and
   *    it would send the session's calls to the other Walnut's server.
   *  - An address, on a host whose Walnut service follows that Walnut (a session this host
   *    assembled itself, judge 'host'): the address is the replica's own root, which takes no call
   *    without a credential (boot-policy.ts self-api-credential), so only Walnut's own CLI, the
   *    shim (the gateway socket, or the host call entry with WALNUT_CALL_TOKEN), reaches it. An
   *    older released `walnut` the box installed ahead on PATH answered 401 not_paired
   *    (2026-11-24).
   *
   * `home`: the Walnut the start is for (its origin's home, or the one its resume record kept).
   */
  function walnutThroughGateway(env: Record<string, unknown> | undefined, home: unknown): boolean {
    if (sessionWalnutApiUrl(env) === undefined) return true
    return typeof home === 'string' && home !== '' && followsHere(home)
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

  /** A session PATH with the shim dir first or, for the hub's own sessions (walnutThroughGateway false), last. */
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

  return { passwdReady, sessionShell, shellSetupStore, shellSetupOfStart, buildSpawnPreamble, walnutThroughGateway, sessionWalnutApiUrl, sessionPathWithShim, settingsEnvOf, gateClaudeLaunch }
}
