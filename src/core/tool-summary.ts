/**
 * Row summaries for the flattened tool / thinking rows mobile clients render:
 * the collapsed one-liner next to a tool name (Claude-app style:
 * "Bash — ls docs/"), plus the fuller excerpts an expanded card shows.
 *
 * Shared by every surface that flattens tool_use / thinking blocks into slim
 * rows: api-v1 chat normalization, session transcript projection, and the cloud
 * bridge transcript builder. Purely additive — consumers that ignore the
 * fields keep working.
 */

import { redactSensitiveText } from '../logging/redact.js'

/** The marker `redactSensitiveText` substitutes — same string, so a preview that
 *  is masked by both that function and the PEM cut below reads as one rule. */
const REDACTED = '[REDACTED]'

/**
 * Slack over a preview's cap that the masker is allowed to see.
 *
 * Redaction has to run BEFORE the cap, because a mask can GROW the text
 * ("token=x" → "token=[REDACTED]") and capping first would let the growth escape
 * the cap. But it must not run over the WHOLE source string: these previews are
 * built for every tool row of every transcript read, and the 60s projection sweep
 * does it for every alive session, so eight regexes over an unbounded file body or
 * tool result would be unbounded work on a hot path.
 *
 * 256 characters is comfortably longer than any single-line shape the masker
 * matches, so a secret that STARTS inside the preview is always wholly inside the
 * window. The one shape longer than the window is a PEM block — see maskPreview.
 *
 * The same rule governs everything else this file does before a cap: the whitespace
 * fold reads a bounded head ({@link foldHead}) and a structured value is serialized
 * under a budget ({@link boundedJson}), because both measured in the tens of ms on a
 * large value (18.2ms to stringify a 25MB value, 9.0ms to fold 2MB). A plain
 * `.trim()` is deliberately NOT bounded (thinkingExcerpt, toolResultPreview): it is
 * one native scan with no backtracking and measures 0.002ms on that same 2MB, while
 * every bounded rewrite of it that keeps the exact same answer needs a widening loop
 * over trailing whitespace — complexity bought with an equivalence risk, for four
 * orders of magnitude less cost than the two above.
 */
const REDACT_WINDOW_SLACK = 256

/**
 * The ONE masking rule every preview field uses (`detail`, `inputPreview`,
 * `resultPreview`): bounded window → mask → PEM backstop. Capping is left to the
 * caller, which does it AFTER this (see REDACT_WINDOW_SLACK for why that order).
 *
 * Deliberately one function rather than three copies: the fields have different
 * caps and different shapes, and the moment the rule is written out per-field is
 * the moment one of them silently keeps shipping raw text.
 */
/**
 * A private key opener the masker did NOT resolve, i.e. one whose `-----END-----`
 * fell outside the window, followed by real key material.
 *
 * The base64 run is the load-bearing half. Requiring only the opener cut a `Grep`
 * result at its first matched LINE ("matches:\n-----BEGIN RSA PRIVATE KEY-----\n
 * found in 3 files" lost everything after "matches:"), which is the ordinary way a
 * developer meets those words. A real truncated key always has ≥40 unbroken
 * base64 characters after the marker — PEM bodies are 64-char lines — while a
 * grep hit, a log line or a doc sentence never does. Case-insensitive for the same
 * reason the masker's own block pattern now is.
 */
const UNRESOLVED_PEM = /-----BEGIN[\w\s]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/i

function maskPreview(text: string, cap: number): string {
  const limit = cap + REDACT_WINDOW_SLACK
  const windowed = text.length > limit ? text.slice(0, limit) : text
  const masked = redactSensitiveText(windowed)
  const pem = masked.search(UNRESOLVED_PEM)
  return pem === -1 ? masked : masked.slice(0, pem) + REDACTED
}

const DETAIL_MAX = 160

/**
 * Fold whitespace out of the HEAD of a long string, without folding the whole
 * thing (p2-6: `/\s+/g` over a 2MB thinking block measured 7.56ms, on a path that
 * runs per tool row per transcript read).
 *
 * Folding shrinks, so a fixed window can come up short on whitespace-heavy text —
 * hence the widening loop rather than a single slice. Each pass is O(need); the
 * common case (prose, one pass) is now O(1) in the source length, and only text
 * that is almost entirely whitespace degrades to reading it all, which is inherent:
 * you cannot know there are 160 real characters without looking.
 */
function foldHead(text: string, need: number): string {
  let take = Math.min(text.length, need * 4 + REDACT_WINDOW_SLACK)
  for (;;) {
    const folded = text.slice(0, take).replace(/\s+/g, ' ').trim()
    if (folded.length >= need || take >= text.length) return folded
    take = Math.min(text.length, take * 4)
  }
}

