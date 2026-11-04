import path from 'node:path'
import { WebSocket, WebSocketServer } from '#ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WALNUT_HOME } from '../../constants.js'
import { selectWsProtocol } from '../../lib/ws-bearer-protocol.js'
import { FeatureNodeStore } from '../../core/feature-nodes/node-store.js'
import { discoveryRequest } from '../../core/feature-nodes/discovery.js'
import type { ReadTransport } from '../../core/feature-nodes/connections.js'
import type { Clock } from '../../core/feature-nodes/protocol.js'
import { ConnectionJournal } from '../../core/feature-nodes/connection-journal.js'
import { takePlannedRestart } from '../../core/planned-restart.js'
import { buildIdOf } from '../../core/companion-build/wire.js'
import { getBuildInfo } from '../../lib/build-info.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { FeatureNodeHub, type FeatureNodeIdentity, type FeatureNodeStop } from './feature-node-hub.js'
import { setFeatureRequestHandler } from './bridge-registry.js'

const log = createSubsystemLogger('feature-nodes')

const clock: Clock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
let hub: FeatureNodeHub | undefined
let sockets: WebSocketServer | undefined
const activeSockets = new Map<string, WebSocket>()
let upgrades = 0
let serving = false
let lifecycle = 0
let stopping: Promise<void> | undefined
let journal: ConnectionJournal | undefined

/** This server's connection journal (core/feature-nodes/connection-journal.ts); every event is also one log line. */
export function featureNodeJournal(): ConnectionJournal {
  return journal ??= new ConnectionJournal(path.join(WALNUT_HOME, 'local', 'feature-nodes', 'connections.jsonl'), {
    onLine: ({ type, ...meta }) => log.info(`feature node journal: ${type}`, meta),
    onProblem: (message, meta) => log.warn(message, meta),
  })
}

function buildId(): string {
  try { return buildIdOf(getBuildInfo()) } catch { return 'unknown' }
}

function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })])
    .finally(() => { if (timer) clearTimeout(timer) })
}

export function startFeatureNodes(): void {
  serving = true
  lifecycle++
  stopping = undefined
  featureNodeJournal().record({ type: 'server_started', build: buildId() })
  hub ??= new FeatureNodeHub(clock, featureNodeJournal())
  // A marker the previous server never took (an older build, a SIGKILL) is not this server's to read at its stop.
  void takePlannedRestart(WALNUT_HOME).then((stale) => {
    if (stale) log.info('planned-restart marker the previous server never took, removed', { reason: stale.reason, build: stale.build })
  })
  setFeatureRequestHandler(async (frame) => {
    if (!serving) return { success: false, code: 'offline' }
    const query = discoveryRequest(frame)
    if (query?.type === 'list') return { success: true, payload: await featureNodeHub().page(query.after) }
    if (query?.type === 'lookup') return { success: true, payload: await featureNodeHub().lookup(query.nodeId) }
    return featureNodeHub().read(frame)
  })
}
export function featureNodeStore(): FeatureNodeStore {
  return new FeatureNodeStore(path.join(WALNUT_HOME, 'secrets', 'feature-nodes.json'))
}
export function featureNodeHub(): FeatureNodeHub {
  if (!serving) throw new Error('Feature service unavailable')
  return hub ??= new FeatureNodeHub(clock, featureNodeJournal())
}

export async function verifyFeatureNode(token: string): Promise<FeatureNodeIdentity | undefined> {
  const result = await authenticateFeatureNode(token)
  return result.success ? result.identity : undefined
}

export async function authenticateFeatureNode(token: string): Promise<
  { success: true; identity: FeatureNodeIdentity } | { success: false; code: 'denied' | 'unavailable' }
> {
  if (!serving || upgrades >= 8) return { success: false, code: 'unavailable' }
  const generation = lifecycle
  upgrades++
  const store = featureNodeStore()
  const verified = store.verify(token)
  void verified.finally(() => { upgrades-- }).catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      verified.then((authority) => ({ authority, completed: true as const })),
      new Promise<{ completed: false }>((resolve) => { timer = setTimeout(() => resolve({ completed: false }), 1000) }),
    ])
    if (!result.completed || !serving || generation !== lifecycle) return { success: false, code: 'unavailable' }
    if (!result.authority) return { success: false, code: 'denied' }
    return { success: true, identity: { authority: result.authority, verify: () => store.verify(token) } }
  } catch { return { success: false, code: 'unavailable' } }
  finally { if (timer) clearTimeout(timer) }
}

function refused(identity: FeatureNodeIdentity, code: 'offline' | 'busy'): void {
  try {
    featureNodeJournal().record({ type: 'disconnected', nodeId: identity.authority.nodeId, cause: 'refused', code })
  } catch { /* evidence never changes the answer */ }
}

