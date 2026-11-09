/**
 * Walnut's own record of the Walnut calls a session's CLI made that carry words
 * to someone (core/op-cards.ts): what each one said, to whom, and whether it went
 * through. The session's chat card reads it (web SessionOutboundCard), so a send
 * whose payload never rode the command (`@/tmp/a.json`, stdin, a subshell) still
 * shows its words after the temp file is gone. 2026-11-09, the user, of a lead's
 * chat where every send read "Payload from file — the text is not in this
 * transcript": "can it show the summary ... even if it use cli, why can't it show
 * up here?".
 *
 * The `walnut` CLI posts one entry after the call (POST /api/v1/sessions/op-calls,
 * caller sid header). The server ties it to the Bash row that ran it by asking the
 * session's runner which open (or just returned) Bash call runs that op, so the
 * card looks it up by its own tool_use id. One JSON file per session at
 * `WALNUT_HOME/op-calls/<sid>.json`, newest `MAX_ENTRIES` kept. Only the leader
 * keeps them; display data only, so a lost entry costs a card its words, never a
 * message.
 */
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import {
  isCardedOp, OP_CARD_DETAIL_MAX, OP_CARD_SUMMARY_MAX, OP_CARD_TITLE_MAX,
  type OpCardFields, type OpCardKind,
} from '../op-cards.js'
import type { OpArgForm } from '../../lib/walnut-op-command.js'

export const MAX_ENTRIES = 300

export interface OpCallEntry {
  id: string
  at: string
  /** The Bash call that ran it, when the server could tell. */
  toolUseId?: string
  op: string
  form: OpArgForm
  /** `@path` as the CLI read it. */
  path?: string
  ok: boolean
  error?: string
  fields: OpCardFields
}

interface OpCallFile { sessionId: string; calls: OpCallEntry[] }

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FORMS = new Set<OpArgForm>(['inline', 'file', 'stdin', 'flags', 'none'])
const KINDS = new Set<OpCardKind>(['send', 'reply', 'thread', 'brief', 'letter', 'board', 'task'])

const dir = (): string => path.join(WALNUT_HOME, 'op-calls')

function fileOf(sid: string): string | null {
  return SID_RE.test(sid) ? path.join(dir(), `${sid}.json`) : null
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const points = [...v]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : v
}

/** What a client may store: the card's fields, cut to size, nothing else. */
export function normalizeFields(op: string, raw: unknown): OpCardFields | null {
  if (!isCardedOp(op) || !raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = KINDS.has(r.kind as OpCardKind) ? r.kind as OpCardKind : 'send'
  const to = Array.isArray(r.to) ? r.to.filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(t)).slice(0, 20) : []
  const toLabel = str(r.toLabel, 120)
  const title = str(r.title, OP_CARD_TITLE_MAX)
  const summary = str(r.summary, OP_CARD_SUMMARY_MAX)
  const detail = str(r.detail, OP_CARD_DETAIL_MAX)
  return {
    op, kind, to,
    ...(toLabel ? { toLabel } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(detail ? { detail } : {}),
  }
}

async function companion(): Promise<boolean> {
  const { isCompanion } = await import('../server-role.js')
  return isCompanion()
}

/** The session's Bash call that ran `op` (and `@path`), skipping calls that already hold one. */
async function toolUseFor(sid: string, op: string, filePath: string | undefined, taken: Set<string>): Promise<string | undefined> {
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    const { commandRunsOp } = await import('../../lib/walnut-op-command.js')
    const live = sessionRunner.findByClaudeId(sid)
    return live?.bashCallMatching((command) => commandRunsOp(command, op, filePath), taken)
  } catch {
    return undefined
  }
}

export interface RecordInput {
  op: string
  form?: unknown
  path?: unknown
  ok?: unknown
  error?: unknown
  fields?: unknown
}

/** Record one call. Null when it is not one to keep (an op no card covers, a bad id, the companion). */
export async function recordOpCall(sid: string, input: RecordInput, now = new Date()): Promise<OpCallEntry | null> {
  const file = fileOf(sid)
  const fields = normalizeFields(input.op, input.fields)
  if (!file || !fields || await companion()) return null
  const form = FORMS.has(input.form as OpArgForm) ? input.form as OpArgForm : 'none'
  const filePath = str(input.path, 1000)
  const error = str(input.error, 600)
  let entry: OpCallEntry | null = null
  await fs.mkdir(dir(), { recursive: true })
  await updateJsonFile<OpCallFile | null>(file, null, async (cur) => {
    const calls = Array.isArray(cur?.calls) ? cur!.calls : []
    // A loop sends several times from one row: those rows are not taken, the
    // matcher only prefers a row with none of this op yet.
    const taken = new Set(calls.filter((c) => c.op === input.op && c.toolUseId && Date.parse(c.at) > now.getTime() - 30 * 60_000).map((c) => c.toolUseId!))
    const toolUseId = await toolUseFor(sid, input.op, filePath, taken)
    entry = {
      id: `oc-${randomBytes(6).toString('hex')}`,
      at: now.toISOString(),
      ...(toolUseId ? { toolUseId } : {}),
      op: input.op,
      form,
      ...(filePath ? { path: filePath } : {}),
      ok: input.ok !== false,
      ...(error ? { error } : {}),
      fields,
    }
    return { sessionId: sid, calls: [...calls, entry].slice(-MAX_ENTRIES) }
  })
  cache.delete(sid)
  return entry
}

const cache = new Map<string, { mtimeMs: number; calls: OpCallEntry[] }>()

async function readCalls(sid: string): Promise<OpCallEntry[]> {
  const file = fileOf(sid)
  if (!file || await companion()) return []
  let mtimeMs: number
  try { mtimeMs = (await fs.stat(file)).mtimeMs } catch { return [] }
  const hit = cache.get(sid)
  if (hit && hit.mtimeMs === mtimeMs) return hit.calls
  const raw = await readJsonFile<OpCallFile | null>(file, null)
  const calls = Array.isArray(raw?.calls) ? raw!.calls : []
  cache.set(sid, { mtimeMs, calls })
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return calls
}

/** The recorded calls of the given Bash rows, by tool_use id, in the order they ran. */
export async function opCallsForTools(sid: string, toolUseIds: string[]): Promise<Record<string, OpCallEntry[]>> {
  const want = new Set(toolUseIds)
  const out: Record<string, OpCallEntry[]> = {}
  for (const c of await readCalls(sid)) {
    if (!c.toolUseId || !want.has(c.toolUseId)) continue
    ;(out[c.toolUseId] ??= []).push(c)
  }
  return out
}
