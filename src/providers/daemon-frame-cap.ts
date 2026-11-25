/**
 * The largest message a host's daemon takes on its WebSocket in one frame.
 *
 * The daemon's server is Bun.serve, whose `maxPayloadLength` default is 16 MB: a bigger
 * frame closes the socket (1009). 2026-11-07/08: sessions on clouddev called
 * `walnut tools call api '{"method":"GET","path":"/api/tasks"}'` (34 MB) and `/api/sessions`
 * (27 MB). The Mac answered each in one gateway-result frame, the daemon closed the link,
 * asked the relay again on the next socket, and got the same answer from the relay memo:
 * the link to clouddev died every 3 to 4 s for up to two minutes a time, about 50 to 66
 * deaths an hour in a burst, and every other session's relays and streams on that host
 * went down with it. So nothing this machine sends a daemon goes out over the cap: a
 * command is refused before a byte is written, and a relay's answer is replaced by an
 * error that says how big it was and to ask for less. Ratchet:
 * tests/providers/daemon-frame-cap.test.ts (every socket write of daemon-connection.ts
 * goes through this check, and Bun still closes on a frame over the cap).
 */
import { kbps, type LateAnswer } from './paced-send-gate.js'

/** Bun's WebSocket `maxPayloadLength` default, which the daemon's server keeps. */
export const DAEMON_FRAME_MAX_BYTES = 16 * 1024 * 1024

export class DaemonFrameTooLargeError extends Error {
  readonly code = 'frame_too_large'
  constructor(readonly what: string, readonly bytes: number, readonly host: string) {
    super(`${what} to ${host} is ${mb(bytes)}, over the ${mb(DAEMON_FRAME_MAX_BYTES)} one message to a host can carry; it was not sent`)
    this.name = 'DaemonFrameTooLargeError'
  }
}

/** The refusal's words, for a reader that only has the message (a relayed or wrapped error). */
export const FRAME_TOO_LARGE = /one message to a host can carry; it was not sent/

export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Throws DaemonFrameTooLargeError when `message` would close the daemon's socket. */
export function assertFrameFits(message: string, what: string, host: string): void {
  if (message.length * 3 <= DAEMON_FRAME_MAX_BYTES) return
  const bytes = Buffer.byteLength(message, 'utf8')
  if (bytes > DAEMON_FRAME_MAX_BYTES) throw new DaemonFrameTooLargeError(what, bytes, host)
}

/** The gateway-result that stands in for an answer too large to send. */
export function tooLargeGatewayReply(relayId: number, bytes: number, host: string): Record<string, unknown> {
  return {
    relayId,
    error: `The answer is ${mb(bytes)}, more than the ${mb(DAEMON_FRAME_MAX_BYTES)} one message to ${host} can carry, so it was not sent. `
      + 'Ask for less: a filter, a limit, the fields you need, or one id (task_list or task_get instead of the whole /api/tasks, '
      + 'one /api/sessions/<id> instead of every session).',
    errorCode: 'bad_request',
    detail: { tooLarge: true, bytes, maxBytes: DAEMON_FRAME_MAX_BYTES },
  }
}

/**
 * The small answer a caller gets instead of one that cannot reach its host in time on the paced
 * upload link (paced-send-gate.ts). `bad_request`: asking again for the same at once fails the same
 * way while the link is this slow, so the words say what helps (less, or later).
 */
export function tooSlowGatewayReply(relayId: number, host: string, late: LateAnswer): Record<string, unknown> {
  const ahead = late.aheadKB > 0 ? ` with ${late.aheadKB} KB ahead of it` : ''
  return {
    relayId,
    error: `The answer is ${Math.round(late.bytes / 1024)} KB, and the upload link from the leader to ${host} runs at ${late.paceKBps} KB/s${ahead}: `
      + `it needs about ${late.needSecs} s to get there, and this call has ${late.leftSecs} s left, so it was not sent. `
      + 'Ask for less (a limit, compact, since, the fields you need, one id), or try again in a minute.',
    errorCode: 'bad_request',
    detail: { tooSlow: true, ...late },
  }
}

/** The small answer instead of one that alone takes longer to go up the paced link than the host keeps it open. */
export function neverFitsGatewayReply(relayId: number, host: string, bytes: number, bytesPerSec: number): Record<string, unknown> {
  return {
    relayId,
    error: `The answer is ${Math.round(bytes / 1024)} KB, and the upload link from the leader to ${host} runs at ${kbps(bytesPerSec)} KB/s: `
      + `it would take about ${Math.round(bytes / Math.max(1, bytesPerSec))} s, longer than ${host} keeps a link it hears nothing whole from, so it was not sent. `
      + 'Ask for less: a filter, a limit, compact, the fields you need, or one id.',
    errorCode: 'bad_request',
    detail: { tooSlow: true, never: true, bytes, paceKBps: kbps(bytesPerSec) },
  }
}
