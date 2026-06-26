/**
 * Terminal RPC registration. Wires the 6 terminal methods onto the existing
 * `/ws` handler. `terminal:open` first ensures dtach is provisioned on the
 * target; if it can't be built it rejects with a structured NO_DTACH error so
 * the UI can show an install hint instead of silently giving a state-losing
 * shell.
 *
 * node-pty is a native binary — if it fails to load, terminal support is
 * disabled gracefully (the server still boots).
 */

import type { WebSocket } from 'ws'
import { registerMethod } from '../ws/handler.js'
import { terminalManager } from './terminal-manager.js'
import { probeDtach } from './dtach-check.js'
import { killDtachSession } from './dtach-lifecycle.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { log } from '../../logging/index.js'

function asObj(payload: unknown, method: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`${method} requires an object payload`)
  }
  return payload as Record<string, unknown>
}

function str(o: Record<string, unknown>, key: string, method: string): string {
  const v = o[key]
  if (typeof v !== 'string' || !v) throw new Error(`${method} requires ${key} (string)`)
  return v
}

function num(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/**
 * Register terminal RPC. Returns true if node-pty loaded and methods were
 * registered; false if the native binary is unavailable (feature disabled).
 */
export async function registerTerminalRpc(): Promise<boolean> {
  try {
    await import('@homebridge/node-pty-prebuilt-multiarch')
  } catch (err) {
    log.web.warn('terminal disabled: node-pty failed to load', { error: err instanceof Error ? err.message : String(err) })
    return false
  }

  registerMethod('terminal:open', async (payload: unknown, client: WebSocket) => {
    const o = asObj(payload, 'terminal:open')
    const sessionId = str(o, 'sessionId', 'terminal:open')
    const cols = num(o, 'cols', 80)
    const rows = num(o, 'rows', 24)

    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const probe = await probeDtach(record)
    if (!probe.ok) {
      // Return as a structured payload (not a thrown error) so the install hint
      // survives — thrown errors are flattened to a message string by the WS layer.
      return { ok: false, code: 'NO_DTACH', host: probe.host, installHint: probe.installHint }
    }

    const result = await terminalManager.open(sessionId, client, cols, rows)
    return { ok: true, ...result }
  })

  registerMethod('terminal:input', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:input')
    const terminalId = str(o, 'terminalId', 'terminal:input')
    const data = typeof o.data === 'string' ? o.data : ''
    terminalManager.input(terminalId, data)
  })

  registerMethod('terminal:resize', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:resize')
    const terminalId = str(o, 'terminalId', 'terminal:resize')
    terminalManager.resize(terminalId, num(o, 'cols', 80), num(o, 'rows', 24))
  })

  registerMethod('terminal:close', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:close')
    const terminalId = str(o, 'terminalId', 'terminal:close')
    // Collapse UI / detach only — dtach session + pty kept alive (grace period).
    terminalManager.close(terminalId)
  })

  registerMethod('terminal:attach', async (payload: unknown, client: WebSocket) => {
    const o = asObj(payload, 'terminal:attach')
    const terminalId = str(o, 'terminalId', 'terminal:attach')
    const ok = terminalManager.attach(terminalId, client, num(o, 'cols', 80), num(o, 'rows', 24))
    return { ok }
  })

  registerMethod('terminal:kill', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:kill')
    const terminalId = str(o, 'terminalId', 'terminal:kill')
    // Explicit "End terminal": detach the pty AND kill the persistent dtach session.
    terminalManager.close(terminalId)
    const record = await getSessionByClaudeId(terminalId)
    if (record) await killDtachSession(record)
    return { killed: true }
  })

  log.web.info('terminal RPC registered')
  return true
}
