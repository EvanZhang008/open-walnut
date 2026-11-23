/**
 * A read-size count over its op's most is answered with the most (src/ops/count-cap.ts).
 *
 * 2026-11-23: a lead's task_history call with limit 400 (most 200) failed in real use, and the
 * same refusal waited in every op that bounds a count. Now parseOpArgs reads it as the most and
 * the answer's walnut_note says so, and the schema a client checks before sending (MCP, Claude
 * Code) shows no most for these keys, or the client would refuse the call before Walnut sees it.
 *
 * The class guard: every bounded top-level number in the catalog is either a count (capped) or
 * listed here with why it stays refused. A new bounded number fails until it names its side.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { executeOp, getOp, listOps, opInputJsonSchema, parseOpArgs } from '../../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import { COUNT_KEYS, callerInputShape, declaredMost } from '../../../src/ops/count-cap.js'

// Numbers whose bound is part of what the call does, so a larger one is refused, not shortened.
const REFUSED: Record<string, string> = {
  wait_ms: 'a wait is the caller\'s plan: shortening it would change what the call waits for',
  timeout_ms: 'a deadline the caller chose',
  timeout_min: 'a deadline the caller chose',
  timeoutSeconds: 'a deadline the caller chose',
  reply_timeout: 'a deadline the caller chose',
  ms: 'a wait the caller chose',
  everyMinutes: 'a schedule',
  every_turns: 'a schedule',
  width: 'a size of a page or picture',
  height: 'a size of a page or picture',
  radius_m: 'a place\'s size',
  steps: 'how much a browser does, not how much it reads',
  label: 'an element number on a page',
  bucket: 'the width of a history bucket',
  long_min: 'a threshold the report applies',
  merge_gap_min: 'a threshold the report applies',
  chars: 'usage_watch probe: a measured length, not a read size',
  of: 'a part number of a split answer',
  part: 'a part number of a split answer',
  parts: 'a part number of a split answer',
}

const bounded = listOps().flatMap((op) => Object.entries(op.input)
  .map(([key, schema]) => ({ op, key, most: declaredMost(schema as z.ZodType) }))
  .filter((r): r is { op: typeof r.op; key: string; most: number } => r.most !== undefined))

describe('every bounded number in the catalog names its side', () => {
  it('is a read-size count or is listed with why a larger one is refused', () => {
    const unnamed = bounded.filter((r) => !COUNT_KEYS.has(r.key) && !REFUSED[r.key]).map((r) => `${r.op.name}.${r.key}`)
    expect(unnamed, 'add the key to COUNT_KEYS (src/ops/count-cap.ts) when it only bounds the answer, else to REFUSED here').toEqual([])
    // A listed key no op has any more is dropped from the list.
    const stale = Object.keys(REFUSED).filter((k) => !bounded.some((r) => r.key === k))
    expect(stale).toEqual([])
    expect(bounded.filter((r) => COUNT_KEYS.has(r.key)).length).toBeGreaterThan(20)
  })

  it('every count of a read shows no most to a client, and the client\'s shape takes a larger one', () => {
    for (const { op, key, most } of bounded.filter((r) => COUNT_KEYS.has(r.key) && r.op.tags.readonly === true)) {
      const prop = (opInputJsonSchema(op).properties as Record<string, { maximum?: number; description?: string }>)[key]
      expect(prop.maximum === undefined || prop.maximum >= Number.MAX_SAFE_INTEGER, `${op.name}.${key}`).toBe(true)
      expect(prop.description, `${op.name}.${key}`).toContain(`more reads as ${most}`)
      expect((callerInputShape(op)[key] as z.ZodType).safeParse(most + 1).success, `${op.name}.${key}`).toBe(true)
      // Below the least, a fraction and a word are still refused.
      expect((callerInputShape(op)[key] as z.ZodType).safeParse(-1).success, `${op.name}.${key}`).toBe(false)
      expect((callerInputShape(op)[key] as z.ZodType).safeParse(1.5).success, `${op.name}.${key}`).toBe(false)
      expect((callerInputShape(op)[key] as z.ZodType).safeParse('many').success, `${op.name}.${key}`).toBe(false)
    }
  })

  it('every count over its most parses as the most, with the note', () => {
    for (const { op, key, most } of bounded.filter((r) => COUNT_KEYS.has(r.key))) {
      // Only the count is judged here: other issues (a missing id) are the op's own.
      const r = z.object(op.input).strict().safeParse({ [key]: most + 50 })
      const issue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === key)
      expect(issue?.code, `${op.name}.${key}`).toBe('too_big')
    }
    const th = parseOpArgs(getOp('task_history')!, { id: 'abc', limit: 400 })
    expect(th).toEqual({ ok: true, args: { id: 'abc', limit: 200 }, capNote: "limit 400 is over task_history's most, 200: answered with 200." })
  })
})

describe('parseOpArgs caps only a count of a read', () => {
  it('a write\'s count still shows its most and is still refused over it (it can bound what the write changes)', () => {
    const writes = bounded.filter((r) => COUNT_KEYS.has(r.key) && r.op.tags.readonly !== true)
    expect(writes.length).toBeGreaterThan(0)
    for (const { op, key, most } of writes) {
      const prop = (opInputJsonSchema(op).properties as Record<string, { maximum?: number }>)[key]
      expect(prop.maximum, `${op.name}.${key}`).toBe(most)
    }
    const r = parseOpArgs(getOp('project_make_local')!, { limit: 400 } as never)
    expect(!r.ok && r.message).toMatch(/limit/)
  })

  it('a refused number stays refused, and a count is still capped beside it', () => {
    const r = parseOpArgs(getOp('approval_wait')!, { id: 'x', token: 't', wait_ms: 60_000 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/wait_ms/)
  })

  it('another problem in the same call is still reported, the count no longer is', () => {
    const r = parseOpArgs(getOp('task_history')!, { id: 'abc', limit: 400, nope: 1 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/nope/)
    expect(!r.ok && r.message).not.toMatch(/Too big|limit:/)
  })

  it('a count within its most, below its least or not a number is unchanged', () => {
    expect(parseOpArgs(getOp('task_history')!, { id: 'abc', limit: 200 })).toEqual({ ok: true, args: { id: 'abc', limit: 200 } })
    expect(parseOpArgs(getOp('task_history')!, { id: 'abc', limit: 0 }).ok).toBe(false)
    expect(parseOpArgs(getOp('task_history')!, { id: 'abc', limit: 'lots' }).ok).toBe(false)
  })

  it('never edits the caller\'s object', () => {
    const raw = { id: 'abc', limit: 400 }
    parseOpArgs(getOp('task_history')!, raw)
    expect(raw.limit).toBe(400)
  })
})

describe('executeOp answers a capped count with the note', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('search with limit 400 asks for 100 and says so in walnut_note', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ results: [], walnut_note: 'an op note' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const r = await executeOp('search', { q: 'walnut', limit: 400 }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(urls.some((u) => /[?&]limit=100\b/.test(u)), urls.join(' ')).toBe(true)
    // An op's own note is kept, the cap's follows it.
    expect((r as { result: { walnut_note: string } }).result.walnut_note)
      .toBe("an op note limit 400 is over search's most, 100: answered with 100.")
  })

  it('an agent\'s answer keeps the note after the op\'s own shape rebuilt it', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ results: [{ id: 't1', type: 'task', title: 'A' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await executeOp('search', { q: 'walnut', limit: 400 }, { apiBase: 'http://127.0.0.1:1', origin: LOCAL_ORIGIN, forAgent: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify((r as { result: unknown }).result)).toContain("limit 400 is over search's most, 100: answered with 100.")
  })
})
