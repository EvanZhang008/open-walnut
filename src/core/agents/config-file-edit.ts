/**
 * Surgical edits to an engine's config file. Pure functions over text; the
 * transport (daemon fs.read / fs.write) lives in engine-settings-service.ts.
 *
 * Two formats, one rule: change ONLY the addressed key and leave every other
 * byte of meaning in place. These files are owned by the engine and hold data
 * Walnut never declared (hooks, permission allowlists, provider tables), so
 * "parse, mutate, re-serialize the whole document" is only acceptable where
 * the format carries no information a re-serialize would lose (JSON). TOML
 * carries comments and layout, so it gets line-level edits of top-level
 * scalars instead of a parser.
 */

export type JsonObject = Record<string, unknown>

const MAX_DEPTH = 8

function splitPath(path: string): string[] {
  const segments = path.split('.')
  if (segments.length === 0 || segments.length > MAX_DEPTH || segments.some((s) => s.length === 0)) {
    throw new Error(`invalid setting path '${path}'`)
  }
  return segments
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

// ── JSON ──

/** Parse a JSON settings file. An unparsable file throws: never write over bytes we could not read. */
export function parseJsonObject(text: string, label: string): JsonObject {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isObject(parsed)) throw new Error(`${label} is not a JSON object`)
  return parsed
}

