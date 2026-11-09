/**
 * Terminal keys: one session can hold several terminals, each its own dtach
 * session, numbered from 1 ("slot"). The key names everything the terminal owns:
 * its RPC terminalId, its `terminal:data:<key>` events, its dtach socket
 * (`walnut-<key>.dsock`) and pid record.
 *
 * Slot 1 is the session id itself, so the terminal a session had before it could
 * hold several keeps its socket across the upgrade (a running shell reattaches).
 * Slot n > 1 is `<sessionId>__term<n>`. Keys stay inside `[A-Za-z0-9_-]`, because
 * the socket path is put unquoted into a remote ssh command (spawn.ts).
 *
 * Shared by the server and the web app (`@open-walnut/terminal-key`): the page
 * subscribes to a terminal's events before its open answer arrives, so both sides
 * must name a slot the same way. No imports.
 */

export const MAX_TERMINAL_SLOTS = 8

const SLOT_SUFFIX = /^(.+)__term([0-9]{1,2})$/
const SAFE_KEY = /^[A-Za-z0-9_-]+$/

export function isTerminalSlot(slot: unknown): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= MAX_TERMINAL_SLOTS
}

/** The key of a session's terminal in `slot` (1 = the session id). */
export function terminalKeyFor(sessionId: string, slot = 1): string {
  if (!isTerminalSlot(slot)) throw new Error(`Bad terminal slot: ${String(slot)}`)
  return slot === 1 ? sessionId : `${sessionId}__term${slot}`
}

/**
 * The session and slot a key names. A key without a valid slot suffix is slot 1
 * of a session with that id (a session id never ends in `__term<digits>`).
 */
export function parseTerminalKey(key: string): { sessionId: string; slot: number } {
  const m = SLOT_SUFFIX.exec(key)
  if (m) {
    const slot = Number(m[2])
    if (slot >= 2 && isTerminalSlot(slot)) return { sessionId: m[1]!, slot }
  }
  return { sessionId: key, slot: 1 }
}

/** Safe to use as a socket file name and in an unquoted remote command. */
export function isSafeTerminalKey(key: string): boolean {
  return SAFE_KEY.test(key)
}
