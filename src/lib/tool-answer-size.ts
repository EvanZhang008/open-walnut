/**
 * How big a Walnut tool's answer is where the agent reads it, measured the way each client
 * prints it: the MCP stdio server sends compact JSON (walnut-mcp-stdio.ts, fitToolAnswer), the
 * `walnut` CLI prints pretty JSON and a newline (wn-cli.ts, cliAnswerText). The server measures
 * a gateway call's answer with the same text the client will print, so the number is the one
 * the agent's harness gets. The limits are where Claude Code stops passing an answer on and
 * saves it to a file instead (read off session records, 2026-11-21): about 25,000 characters
 * for an MCP tool, about 10 KB for a Bash command's output.
 */

import { TOOL_ANSWER_MAX_CHARS } from './tool-answer-fit.js'

/**
 * The client a program names when it reads an op's answer as data and prints only what it makes
 * of it: wn-cli.ts's own loops (approve, pass, browser, wait, trigger-check) and a plugin job. Its
 * answer is never shaped for an agent (ops/answer.ts), the same as the Mac's own CLI loops get
 * from executeOp (2026-11-23: a single-use `walnut approve` on a remote host read a cut answer,
 * missed its envelope and withdrew the ask as "not made as a single-use approval").
 */
export const PROGRAM_CLIENT = 'program'

export type ToolClient = 'mcp' | 'cli' | typeof PROGRAM_CLIENT | 'unknown'

/** A client that prints the answer to an agent. */
export type AgentClient = 'mcp' | 'cli'

export const ANSWER_LIMITS: Readonly<Record<AgentClient, { max: number; unit: 'chars' | 'bytes' }>> = {
  mcp: { max: 25_000, unit: 'chars' },
  cli: { max: 10_240, unit: 'bytes' },
}

/** The text `walnut tools call` prints for an op's answer. */
export function cliAnswerText(result: unknown): string {
  return JSON.stringify(result, null, 2) + '\n'
}

/** Past this many compact characters the pretty text is not built: the answer is far over any limit already. */
const PRETTY_MEASURE_MAX = 200_000

/**
 * The answer's size in the unit its client is judged in (characters for MCP and unknown, bytes
 * for the CLI), and whether it passes that client's limit. An MCP answer past fitToolAnswer's
 * cap never reaches the agent whole: the MCP server saves it to a file and sends a short note
 * (`spilled`), which no harness cuts.
 */
export function answerSize(result: unknown, client: ToolClient): { size: number; overLimit: boolean; spilled?: true } {
  const compact = JSON.stringify(result) ?? 'null'
  if (client === 'mcp') {
    if (compact.length > TOOL_ANSWER_MAX_CHARS) return { size: compact.length, overLimit: false, spilled: true }
    return { size: compact.length, overLimit: compact.length > ANSWER_LIMITS.mcp.max }
  }
  if (client === 'cli') {
    const size = compact.length > PRETTY_MEASURE_MAX ? Buffer.byteLength(compact, 'utf-8') : Buffer.byteLength(cliAnswerText(result), 'utf-8')
    return { size, overLimit: size > ANSWER_LIMITS.cli.max }
  }
  // A program reads the answer itself: no agent's harness cuts it.
  if (client === PROGRAM_CLIENT) return { size: compact.length, overLimit: false }
  // An older client names none: over the larger limit is over every client's (the CLI's pretty text
  // is longer than the compact one), so a 290 K answer reads over budget whoever asked.
  return { size: compact.length, overLimit: compact.length > ANSWER_LIMITS.mcp.max }
}

export function isToolClient(v: unknown): v is Exclude<ToolClient, 'unknown'> {
  return v === 'mcp' || v === 'cli' || v === PROGRAM_CLIENT
}
