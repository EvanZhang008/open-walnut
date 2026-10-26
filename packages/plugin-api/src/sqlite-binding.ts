// Plugin database parameter binding, by better-sqlite3's rules: the plugin database contract.
// One module for both sides that must agree on it: the fake database plugin tests run against
// (testing-database.ts, over node:sqlite) and the host's plugin database worker
// (src/core/plugins/plugin-storage.ts, over bun:sqlite, which loads this through src/lib/sqlite.ts).
// Internal: no entry point of the package exports it; its importers carry it into their bundles.

export interface ParameterSlots {
  /** sqlite3_bind_parameter_count: the highest parameter index. */
  count: number
  /** Index to the name SQLite reports for it (with its prefix). An index with no name is anonymous. */
  names: Map<number, string>
}

function isIdChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 95 || code === 36 || code >= 0x80
}

/**
 * What better-sqlite3 lets follow the one statement it prepares: whitespace, `;` and comments.
 * A whole SQL string of nothing else holds no statement at all.
 */
export function onlyTrailingNoise(tail: string): boolean {
  let i = 0
  while (i < tail.length) {
    const char = tail[i]
    if (char === ' ' || char === ';' || (char >= '\t' && char <= '\r')) {
      i++
    } else if (char === '/' && tail[i + 1] === '*') {
      const end = tail.indexOf('*/', i + 2)
      i = end < 0 ? tail.length : end + 2
    } else if (char === '-' && tail[i + 1] === '-') {
      const end = tail.indexOf('\n', i + 2)
      i = end < 0 ? tail.length : end + 1
    } else {
      return false
    }
  }
  return true
}

/**
 * SQLite's own numbering of `?`, `?NNN`, `:name`, `@name`, `$name` and `#name`, skipping literals
 * and comments. Without the TCL forms (`$a::b`, `$a(x)`): better-sqlite3's SQLite build leaves them out.
 */
export function parameterSlots(sql: string): ParameterSlots {
  const names = new Map<number, string>()
  const numbers = new Map<string, number>()
  let count = 0
  const add = (name: string, index: number) => {
    if (!numbers.has(name)) numbers.set(name, index)
    if (!names.has(index)) names.set(index, name)
  }
  let i = 0
  while (i < sql.length) {
    const char = sql[i]
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end < 0 ? sql.length : end + 1
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
    } else if (char === "'" || char === '"' || char === '`') {
      i++
      while (i < sql.length) {
        if (sql[i] === char) {
          if (sql[i + 1] !== char) break
          i++
        }
        i++
      }
      i++
    } else if (char === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end < 0 ? sql.length : end + 1
    } else if (char === '?') {
      let end = i + 1
      while (end < sql.length && sql.charCodeAt(end) >= 48 && sql.charCodeAt(end) <= 57) end++
      if (end === i + 1) {
        count++
      } else {
        const index = Number(sql.slice(i + 1, end))
        if (index > count) count = index
        add(sql.slice(i, end), index)
      }
      i = end
    } else if (char === ':' || char === '@' || char === '$' || char === '#') {
      let end = i + 1
      while (end < sql.length && isIdChar(sql.charCodeAt(end))) end++
      const name = sql.slice(i, end)
      if (end > i + 1 && !numbers.has(name)) add(name, ++count)
      i = end
    } else if (isIdChar(sql.charCodeAt(i))) {
      // Identifiers, keywords and numbers: a `$` inside `a$b` is part of the name, not a parameter.
      while (i < sql.length && isIdChar(sql.charCodeAt(i))) i++
    } else {
      i++
    }
  }
  return { count, names }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function bindable(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || ArrayBuffer.isView(value)) return value
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * bindable() plus better-sqlite3's refusal of a bigint outside 64 bits, for the host:
 * bun:sqlite binds one as 0 without a word (node:sqlite, under the fake, refuses it itself).
 */
