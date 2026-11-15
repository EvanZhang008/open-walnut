/**
 * The zod rules Walnut keeps across zod's own changes, in one place.
 *
 * zod 4.5 made two string rules stricter or different (its 4.5.0 release notes):
 * - `datetime()` needs seconds: `2026-10-22T12:30Z` is refused. Walnut took such
 *   times before (stored inbox items and receipts, task_history before/since), so
 *   `isoDateTime()` still takes them and hands the time back with `:00` seconds.
 * - `.min()`/`.max()` count code points, no longer UTF-16 units. That matches the
 *   `maxLength` an op's JSON Schema shows, so op inputs keep zod's count. A schema
 *   whose limit a hand-written check repeats in UTF-16 units (JS `.length`), such as
 *   the inbox items letter-check.ts and the store check, uses `utf16String()`.
 *
 * And every list that comes from outside has a size bound (`LIST_MAX`): zod checks
 * a bound before it parses the elements (4.6.6, GHSA-mrhx-c7xc-m3w5), so a huge
 * list costs one issue instead of one per element. `oversizedCollection()` is the
 * bound for what a schema cannot bound itself (records, plugin schemas).
 */

import { z } from 'zod'

/** The bound of a list an op takes from a caller: far above any real use. */
export const LIST_MAX = 1000

/**
 * The bound of any list or object anywhere in an op's arguments: far above a real
 * payload (an `api` body, an MCP tool's arguments), and a cap on how many issues
 * one record of checked values can make zod collect.
 */
export const COLLECTION_MAX = 100_000

// What zod 4.3's z.string().datetime({ offset: true }) took: leap years checked,
// seconds and their fraction optional, Z or a +hh:mm/-hh:mm offset.
const DATE = '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'
export const ISO_DATETIME = new RegExp(`^${DATE}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`)
const MINUTES_ONLY = /^(.{10}T\d\d:\d\d)(Z|[+-].*)$/

/** `2026-10-22T12:30Z` -> `2026-10-22T12:30:00Z`; any other accepted time unchanged. */
export function withSeconds(value: string): string {
  const m = MINUTES_ONLY.exec(value)
  return m ? `${m[1]}:00${m[2]}` : value
}

/** An ISO 8601 time with a zone, seconds optional (filled in as `:00`). */
export function isoDateTime() {
  return z.string().regex(ISO_DATETIME, 'Invalid ISO datetime: expected YYYY-MM-DDTHH:MM[:SS[.fff]] with Z or an offset').transform(withSeconds)
}

/** A string at most `max` UTF-16 units long (JS `.length`), as a hand-written check counts it. */
export function utf16String(max: number) {
  return z.string().max(max).superRefine((value, ctx) => {
    if (value.length > max) {
      ctx.addIssue({ code: 'too_big', origin: 'string', maximum: max, inclusive: true, input: value, message: `Too big: expected string to have <=${max} characters` })
    }
  })
}

/**
 * The path of the first list or object in `value` with more than `max` entries, or
 * null. Runs before zod, which would otherwise walk every element of a record or an
 * unbounded list. Iterative, so a deep value cannot overflow the stack; the
 * request body limit bounds the total size.
 */
export function oversizedCollection(value: unknown, max = COLLECTION_MAX): string | null {
  const stack: Array<[unknown, string]> = [[value, '']]
  while (stack.length) {
    const [node, path] = stack.pop()!
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      if (node.length > max) return path || '(root)'
      node.forEach((v, i) => stack.push([v, `${path}[${i}]`]))
      continue
    }
    const keys = Object.keys(node)
    if (keys.length > max) return path || '(root)'
    for (const k of keys) stack.push([(node as Record<string, unknown>)[k], path ? `${path}.${k}` : k])
  }
  return null
}
