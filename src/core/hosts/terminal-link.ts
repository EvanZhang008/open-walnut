/**
 * A terminal over a host's daemon link ('pty-stream-v1', providers/pty-stream-core.ts):
 * the capability and the one sentence every surface says when a host's daemon has none
 * (the host status, a terminal open, the API). Leaf: no runtime imports, so the pure
 * host status and the daemon connection both read it.
 */

export const PTY_STREAM_CAPABILITY = 'pty-stream-v1'

/** Why a host's daemon opens no terminal. Never "not SSH": the connection is not the reason. */
export function ptyStreamMissingSentence(host: string): string {
  return `The Walnut daemon on ${host} needs an update before it can open a terminal (it has no terminal streams: an older build, or one running on Node)`
}
