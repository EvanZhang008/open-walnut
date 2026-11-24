/**
 * The cloud bridge: this daemon dials OUT to the cloud companion, one link per Walnut, and
 * treats the outbound socket as one more authenticated client (its frames go through the same
 * dispatch, the JSONL fan-out reaches it as any subscriber). A link's config arrives by
 * `bridge.configure` and persists to bridge.json, so a restarted daemon re-dials on its own.
 * Here: the links and their files, which Walnut a bridge socket speaks for, configure, status and
 * peer; a link's dial, redial, watchdog and adapter are daemon-cloud-bridge-dial.ts, made here.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers `bridge.configure`, `bridge.peer` and `bridge.status`
 * through what it returns, Main loads and starts the saved links, cleanup stops them, and the
 * relays, the gateway and the Walnut-scope fold read the links. The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decideBridgeRestart } from './daemon-core.js'
import { createBridgeUplink, createLoopDriftProbe } from './bridge-uplink-core.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { SessionData, WsData } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'
import { createDaemonCloudBridgeDial } from './daemon-cloud-bridge-dial.js'

// `scoped: 1` marks a file written since the per-Walnut split. An unnamed file
// without it is the one global copy an older daemon kept (see BridgeLink.inherited).
export interface BridgeConfig { enabled: boolean; url: string; token: string; hostAlias: string; home?: string; scoped?: 1 }

/**
 * One cloud uplink per Walnut (2026-11-03): two Walnuts on this daemon each keep
 * their own link, and one's configure, re-push or enabled:false never touches the
 * other's (each re-push used to tear the other's link down). Keyed by the Walnut's
 * home (walnutScope); '' is a server older than the split, which keeps the legacy
 * bridge.json. A link's adapter carries its home (`data.bridgeHome`), so what
 * arrives on it acts for that Walnut only.
 */
export interface BridgeLink<W extends object> {
  home: string
  config: BridgeConfig | null
  // An unnamed copy an older daemon left: a named configure of its Walnut takes it
  // over (takeOverInheritedBridge), so one Walnut never holds two links to one companion.
  inherited: boolean
  // The sockets that pushed this link's configure: they serve its relays before
  // (or without) binding their home, as a server pushes at connect.
  pushers: WeakSet<W>
  client: WebSocket | null
  adapter: W | null
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

export interface DaemonCloudBridgeDeps<W extends { data: WsData }> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  /** The scope dirs another Walnut leaves under these tell onlyWalnutHere it is not alone. */
  HOOKS_DIR: string
  TRIGGER_STATE_DIR: string
  TRIGGERS_BASE_DIR: string
  WORKSPACE_STATE_DIR: string
  DAEMON_VERSION: string
  DAEMON_INSTANCE_ID: string
  /** What the companion may ask of this daemon, in the hello. */
  BRIDGE_CAPABILITIES: string[]
  /** Bun 1.4.4 or later: a ws:// bridge rides a TCP socket the daemon opens itself (openBridgeClient). */
  BRIDGE_OWN_TCP: boolean
  walnutScope: ReturnType<typeof createWalnutScope>
  sessions: Map<string, SessionData<W>>
  wsClients: Set<W>
  /** The home each trusted socket bound (gateway hello). */
  gatewayClientHomes: WeakMap<W, string>
  socketWalnut: (ws: W) => string | undefined
  wsId: (ws: W) => number
  isJournalSid: (sid: unknown) => sid is string
  journaledIds: () => Set<string>
  /** Drop the runtime's cached spawn-journal ids: the next journaledIds() reads the file again. */
  forgetJournaledSids: () => void
  sessionStartHomeOf: (sid: string) => string
  handleCommand: (ws: W, msg: string) => void
  handleDisconnect: (ws: W) => void
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  setInterval: typeof globalThis.setInterval
  clearTimeout: typeof globalThis.clearTimeout
  clearInterval: typeof globalThis.clearInterval
  logMsg: DaemonLog
  sendFrame: (ws: W, frame: Record<string, unknown>, local?: Record<string, unknown>) => void
}

