/**
 * Where `walnut tools call <op> …` reads its JSON arguments from.
 *
 * Shared by BOTH CLI faces (src/providers/wn-cli.ts — the walnut CLI bundled into the daemon
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
 * A word after the arguments is refused, never dropped. The CLI read only the one argument, so
 * `tools call task_send '{...}' --dry-run` sent a real message to a task whose sender believed
 * it was a preview (2026-10-31). A stray `--json` asks for what every call prints anyway and
 * still passes. Null = nothing to refuse. The template CLI in daemon-source.ts inlines the same
 * rule and words.
 */
export function trailingArgsMessage(extra: readonly string[]): string | null {
  const first = extra.find((a) => a !== '--json')
  if (first === undefined) return null
  return `nothing was run: tools call reads <op> and one argument (inline JSON, @file or -) and nothing after it, so ${first} would have been ignored`
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

/**
 * A text the shell already changed: the JSON went inside double quotes, so zsh or bash
 * expanded `$14` and `$52` as positional parameters (empty) and `$0` as the shell's
 * name, and "Tea $14.99" arrived as "Tea .99" with no error anywhere (2026-10-30: a
 * lead's prices reached Main as ".99" and ".52"). Only the JSON typed on the command
 * line (inline, or a flag's value) can be cut this way, and only its prose is read: the
 * fields in PROSE_FIELDS, at any depth below them, never html, a script or a note's body
 * (CSS and code are full of ".85"). Only the shapes a lost `$N` leaves are flagged: a
 * decimal or a thousands group after a space or the start (never one a ";" ends, as a CSS
 * value does), or the shell's own name in front of one. Null when the text looks whole. sh and bash leave "4.99" instead, which
 * no reading of the text can tell from a price: the session's Bash hook refuses that
 * command before it runs (shell-dollar-guard-hook.ts).
 */
export const STRIPPED_AMOUNT = /(^|[\s"':])((?:\.\d{2}|,\d{3})(?=$|[\s.,:!?"')]))|(^|[\s"'=:])((?:-?\/?(?:usr\/)?(?:local\/)?(?:bin\/)?)(?:zsh|bash|sh)(?:\.\d{2}|,\d{3}))(?![\d\p{L}_])/u

/** The message fields whose words a person reads: the ones a lost "$" amount corrupts unseen. */
export const PROSE_FIELDS = ['text', 'title', 'result', 'evidence', 'not_done', 'message', 'description', 'body', 'summary', 'reason', 'question', 'subject']

export interface StrippedText { field: string; found: string; near: string }

export function strippedShellText(args: unknown, field = '', depth = 0): StrippedText | null {
  if (depth === 0) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
    for (const k of PROSE_FIELDS) {
      const hit = strippedShellText((args as Record<string, unknown>)[k], k, 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof args === 'string') {
    const m = STRIPPED_AMOUNT.exec(args)
    if (!m) return null
    const found = m[2] ?? m[4] ?? ''
    const at = m.index + (m[1] ?? m[3] ?? '').length
    const near = args.slice(Math.max(0, at - 24), at + found.length + 8).replace(/\s+/g, ' ')
    return { field: field || 'arguments', found, near }
  }
  if (depth > 4 || args === null || typeof args !== 'object') return null
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const hit = strippedShellText(v, field ? `${field}.${k}` : k, depth + 1)
    if (hit) return hit
  }
  return null
}

/** What the CLI prints when it refuses such a text (the hub CLI, wn-cli.ts and the JS twin say the same). */
export function strippedShellTextMessage(hit: StrippedText): string {
  return `"${hit.field}" looks cut by the shell: "${hit.found}" stands where a "$" amount would be (…${hit.near}…). `
    + 'In double quotes the shell expands $14 or $5,000 to nothing. Nothing was sent. Send it again with the JSON in '
    + "single quotes, or from a file (@/path/args.json) or stdin (-) written with a quoted heredoc (<<'EOF'). "
    + 'If the text is right as it is, set WALNUT_TEXT_CHECK=0 for that call.'
}