export function upgradeFeatureNode(request: IncomingMessage, socket: Duplex, head: Buffer, identity: FeatureNodeIdentity): void {
  if (!serving || !activeSockets.has(identity.authority.nodeId) && activeSockets.size >= 32
    || (sockets?.clients.size ?? 0) >= 64) { refused(identity, serving ? 'busy' : 'offline'); socket.destroy(); return }
  sockets ??= new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
    handleProtocols: (protocols) => selectWsProtocol(protocols) })
  sockets.handleUpgrade(request, socket, head, (ws) => attachFeatureNode(ws, identity))
}

export function attachFeatureNode(ws: WebSocket, identity: FeatureNodeIdentity): void {
  ws.on('error', () => {})
  if (!serving) { refused(identity, 'offline'); ws.close(1008, 'feature service unavailable'); return }
  let timer: ReturnType<typeof setInterval> | undefined
  const close = (code?: number, reason?: string) => {
    if (timer) clearInterval(timer)
    if (code === undefined) { ws.terminate(); return }
    try { ws.close(code, reason) } catch { ws.terminate(); return }
    // A peer that never answers the close frame would hold the socket for ws's 30 s close timeout.
    setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate() }, 1000).unref()
  }
  const transport: ReadTransport = {
    state: () => ws.readyState === WebSocket.OPEN ? 'open' : 'closed',
    bufferedBytes: () => ws.bufferedAmount,
    send: (text) => { ws.send(text); return true },
    onMessage: (listener) => {
      // A binary frame is no feature frame: the hub refuses it (protocol_error) and closes with 1008.
      const receive = (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => { listener(binary ? data : data.toString()) }
      ws.on('message', receive)
      return () => { ws.off('message', receive) }
    },
    onClose: (listener) => {
      const closed = (code: number, reason: Buffer) => { listener(code, reason.toString('utf8')) }
      ws.on('close', closed)
      return () => { ws.off('close', closed) }
    },
    onError: (listener) => { ws.on('error', listener); return () => { ws.off('error', listener) } },
    close,
  }
  const activeHub = featureNodeHub()
  const attached = activeHub.attach(identity, transport)
  if (!attached.success) { ws.close(1008, 'feature connection refused'); return }
  activeSockets.set(identity.authority.nodeId, ws)
  ws.once('close', () => {
    if (activeSockets.get(identity.authority.nodeId) === ws) activeSockets.delete(identity.authority.nodeId)
  })
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'ready', generation: attached.payload.generation,
    nodeId: identity.authority.nodeId, accountId: identity.authority.accountId }))
  let checking = false
  const { nodeId } = identity.authority
  const { generation } = attached.payload
  // Through the hub first, so the journal names why (a no-op when the hub already dropped it).
  const end = () => { activeHub.disconnect(nodeId, generation, 'credential_check_failed'); close() }
  timer = setInterval(() => {
    if (!serving) { close(); return }
    if (checking) return
    checking = true
    void activeHub.check(nodeId, generation)
      .then((valid) => { if (!valid) end() }).catch(end).finally(() => { checking = false })
  }, 5000)
  timer.unref()
  ws.once('close', () => { if (timer) clearInterval(timer) })
}

/**
 * The server stops (stopServer, first thing): the stop's reason is a planned restart's
 * marker when one was left (core/planned-restart.ts), else the signal, else `unknown`.
 * Every node is closed with 1012 and given a moment to see it before the process ends.
 */
export function stopFeatureNodes(stopReason?: string): Promise<void> {
  if (!serving) return stopping ?? Promise.resolve()
  return stopping ??= (async () => {
    const started = Date.now()
    const planned = await bounded(takePlannedRestart(WALNUT_HOME), 300, null)
    const open = [...activeSockets.values()]
    const reason = planned?.reason ?? stopReason ?? 'unknown'
    // stopServer's reason: a signal name, or 'self-update' / 'parent_gone'; only a signal fills `signal`.
    const signal = stopReason && /^SIG[A-Z0-9]+$/.test(stopReason) ? stopReason : undefined
    closeFeatureNodes({ reason, build: buildId(), ...(signal ? { signal } : {}), ...(planned?.build ? { nextBuild: planned.build } : {}) })
    const gone = (ws: WebSocket) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.once('close', () => resolve())
    })
    const settled = await bounded(Promise.all([featureNodeJournal().flush(), ...open.map(gone)]).then(() => true), 500, false)
    for (const ws of open) if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    log.info('feature nodes stopped', { reason, nodes: open.length, settled, ms: Date.now() - started })
  })()
}

export function closeFeatureNodes(stop?: FeatureNodeStop): void {
  serving = false
  lifecycle++
  setFeatureRequestHandler(null)
  void hub?.close(stop ?? { reason: 'unknown', build: buildId() })
  hub = undefined
  activeSockets.clear()
  sockets?.close()
  sockets = undefined
}
