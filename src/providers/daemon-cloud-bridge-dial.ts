/**
 * The cloud bridge's dial (daemon-cloud-bridge.ts keeps the links): one link's start and stop,
 * the dial with its timeout, the redial backoff with its fast window after a healthy link drops,
 * the silence watchdog, the outbound socket the daemon can end at once, the adapter that makes
 * that socket one more client of the dispatcher, and the close line each connection logs.
 *
 * Created once per cloud bridge by createDaemonCloudBridge, at the place its constants had; the
 * configure, the takeover of an older daemon's link and the Walnut-scope fold start and stop
 * links through what it returns. The code is the runtime's as it was; deps carry its own names.
 */
import net from 'node:net'
import { bridgeRedialStep, armsBridgeFastWindow, envTimerMs, BRIDGE_WATCHDOG } from './daemon-core.js'
import { createBridgeUplink } from './bridge-uplink-core.js'
import type { BridgeLink } from './daemon-cloud-bridge.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { SessionData, WsData } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

export interface DaemonCloudBridgeDialDeps<W extends { data: WsData }> {
  daemonEnv: DaemonEnv
  DAEMON_VERSION: string
  DAEMON_INSTANCE_ID: string
  /** What the companion may ask of this daemon, in the hello. */
  BRIDGE_CAPABILITIES: string[]
  /** Bun 1.4.4 or later: a ws:// bridge rides a TCP socket the daemon opens itself (openBridgeClient). */
  BRIDGE_OWN_TCP: boolean
  walnutScope: Pick<ReturnType<typeof createWalnutScope>, 'label'>
  sessions: Map<string, SessionData<W>>
  wsClients: Set<W>
  wsId: (ws: W) => number
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

export function createDaemonCloudBridgeDial<W extends { data: WsData }>(deps: DaemonCloudBridgeDialDeps<W>) {
  const { daemonEnv, DAEMON_VERSION, DAEMON_INSTANCE_ID, BRIDGE_CAPABILITIES, BRIDGE_OWN_TCP, walnutScope, sessions, wsClients, wsId, handleCommand, handleDisconnect, setTimeout, setInterval, clearTimeout, clearInterval, logMsg, sendFrame } = deps

  let bridgeConnSeq = 0

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

  function stopBridge(link: BridgeLink<W>): void {
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

  function startBridge(link: BridgeLink<W>, reason: string): void {
    stopBridge(link)
    if (!link.config?.enabled) return
    link.backoffMs = 1000
    logMsg('info', 'bridge: starting', { reason, url: link.config.url, hostAlias: link.config.hostAlias, scope: walnutScope.label(link.home) })
    dialBridge(link, link.generation)
  }

  function scheduleBridgeRedial(link: BridgeLink<W>, gen: number): void {
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
  function makeBridgeAdapter(client: WebSocket, uplink: ReturnType<typeof createBridgeUplink>, home: string): W {
    const adapter = {
      data: { origin: 'bridge', bridgeHome: home } as WsData,
      get readyState() { return client.readyState },
      send(payload: string): number {
        return uplink.send(payload) === 'sent' ? payload.length : -1
      },
      close() { try { client.close() } catch {} },
    }
    return adapter as unknown as W
  }

  /** One `bridge-conn-close` line per opened connection (counts and sizes only). */
  function logBridgeConnClose(link: BridgeLink<W>, info: { code: number | null; reason: string; wasClean: boolean | null }): void {
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

  function dialBridge(link: BridgeLink<W>, gen: number): void {
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

  return { BRIDGE_DIAL_TIMEOUT_MS, stopBridge, startBridge }
}
