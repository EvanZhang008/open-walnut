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
import { FeatureNodeHub, type FeatureNodeIdentity } from './feature-node-hub.js'
import { setFeatureRequestHandler } from './bridge-registry.js'

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
export function startFeatureNodes(): void {
  serving = true
  lifecycle++
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
  return hub ??= new FeatureNodeHub(clock)
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

export function upgradeFeatureNode(request: IncomingMessage, socket: Duplex, head: Buffer, identity: FeatureNodeIdentity): void {
  if (!serving || !activeSockets.has(identity.authority.nodeId) && activeSockets.size >= 32
    || (sockets?.clients.size ?? 0) >= 64) { socket.destroy(); return }
  sockets ??= new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
    handleProtocols: (protocols) => selectWsProtocol(protocols) })
  sockets.handleUpgrade(request, socket, head, (ws) => attachFeatureNode(ws, identity))
}

export function attachFeatureNode(ws: WebSocket, identity: FeatureNodeIdentity): void {
  ws.on('error', () => {})
  if (!serving) { ws.close(1008, 'feature service unavailable'); return }
  let timer: ReturnType<typeof setInterval> | undefined
  const close = () => { if (timer) clearInterval(timer); ws.terminate() }
  const transport: ReadTransport = {
    state: () => ws.readyState === WebSocket.OPEN ? 'open' : 'closed',
    bufferedBytes: () => ws.bufferedAmount,
    send: (text) => { ws.send(text); return true },
    onMessage: (listener) => {
      const receive = (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
        if (binary) { ws.close(1008, 'invalid feature frame'); return }
        listener(data.toString())
      }
      ws.on('message', receive)
      return () => { ws.off('message', receive) }
    },
    onClose: (listener) => { ws.on('close', listener); return () => { ws.off('close', listener) } },
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
  timer = setInterval(() => {
    if (!serving) { close(); return }
    if (checking) return
    checking = true
    void activeHub.check(identity.authority.nodeId, attached.payload.generation)
      .then((valid) => { if (!valid) close() }).catch(close).finally(() => { checking = false })
  }, 5000)
  timer.unref()
  ws.once('close', () => { if (timer) clearInterval(timer) })
}

export function closeFeatureNodes(): void {
  serving = false
  lifecycle++
  setFeatureRequestHandler(null)
  hub?.close()
  hub = undefined
  activeSockets.clear()
  sockets?.close()
  sockets = undefined
}
