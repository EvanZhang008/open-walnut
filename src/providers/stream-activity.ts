/**
 * Which stream lines are the conversation moving, for the idle clock.
 *
 * The session manager's `lastEventAt` decides when an idle CLI is reaped
 * (session-health-monitor.ts checkIdleTimeout). It used to advance on every
 * line, and Walnut itself makes a quiet CLI write lines: every server start
 * syncs skills and settings into each live session, which answers with
 * `control_response`, `system/commands_changed`, hook and state lines. With a
 * deploy every hour or two, no CLI ever looked idle for the configured 2 hours:
 * on 2026-10-25, 35 live CLIs held 9.9 GB, several of them silent for 4 hours.
 *
 * A line counts unless it is one of Walnut's own control exchanges or a CLI
 * status notice. Anything unrecognised counts, so a new line type can only
 * keep a session alive longer, never reap one that is working.
 */

const QUIET_TYPES = new Set([
  'control_response',
  'control_cancel_request',
  'keep_alive',
  'command_lifecycle',
])

const QUIET_SYSTEM_SUBTYPES = new Set([
  'commands_changed',
  'control_request_progress',
  'hook_started',
  'hook_response',
  'session_state_changed',
])

// The CLI writes `type` first and `subtype` right after it; a line in any other
// shape is simply treated as activity.
const HEAD = /^\{"type":"([a-z_]+)"(?:,"subtype":"([a-z_]+)")?/

export function isConversationActivityLine(line: string): boolean {
  const m = HEAD.exec(line.slice(0, 120))
  if (!m) return true
  if (QUIET_TYPES.has(m[1])) return false
  if (m[1] === 'system' && m[2] && QUIET_SYSTEM_SUBTYPES.has(m[2])) return false
  return true
}

/** What the CLI says its session is doing, from its own state notices. */
export type CliTurnState = 'running' | 'idle' | 'requires_action'

const STATE_LINE = /^\{"type":"system","subtype":"session_state_changed","state":"(running|idle|requires_action)"/

/** The state a `session_state_changed` line reports, or null for any other line. */
export function cliStateOf(line: string): CliTurnState | null {
  const m = STATE_LINE.exec(line.slice(0, 120))
  return m ? m[1] as CliTurnState : null
}
