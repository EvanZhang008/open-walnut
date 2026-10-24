/**
 * The claude CLI flags Walnut's spawns pass, as tests/providers/mock-claude.mjs
 * reads them: each flag that takes a value, and each that takes none.
 *
 * The mock reads a bare argument as the first turn's message. A flag it did not
 * know was read that way too: Walnut's spawn ends with
 * `--permission-prompt-tool stdio --input-format stream-json`, so the message
 * became "stdio". When the daemon's first FIFO line came after the mock's 500 ms
 * first read, the mock answered "stdio" as a whole turn and exited, and the
 * daemon's real first line failed ENXIO ("a new session never answers"). And the
 * mock's init-only path never ran for a Walnut spawn.
 *
 * tests/providers/mock-claude-flags.test.ts checks that every flag the claude
 * argv builders in src/ name is listed here, so a new one cannot fall through.
 */

/** Flags followed by a value (`--flag value` or `--flag=value`). */
export const VALUE_FLAGS = new Set([
  '--agent', '--agents', '--allowedTools', '--append-system-prompt', '--debug-file',
  '--disallowedTools', '--effort', '--fallback-model', '--input-format', '--mcp-config',
  '--model', '--output-format', '--permission-mode', '--permission-prompt-tool',
  '--resume-session-at', '--session-id', '--setting-sources', '--settings',
  '--system-prompt', '--tools',
])

/** Flags whose value is optional: taken only when the next argument is no flag. */
export const OPTIONAL_VALUE_FLAGS = new Set(['--resume', '-r'])

/** Flags that take no value. Walnut passes `--debug` with no filter. */
export const BARE_FLAGS = new Set([
  '-p', '--print', '--verbose', '--include-partial-messages', '--debug', '--fork-session',
  '--continue', '-c', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--strict-mcp-config', '--disable-slash-commands', '--bare',
])

/** True when the mock knows `name` (with or without a value). */
export function knownFlag(name) {
  return VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name) || BARE_FLAGS.has(name)
}
