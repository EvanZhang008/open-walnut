/**
 * Every Walnut MCP tool answer fits what an agent's tool result takes.
 *
 * 2026-11-10: `board_get` on a big team board answered 165,884 characters, over
 * Claude Code's MCP output limit (25,000 tokens by default), so the agent got
 * nothing it could read. Any op can grow that way as the user's data grows, so
 * the servers cap every answer here, whatever the op: an answer over the cap is
 * written whole to a file, and the tool answers the op's own outcome and next,
 * the file's path and a short head instead. Dependency-light (node builtins only): the
 * daemon builds carry it (src/providers/walnut-mcp-stdio.ts) as well as the hub
 * (src/mcp/tools.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The most characters one tool answer carries (well under 25,000 tokens of JSON). */
export const TOOL_ANSWER_MAX_CHARS = 60_000

/** How much of a too-big answer is shown inline. */
const HEAD_CHARS = 6_000

/** Spilled answers older than this are removed at the next spill. */
const KEEP_MS = 24 * 60 * 60 * 1000

export interface FitOptions {
  /** The op that answered (named in the note). */
  op: string
  /** Where a too-big answer is written; defaults to `<tmp>/walnut-tool-answers-<uid>`. */
  dir?: string
  /** Pretty-print an answer that fits (the hub's own server keeps its old shape). */
  pretty?: boolean
  /** Overrides TOOL_ANSWER_MAX_CHARS (tests). */
  maxChars?: number
}

function sweep(dir: string, nowMs: number): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try { if (nowMs - fs.statSync(file).mtimeMs > KEEP_MS) fs.unlinkSync(file) } catch { /* gone already */ }
    }
  } catch { /* no dir yet */ }
}

/** The text of one tool answer: the payload as JSON when it fits, else a short note naming the file holding it. */
export function fitToolAnswer(payload: unknown, opts: FitOptions): string {
  const max = opts.maxChars ?? TOOL_ANSWER_MAX_CHARS
  const compact = JSON.stringify(payload) ?? 'null'
  if (compact.length <= max) {
    if (!opts.pretty) return compact
    const pretty = JSON.stringify(payload, null, 2) ?? compact
    return pretty.length <= max ? pretty : compact
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const dir = opts.dir ?? path.join(os.tmpdir(), `walnut-tool-answers-${uid}`)
  const nowMs = Date.now()
  let file: string | undefined
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // The answer holds the user's data: only a directory of this user's own, closed to others.
    const st = fs.lstatSync(dir)
    if (!st.isDirectory() || (uid >= 0 && st.uid !== uid) || (st.mode & 0o077) !== 0) throw new Error('unsafe answer dir')
    sweep(dir, nowMs)
    const name = `${opts.op.replace(/[^a-z0-9_]/gi, '_')}-${nowMs.toString(36)}-${crypto.randomBytes(4).toString('hex')}.json`
    file = path.join(dir, name)
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  } catch {
    file = undefined
  }
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  // A board's page is one long JSON string: Read cuts long lines, so name the exact way to get it whole.
  const board = obj.board && typeof obj.board === 'object' ? obj.board as Record<string, unknown> : undefined
  const htmlWay = file && typeof board?.html === 'string'
    ? `The page's exact html: jq -r .board.html ${file} (its version: jq .board.version ${file}). ` : ''
  const note = {
    too_big: true,
    op: opts.op,
    chars: compact.length,
    ...(typeof obj.outcome === 'string' ? { outcome: obj.outcome } : {}),
    ...(typeof obj.next === 'string' ? { next: obj.next } : {}),
    ...(file ? { file } : {}),
    hint: `The whole answer is ${compact.length.toLocaleString('en-US')} characters, more than one tool answer `
      + `carries (${max.toLocaleString('en-US')}). `
      + (file ? `It is in ${file}: read the part you need from there (jq, or Read with offset/limit). ` : '')
      + htmlWay
      + `Or ask ${opts.op} for less: its paging, limit, fields or parts arguments.`,
    head: compact.slice(0, HEAD_CHARS),
  }
  return JSON.stringify(note)
}
