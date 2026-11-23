/**
 * Every request line a client writes to this host's daemon gateway socket (`walnut tools call`,
 * `walnut mcp-server`, `walnut wait`, the shared loops, a trigger check, the Mac's own CLI), built
 * here and nowhere else (ratchet: tests/providers/gateway-request-builder.test.ts).
 *
 * A `tools.call` names how long the daemon may hold it (`waitMs`): while the Walnut server restarts
 * or its link to this host dials again, the daemon keeps the call (nothing of it was sent yet) and
 * sends it once a server of its Walnut is back, instead of answering hub_unreachable at once.
 * 2026-11-23: a session's task_create through the MCP server failed 13 s after a deploy restarted
 * the server (its socket was connected but had not said whose Walnut it is yet), while the same
 * call through `walnut tools call` would have waited: the CLI named a wait, the MCP server did not.
 * So every caller states its wait here, by name; `'none'` is a choice a caller makes on purpose
 * (it has another way to go, or the answer is not worth waiting for), and the ratchet lists them.
 * It goes on the line as `waitMs: 0`, so the daemon never holds it (a line with no `waitMs` is an
 * older client's, which waits a moment for a server that is starting: gatewayIdentifyPlan).
 *
 * Older daemons: `waitMs` is one more field on the local socket line, not a command between server
 * and daemon, so it needs no capability. A daemon from before 2026-11-03 built its request from
 * v/op/sid/args only and ignores it (it answers within its hub timeout, well inside the socket
 * time below); every later one honours a positive one and reads 0 as none, as before. Waiting is
 * safe to repeat: hub_unreachable means nothing was sent, and the server runs a call id at most
 * once (src/ops/op-calls.ts).
 */
import type { GatewayOp, GatewayRequest } from './gateway-core.js'
import { GATEWAY_MIN_RELAY_MS, GATEWAY_WAIT_MAX_MS, gatewayWaitMs } from './gateway-core.js'

/** One request line and how long its socket waits for the answer line. */
export interface GatewayLine {
  req: GatewayRequest
  timeoutMs: number
}

/** A call's wait for a server: ms, or 'none' (no server is answered at once; the caller has another way). */
export type GatewayWait = number | 'none'

/** Client-side wait for the daemon's single response line, for a line that waits for nothing. */
export const WALNUT_CLI_TIMEOUT_MS = 30_000

/** A call's socket stays open this long past its wait: the daemon answers first, never the client's timer. */
export const GATEWAY_ANSWER_SLACK_MS = 10_000

/** Past this with no answer, a caller that can tell someone says the call is still waiting. */
export const GATEWAY_WAIT_NOTICE_MS = 10_000

function envMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '')
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), GATEWAY_WAIT_MAX_MS) : fallback
}

/**
 * How long a `walnut tools call` gives the daemon in all: while the Walnut server restarts or its
 * link to this host dials again, the daemon holds the call and sends it again instead of failing it
 * at once (2026-11-03: a deploy and a link that kept breaking failed every call on clouddev for 8
 * minutes). WALNUT_CLI_WAIT_MS sets it (tests).
 */
export function cliWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.WALNUT_CLI_WAIT_MS, 90_000)
}

/**
 * How long an agent's call through `walnut mcp-server` gives the daemon. Claude Code holds the
 * model's turn on an MCP tool call, so this is shorter than the CLI's 90 s: a deploy's restart has
 * the server back and naming its Walnut well inside a minute, and past that the model hears
 * "nothing was sent, try again" and can do something else instead of sitting blocked.
 * WALNUT_MCP_WAIT_MS sets it (tests).
 */
export const MCP_CALL_WAIT_MS = 60_000
export function mcpWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.WALNUT_MCP_WAIT_MS, MCP_CALL_WAIT_MS)
}

/** What a waiting call says once it has waited GATEWAY_WAIT_NOTICE_MS (the CLI prefixes "walnut: "). */
export function waitNoticeText(waitMs: number): string {
  return `no answer yet; this call waits up to ${Math.round(waitMs / 1000)}s`
}

/**
 * One `tools.call` line. A number is how long the daemon may hold the call for a server (clamped as
 * the daemon clamps it: gateway-core.ts gatewayWaitMs), its socket open that long and
 * GATEWAY_ANSWER_SLACK_MS, so the daemon's answer always comes first. `'none'`: the daemon never
 * holds it (`waitMs: 0`); `timeoutMs` is then the socket's time, given by a caller with a hard
 * budget of its own (a trigger check, a display record).
 */
export function toolsCallLine(sid: string, args: Record<string, unknown>, wait: number): GatewayLine
export function toolsCallLine(sid: string, args: Record<string, unknown>, wait: 'none', timeoutMs?: number): GatewayLine
export function toolsCallLine(sid: string, args: Record<string, unknown>, wait: GatewayWait, timeoutMs?: number): GatewayLine {
  if (wait === 'none') return { req: { v: 1, op: 'tools.call', sid, args, waitMs: 0 }, timeoutMs: timeoutMs ?? WALNUT_CLI_TIMEOUT_MS }
  const waitMs = gatewayWaitMs(wait) ?? GATEWAY_MIN_RELAY_MS
  return { req: { v: 1, op: 'tools.call', sid, args, waitMs }, timeoutMs: waitMs + GATEWAY_ANSWER_SLACK_MS }
}

/**
 * A `tools.call` that waits for a server no longer than `leftMs` (a lost call's follow read, a poll
 * of `walnut wait`): up to `wantMs` within that. Its socket stays open GATEWAY_ANSWER_SLACK_MS past
 * the wait for the answer itself, as every call's does. With less left than the shortest wait the
 * daemon grants (GATEWAY_MIN_RELAY_MS) it waits for none, and its socket ends with what is left.
 */
export function toolsCallLineWithin(sid: string, args: Record<string, unknown>, leftMs: number, wantMs: number = leftMs): GatewayLine {
  const left = Math.max(1, Math.floor(Number.isFinite(leftMs) ? leftMs : 0))
  if (left < GATEWAY_MIN_RELAY_MS) return toolsCallLine(sid, args, 'none', left)
  return toolsCallLine(sid, args, Math.min(left, wantMs))
}

/** A line of an op that runs nothing on the server and waits for nothing (a catalog list). */
export function gatewayListLine(op: Exclude<GatewayOp, 'tools.call'>, sid: string, args: Record<string, unknown>, timeoutMs = WALNUT_CLI_TIMEOUT_MS): GatewayLine {
  return { req: { v: 1, op, sid, args }, timeoutMs }
}
