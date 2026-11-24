/**
 * The ONE place the `claude -p` argv of a Walnut session is assembled (its `--settings` JSON is
 * claude-session-settings.ts). Callers hand it their session-specific parts:
 *   - claude-code-session.ts `send()`: the real values of a start on this machine.
 *   - spawn-template.ts: the same argv with SLOTS where a start's own fields go, which a host's
 *     daemon fills while the Mac is away (host-start-core.ts).
 *   - daemon-standalone.ts: the argv of a resume whose spawn record is lost.
 * Each gets the fixed frame (output flags, streaming, debug, the bypass capability, `--settings`,
 * the stdin format, the permission prompt tool) from here, so a flag added here reaches every way a
 * session starts. Pure and import-free (the daemon bundles it): it reads only the env it is given.
 * A source ratchet (tests/providers/claude-session-argv-ratchet.test.ts) keeps other files from
 * assembling it again.
 */

export interface ClaudeArgvInput<T> {
  /** The CLI command, first in the list; absent: the list starts at `-p` (the daemon adds the command). */
  command?: string
  /** Read for WALNUT_CLAUDE_DEBUG. */
  env: NodeJS.ProcessEnv
  /** config.session.stream_partial_messages: on unless explicitly false. */
  streamPartialMessages?: boolean
  /** config.session.permission_prompt: on unless explicitly false. */
  permissionPrompt?: boolean
  /** Between the bypass capability and `--settings`: the mode, model, effort, resume or session id,
   *  prompts and tool lists, as strings (send) or slots (the host template). */
  session: readonly (string | T)[]
  /** From buildSessionSettings; emitted as `--settings` when it holds a key. */
  settings: Record<string, unknown>
}

export function buildClaudeArgv<T = never>(i: ClaudeArgvInput<T>): Array<string | T> {
  const args: Array<string | T> = []
  if (i.command !== undefined) args.push(i.command)
  args.push('-p', '--output-format', 'stream-json', '--verbose')
  // Token-level streaming: Anthropic SSE stream_event records, so text streams into the UI
  // character by character. Default on; an explicit false falls back to per-message delivery.
  if (i.streamPartialMessages !== false) args.push('--include-partial-messages')
  // Claude Code's trace log (~/.claude/debug/<session id>.txt on the host the CLI runs on).
  // Off with WALNUT_CLAUDE_DEBUG=0.
  if (i.env.WALNUT_CLAUDE_DEBUG !== '0') args.push('--debug')
  // Authorize the bypass CAPABILITY at startup without ACTIVATING it: the CLI rejects a later
  // set_permission_mode(bypassPermissions) unless it was launched with it, so every session needs
  // it, plan ones too. It MUST be `--allow-dangerously-skip-permissions`, never the bare
  // `--dangerously-skip-permissions`, which SELECTS the mode and outranks --permission-mode
  // (measured on CLI 2.1.220: all six requested modes came up in bypassPermissions).
  args.push('--allow-dangerously-skip-permissions')
  args.push(...i.session)
  if (Object.keys(i.settings).length > 0) args.push('--settings', JSON.stringify(i.settings))
  // Local and SSH sessions alike take their input as stream-json on stdin.
  args.push('--input-format', 'stream-json')
  // The permission prompt tool intercepts sensitive-file and AskUserQuestion checks; a remote
  // session's answer is routed through the daemon's `sendRaw`.
  if (i.permissionPrompt !== false) args.push('--permission-prompt-tool', 'stdio')
  return args
}
