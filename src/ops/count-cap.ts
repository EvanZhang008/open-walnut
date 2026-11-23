/**
 * A read-size count over a read op's most is answered with the most, not refused.
 *
 * 2026-11-23: the VP's task_history call with `limit: 400` (most 200) failed, and an agent that
 * asks for "a lot" learns nothing from a refusal it could not have read off the answer instead.
 * A count of what to read (rows, messages, days, characters) only bounds the size of the answer,
 * so a larger one is read as the op's most and the answer says so in its `walnut_note`.
 *
 * Only on a read (`readonly`): a write's count can bound what it changes, so there it is still refused.
 * Every surface checks the same way: parseOpArgs caps (executor.ts), and the schema a client sees
 * leaves out the most for these keys (opInputJsonSchema, the MCP server's shape), so Claude Code
 * does not refuse the call before it reaches Walnut. Any other bounded number (a wait, a port, a
 * size of a picture) is still refused: tests/unit/ops/count-cap.test.ts makes every new bounded number
 * name its side.
 */
import { z } from 'zod'

/** Top-level argument names that count how much an op reads back. */
export const COUNT_KEYS: ReadonlySet<string> = new Set([
  'limit', 'top', 'max', 'max_chars', 'body_max', 'days', 'last_days', 'last_nights',
])

type Issue = { code: string; path: PropertyKey[]; maximum?: unknown; origin?: unknown }

/** The input with each read-size count over its most set to the most, or null when none was over. */
export function capOverCounts(
  input: unknown,
  issues: readonly Issue[],
): { input: Record<string, unknown>; capped: { key: string; asked: unknown; most: number }[] } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const capped: { key: string; asked: unknown; most: number }[] = []
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const i of issues) {
    const key = i.path.length === 1 && typeof i.path[0] === 'string' ? i.path[0] : undefined
    if (i.code !== 'too_big' || i.origin !== 'number' || !key || !COUNT_KEYS.has(key)) continue
    if (typeof i.maximum !== 'number' || !Number.isFinite(i.maximum)) continue
    capped.push({ key, asked: out[key], most: i.maximum })
    out[key] = i.maximum
  }
  return capped.length ? { input: out, capped } : null
}

/** The one line an answer carries when a count was read as its op's most. */
export function countCapNote(op: string, capped: readonly { key: string; asked: unknown; most: number }[]): string {
  return capped.map((c) => `${c.key} ${String(c.asked)} is over ${op}'s most, ${c.most}: answered with ${c.most}.`).join(' ')
}

/** The most a number schema declares (`.max(N)`), unwrapping `.optional()`. */
export function declaredMost(schema: z.ZodType): number | undefined {
  const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema
  if (!(inner instanceof z.ZodNumber)) return undefined
  const most = inner.maxValue
  return typeof most === 'number' && Number.isFinite(most) && most < Number.MAX_SAFE_INTEGER ? most : undefined
}

function withoutMost(schema: z.ZodType, most: number): z.ZodType {
  const optional = schema instanceof z.ZodOptional
  const inner = (optional ? (schema as z.ZodOptional<z.ZodType>).unwrap() : schema) as z.ZodNumber
  const def = inner._zod.def
  const relaxed = inner.clone({ ...def, checks: (def.checks ?? []).filter((c) => c._zod.def.check !== 'less_than') }) as z.ZodNumber
  const said = schema.description ?? inner.description
  const note = `more reads as ${most}`
  const wrapped = optional ? relaxed.optional() : relaxed
  return wrapped.describe(said ? `${said} (${note})` : note)
}

/**
 * A read op's input as a caller sees it: each read-size count without its most, so a larger number
 * reaches parseOpArgs, which caps it. Validation of everything else is unchanged.
 */
export function callerInputShape(op: { input: z.ZodRawShape; tags?: { readonly?: boolean } }): z.ZodRawShape {
  const shape = op.input
  // A write's count can bound what it changes (a batch), so a larger one is still refused there.
  if (op.tags?.readonly !== true) return shape
  let out: z.ZodRawShape | undefined
  for (const [key, schema] of Object.entries(shape)) {
    if (!COUNT_KEYS.has(key)) continue
    const most = declaredMost(schema as z.ZodType)
    if (most === undefined) continue
    out ??= { ...shape }
    ;(out as Record<string, z.ZodType>)[key] = withoutMost(schema as z.ZodType, most)
  }
  return out ?? shape
}