export function getJsonPath(obj: JsonObject, path: string): unknown {
  let cur: unknown = obj
  for (const seg of splitPath(path)) {
    if (!isObject(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * Set a dotted path, creating intermediate objects. Returns a NEW root; the
 * input is never mutated. Sibling keys at every level are carried over as-is,
 * which is what keeps `permissions.allow` intact when `permissions.defaultMode`
 * changes.
 */
export function setJsonPath(obj: JsonObject, path: string, value: unknown): JsonObject {
  const segments = splitPath(path)
  const walk = (node: JsonObject, depth: number): JsonObject => {
    const key = segments[depth]
    if (depth === segments.length - 1) return { ...node, [key]: value }
    const child = node[key]
    // A scalar where an object is needed is replaced: the engine's schema says
    // this path is an object, so the scalar was never meaningful to it.
    const next = isObject(child) ? child : {}
    return { ...node, [key]: walk(next, depth + 1) }
  }
  return walk(obj, 0)
}

/** Remove a dotted path. Empty intermediate objects are left in place (harmless, and what the CLI does). */
export function unsetJsonPath(obj: JsonObject, path: string): JsonObject {
  const segments = splitPath(path)
  const walk = (node: JsonObject, depth: number): JsonObject => {
    const key = segments[depth]
    if (!(key in node)) return node
    if (depth === segments.length - 1) {
      const { [key]: _removed, ...rest } = node
      return rest
    }
    const child = node[key]
    if (!isObject(child)) return node
    return { ...node, [key]: walk(child, depth + 1) }
  }
  return walk(obj, 0)
}

/**
 * Serialize in the style of the text being replaced (indent unit and trailing
 * newline), so a Walnut edit diffs as one line instead of a reformat. Without a
 * reference text: 2-space JSON with no trailing newline, which is what Claude
 * Code itself writes.
 */
export function serializeJsonObject(obj: JsonObject, like?: string): string {
  let indent: string | number = 2
  let trailingNewline = false
  if (like !== undefined) {
    const firstIndented = /^([ \t]+)"/m.exec(like)
    if (firstIndented) indent = firstIndented[1].includes('\t') ? '\t' : firstIndented[1].length
    trailingNewline = like.endsWith('\n')
  }
  return JSON.stringify(obj, null, indent) + (trailingNewline ? '\n' : '')
}

// ── TOML, top-level scalars only ──

export type TomlScalar = string | boolean | number

interface TomlTopLevelLine {
  index: number
  key: string
  value: TomlScalar | undefined
}

const KEY_LINE = /^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/

/** Parse the value half of a `key = value` line. Unsupported shapes (arrays, tables, dates) return undefined. */
function parseTomlScalar(raw: string): TomlScalar | undefined {
  const text = stripTrailingComment(raw)
  // A triple-quoted string (multi-line or not) is not a shape this editor
  // rewrites; without this check `'''` alone reads as the literal string `'`.
  if (text.startsWith('"""') || text.startsWith("'''")) return undefined
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      return undefined
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return undefined
}

/** Drop a `# comment` that follows a scalar, without touching `#` inside a quoted string. */
function stripTrailingComment(raw: string): string {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#') return raw.slice(0, i).trim()
  }
  return raw.trim()
}

/** The multi-line string delimiter a line ends inside of, if any. */
type MultiLineQuote = '"""' | "'''" | null

/**
 * Scan one line for structure that spans lines: bracket depth (multi-line arrays
 * and inline tables) and multi-line string delimiters, ignoring anything inside
 * a string. `open` is the multi-line string the previous line ended inside of.
 */
function scanLine(line: string, open: MultiLineQuote): { delta: number; open: MultiLineQuote } {
  let depth = 0
  let quote: string | null = null
  let i = 0
  if (open) {
    const close = line.indexOf(open)
    if (close === -1) return { delta: 0, open }
    i = close + 3
    open = null
  }
  for (; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      const triple = line.slice(i, i + 3)
      if (triple === '"""' || triple === "'''") {
        const close = line.indexOf(triple, i + 3)
        if (close === -1) return { delta: depth, open: triple }
        i = close + 2
        continue
      }
      quote = ch
      continue
    }
    if (ch === '#') break
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
  }
  return { delta: depth, open: null }
}

/**
 * Locate the top-level region (every line before the first `[table]` header)
 * and the `key = value` lines in it. Lines inside a multi-line array, inline
 * table or multi-line string are skipped, so an element such as `"turn-ended",`
 * is never mistaken for a key and a `[` inside a string never for a table header.
 */
function scanTomlTopLevel(lines: string[]): { keyLines: TomlTopLevelLine[]; endOfTopLevel: number } {
  const keyLines: TomlTopLevelLine[] = []
  let depth = 0
  let open: MultiLineQuote = null
  let endOfTopLevel = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (depth === 0 && open === null) {
      if (trimmed.startsWith('[')) { endOfTopLevel = i; break }
      const m = KEY_LINE.exec(trimmed)
      if (m && !trimmed.startsWith('#')) {
        keyLines.push({ index: i, key: m[1], value: parseTomlScalar(m[2]) })
      }
    }
    const scanned = scanLine(line, open)
    open = scanned.open
    depth += scanned.delta
    if (depth < 0) depth = 0
  }
  return { keyLines, endOfTopLevel }
}

/** Thrown when a key's current value is a shape this editor cannot replace in place (a multi-line string, an array). */
export class TomlUnsupportedValueError extends Error {
  constructor(key: string) {
    super(`cannot change '${key}' in place: its current value is not a plain string, number or boolean`)
    this.name = 'TomlUnsupportedValueError'
  }
}

/** Current top-level scalar values. A key whose value is not a scalar we understand maps to undefined. */
export function readTomlTopLevel(text: string): Map<string, TomlScalar | undefined> {
  const out = new Map<string, TomlScalar | undefined>()
  for (const kl of scanTomlTopLevel(text.split(/\r?\n/)).keyLines) out.set(kl.key, kl.value)
  return out
}

function formatTomlScalar(value: TomlScalar): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * Apply `set` and `unset` to the top-level region. Existing lines are replaced
 * in place (their comment tail kept), new keys are appended at the end of the
 * top-level region (before the first table, after any trailing blank lines are
 * skipped back over), removed keys drop their line. Everything else, including
 * comments and every table, is returned byte-for-byte.
 */
export function editTomlTopLevel(text: string, set: Record<string, TomlScalar>, unset: readonly string[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const { keyLines, endOfTopLevel } = scanTomlTopLevel(lines)
  const byKey = new Map(keyLines.map((kl) => [kl.key, kl]))
  const replaced = new Set<number>()
  const removed = new Set<number>()
  const appended: string[] = []

  // A line whose value the scanner did not understand (`model = """` opening a
  // multi-line string, an array) cannot be replaced or dropped by the line: the
  // continuation lines would be left behind as stray text.
  const existingScalar = (key: string): TomlTopLevelLine | undefined => {
    const existing = byKey.get(key)
    if (existing && existing.value === undefined) throw new TomlUnsupportedValueError(key)
    return existing
  }

  for (const key of unset) {
    const existing = existingScalar(key)
    if (existing) removed.add(existing.index)
  }
  for (const [key, value] of Object.entries(set)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid TOML key '${key}'`)
    const existing = existingScalar(key)
    const rendered = key + ' = ' + formatTomlScalar(value)
    if (existing) {
      // Keep a trailing comment: `key = "x" # why` → `key = "y" # why`.
      const m = KEY_LINE.exec(lines[existing.index].trim())
      const rawValue = m ? m[2] : ''
      const scalarPart = stripTrailingComment(rawValue)
      const tail = rawValue.slice(rawValue.indexOf(scalarPart) + scalarPart.length)
      lines[existing.index] = rendered + tail
      replaced.add(existing.index)
      removed.delete(existing.index)
    } else {
      appended.push(rendered)
    }
  }

  // Insert new keys right after the last non-blank top-level line so the file
  // keeps its "keys, blank line, first table" shape. With no tables and no
  // trailing newline, insertAt lands past the last line and the keys go last.
  let insertAt = endOfTopLevel
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) out.push(...appended)
    if (removed.has(i)) continue
    out.push(lines[i])
  }
  if (insertAt >= lines.length) out.push(...appended)
  return out.join(eol)
}
