/**
 * A handler op whose self-calls reach no server says so (`unreachable`), as a bound op does.
 *
 * Incident this pins (2026-11-20): a VP session of a Walnut on another port had no
 * OPEN_WALNUT_API_URL in its process env, so its `walnut tools call` went to the default
 * :3456, where nothing listened. A bound op (task_get) answered `unreachable` and the CLI
 * asked the session's host daemon instead, which reached the right Walnut. task_create, a
 * handler op, turned the refused self-call into a plain error, so the CLI never asked the
 * daemon and the VP read "Walnut server not running at http://127.0.0.1:3456/api/v1".
 *
 * The class is every op with a handler: each one that runs is called here against a fetch
 * that always refuses, and a failure after a refused self-call must carry `unreachable`. A
 * new handler op is covered the day it lands, and the count below fails if the sweep stops
 * reaching most of them (the sample args no longer parse).
 *
 * ZERO side effects: fetch is stubbed, nothing listens, nothing is written.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { executeOp, listOps } from '../../../src/ops/index.js'
import { setSelfApiRoot } from '../../../src/lib/self-api-root.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setSelfApiRoot(null)
})

/** Every fetch is refused the way bun and Node say it (fetch-error.ts). */
function refuseAll(): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' } })
  })
  return { calls: () => n }
}

type Schema = { type?: string | string[]; enum?: unknown[]; const?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; minItems?: number; minLength?: number; format?: string; pattern?: string }

/** A value for a JSON-schema node: the smallest one that is likely to parse. */
function sample(s: Schema | undefined, key = ''): unknown {
  if (!s) return 'x'
  if (s.const !== undefined) return s.const
  if (s.enum?.length) return s.enum[0]
  const alt = s.anyOf ?? s.oneOf
  if (alt?.length) return sample(alt.find((a) => a.type !== 'null') ?? alt[0], key)
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  switch (type) {
    case 'string':
      if (s.format === 'date-time') return '2026-11-20T10:00:00Z'
      if (/id$/i.test(key)) return 'mwpq0000-abcd'
      return 'x'.repeat(Math.max(1, s.minLength ?? 1))
    case 'number': case 'integer': return 1
    case 'boolean': return false
    case 'array': return Array.from({ length: s.minItems ?? 0 }, () => sample(s.items, key))
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const k of s.required ?? []) out[k] = sample(s.properties?.[k], k)
      return out
    }
    default: return 'x'
  }
}

function sampleArgs(input: z.ZodRawShape): Record<string, unknown> | null {
  try {
    return sample(z.toJSONSchema(z.object(input), { unrepresentable: 'any', io: 'input' }) as Schema) as Record<string, unknown>
  } catch { return null }
}

describe('handler ops and a server that is not there', () => {
  it('task_create, the op that failed in the incident, answers unreachable', async () => {
    const fetches = refuseAll()
    const r = await executeOp('task_create', { title: 'probe', record_only: true }, { origin: 'local' } as never)
    expect(fetches.calls()).toBeGreaterThan(0)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ unreachable: true })
  })

  it('every handler op that tried the server and failed says unreachable', async () => {
    const handlerOps = listOps({ includeDeprecated: true }).filter((op) => op.handler)
    const tried: string[] = []
    const missing: string[] = []
    for (const op of handlerOps) {
      const args = sampleArgs(op.input)
      if (!args) continue
      const fetches = refuseAll()
      const r = await executeOp(op.name, args, { origin: 'local' } as never)
      vi.unstubAllGlobals()
      if (fetches.calls() === 0) continue
      tried.push(op.name)
      if (!r.ok && !('unreachable' in r && r.unreachable)) missing.push(`${op.name}: ${r.message.slice(0, 120)}`)
    }
    expect(missing).toEqual([])
    // Most handler ops are reached by the sample args; a sweep that reaches few proves little.
    expect(tried.length, `reached ${tried.length} of ${handlerOps.length} handler ops`).toBeGreaterThanOrEqual(Math.floor(handlerOps.length / 2))
  }, 120_000)
})
