/**
 * WebSocket connection manager.
 *
 * Tracks connected clients, broadcasts bus events, and routes
 * incoming RPC requests to registered method handlers.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { WsFrame } from './protocol.js'
import { log } from '../../logging/index.js'

export type RpcHandler = (payload: unknown, client: WebSocket) => unknown | Promise<unknown>

interface Client {
  ws: WebSocket
  seq: number
  alive: boolean
}

let wss: WebSocketServer | null = null
const clients = new Set<Client>()
const rpcMethods = new Map<string, RpcHandler>()

const PING_INTERVAL_MS = 30_000

let pingTimer: ReturnType<typeof setInterval> | null = null

/**
 * Register an RPC method handler.
 * When a client sends `{ type: "req", method: name, ... }`, the handler is called.
 */
export function registerMethod(name: string, handler: RpcHandler): void {
  rpcMethods.set(name, handler)
}

/**
 * Broadcast a bus event to all connected WebSocket clients.
 */
export function broadcastEvent(name: string, data: unknown): void {
  log.ws.debug(`broadcast ${name}`, { clientCount: clients.size })
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue
    client.seq++
    const frame: WsFrame = { type: 'event', name, data, seq: client.seq }
    client.ws.send(JSON.stringify(frame))
  }
}

/**
 * Send a bus event to a single WebSocket client.
 */
export function sendToClient(ws: WebSocket, name: string, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  // Find the client to update its seq counter
  for (const client of clients) {
    if (client.ws === ws) {
      client.seq++
      const frame: WsFrame = { type: 'event', name, data, seq: client.seq }
      ws.send(JSON.stringify(frame))
      return
    }
  }
}

/**
 * Send a streaming event to all connected clients.
 * Clients filter by sessionId on the frontend side.
 */
export function sendStreamEvent(_sessionId: string, name: string, data: unknown): void {
  broadcastEvent(name, data)
}

/**
 * Send an RPC response back to a specific WebSocket client.
 */
function sendResponse(ws: WebSocket, id: string, ok: boolean, payload?: unknown, error?: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const frame: WsFrame = ok
    ? { type: 'res', id, ok: true, payload }
    : { type: 'res', id, ok: false, error }
  ws.send(JSON.stringify(frame))
}

/**
 * Handle an incoming message from a client.
 */
async function handleMessage(client: Client, raw: string): Promise<void> {
  let frame: WsFrame
  try {
    frame = JSON.parse(raw) as WsFrame
  } catch {
    return // ignore malformed JSON
  }

  if (frame.type !== 'req') return // only handle RPC requests from clients

  const handler = rpcMethods.get(frame.method)
  if (!handler) {
    sendResponse(client.ws, frame.id, false, undefined, `Unknown method: ${frame.method}`)
    return
  }

  try {
    const result = await handler(frame.payload, client.ws)
    sendResponse(client.ws, frame.id, true, result ?? undefined)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.ws.error(`RPC handler error for "${frame.method}"`, { error: message })
    sendResponse(client.ws, frame.id, false, undefined, message)
  }
}

/**
 * Attach the WebSocket server to an existing HTTP server via upgrade.
 */
export function attachWss(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    // Only upgrade requests to /ws (or all if no path check needed)
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const client: Client = { ws, seq: 0, alive: true }
    clients.add(client)
    log.ws.info('client connected', { clientCount: clients.size })

    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', (data) => {
      handleMessage(client, data.toString()).catch((err) => {
        log.ws.error('message handler error', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })

    ws.on('close', () => {
      clients.delete(client)
      log.ws.info('client disconnected', { clientCount: clients.size })
    })

    ws.on('error', () => {
      clients.delete(client)
      log.ws.warn('client error, removing', { clientCount: clients.size })
    })
  })

  // Ping/pong heartbeat
  pingTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate()
        clients.delete(client)
        continue
      }
      client.alive = false
      client.ws.ping()
    }
  }, PING_INTERVAL_MS)

  return wss
}

/**
 * Close all connections and stop the WebSocket server.
 */
export function closeWss(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }

  for (const client of clients) {
    client.ws.terminate()
  }
  clients.clear()

  if (wss) {
    wss.close()
    wss = null
  }
}

/**
 * Number of currently connected clients (useful for tests/debugging).
 */
export function clientCount(): number {
  return clients.size
}
