/**
 * Whether this Walnut server has begun its own stop, and why (a deploy, an update, a signal).
 *
 * stopServer marks it at its entry, before any daemon link closes, so whatever fails from
 * then on fails because this server is going away, never because a host went away. 2026-11-12:
 * three task moves from this Mac died 1 to 2 s after a deploy began, each recorded as "Walnut is
 * not connected to this Mac right now." (the shutdown had closed the local daemon's link), and
 * each had to be asked for again. A long operation that meets a stop pauses instead and runs
 * again after the next boot (sessions/engine-switch.ts); a daemon call made while stopping
 * throws TransferServerStoppingError, never TransferHostOfflineError
 * (transfer/daemon-transfer-client.ts); sessions/shutdown-death.ts reads the same flag.
 */

let stopping = false
let why: string | undefined

/** This server began its own stop (stopServer's entry). */
export function markServerStopping(): void { stopping = true }

/** A server started in this process again (tests start and stop many). */
export function resetServerStopping(): void { stopping = false; why = undefined }

export function isServerStopping(): boolean { return stopping }

/**
 * Why this server stops, once known: a planned restart's marker (`deploy`, `companion-update`,
 * planned-restart.ts) or stopServer's own `self-update`. A signal name says nothing of why (a
 * deploy stops the server with SIGTERM too), so it is never taken.
 */
export function noteServerStopReason(reason: string | undefined): void {
  if (stopping && reason && WORDS[reason]) why = reason
}

const WORDS: Record<string, string> = { deploy: 'a deploy', 'companion-update': 'an update', 'self-update': 'an update' }

/** The stop in plain words ("a deploy", "an update"), or '' while its reason is not known. */
export function serverStopWords(): string {
  return (why && WORDS[why]) || ''
}

/** " (a deploy)", or nothing: true whatever the stop turns out to be. */
export function serverStopNote(): string {
  const w = serverStopWords()
  return w ? ` (${w})` : ''
}

/** Thrown by work this server's stop cut short; `code` is the answer's error code. */
export class ServerStoppingError extends Error {
  readonly code = 'server_restarting'
  readonly status = 503
  constructor(message?: string) {
    super(message ?? `The Walnut server is restarting${serverStopNote()}.`)
    this.name = 'ServerStoppingError'
  }
}

/**
 * Whether `err` came from this server's stop: thrown as one, or thrown while the stop runs (a
 * failure then says nothing true about the work: links, timers and stores are being torn down).
 */
export function interruptedByShutdown(err: unknown): boolean {
  return err instanceof ServerStoppingError || stopping
}
