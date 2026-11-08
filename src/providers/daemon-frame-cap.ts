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
