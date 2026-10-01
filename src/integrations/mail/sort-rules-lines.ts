/**
 * Where in the file a semantic error lives. js-yaml only gives a position for SYNTAX errors, so
 * for `then: 3` or an unknown field this scans the raw text: the top-level `rules:` block, the
 * line each `- ` item starts on, and the line of the offending key inside that item.
 *
 * When the scan cannot find it, no line number is invented: the sentence names the rule instead
 * (`Rule 3 (r-7f3a2c): ...`).
 */
import type { RuleValidationError, RulesError } from './sort-types.js'

interface Block {
  /** 1-based line of the block's key (`rules:` / `groups:`), or 0. */
  keyLine: number
  /** 1-based line ranges of each list item, in order. */
  items: Array<{ start: number; end: number }>
  end: number
}

const TOP_KEY = /^([A-Za-z_][\w-]*)\s*:/

function blockOf(lines: string[], key: string): Block {
  const keyIndex = lines.findIndex((line) => TOP_KEY.exec(line)?.[1] === key)
  if (keyIndex < 0) return { keyLine: 0, items: [], end: 0 }
  let end = lines.length
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    if (TOP_KEY.test(lines[i]!)) { end = i; break }
  }
  const items: Array<{ start: number; end: number }> = []
  let indent: number | null = null
  for (let i = keyIndex + 1; i < end; i += 1) {
    const match = /^(\s*)-(\s|$)/.exec(lines[i]!)
    if (!match) continue
    const width = match[1]!.length
    if (indent === null) indent = width
    if (width !== indent) continue
    if (items.length > 0) items[items.length - 1]!.end = i
    items.push({ start: i + 1, end })
  }
  return { keyLine: keyIndex + 1, items, end }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The 1-based line of `key:` inside lines [start, end) (1-based start, exclusive 0-based end). */
function keyLineIn(lines: string[], start: number, end: number, key: string): number | undefined {
  const pattern = new RegExp(`(^|[\\s{,-])${escape(key)}\\s*:`)
  for (let i = start - 1; i < end; i += 1) {
    const line = lines[i]!.replace(/\s#.*$/, '')
    if (pattern.test(line)) return i + 1
  }
  return undefined
}

/** The line one validation error points at, when the raw text shows it. */
export function lineOfError(text: string, error: RuleValidationError): number | undefined {
  const lines = text.split(/\r?\n/)
  if (error.index < 0) {
    const block = blockOf(lines, error.field === 'groups' ? 'groups' : error.field)
    if (!block.keyLine) return undefined
    const quoted = /"([^"]+)"\.? are too similar|and "([^"]+)" are too similar/.exec(error.message)
    const name = quoted?.[2] ?? quoted?.[1]
    if (name) {
      for (let i = block.keyLine; i < block.end; i += 1) if (lines[i]!.includes(name)) return i + 1
    }
    return block.keyLine
  }
  const item = blockOf(lines, 'rules').items[error.index]
  if (!item) return undefined
  const segments = error.field.split('.')
  for (let depth = segments.length; depth >= 1; depth -= 1) {
    const found = keyLineIn(lines, item.start, item.end, segments[depth - 1]!)
    if (found) return found
  }
  return item.start
}

/**
 * The first error as the `rulesError` the grouped view and Settings show. With a line, the
 * message is bare (the UI says `Line 7: ...`); without one it names the rule.
 */
export function rulesErrorOf(text: string, errors: RuleValidationError[], since: number): RulesError {
  const first = errors[0] ?? { index: -1, field: 'file', message: 'The rules file could not be read.' }
  const line = lineOfError(text, first)
  const rule = first.index >= 0 ? { index: first.index, ...(first.id ? { id: first.id } : {}) } : undefined
  const named = rule ? `Rule ${rule.index + 1}${rule.id ? ` (${rule.id})` : ''}: ${first.message}` : first.message
  return {
    ...(line ? { line } : {}),
    ...(rule ? { rule } : {}),
    message: line ? first.message : named,
    since,
  }
}

/** Every error with its line filled in when the text shows one (the PUT 400 answer). */
export function withLines(text: string | null, errors: RuleValidationError[]): RuleValidationError[] {
  if (!text) return errors
  return errors.map((error) => {
    const line = lineOfError(text, error)
    return line ? { ...error, line } : error
  })
}

/** A js-yaml syntax error as a `rulesError` (its `mark.line` is 0-based). */
export function syntaxErrorOf(error: unknown, since: number): RulesError {
  const mark = (error as { mark?: { line?: number } } | null)?.mark
  const reason = (error as { reason?: string } | null)?.reason
    ?? (error instanceof Error ? error.message : String(error))
  return {
    ...(typeof mark?.line === 'number' ? { line: mark.line + 1 } : {}),
    message: `The file is not valid YAML: ${reason}.`,
    since,
  }
}