/**
 * The collapsed one-liner: folded to a single line, masked, then clipped to 160.
 *
 * The field's SHAPE is frozen (≤160, one line, from the same input key — see
 * TOOL_DETAIL_KEYS, which must not be reordered); only the value changes, and only
 * where the masker matches. It has to be masked for the same reason the other two
 * previews are: this is a tool's own input text (a `description` a model wrote, a
 * command line) and it leaves the box — over a LAN to a phone, and down the bridge
 * to a cloud replica. Two of three fields masked and the third documented as a
 * known hole is the shape that becomes a bug report.
 */
function clipDetail(s: string): string {
  const oneLine = maskPreview(foldHead(s, DETAIL_MAX + REDACT_WINDOW_SLACK), DETAIL_MAX)
  return oneLine.length > DETAIL_MAX ? oneLine.slice(0, DETAIL_MAX) + '…' : oneLine
}

/** Input keys tried per tool name — first present string wins. */
const TOOL_DETAIL_KEYS: Record<string, string[]> = {
  Bash: ['description', 'command'],
  BashOutput: ['bash_id'],
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  Skill: ['skill', 'command'],
  TodoWrite: ['subject'],
  ExitPlanMode: ['plan'],
}

// Generic fallback keys when the tool isn't in the map above — covers both
// CLI tools and the Personal AI's walnut-native tools (task_* / session_*).
const GENERIC_DETAIL_KEYS = [
  'description', 'command', 'file_path', 'path', 'url', 'query', 'queries',
  'pattern', 'prompt', 'text', 'title', 'message', 'question', 'id',
]

/**
 * Short summary of a tool call's input ("what is it doing"), or undefined
 * when the input carries nothing human-readable.
 */
export function toolDetail(name: string, input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const keys = TOOL_DETAIL_KEYS[name] ?? GENERIC_DETAIL_KEYS
  for (const key of keys) {
    const val = input[key]
    if (typeof val === 'string' && val.trim()) return clipDetail(val)
    // String arrays ("queries": [...]) summarize as a comma list.
    if (Array.isArray(val)) {
      const strings = val.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      if (strings.length > 0) return clipDetail(strings.join(', '))
    }
  }
  return undefined
}

/**
 * Budget for the expanded card's INPUT section. Two caps, not one:
 *
 *  - `INPUT_PREVIEW_VALUE_MAX` per value, so ONE fat key cannot eat the whole
 *    budget and hide the others. Without it a `Write` call renders as 2000
 *    characters of file body and the `file_path` next to it never appears —
 *    which is the same "unreachable at any expansion level" defect this field
 *    exists to fix, just moved one key over.
 *  - `INPUT_PREVIEW_MAX` on the joined result, which is what actually bounds
 *    the wire. ~2000 holds a real command line, a diff-sized `old_string`, or a
 *    handful of ordinary keys, and 50 of them stay inside one mobile page.
 */
const INPUT_PREVIEW_MAX = 2_000
const INPUT_PREVIEW_VALUE_MAX = 1_000

function clipValue(s: string): string {
  return s.length > INPUT_PREVIEW_VALUE_MAX ? s.slice(0, INPUT_PREVIEW_VALUE_MAX) + '…' : s
}

/** Rough cost charged for a scalar, so a wide object bounds out too. */
const JSON_SCALAR_COST = 8

/**
 * `JSON.stringify` with a work budget (p2-6).
 *
 * Serializing first and clipping after is the obvious shape and the wrong one: a
 * tool input can carry a 25MB value (a MultiEdit's edit array, a pasted blob), and
 * `JSON.stringify` on it measured 16ms — on the same per-row, per-transcript-read
 * path REDACT_WINDOW_SLACK exists to keep bounded. So a bounded COPY is built
 * first, spending the budget as it walks, and that copy is what gets serialized.
 *
 * Why a copy and not a `JSON.stringify` replacer, which is the shorter version: a
 * replacer cannot stop. Returning `undefined` for an array element yields `null`,
 * so a 100k-element array came back as ~940 `null`s filling the whole preview (the
 * first attempt here did exactly that, and its own test caught it). Building the
 * copy means running out of budget inside an array just ENDS the array.
 *
 * Truncation is marked with `…`: dropping keys silently would leave output that
 * reads like the whole value, which is worse than visibly short. Under budget the
 * copy is structurally identical to the input, so the result is byte-identical to
 * plain `JSON.stringify` — including `toJSON()` (a Date must not become `{}`).
 *
 * A reference cycle needs no special case: every level of the walk spends budget,
 * so a cycle bottoms out instead of recursing forever.
 */
