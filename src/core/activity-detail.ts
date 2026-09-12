/**
 * The full text behind ONE expanded activity row (`kind:'thinking'` / `kind:'tool'`).
 *
 * Why this exists at all: the rows those two kinds produce carry EXCERPTS
 * (`thinkingText` ≤2000, `resultPreview` ≤700, `inputPreview` ≤2000) because they
 * ride a ~100-row page that a phone refetches at every turn end — measured, the
 * excerpts are already ~72% of that payload, and inlining whole reasoning blocks
 * added ~150KB per read. But the client's drawer opens to "see the whole thing", so
 * the tail has to be reachable; it is reachable HERE, one row per user tap, and the
 * list read stays slim.
 *
 * Identity is the whole problem this file solves. A row's position is not an
 * identity: the session transcript serves a sliding ~100-message TAIL, so "row 12"
 * means a different row after the next turn. What survives a re-read of the same
 * JSONL is the message's own id plus the slot inside it:
 *
 *  - `msgId` is the API `message.id` (`msg_…`) for an assistant message, else the
 *    JSONL line `uuid` — assigned by the CLI, written once, never rewritten. The
 *    same id rides the live stream, so it is already the natural key this codebase
 *    matches history against streaming blocks with.
 *  - The slot is `k` for the reasoning or `t<n>` for the n-th tool call of that
 *    message. Block order inside one message is fixed by the file: the parser walks
 *    `message.content` in order, and that array is part of an immutable line. One
 *    message collapses ALL its thinking blocks into a single joined string
 *    (SessionHistoryMessage.thinking), which is why the reasoning slot needs no
 *    index at all.
 *
 * Two ids can only ever fail CLOSED. A rewind deletes lines, compaction rewrites
 * them, and a whale JSONL is read through a bounded window that may not contain the
 * message any more — in all three the lookup finds nothing and the route answers
 * `410 detail_gone`, which leaves the client showing the excerpt it already has. It
 * never answers with a neighbouring row's text: a confident wrong answer would be
 * worse than an error.
 *
 * A tool's OUTPUT needs one more step than reasoning does, for the same reason. The
 * parsed row keeps only the first HISTORY_TOOL_RESULT_MAX characters of it, because
 * a whole-transcript parse holds every row's result at once — a bound that buys
 * nothing here, where exactly one row is being read. So this file re-reads that one
 * tool_use_id with the cap lifted (`readSessionRowToolResult`), and when even that
 * cannot reach the rest, it reports the true length and `truncated: true` rather
 * than handing back a prefix that looks complete.
 */

import { engineCaps } from './agents/engine-registry.js'
import {
  FULL_TEXT_SECTION_MAX,
  sectionHasMore,
  thinkingFullText,
  toolInputFullText,
  toolResultFullText,
  type FullTextSection,
} from './tool-summary.js'
import type { SessionRecord } from './types.js'

/** Slot inside one message: the reasoning, or the n-th tool call. */
export type ActivitySlot = { kind: 'thinking' } | { kind: 'tool'; index: number }

export interface ActivityRef {
  sessionId: string
  msgId: string
  slot: ActivitySlot
}

/** Which section of a row's detail a paging read wants. */
export type ActivityPart = 'reasoning' | 'input' | 'result'

export interface ActivityDetail {
  version: 1
  kind: 'thinking' | 'tool'
  toolName?: string
  text?: string
  textChars?: number
  textNextOffset?: number
  /** Present (and always `true`) when THIS section carries less than the row's text.
   *  Per section on purpose: the payload-wide `truncated` cannot say WHICH one fell
   *  short, so a client reading only that flag has to either label every section
   *  incomplete (wrong for the complete ones) or re-derive the answer from the
   *  numbers. Absent means whole — no client should have to do arithmetic to find
   *  that out, and a section's own honesty is not something to leave implicit. */
  textTruncated?: boolean
  input?: string
  inputChars?: number
  inputNextOffset?: number
  inputTruncated?: boolean
  result?: string
  resultChars?: number
  resultNextOffset?: number
  resultTruncated?: boolean
  offset: number
  /** True when ANY section fell short — the OR of the per-section flags. Kept
   *  because it shipped first; prefer the per-section flag for anything a user
   *  reads. */
  truncated: boolean
}

