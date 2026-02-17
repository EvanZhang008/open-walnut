/**
 * Mock Session Server — simulates the real session server for testing.
 *
 * Accepts WebSocket connections using the same protocol as the real server.
 * On `session.start`, plays back a scripted sequence of events (a scenario).
 * Supports interactive events that block until a response command arrives.
 *
 * Usage:
 *   const mock = new MockSessionServer()
 *   const port = await mock.start()
 *   mock.setScenario(myScenario)
 *   // ... connect client, run tests ...
 *   await mock.stop()
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import crypto from 'node:crypto'
import type {
  CommandFrame,
  ResponseFrame,
  EventFrame,
  SessionEventName,
  ScriptedEvent,
  MockScenario,
  SessionStartParams,
  SessionSendParams,
  SessionInterruptParams,
  SessionSetModeParams,
  SessionStopParams,
  SessionRespondToQuestionParams,
  SessionRespondToPermissionParams,
  SessionInfo,
} from '../../src/session-server/types.js'

interface PendingWaiter {
  method: string
  resolve: (cmd: CommandFrame) => void
}

interface ActiveSession {
  sessionId: string
  status: 'running' | 'idle' | 'error'
  cwd?: string
  mode?: string
}

export class MockSessionServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private scenario: MockScenario | null = null
  private clients = new Set<WebSocket>()
  private pendingWaiters: PendingWaiter[] = []
  private activeSessions = new Map<string, ActiveSession>()

  /** All commands received from clients, in order. */
  readonly receivedCommands: CommandFrame[] = []

  /** Set the scenario to play back on next session.start */
  setScenario(scenario: MockScenario): void {
    this.scenario = scenario
  }

  /** Start the mock server on a random port. Returns the port number. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer()
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws) => {
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
        ws.on('message', (raw) => {
          try {
            const frame = JSON.parse(raw.toString()) as CommandFrame
            if (frame.type === 'cmd') {
              this.handleCommand(ws, frame)
            }
          } catch {
            // ignore parse errors
          }
        })
      })

      this.httpServer.listen(0, () => {
        const addr = this.httpServer!.address()
        if (typeof addr === 'object' && addr) {
          resolve(addr.port)
        } else {
          reject(new Error('Failed to get server address'))
        }
      })

      this.httpServer.on('error', reject)
    })
  }

  /** Stop the mock server and close all connections. */
  async stop(): Promise<void> {
    for (const ws of this.clients) {
      ws.close()
    }
    this.clients.clear()

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve())
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
  }

  /** Reset state between test cases. */
  reset(): void {
    this.receivedCommands.length = 0
    this.pendingWaiters.length = 0
    this.activeSessions.clear()
    this.scenario = null
  }

  private handleCommand(ws: WebSocket, cmd: CommandFrame): void {
    this.receivedCommands.push(cmd)

    // Check if any scripted event is waiting for this command method
    const waiterIdx = this.pendingWaiters.findIndex((w) => w.method === cmd.method)
    if (waiterIdx >= 0) {
      const [waiter] = this.pendingWaiters.splice(waiterIdx, 1)
      waiter.resolve(cmd)
    }

    switch (cmd.method) {
    case 'session.start':
      this.handleSessionStart(ws, cmd)
      break
    case 'session.send':
      this.handleSessionSend(ws, cmd)
      break
    case 'session.interrupt':
      this.handleSessionInterrupt(ws, cmd)
      break
    case 'session.setMode':
      this.handleSessionSetMode(ws, cmd)
      break
    case 'session.stop':
      this.handleSessionStop(ws, cmd)
      break
    case 'session.respondToQuestion':
      this.handleRespondToQuestion(ws, cmd)
      break
    case 'session.respondToPermission':
      this.handleRespondToPermission(ws, cmd)
      break
    case 'session.list':
      this.handleSessionList(ws, cmd)
      break
    case 'ping':
      this.sendResponse(ws, cmd.id, true, { ok: true })
      break
    default:
      this.sendResponse(ws, cmd.id, false, undefined, `Unknown method: ${cmd.method}`)
    }
  }

  private handleSessionStart(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionStartParams
    const sessionId = params.sessionId ?? `mock-session-${crypto.randomBytes(4).toString('hex')}`

    this.activeSessions.set(sessionId, {
      sessionId,
      status: 'running',
      cwd: params.cwd,
      mode: params.mode,
    })

    // Ack immediately with sessionId
    this.sendResponse(ws, cmd.id, true, { sessionId })

    // Play back scripted events
    if (this.scenario) {
      this.playEvents(ws, sessionId, this.scenario.events)
    }
  }

  private handleSessionSend(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionSendParams
    this.sendResponse(ws, cmd.id, true, { ok: true })

    const session = this.activeSessions.get(params.sessionId)
    if (session) {
      session.status = 'running'
    }

    // Play sendEvents if scenario defines them
    if (this.scenario?.sendEvents) {
      this.playEvents(ws, params.sessionId, this.scenario.sendEvents)
    }
  }

  private handleSessionInterrupt(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionInterruptParams
    const session = this.activeSessions.get(params.sessionId)
    if (session) {
      session.status = 'idle'
    }
    this.sendResponse(ws, cmd.id, true, { ok: true })

    // Emit an interrupted result
    this.sendEvent(ws, params.sessionId, 'session:result', {
      sessionId: params.sessionId,
      result: '',
      subtype: 'interrupted',
    })
  }

  private handleSessionSetMode(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionSetModeParams
    const session = this.activeSessions.get(params.sessionId)
    if (session) {
      session.mode = params.mode
    }
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleSessionStop(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionStopParams
    this.activeSessions.delete(params.sessionId)
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleRespondToQuestion(ws: WebSocket, cmd: CommandFrame): void {
    // The response just acks — the actual unblocking happens via pendingWaiters
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleRespondToPermission(ws: WebSocket, cmd: CommandFrame): void {
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleSessionList(ws: WebSocket, cmd: CommandFrame): void {
    const sessions: SessionInfo[] = []
    for (const [, session] of this.activeSessions) {
      sessions.push({
        sessionId: session.sessionId,
        status: session.status,
        cwd: session.cwd,
        mode: session.mode,
      })
    }
    this.sendResponse(ws, cmd.id, true, { sessions })
  }

  private async playEvents(ws: WebSocket, sessionId: string, events: ScriptedEvent[]): Promise<void> {
    for (const event of events) {
      // Wait for a specific command if required
      if (event.waitForCommand) {
        await this.waitForCommand(event.waitForCommand)
      }

      // Apply delay
      if (event.delay && event.delay > 0) {
        await new Promise((r) => setTimeout(r, event.delay))
      }

      // Inject sessionId into event data if not already present
      const data = typeof event.data === 'object' && event.data !== null
        ? { sessionId, ...event.data as Record<string, unknown> }
        : event.data

      this.sendEvent(ws, sessionId, event.name, data)
    }

    // Mark session as idle after all events played
    const session = this.activeSessions.get(sessionId)
    if (session) {
      session.status = 'idle'
    }
  }

  private waitForCommand(method: string): Promise<CommandFrame> {
    // Check if we already received this command
    const existing = this.receivedCommands.find((c) => c.method === method)
    // Only use commands that haven't been consumed yet by previous waiters
    // Simple approach: always wait for the NEXT one
    return new Promise((resolve) => {
      this.pendingWaiters.push({ method, resolve })
    })
  }

  private sendResponse(ws: WebSocket, id: string, ok: boolean, data?: unknown, error?: string): void {
    const frame: ResponseFrame = { type: 'res', id, ok }
    if (data !== undefined) frame.data = data
    if (error !== undefined) frame.error = error
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }

  private sendEvent(ws: WebSocket, sessionId: string, name: SessionEventName, data: unknown): void {
    const frame: EventFrame = { type: 'event', sessionId, name, data }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
}
