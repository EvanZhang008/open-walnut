/**
 * Terminal RPC registration. Wires the terminal methods onto the existing
 * `/ws` handler. `terminal:open` first ensures dtach is provisioned on the
 * target, then answers one of:
 *
 *   { ok: true, terminalId, cols, rows, persistent: true }
 *   { ok: true, terminalId, cols, rows, persistent: false, reason, installHint, installCommand, detail? }
 *   { ok: false, code: 'SSH_FAILED', host, detail, hint }
 *
 * A session holds up to MAX_TERMINAL_SLOTS terminals: `slot` (default 1) picks
 * one, and the answer's terminalId is its key (core/terminal-key.ts), which every
 * other method takes. `terminal:list` names the slots a session has now, so a
 * reload or another device finds the terminals still running, and
 * `terminal:reserve` hands out the slot for a new one.
 *
 * Without dtach (no compiler, failed build) it still opens a terminal, as a
 * plain shell the UI labels "Not persistent" with the fix and a Retry. It used
 * to refuse outright ("never a silent state-losing shell"), which left a host
 * without gcc with no terminal at all; a LOUD fallback keeps the no-silent-loss
 * intent. ssh failures stay blocking: nothing can run there. See dtach-check.ts.
 *
 * The pty is bun's built-in one (src/lib/pty.ts): where it cannot load, terminal
 * support is disabled gracefully (the server still boots).
 */

import type { WebSocket } from '#ws'
import { registerMethod } from '../ws/handler.js'
import { terminalManager } from './terminal-manager.js'
import { probeTerminalMode, type TerminalMode } from './dtach-check.js'
import { endDtachForTerminal } from './terminal-end.js'
import { prewarmRemoteHost } from './spawn.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { log } from '../../logging/index.js'
import { loadPty } from '../../lib/pty.js'
import { isSafeTerminalKey, isTerminalSlot, parseTerminalKey, terminalKeyFor } from '../../core/terminal-key.js'
import { listSessionDtachSlots, terminalShellCwd } from './dtach-lifecycle.js'

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
 * Register terminal RPC. Returns true if the pty loaded and methods were
 * registered; false if there is no pty here (feature disabled).
 */
export async function registerTerminalRpc(): Promise<boolean> {
  try {
    await loadPty()
  } catch (err) {
    log.web.warn('terminal disabled: the pty failed to load', { error: err instanceof Error ? err.message : String(err) })
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
    const slot = o.slot === undefined ? 1 : o.slot
    if (!isTerminalSlot(slot)) throw new Error('terminal:open requires slot to be a whole number from 1 to 8')

    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    // A live terminal is reattached as it is; only an explicit Retry re-probes,
    // because an upgrade replaces the plain shell and loses its state.
    const live = terminalManager.liveMode(terminalKeyFor(sessionId, slot))
    if (live && !reprobe) {
      return openPayload(await terminalManager.open(sessionId, client, cols, rows, live, slot))
    }

    const decision = await probeTerminalMode(record, { fresh: reprobe })
    if (!decision.ok) {
      // A Retry that hit an ssh blip keeps the shell the user already has.
      if (live) return openPayload(await terminalManager.open(sessionId, client, cols, rows, live, slot))
      // Structured payload (not a thrown error) so host/detail survive: thrown
      // errors are flattened to a message string by the WS layer.
      return decision
    }

    return openPayload(await terminalManager.open(sessionId, client, cols, rows, decision.mode, slot))
  })

  // A slot for a new terminal (the "+" and the splits): handed out by this
  // server, so two windows of one session never open the same new shell.
  // `exclude`: the slots the asking window already shows.
  registerMethod('terminal:reserve', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:reserve')
    const sessionId = str(o, 'sessionId', 'terminal:reserve')
    const exclude = Array.isArray(o.exclude) ? o.exclude.filter(isTerminalSlot) : []
    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)
    let hostSlots: number[] = []
    try {
      hostSlots = await listSessionDtachSlots(record)
    } catch (err) {
      log.web.debug('terminal:reserve could not list the host', { sessionId, host: record.host, error: String(err) })
    }
    return { slot: terminalManager.reserveSlot(sessionId, exclude, hostSlots) }
  })

  // The session's terminals now: the slots with a dtach socket on its host, and
  // the ones this process holds (a plain shell has no socket). `listed: false`
  // when the host could not be asked: the page then keeps the tabs it had.
  registerMethod('terminal:list', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:list')
    const sessionId = str(o, 'sessionId', 'terminal:list')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) return { slots: [], listed: true }
    const slots = new Set<number>(terminalManager.liveSlots(sessionId).map((t) => t.slot))
    let listed = true
    try {
      for (const slot of await listSessionDtachSlots(record)) slots.add(slot)
    } catch (err) {
      listed = false
      log.web.debug('terminal:list could not list the host', { sessionId, host: record.host, error: String(err) })
    }
    return { slots: [...slots].sort((a, b) => a - b), listed }
  })

  // The directory a terminal's shell is in now (after a `cd`), and its git root:
  // a relative path in its output is opened from there. null when it cannot be told.
  registerMethod('terminal:cwd', async (payload: unknown) => {
    const o = asObj(payload, 'terminal:cwd')
    const terminalId = str(o, 'terminalId', 'terminal:cwd')
    const { sessionId, slot } = parseTerminalKey(terminalId)
    // Only a terminal key in its own form (it names a socket path the host is asked about).
    const none = { cwd: null, root: null }
    if (terminalKeyFor(sessionId, slot) !== terminalId || !isSafeTerminalKey(terminalId)) return none
    const record = await getSessionByClaudeId(sessionId)
    if (!record) return none
    try {
      const place = await terminalShellCwd({ claudeSessionId: record.claudeSessionId, host: record.host, terminalKey: terminalId }, terminalManager.plainLocalPid(terminalId))
      return place ?? none
    } catch (err) {
      log.web.debug('terminal:cwd failed', { terminalId, host: record.host, error: String(err) })
      return none
    }
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

  registerMethod('terminal:close', async (payload: unknown, client: WebSocket) => {
    const o = asObj(payload, 'terminal:close')
    const terminalId = str(o, 'terminalId', 'terminal:close')
    // Collapse UI / detach only — dtach session + pty kept alive (grace period).
    terminalManager.close(terminalId, client)
  })

  registerMethod('terminal:attach', async (payload: unknown, client: WebSocket) => {
    const o = asObj(payload, 'terminal:attach')
    const terminalId = str(o, 'terminalId', 'terminal:attach')
    const ok = terminalManager.attach(terminalId, client, num(o, 'cols', 80), num(o, 'rows', 24))
    return { ok }
  })

  registerMethod('terminal:kill', async (payload: unknown, client: WebSocket) => {
    const o = asObj(payload, 'terminal:kill')
    const terminalId = str(o, 'terminalId', 'terminal:kill')
    // Explicit "End terminal": release the pty now (for a plain shell that IS
    // the kill) AND kill the persistent dtach session (a no-op without one).
    // A master left running answers { killed: false, unconfirmed, reason }.
    // Other windows viewing it hear it exited.
    terminalManager.end(terminalId, client)
    const record = await getSessionByClaudeId(parseTerminalKey(terminalId).sessionId)
    if (!record) return { killed: true }
    return endDtachForTerminal(terminalId, { claudeSessionId: record.claudeSessionId, host: record.host, terminalKey: terminalId })
  })

  log.web.info('terminal RPC registered')
  return true
}