/** Session ids land in filenames and RPC params — same alphabet the routes enforce. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/
/**
 * The delimiter, and the reason a message id containing it means "no ref".
 *
 * The ref is a plain delimited string rather than base64 JSON for two reasons that
 * both matter more than looking opaque: it is ~half the bytes (it rides EVERY
 * clipped row of a page), and it can be read by a human in a log line when a drawer
 * misbehaves. `~` is unreserved in a URI, and no id shape the CLI mints contains
 * one (`msg_…`, a uuid, or `<iso timestamp>-<n>`) — one that somehow does simply
 * gets no ref, which degrades to the excerpt.
 */
const REF_SEP = '~'
const REF_VERSION = '1'

/**
 * Mint the token a row advertises, or undefined when this row cannot be addressed
 * (no message id, or an id that would not survive the round trip).
 *
 * Callers must ALSO gate on "is there more than the excerpt" — see
 * `thinkingHasFullText` / `toolHasFullText`. A ref on a complete row would offer
 * the user a fuller read that returns the same text.
 */
export function activityRef(sessionId: string, msgId: string | undefined, slot: ActivitySlot): string | undefined {
  if (!msgId || !sessionId) return undefined
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined
  if (msgId.includes(REF_SEP) || /[\s?&#/]/.test(msgId)) return undefined
  const tail = slot.kind === 'thinking' ? 'k' : `t${slot.index}`
  return [REF_VERSION, sessionId, msgId, tail].join(REF_SEP)
}

/** Parse a ref back, or null when it is not one this box minted. */
export function parseActivityRef(ref: string): ActivityRef | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) return null
  const parts = ref.split(REF_SEP)
  if (parts.length !== 4) return null
  const [version, sessionId, msgId, tail] = parts
  if (version !== REF_VERSION || !msgId) return null
  if (!SAFE_SESSION_ID.test(sessionId)) return null
  if (tail === 'k') return { sessionId, msgId, slot: { kind: 'thinking' } }
  const index = /^t(\d{1,4})$/.exec(tail)
  if (!index) return null
  return { sessionId, msgId, slot: { kind: 'tool', index: Number(index[1]) } }
}

/**
 * Read the session's history the SAME way the row producer did, so the message the
 * ref names is the message this finds.
 *
 * `readSessionHistoryTail` is deliberate rather than incidental: it is the call
 * `buildSessionTranscript` makes, so its mtime parse cache usually answers this
 * with zero I/O right after a list read, and a whale degrades to the same bounded
 * window on both paths instead of one of them ranging over 40MB.
 */
async function readHistoryForRef(sessionId: string): Promise<{
  messages: import('./session-history.js').SessionHistoryMessage[]
  /** Absent for an ACP session, whose transcript is a journal with no JSONL row to
   *  re-read — the retained-row cap does not apply to it either. */
  jsonl?: { cwd?: string; host?: string }
}> {
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  const record: SessionRecord | null = await getSessionByClaudeId(sessionId)
  if (record && engineCaps(record.engine).historySource === 'acp-journal') {
    const { readAcpSessionHistory } = await import('../providers/acp-session-history.js')
    return { messages: await readAcpSessionHistory(record) }
  }
  const { readSessionHistoryTail } = await import('./session-history.js')
  const messages = await readSessionHistoryTail(sessionId, record?.cwd, record?.host, record?.outputFile) ?? []
  return { messages, jsonl: { cwd: record?.cwd, host: record?.host } }
}

type Section = { text: string; chars: number; more: boolean; next?: number }

const section = (s: FullTextSection | undefined): Section | undefined =>
  s
    ? {
      text: s.text,
      chars: s.totalChars,
      more: sectionHasMore(s),
      ...(s.nextOffset !== undefined ? { next: s.nextOffset } : {}),
    }
    : undefined

