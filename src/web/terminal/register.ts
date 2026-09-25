/**
 * Terminal RPC registration. Wires the terminal methods onto the existing
 * `/ws` handler. `terminal:open` first ensures dtach is provisioned on the
 * target, then answers one of:
 *
 *   { ok: true, terminalId, cols, rows, persistent: true }
 *   { ok: true, terminalId, cols, rows, persistent: false, reason, installHint, installCommand, detail? }
 *   { ok: false, code: 'SSH_FAILED', host, detail, hint }
 *
 * Without dtach (no compiler, failed build) it still opens a terminal, as a
 * plain shell the UI labels "Not persistent" with the fix and a Retry. It used
 * to refuse outright ("never a silent state-losing shell"), which left a host
 * without gcc with no terminal at all; a LOUD fallback keeps the no-silent-loss
 * intent. ssh failures stay blocking: nothing can run there. See dtach-check.ts.
 *
 * node-pty is a native binary — if it fails to load, terminal support is
 * disabled gracefully (the server still boots).
 */

import type { WebSocket } from 'ws'
import { registerMethod } from '../ws/handler.js'
import { terminalManager } from './terminal-manager.js'
import { probeTerminalMode, type TerminalMode } from './dtach-check.js'
import { killDtachSession } from './dtach-lifecycle.js'
import { prewarmRemoteHost } from './spawn.js'
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

/** Flatten an open result into the wire shape: `{ ok: true, ...ids, ...mode }`. */
function openPayload(r: { terminalId: string; cols: number; rows: number; mode: TerminalMode }) {
  const { mode, ...ids } = r
  return { ok: true as const, ...ids, ...mode }
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
    // Set by the UI's Retry: re-probe now (skip a cached failure) and upgrade a
    // live plain shell if dtach turns out to be available.
    const reprobe = o.reprobe === true

    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    // A live terminal is reattached as it is; only an explicit Retry re-probes,
    // because an upgrade replaces the plain shell and loses its state.
    const live = terminalManager.liveMode(sessionId)
    if (live && !reprobe) {
      return openPayload(await terminalManager.open(sessionId, client, cols, rows, live))
    }

    const decision = await probeTerminalMode(record, { fresh: reprobe })
    if (!decision.ok) {
      // A Retry that hit an ssh blip keeps the shell the user already has.
      if (live) return openPayload(await terminalManager.open(sessionId, client, cols, rows, live))
      // Structured payload (not a thrown error) so host/detail survive: thrown
      // errors are flattened to a message string by the WS layer.
      return decision
    }

    return openPayload(await terminalManager.open(sessionId, client, cols, rows, decision.mode))
  })

  // Prewarm: open the remote host's ControlMaster + provision dtach ahead of the
  // click so a later terminal:open is ~0.2s instead of ~2.5s. Fire-and-forget
  // from the UI when a remote session panel mounts. No-op for local sessions.
  registerMethod('terminal:prewarm', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:prewarm')
    const sessionId = str(o, 'sessionId', 'terminal:prewarm')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) return { warmed: false } // session gone; nothing to warm
    // Don't await — return immediately so the UI's fire-and-forget call resolves
    // fast; the warming happens in the background and the next open reuses it.
    void prewarmRemoteHost(record.host)
    return { warmed: Boolean(record.host) }
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
    // Explicit "End terminal": release the pty now (for a plain shell that IS
    // the kill) AND kill the persistent dtach session (a no-op without one).
    terminalManager.end(terminalId)
    const record = await getSessionByClaudeId(terminalId)
    if (record) await killDtachSession(record)
    return { killed: true }
  })

  log.web.info('terminal RPC registered')
  return true
}