export function createDaemonCloudBridge<W extends { data: WsData }>(deps: DaemonCloudBridgeDeps<W>) {
  const { daemonEnv, DAEMON_DIR, HOOKS_DIR, TRIGGER_STATE_DIR, TRIGGERS_BASE_DIR, WORKSPACE_STATE_DIR, DAEMON_VERSION, DAEMON_INSTANCE_ID, BRIDGE_CAPABILITIES, BRIDGE_OWN_TCP, walnutScope, sessions, wsClients, gatewayClientHomes, socketWalnut, wsId, isJournalSid, journaledIds, forgetJournaledSids, sessionStartHomeOf, handleCommand, handleDisconnect, setTimeout, setInterval, clearTimeout, clearInterval, logMsg, sendOk, sendError, sendFrame } = deps

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

  const bridgeLinks = new Map<string, BridgeLink<W>>()
  // An older server (no home) pushed since boot: another Walnut is here, so a
  // leftover copy is never taken over just for being the only Walnut known.
  let bridgeUnnamedPushed = false

  function newBridgeLink(home: string): BridgeLink<W> {
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
  function bridgeLinkOf(ws: W): BridgeLink<W> | null {
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
  function bridgeLinkFor(home: string): BridgeLink<W> | null {
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
  function servesBridgeHome(client: W, home: string): boolean {
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
  function bridgeHearsSession(client: W, sid: string): boolean {
    const own = bridgeHomeOf(client)
    if (!own) return true
    // Another daemon may have journaled it since this one read the journal: judge on the file as it is now.
    if (isJournalSid(sid) && !journaledIds().has(sid)) forgetJournaledSids()
    const owner = sessionStartHomeOf(sid)
    return !owner || owner === own
  }

  /** Whether bridge socket `ws` may act for `home`: a named link for its own Walnut only. */
  function bridgeSpeaksFor(ws: W, home: string): boolean {
    const own = bridgeHomeOf(ws)
    return !own || own === home
  }

  /** The home a bridge socket speaks for ('' = an older server's link, or not a bridge). */
  function bridgeHomeOf(ws: W): string {
    return ws.data?.origin === 'bridge' ? ws.data.bridgeHome ?? '' : ''
  }

  // The dial, its redial and watchdog, the adapter (daemon-cloud-bridge-dial.ts).
  const { BRIDGE_DIAL_TIMEOUT_MS, stopBridge, startBridge } = createDaemonCloudBridgeDial({ daemonEnv, DAEMON_VERSION, DAEMON_INSTANCE_ID, BRIDGE_CAPABILITIES,
    BRIDGE_OWN_TCP, walnutScope, sessions, wsClients, wsId, handleCommand, handleDisconnect, setTimeout, setInterval, clearTimeout, clearInterval, logMsg, sendFrame })

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
  function takeOverInheritedBridge(home: string, cmd: Record<string, unknown>, own: BridgeLink<W> | null): BridgeLink<W> | null {
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

  function cmdBridgeConfigure(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdBridgePeer(ws: W, id: number, cmd: Record<string, unknown>) {
    const link = bridgeLinkOf(ws)
    if (!link || !link.uplink) return sendError(ws, id, 'bridge.peer: not the bridge socket')
    const chunkBytes = link.uplink.setChunkBytes(cmd.chunkBytes)
    logMsg('info', 'bridge: peer reassembles chunks', { connId: link.connId, chunkBytes })
    sendOk(ws, id, { chunkBytes })
  }

  /** The asking Walnut's link: the home it names, else the one its socket speaks for. */
  function cmdBridgeStatus(ws: W, id: number, cmd: Record<string, unknown>) {
    if (walnutScope.foreign(cmd, gatewayClientHomes.get(ws))) return sendError(ws, id, 'bridge.status: this socket speaks for another Walnut')
    const link = bridgeLinkFor(walnutScope.askedHome(cmd) || (gatewayClientHomes.get(ws) ?? ''))
    sendOk(ws, id, {
      connected: link?.adapter != null,
      connId: link?.adapter != null ? link.connId : null,
      queuedBytes: link?.uplink?.queuedBytes ?? 0,
      inFlightBytes: link?.uplink?.inFlightBytes ?? 0,
    })
  }

  return { BRIDGE_FILE, bridgeLinks, bridgeFileFor, bridgeLinkOf, bridgeLinkFor, servesBridgeHome, bridgeHearsSession, bridgeSpeaksFor, bridgeHomeOf, loadBridgeConfig, startBridges, stopBridges, bridgeConfigKey, cmdBridgeConfigure, stopBridge, startBridge, cmdBridgePeer, cmdBridgeStatus }
}
