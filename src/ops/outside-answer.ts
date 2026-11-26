/**
 * An op answer that carries text an outside party wrote, framed for the agent that reads it.
 *
 * A plugin's data comes from outside Walnut (a calendar event an organizer wrote, a colleague's
 * ticket), so every plugin op declares `outside` (core/plugins/server-api.ts) unless its spec says
 * it frames its own answers (`framesOwnAnswer`, the mail plugin). The executor frames such an
 * answer whenever a model may read it (agentReadsFramed below): an agent's MCP tool, `walnut tools
 * call`, a host gateway, a route or relay a session reached, an in-process tool belt. A person's App
 * and a program that parses the answer (a plugin's own code, a trigger check script) read the data
 * as it is.
 *
 * Always the JSON envelope (frameOutsideData), a string answer too: the answer cap (answer.ts)
 * shortens long strings and lists inside it, and a cut inside `external_content.data` leaves the
 * frame whole, where a cut text block would lose its closing tag and the reminder after it.
 */
import { frameOutsideData, isWalnutFramed } from '../core/outside-content.js'
import type { OpCaller, OpOutside } from './registry.js'

/**
 * Whether a model may read this caller's answer, so outside text in it goes framed. The one rule for
 * the executor's frame of an `outside` op and for every handler that frames its own (the `api` op,
 * the inbox ops):
 * - `reader: 'model'`: framed whoever the caller is (the in-process tool belt, read by a model).
 * - `reader: 'program'`: plain. A plugin's own code (walnut.ops.call, a plugin job) or a trigger
 *   check script parses it; a check's output reaches a session only inside the fire's frame.
 * - otherwise by kind: an agent's or a script's framed, a person's plain.
 * A plugin id alone says nothing here: it is attribution, set for a session's call through the
 * plugin's route or relay too (2026-11-26 review: such a call read an organizer's text unframed).
 */
export function agentReadsFramed(caller: Pick<OpCaller, 'kind' | 'reader'> | undefined): boolean {
  if (caller?.reader === 'model') return true
  if (caller?.reader === 'program') return false
  return caller?.kind === 'agent'
}

/**
 * `result` framed as outside data. Skipped only for an envelope this process built (isWalnutFramed):
 * never for content that looks framed, which an outside party can write. Framing a copy again is safe.
 * With `fields` (OpOutside), only those top-level keys go inside the frame and the rest stays beside
 * it, ahead of it; an answer that holds none of them is Walnut's alone and stays as it is.
 */
export function frameOpAnswer(from: OpOutside, result: unknown): unknown {
  if (result === undefined || result === null) return result
  if (isWalnutFramed(result)) return result
  const { fields, ...source } = from
  if (!fields || typeof result !== 'object' || Array.isArray(result)) return frameOutsideData(source, result)
  const outside: Record<string, unknown> = {}
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (fields.includes(key)) outside[key] = value
    else own[key] = value
  }
  if (!Object.keys(outside).length) return result
  return frameOutsideData(source, outside, undefined, { before: own })
}

/**
 * An MCP tool's answer, relayed by a core op (mcp.ts, host-reach.ts): the tool's own output is the
 * server's, and a server can relay anyone's words (a chat message, a mail, a web page). Its text,
 * data and content go framed; the call's status (isError, callId, running, ms, images saved) is Walnut's.
 */
export const MCP_ANSWER_OUTSIDE: OpOutside = { source: 'MCP tool answer', fields: ['data', 'text', 'content', 'structured'] }

/** The one unwrap lives beside the frame (core/outside-content.ts); kept here for older importers. */
export { outsideDataOf } from '../core/outside-content.js'
