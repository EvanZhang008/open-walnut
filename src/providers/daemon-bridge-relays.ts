/**
 * The bridge relays: what a phone asks through the cloud bridge that only the walnut server on
 * this host can answer goes to that server (a TRUSTED client) as an event, and its answer comes
 * back as a `*-result` command with the same relayId. STT (`stt`), a session launch
 * (`session.launch`), a session control (`session.control`) and a phone send (`session.message`,
 * moved to the next client when its target closes); plus the reverse direction, the server's
 * mobile events pushed up the bridge (`mobile-event`). The daemon runs, spawns and stores nothing
 * here: each relay is one trusted-client pick, one timeout and one pending map.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), right after the cloud
 * bridge (daemon-cloud-bridge.ts) whose links it reads; its dispatcher answers the relay
 * commands through what it returns, the update's busy check reads the pending maps and the
 * disconnect moves a closed client's phone sends. The code is the runtime's as it was; deps
 * carry the runtime's own names.
 */
import type { createWalnutScope } from './walnut-scope-core.js'
import type { BridgeLink } from './daemon-cloud-bridge.js'
import type { DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonBridgeRelaysDeps<W extends object> extends DaemonReplies<W> {
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The home each trusted socket bound (gateway hello). */
  gatewayClientHomes: WeakMap<W, string>
  /** The trusted client a relay goes to (never a bridge socket), for the Walnut of `home`. */
  pickTrustedClient: (home?: string) => { client: W | null; quiet: number; quietForMs: number | null }
  noPrimaryError: (contract: string, picked: { client: W | null; quiet: number; quietForMs: number | null }) => string
  /** Whether `ws` answers a relay another Walnut's link asked. */
  answersForOtherWalnut: (ws: W, home: string) => boolean
  bridgeHomeOf: (ws: W) => string
  bridgeLinkFor: (home: string) => BridgeLink<W> | null
  wsId: (ws: W) => number
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  logMsg: DaemonLog
  sendEvent: (ws: W, ev: string, data: Record<string, unknown>, local?: Record<string, unknown>) => void
  sendFrame: (ws: W, frame: Record<string, unknown>, local?: Record<string, unknown>) => void
}

export function createDaemonBridgeRelays<W extends object>(deps: DaemonBridgeRelaysDeps<W>) {
  const { walnutScope, gatewayClientHomes, pickTrustedClient, noPrimaryError, answersForOtherWalnut, bridgeHomeOf, bridgeLinkFor, wsId, setTimeout, clearTimeout, logMsg, sendOk, sendError, sendEvent, sendFrame } = deps

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
    ws: W; id: number; timer: ReturnType<typeof setTimeout>
    /** The Walnut whose bridge link asked ('' = an older server's link). */
    home: string
  }>()

  function cmdSttRelay(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdSttResult(ws: W, id: number, cmd: Record<string, unknown>) {
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
    ws: W; id: number; timer: ReturnType<typeof setTimeout>
    /** The Walnut whose bridge link asked ('' = an older server's link). */
    home: string
  }>()

  function cmdLaunchRelay(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdLaunchResult(ws: W, id: number, cmd: Record<string, unknown>) {
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
    ws: W; id: number; timer: ReturnType<typeof setTimeout>
    /** The Walnut whose bridge link asked ('' = an older server's link). */
    home: string
  }>()

  function cmdControlRelay(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdControlResult(ws: W, id: number, cmd: Record<string, unknown>) {
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
    ws: W; id: number; timer: ReturnType<typeof setTimeout>
    /** The trusted client it was handed to, the request as sent, and how often it moved. */
    target: W; request: Record<string, unknown>; hops: number
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
  function rerouteMessageRelays(closed: W): void {
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

  function cmdMessageRelay(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdMessageResult(ws: W, id: number, cmd: Record<string, unknown>) {
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

  function cmdMobileEvent(ws: W, id: number, cmd: Record<string, unknown>) {
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

  return { sttRelayPending, launchRelayPending, controlRelayPending, messageRelayPending, rerouteMessageRelays, cmdSttRelay, cmdSttResult, cmdLaunchRelay, cmdLaunchResult, cmdControlRelay, cmdControlResult, cmdMessageRelay, cmdMessageResult, cmdMobileEvent }
}