function boundedJson(value: unknown, budget: number): string {
  let left = budget
  let truncated = false
  const trim = (v: unknown): unknown => {
    if (v === null) { left -= 4; return null }
    if (typeof v === 'string') {
      left -= Math.min(v.length, budget) + 2
      if (v.length > budget) { truncated = true; return v.slice(0, budget) }
      return v
    }
    if (typeof v === 'number' || typeof v === 'boolean') { left -= JSON_SCALAR_COST; return v }
    if (typeof v !== 'object') return undefined // function / symbol: stringify drops these
    const asJson = (v as { toJSON?: unknown }).toJSON
    if (typeof asJson === 'function') return trim((asJson as () => unknown).call(v))
    if (Array.isArray(v)) {
      const out: unknown[] = []
      for (const el of v) {
        if (left <= 0) { truncated = true; break }
        left -= 1
        out.push(trim(el))
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (left <= 0) { truncated = true; break }
      left -= key.length + 3
      out[key] = trim(val)
    }
    return out
  }
  let json: string
  try { json = JSON.stringify(trim(value)) ?? '' } catch { return '' }
  return truncated && json ? json + '…' : json
}

/**
 * The tool INPUT rendered for an expanded card: `key: value` lines in the
 * input's own key order, newlines inside a value preserved (a heredoc or a
 * multi-line `old_string` is unreadable folded onto one line — this is rendered
 * verbatim monospace, like `resultPreview`).
 *
 * Separate from {@link toolDetail} on purpose. `detail` is a DOCUMENTED ≤160
 * one-liner that web already depends on and whose per-tool key preference is
 * tuned for a collapsed row (Bash prefers `description`, which reads better but
 * means the actual command never reached the phone). Rather than reorder that —
 * which would change an existing field's meaning — the real input rides here.
 *
 * Masked before it leaves ({@link maskPreview}): this ships raw command lines and
 * file bodies over a LAN and down to a cloud replica. Masking runs on the JOINED
 * text, after the per-value clip, so a value cut mid-secret can leave a <20-char
 * prefix that no pattern matches — unusable on its own, and the alternative
 * (masking every fat value in full before clipping) is exactly the unbounded
 * hot-path work REDACT_WINDOW_SLACK exists to avoid.
 */
export function toolInputPreview(input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const lines: string[] = []
  let budget = INPUT_PREVIEW_MAX
  for (const [key, val] of Object.entries(input)) {
    if (val == null) continue
    let rendered: string
    if (typeof val === 'string') {
      // `/\S/` not `.trim()`: same answer, but it stops at the first non-space
      // instead of copying a 25MB value just to learn it is non-empty.
      if (!/\S/.test(val)) continue
      rendered = val
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      rendered = String(val)
    } else {
      rendered = boundedJson(val, INPUT_PREVIEW_VALUE_MAX)
      if (!rendered) continue
    }
    const line = `${key}: ${clipValue(rendered)}`
    lines.push(line)
    budget -= line.length + 1
    // Enough text to fill the budget already — stop reading keys.
    if (budget <= 0) break
  }
  if (lines.length === 0) return undefined
  const masked = maskPreview(lines.join('\n'), INPUT_PREVIEW_MAX)
  return masked.length > INPUT_PREVIEW_MAX ? masked.slice(0, INPUT_PREVIEW_MAX) + '…' : masked
}

/** Documented cap for the collapsed `kind:'thinking'` row's `text`. */
const THINKING_LINE_MAX = 160
/**
 * Cap for the expanded thinking excerpt (`thinkingText`). Sized like a long
 * `resultPreview` rather than like a whole reasoning block: a real thinking
 * block runs into the tens of KB, and this rides a 50-row mobile page.
 */
const THINKING_EXCERPT_MAX = 2_000

/**
 * Collapsed one-line thinking row (whitespace folded, like `detail`).
 *
 * Folds only the HEAD (see {@link foldHead}): a real thinking block runs to tens of
 * KB and `/\s+/g` over 2MB measured 7.56ms, all of it to produce 160 characters.
 */
export function thinkingLine(text: string): string {
  const oneLine = foldHead(text, THINKING_LINE_MAX + 1)
  return oneLine.length > THINKING_LINE_MAX ? oneLine.slice(0, THINKING_LINE_MAX) + '…' : oneLine
}

/**
 * Fuller thinking excerpt for the expanded card — newlines kept (reasoning is
 * paragraphs), clipped from the START of the block so the excerpt is the part
 * that explains what the model set out to do.
 */
export function thinkingExcerpt(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > THINKING_EXCERPT_MAX ? trimmed.slice(0, THINKING_EXCERPT_MAX) + '…' : trimmed
}

const RESULT_PREVIEW_MAX = 700

/**
 * Clipped tool result text for the expanded card — mobile renders it as monospace
 * verbatim. Undefined when there is no text.
 *
 * Masked by the same {@link maskPreview} rule as the two input fields. A tool's
 * OUTPUT leaks exactly as readily as its input: `cat .env`, an `aws configure`
 * echo, a curl that prints the request it sent.
 */
export function toolResultPreview(result: string | undefined | null): string | undefined {
  if (typeof result !== 'string') return undefined
  const trimmed = result.trim()
  if (!trimmed) return undefined
  const masked = maskPreview(trimmed, RESULT_PREVIEW_MAX)
  return masked.length > RESULT_PREVIEW_MAX ? masked.slice(0, RESULT_PREVIEW_MAX) + '…' : masked
}

/**
 * Extract the plain-text payload of a tool_result content field (string or
 * Anthropic content-block array). Image blocks are skipped (binary).
 */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}
