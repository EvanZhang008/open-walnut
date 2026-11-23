/**
 * Close a server's socket because the server stops: 1001 (going away), so the peer dials again
 * (the next door of its list), and a terminate once a short grace passed without the peer's close
 * answer. A socket that waits on its peer keeps the process alive: a leader with a host dialed in
 * stayed up for minutes after a SIGTERM (2026-11-23).
 */
import type { WebSocket } from '#ws'

export const GOING_AWAY = 1001
export const GOING_AWAY_GRACE_MS = 1_000

export function closeGoingAway(ws: WebSocket, why = 'stopping', graceMs = GOING_AWAY_GRACE_MS): void {
  try { ws.close(GOING_AWAY, why.slice(0, 100)) } catch { /* terminated below */ }
  if (ws.readyState === ws.CLOSED) return
  const t = setTimeout(() => { try { ws.terminate() } catch { /* gone */ } }, graceMs)
  t.unref?.()
  ws.once('close', () => clearTimeout(t))
}
