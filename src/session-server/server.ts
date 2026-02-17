/**
 * Session Server — WebSocket server that wraps @anthropic-ai/claude-agent-sdk.
 *
 * Lightweight Node.js process. Single responsibility: wrap the Agent SDK.
 * No Express, no REST API — WebSocket only.
 *
 * Accepts commands from Walnut, manages SdkSession instances, streams
 * ALL events back (text, tools, questions, plan, compact, permissions).
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { SdkSession } from './sdk-session.js'
import { StateManager } from './state.js'
import type {
  CommandFrame,
  ResponseFrame,
  EventFrame,
  SessionEventName,
  SessionStartParams,
  SessionSendParams,
  SessionInterruptParams,
  SessionSetModeParams,
  SessionStopParams,
  SessionRespondToQuestionParams,
  SessionRespondToPermissionParams,
  SessionInfo,
} from './types.js'

export interface SessionServerOptions {
  port: number
  dataDir: string
}

export class SessionServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private sessions = new Map<string, SdkSession>()
  private state: StateManager
  private clients = new Set<WebSocket>()

  constructor(private options: SessionServerOptions) {
    this.state = new StateManager(options.dataDir)
  }

  /** Start the WebSocket server. Returns the actual port. */
  async start(): Promise<number> {
    // Load persisted sessions (mark all as idle on restart)
    const persisted = this.state.getAll()
    for (const p of persisted) {
      // Don't auto-resume — Walnut decides when to resume
      this.state.remove(p.sessionId)
    }

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
            // Ignore parse errors
          }
        })
      })

      this.httpServer.listen(this.options.port, () => {
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

  /** Stop the server and clean up all sessions. */
  async stop(): Promise<void> {
    // Stop all active sessions
    for (const [, session] of this.sessions) {
      session.stop()
    }
    this.sessions.clear()

    // Close all WebSocket connections
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

  private async handleCommand(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    try {
      switch (cmd.method) {
      case 'session.start':
        await this.handleSessionStart(ws, cmd)
        break
      case 'session.send':
        await this.handleSessionSend(ws, cmd)
        break
      case 'session.interrupt':
        await this.handleSessionInterrupt(ws, cmd)
        break
      case 'session.setMode':
        await this.handleSessionSetMode(ws, cmd)
        break
      case 'session.stop':
        await this.handleSessionStop(ws, cmd)
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
    } catch (err) {
      this.sendResponse(ws, cmd.id, false, undefined, err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSessionStart(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    const params = cmd.params as SessionStartParams
    const sessionId = params.sessionId ?? `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create event emitter that broadcasts to all connected clients
    const emitEvent = (name: SessionEventName, data: unknown) => {
      this.broadcastEvent(sessionId, name, data)
    }

    const session = new SdkSession(sessionId, emitEvent)
    this.sessions.set(sessionId, session)

    // Persist session state
    this.state.set(sessionId, {
      cwd: params.cwd,
      mode: params.mode,
      startedAt: new Date().toISOString(),
    })

    // Ack immediately with sessionId
    this.sendResponse(ws, cmd.id, true, { sessionId })

    // Start the session (async — events will stream back)
    session.start({
      message: params.message,
      cwd: params.cwd,
      mode: params.mode,
      systemPrompt: params.systemPrompt,
      sessionId: params.sessionId,
    }).catch((err) => {
      this.broadcastEvent(sessionId, 'session:error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private async handleSessionSend(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    const params = cmd.params as SessionSendParams
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      this.sendResponse(ws, cmd.id, false, undefined, `Session not found: ${params.sessionId}`)
      return
    }

    this.sendResponse(ws, cmd.id, true, { ok: true })

    session.send(params.message).catch((err) => {
      this.broadcastEvent(params.sessionId, 'session:error', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private async handleSessionInterrupt(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    const params = cmd.params as SessionInterruptParams
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      this.sendResponse(ws, cmd.id, false, undefined, `Session not found: ${params.sessionId}`)
      return
    }

    await session.interrupt()
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private async handleSessionSetMode(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    const params = cmd.params as SessionSetModeParams
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      this.sendResponse(ws, cmd.id, false, undefined, `Session not found: ${params.sessionId}`)
      return
    }

    await session.setMode(params.mode)
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private async handleSessionStop(ws: WebSocket, cmd: CommandFrame): Promise<void> {
    const params = cmd.params as SessionStopParams
    const session = this.sessions.get(params.sessionId)
    if (session) {
      session.stop()
      this.sessions.delete(params.sessionId)
      this.state.remove(params.sessionId)
    }
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleRespondToQuestion(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionRespondToQuestionParams
    const session = this.sessions.get(params.sessionId)
    if (session) {
      session.resolveQuestion(params.questionId, params.answers)
    }
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleRespondToPermission(ws: WebSocket, cmd: CommandFrame): void {
    const params = cmd.params as SessionRespondToPermissionParams
    const session = this.sessions.get(params.sessionId)
    if (session) {
      session.resolvePermission(params.requestId, params.allow, params.message)
    }
    this.sendResponse(ws, cmd.id, true, { ok: true })
  }

  private handleSessionList(ws: WebSocket, cmd: CommandFrame): void {
    const sessions: SessionInfo[] = []
    for (const [id, session] of this.sessions) {
      sessions.push({
        sessionId: session.sessionId ?? id,
        status: session.status,
        cwd: session.cwd,
        mode: session.mode,
      })
    }
    this.sendResponse(ws, cmd.id, true, { sessions })
  }

  private sendResponse(ws: WebSocket, id: string, ok: boolean, data?: unknown, error?: string): void {
    const frame: ResponseFrame = { type: 'res', id, ok }
    if (data !== undefined) frame.data = data
    if (error !== undefined) frame.error = error
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }

  private broadcastEvent(sessionId: string, name: SessionEventName, data: unknown): void {
    const frame: EventFrame = { type: 'event', sessionId, name, data }
    const payload = JSON.stringify(frame)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    }
  }
}
