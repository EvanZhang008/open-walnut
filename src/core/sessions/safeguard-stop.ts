/**
 * A turn the model's safeguards refused (2026-11-11: sessions got "API Error: Opus 5.5's safeguards
 * flagged this message ... Details: [reasoning_extraction]" on ordinary code edits, one 19 times in
 * 34 minutes, and each stayed stuck until the user typed /model). Read from what the engine itself
 * marks, never from the error's words:
 *
 *   Claude Code   its own error reply, a synthetic assistant message (`isApiErrorMessage` in the
 *                 transcript, `error` + model `<synthetic>` on the stream-json line), whose
 *                 `message.stop_reason` is `refusal` (`stop_details.category` names the flag), and
 *                 the turn's `result` line: `is_error: true` with `stop_reason: "refusal"`.
 *   ACP engines   the prompt response's `stopReason: "refusal"` (the protocol's own stop reason).
 *
 * The engines stamp these facts on `session:result` (`safeguardStop`), and the safeguard switch
 * (sessions/safeguard-switch.ts) moves a session refused twice in a row to another model.
 * The model pick lives here too. No imports, so the light readers can take it.
 */

/** What a refused turn says about itself. */
export interface SafeguardStopFacts {
  /** The flag the safeguards named (`reasoning_extraction`, `cyber`), when the engine said. */
  category?: string
  /** The model that refused, when the line named it (never `<synthetic>`). */
  model?: string
}

type CliLine = {
  isApiErrorMessage?: boolean
  is_api_error_message?: boolean
  error?: unknown
  message?: { model?: string; stop_reason?: unknown; stop_details?: { category?: unknown } | null }
}

/** Claude Code's own error reply for a refused turn, or null for any other line. */
export function safeguardStopOfCliLine(raw: CliLine | null | undefined): SafeguardStopFacts | null {
  if (!raw) return null
  const synthetic = raw.isApiErrorMessage === true || raw.is_api_error_message === true
    || (typeof raw.error === 'string' && raw.message?.model === '<synthetic>')
  if (!synthetic || raw.message?.stop_reason !== 'refusal') return null
  const category = raw.message?.stop_details?.category
  return typeof category === 'string' && category ? { category } : {}
}

/** A turn's `result` line that says the safeguards ended it, or null. */
export function safeguardStopOfResult(result: { is_error?: unknown; stop_reason?: unknown } | null | undefined): SafeguardStopFacts | null {
  return result?.is_error === true && result.stop_reason === 'refusal' ? {} : null
}

/** An ACP turn's stop reason. */
export function safeguardStopOfAcpStopReason(stopReason: unknown): SafeguardStopFacts | null {
  return stopReason === 'refusal' ? {} : null
}

// ── The model to switch to ──────────────────────────────────────────────────

/** The families tried, in order: the strongest first. Haiku is left out (too small for a task's work). */
export const FALLBACK_FAMILIES = ['opus', 'fable', 'sonnet'] as const
export type ModelFamily = (typeof FALLBACK_FAMILIES)[number] | 'haiku'

const FAMILY_RE = /claude-(opus|fable|sonnet|haiku)\b|^(opus|fable|sonnet|haiku)\b/i

/** The Claude family a model id or name belongs to, or null (another vendor's, an alias like `default`). */
export function modelFamilyOf(id: string | null | undefined): ModelFamily | null {
  if (!id) return null
  const m = id.trim().match(FAMILY_RE) ?? id.match(/\b(opus|fable|sonnet|haiku)\b/i)
  if (!m) return null
  return (m[1] ?? m[2] ?? '').toLowerCase() as ModelFamily
}

/** One row of the session's model menu (session-controls.ts computeModelOptions). */
export interface ModelRow { id: string; label?: string; resolvedModel?: string }

/** The family of a menu row: what it resolves to first, then its id and its label. */
export function rowFamily(row: ModelRow): ModelFamily | null {
  return modelFamilyOf(row.resolvedModel) ?? modelFamilyOf(row.id) ?? modelFamilyOf(row.label)
}