function bindableInt64(value: unknown): unknown {
  const bound = bindable(value)
  if (typeof bound === 'bigint' && (bound < INT64_MIN || bound > INT64_MAX)) {
    throw new RangeError('The bound string, buffer, or bigint is too big')
  }
  return bound
}

interface CheckedBinding {
  slots: ParameterSlots
  /** The anonymous slots' values, in index order: exactly one per anonymous slot. */
  positional: unknown[]
  /** Exact parameter name (with its prefix) to value, when the call passed a plain object. */
  namedValues?: Record<string, unknown>
}

/**
 * better-sqlite3's Binder over the host's `invoke` (an array is the argument list, anything else
 * one argument): every refusal, with its message, class and order. Returns only a complete binding.
 */
function checkBinding(sql: string, params: unknown, bind: (value: unknown) => unknown): CheckedBinding {
  const args = params === undefined ? [] : Array.isArray(params) ? params : [params]
  const slots = parameterSlots(sql)
  const named = [...slots.names]
    .map(([index, name]) => ({ index, name, key: name.slice(1) }))
    .sort((a, b) => a.index - b.index)
  const anonymousCount = slots.count - slots.names.size
  const positional: unknown[] = []
  let namedValues: Record<string, unknown> | undefined
  const bindAnonymous = (value: unknown) => {
    const bound = bind(value)
    if (positional.length >= anonymousCount) throw new RangeError('Too many parameter values were provided')
    positional.push(bound)
  }
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const value of arg) bindAnonymous(value)
    } else if (isPlainObject(arg)) {
      if (namedValues) throw new TypeError('You cannot specify named parameters in two different objects')
      namedValues = {}
      for (const { name, key } of named) {
        if (!Object.prototype.hasOwnProperty.call(arg, key)) throw new RangeError(`Missing named parameter "${key}"`)
        namedValues[name] = bind(arg[key])
      }
    } else if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && named.length) {
      throw new TypeError('Named parameters can only be passed within plain objects')
    } else {
      bindAnonymous(arg)
    }
  }
  const bound = positional.length + (namedValues ? named.length : 0)
  if (bound < slots.count) {
    if (!namedValues && named.length) throw new TypeError('Missing named parameters')
    throw new RangeError('Too few parameter values were provided')
  }
  return { slots, positional, namedValues }
}

/**
 * bindable() for node:sqlite, which binds every JS number as a REAL: a whole one goes as a
 * bigint, so it binds as the INTEGER Walnut's host (bun:sqlite) binds it as ('3', not '3.0',
 * in a TEXT column; `? / 2` divides as integers).
 */
function bindableLikeHost(value: unknown): unknown {
  const bound = bindable(value)
  return typeof bound === 'number' && Number.isSafeInteger(bound) && !Object.is(bound, -0) ? BigInt(bound) : bound
}

/** The binding as node:sqlite arguments: the named values (when any) as one object, then the positional ones. */
export function bindArguments(sql: string, params: unknown): unknown[] {
  const { positional, namedValues } = checkBinding(sql, params, bindableLikeHost)
  // Exact names, so neither node:sqlite's bare-name nor its unknown-name option can change what binds where.
  return namedValues ? [namedValues, ...positional] : positional
}

/**
 * The binding as exactly `count` values, the value for parameter index i at i - 1: a named slot
 * takes its named value, an anonymous slot (a gap left by `?NNN` included) the next positional
 * one. So an API that binds only by position (bun:sqlite's `run(...values)`) binds every index
 * as better-sqlite3 would.
 */
export function bindByIndex(sql: string, params: unknown): unknown[] {
  const { slots, positional, namedValues } = checkBinding(sql, params, bindableInt64)
  const values: unknown[] = []
  let next = 0
  for (let index = 1; index <= slots.count; index++) {
    const name = slots.names.get(index)
    // checkBinding refuses a call that leaves a named slot without its object, so namedValues is set here.
    values.push(name === undefined ? positional[next++] : namedValues![name])
  }
  return values
}
