/**
 * Where `walnut tools call <op> …` reads its JSON arguments from.
 *
 * Shared by BOTH CLI faces (src/providers/wn-cli.ts, bundled into the daemon
 * binary, and src/commands/tools.ts on the hub) so the three spellings behave
 * identically wherever an agent runs.
 *
 * Why this exists at all: the argument used to be argv-only (plus an implicit
 * stdin when stdin was not a TTY). On Linux the kernel caps ONE argv entry at
 * MAX_ARG_STRLEN (128KB, 32 pages) regardless of how much room ARG_MAX leaves,
 * so a letter carrying an inline base64 audio digest died in execve with E2BIG
 * before any Walnut code ran — a client-side "Argument list too long" that looks
 * nothing like a size limit. A payload that big has to arrive by descriptor:
 *
 *   walnut tools call op '{"a":1}'          inline JSON (small payloads)
 *   walnut tools call op @/tmp/letter.json  read the file (any size)
 *   walnut tools call op -                  read stdin explicitly
 *   … | walnut tools call op                read stdin when it is a pipe
 *
 * Pure classification here, I/O at the call sites, so the rules are unit-tested
 * without a filesystem.
 */

export type ArgsSource =
  | { kind: 'inline'; json: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  | { kind: 'none' }
  | { kind: 'usage-error'; message: string }

/**
 * Classify the single positional argument. `stdinIsTty` decides only the
 * ABSENT case: a piped stdin is args, an interactive terminal is "no args"
 * (otherwise `walnut tools call task_list` would hang waiting for the human to
 * type EOF).
 */
export function classifyArgsSource(raw: string | undefined, stdinIsTty: boolean): ArgsSource {
  if (raw === undefined) return stdinIsTty ? { kind: 'none' } : { kind: 'stdin' }
  const value = raw.trim()
  if (value === '-') return { kind: 'stdin' }
  if (value.startsWith('@')) {
    const path = value.slice(1)
    if (!path) return { kind: 'usage-error', message: '@ needs a file path, e.g. @/tmp/letter.json' }
    return { kind: 'file', path }
  }
  if (!value) return { kind: 'none' }
  return { kind: 'inline', json: raw }
}

/**
 * Above this, the payload does not travel INSIDE the gateway request.
 *
 * A gateway call is one NDJSON line on a unix socket and then one WebSocket
 * frame to the hub, so inlining a 100MB letter body would make the biggest thing
 * an agent can send a property of the framing. Over this size the CLI sends only
 * the file's PATH (`argsFile`), and the hub pulls it back from this host's daemon
 * in bounded byte ranges (core/peers/gateway-args-file.ts). A payload on stdin is
 * spilled to a temp file first so it can take the same lane.
 *
 * 1MB keeps every ordinary call on the single-round-trip path — the pull only
 * kicks in for the media-carrying payloads that need it.
 */
export const GATEWAY_INLINE_ARGS_MAX_BYTES = 1024 * 1024

export type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * Parse the raw text into the op's argument object. A JSON array or scalar is
 * rejected by name rather than being coerced: an op's arguments are always an
 * object, and silently wrapping a mistake produces a confusing server error
 * instead of a clear local one.
 */
export function parseToolArgs(text: string): ParsedToolArgs {
  if (!text.trim()) return { ok: true, args: {} }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'arguments must be a JSON object, e.g. \'{"id":"abc"}\'' }
  }
  return { ok: true, args: value as Record<string, unknown> }
}