/**
 * The model a refused session moves to: the first family in FALLBACK_FAMILIES that is neither the
 * current one nor one already tried since the session last worked, taken from the session's own menu
 * (so the id is one its host serves). Within a family: a 1M row when the session runs on a wide window
 * (`current.wide`: its context would not fit 200K), then the family's alias (`opus`), then its full id;
 * never the menu's `default` alias, never a variant like `opusplan`. Null when no such family is on the menu. Pure.
 */
export function pickFallbackModel(
  rows: ReadonlyArray<ModelRow>,
  current: { id?: string | null; family: ModelFamily | null; wide?: boolean },
  tried: ReadonlyArray<string>,
): { row: ModelRow; family: ModelFamily } | null {
  const skip = new Set<string>([...tried, ...(current.family ? [current.family] : [])])
  const wide = current.wide ?? /\[1m\]/i.test(current.id ?? '')
  for (const family of FALLBACK_FAMILIES) {
    if (skip.has(family)) continue
    const variant = new RegExp(`${family}[a-z]`, 'i')
    const inFamily = rows.filter((r) => r.id !== 'default' && r.id !== current.id && rowFamily(r) === family && !variant.test(r.id))
    if (inFamily.length === 0) continue
    const score = (r: ModelRow) => {
      const is1m = /\[1m\]/i.test(r.id)
      const alias = r.id.replace(/\[1m\]$/i, '').toLowerCase() === family
      return (is1m === wide ? 0 : wide ? 10 : 1) + (alias ? 0 : 2)
    }
    const row = [...inFamily].sort((a, b) => score(a) - score(b))[0]!
    return { row, family }
  }
  return null
}

/** A row's name as the user reads it. */
export function modelName(row: ModelRow | null | undefined, fallback?: string | null): string {
  return row?.label?.trim() || row?.id || fallback || 'its model'
}

// ── What Walnut says ────────────────────────────────────────────────────────

/** Consecutive refused turns that make Walnut switch the model. */
export const REFUSALS_BEFORE_SWITCH = 2

export interface OwedWords { text: string; sentBy?: 'person' | 'agent'; at: string }

const KEEP_CHARS = 40_000
const NOTE_CHARS = 120_000

/** Why, in one clause: "Opus 5.5's safeguards refused 2 turns in a row ([reasoning_extraction])". */
export function refusedClause(fromName: string, count: number, category?: string): string {
  return `${fromName}'s safeguards refused ${count} turns in a row${category ? ` ([${category}])` : ''}`
}

/** The timeline line: which model, and why. */
export function switchedLine(fromName: string, toName: string, count: number, category?: string): string {
  return `Walnut switched this session from ${fromName} to ${toName}: ${refusedClause(fromName, count, category)}.`
}

/** The note that tells the session it moved and hands it what got no answer. Pure; exported for tests. */
export function resendNoteText(fromName: string, toName: string, count: number, category: string | undefined, rows: ReadonlyArray<OwedWords>): string {
  const head = `${switchedLine(fromName, toName, count, category)} You now run on ${toName}. `
    + 'The refusal was the model\'s safety filter, not your work or a tool: do not quote or restate any model\'s internal reasoning, and work from the task, the repository and the messages.'
  if (rows.length === 0) {
    return `${head} No new message reached you in the refused turns; carry on with the work from where it stopped.`
  }
  // Newest first into the budget (the latest ask matters most), then shown oldest first.
  let budget = NOTE_CHARS
  const kept = [...rows].reverse().flatMap((r) => {
    if (budget <= 0) return []
    const text = r.text.slice(0, Math.min(KEEP_CHARS, budget))
    budget -= text.length
    return [{ ...r, text, left: r.text.length - text.length }]
  }).reverse()
  const items = kept.map((r, i) => {
    const who = r.sentBy === 'person' ? 'the user' : 'Walnut or another task'
    const tail = r.left > 0 ? `\n[${r.left} more characters of this message are left out here; it is above in this conversation]` : ''
    return `--- Message ${i + 1} of ${kept.length}, from ${who}, at ${r.at} ---\n${r.text}${tail}`
  })
  const left = rows.length - kept.length
  return `${head} ${kept.length === 1 ? 'The message that got no answer is' : 'The messages that got no answer are'} here again, oldest first`
    + `${left > 0 ? ` (${left} older ones are above in this conversation)` : ''}. Answer now and carry on with the work.\n\n${items.join('\n\n')}`
}