/**
 * The output of one tool call, at full length rather than at the length a
 * whole-transcript parse retains (HISTORY_TOOL_RESULT_MAX).
 *
 * The row this read serves is ONE row, so the memory argument behind that cap does
 * not apply; the cap stays where it belongs (the list read, whose display field is a
 * 700-character preview anyway) and is lifted here for a single tool_use_id. Only
 * called for a row already known to be cut, so an ordinary result costs nothing.
 *
 * Falls back to the prefix the parse kept, and says so through `reachable: false`:
 * with `resultChars` alongside it the answer then reports how much is missing AND
 * offers no cursor, because there is no request that would return the rest. A cursor
 * in that state advertised a page which answered `200` with an empty string.
 */
async function fullResultFor(
  tool: import('./session-history.js').SessionHistoryTool,
  sessionId: string,
  jsonl: { cwd?: string; host?: string } | undefined,
  offset: number,
): Promise<{ text: string | undefined; sourceChars?: number; reachable: boolean }> {
  const kept = { text: tool.result, sourceChars: tool.resultChars, reachable: false }
  if (tool.resultChars === undefined || !tool.toolUseId || !jsonl) return kept
  try {
    const { readSessionRowToolResult } = await import('./session-history.js')
    const full = await readSessionRowToolResult(
      sessionId, tool.toolUseId, offset + FULL_TEXT_SECTION_MAX, jsonl.cwd, jsonl.host,
    )
    // reachable only when THIS read reached the source: a wider budget then returns
    // more, which is exactly what a cursor promises.
    return full ? { text: full.text, sourceChars: full.sourceChars, reachable: true } : kept
  } catch {
    return kept
  }
}

/**
 * Resolve one ref to the full text behind it, or null when the row is gone.
 *
 * Newest-first scan: a drawer is opened on something the user just watched happen,
 * and the same `msgId` can legitimately appear on two lines when the CLI splits one
 * API message (one line carrying the thinking, the next the tool calls) — requiring
 * the SLOT to be present is what picks the right line in that case, rather than the
 * first line that happens to share the id.
 */
export async function resolveActivityDetail(
  ref: ActivityRef,
  opts?: { part?: ActivityPart; offset?: number },
): Promise<ActivityDetail | null> {
  const part = opts?.part
  // An offset only means something once a SECTION is named: the same number is a
  // different place in a tool's input than in its result. The HTTP edge rejects the
  // ambiguous combination outright; here it degrades to the whole row, so no caller
  // (including the cloud relay's own validation) can produce a half-offset answer.
  const offset = part ? Math.max(0, Math.trunc(opts?.offset ?? 0)) : 0
  const { messages: history, jsonl } = await readHistoryForRef(ref.sessionId)
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.msgId !== ref.msgId) continue
    if (ref.slot.kind === 'thinking') {
      if (!m.thinking) continue
      if (part && part !== 'reasoning') return null
      const text = section(thinkingFullText(m.thinking, offset))
      if (!text) continue
      return {
        version: 1, kind: 'thinking', offset,
        text: text.text, textChars: text.chars,
        ...(text.next !== undefined ? { textNextOffset: text.next } : {}),
        ...(text.more ? { textTruncated: true } : {}),
        truncated: text.more,
      }
    }
    const tool = m.tools?.[ref.slot.index]
    if (!tool) continue
    if (part === 'reasoning') return null
    const input = part === 'result' ? undefined : section(toolInputFullText(tool.input, offset))
    const output = part === 'input'
      ? undefined
      : await fullResultFor(tool, ref.sessionId, jsonl, offset)
    const result = output && section(toolResultFullText(
      output.text, offset,
      output.sourceChars === undefined ? undefined : { chars: output.sourceChars, reachable: output.reachable },
    ))
    return {
      version: 1, kind: 'tool', toolName: tool.name, offset,
      ...(input ? { input: input.text, inputChars: input.chars } : {}),
      ...(input?.next !== undefined ? { inputNextOffset: input.next } : {}),
      ...(input?.more ? { inputTruncated: true } : {}),
      ...(result ? { result: result.text, resultChars: result.chars } : {}),
      ...(result?.next !== undefined ? { resultNextOffset: result.next } : {}),
      ...(result?.more ? { resultTruncated: true } : {}),
      // Either section falling short truncates the ANSWER — including a result whose
      // remainder is no longer reachable, which carries no cursor to notice it by.
      truncated: !!input?.more || !!result?.more,
    }
  }
  return null
}

export { FULL_TEXT_SECTION_MAX }
