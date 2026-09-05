/**
 * JSON Schema -> zod shape, the conversion that lets an op be declared from
 * outside this repo (plugin-api carries no zod, so a plugin op ships a JSON
 * Schema and the host converts it here).
 *
 * The round-trip test is the load-bearing one: a converted op is rendered back
 * as JSON Schema by opInputJsonSchema for MCP, the CLI, and the docs, so what a
 * plugin declared has to survive the trip.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaToZodShape, jsonSchemaToZodType } from '../../../src/ops/schema-to-zod.js'
import { opInputJsonSchema } from '../../../src/ops/registry.js'

/** Exactly how executor.ts validates an op's args, so these tests grade the real gate. */
function parseArgs(schema: unknown, args: Record<string, unknown>) {
  const result = z.object(jsonSchemaToZodShape(schema)).strict().safeParse(args)
  return {
    ok: result.success,
    data: result.data as Record<string, unknown> | undefined,
    issues: result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
  }
}

function rendered(schema: unknown): Record<string, unknown> {
  return opInputJsonSchema({
    name: 'probe',
    title: 'Probe',
    description: 'Probe',
    input: jsonSchemaToZodShape(schema),
    handler: async () => undefined,
    tags: { readonly: true, remote: 'allow' },
  })
}

describe('jsonSchemaToZodType', () => {
  it('converts the scalar types', () => {
    expect(jsonSchemaToZodType({ type: 'string' }).safeParse('x').success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'string' }).safeParse(1).success).toBe(false)
    expect(jsonSchemaToZodType({ type: 'number' }).safeParse(1.5).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'integer' }).safeParse(1.5).success).toBe(false)
    expect(jsonSchemaToZodType({ type: 'integer' }).safeParse(2).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'boolean' }).safeParse(true).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'boolean' }).safeParse('true').success).toBe(false)
  })

  it('converts a string enum and rejects a value outside it', () => {
    const type = jsonSchemaToZodType({ type: 'string', enum: ['plan', 'exec'] })
    expect(type.safeParse('plan').success).toBe(true)
    expect(type.safeParse('other').success).toBe(false)
  })

  it('treats a mixed-type enum as unknown rather than guessing', () => {
    const type = jsonSchemaToZodType({ enum: ['plan', 3] })
    expect(type.safeParse(3).success).toBe(true)
    expect(type.safeParse({ anything: true }).success).toBe(true)
  })

  it('converts arrays of scalars, and an itemless array to an array of anything', () => {
    expect(jsonSchemaToZodType({ type: 'array', items: { type: 'string' } }).safeParse(['a']).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'array', items: { type: 'string' } }).safeParse([1]).success).toBe(false)
    expect(jsonSchemaToZodType({ type: 'array' }).safeParse([1, 'a', null]).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'array' }).safeParse('a').success).toBe(false)
  })

  it('converts a nested object with its own required list', () => {
    const type = jsonSchemaToZodType({
      type: 'object',
      properties: { deep: { type: 'string' }, maybe: { type: 'number' } },
      required: ['deep'],
    })
    expect(type.safeParse({ deep: 'x' }).success).toBe(true)
    expect(type.safeParse({ maybe: 1 }).success).toBe(false)
  })

  it('keeps a freeform object bag whole instead of emptying it', () => {
    // JSON Schema allows extra keys by default; zod's `object` STRIPS them, so a
    // `{ type: 'object' }` payload used to reach the handler as {}.
    const parsed = parseArgs(
      { type: 'object', properties: { payload: { type: 'object' } } },
      { payload: { any: 1, nested: { deep: true } } },
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.data?.payload).toEqual({ any: 1, nested: { deep: true } })
  })

  it('keeps undeclared keys on a nested object that DOES declare properties', () => {
    const parsed = parseArgs(
      {
        type: 'object',
        properties: {
          filter: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
          rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        },
      },
      { filter: { project: 'walnut', extra: 7 }, rows: [{ id: 'a', extra: 8 }] },
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.data?.filter).toEqual({ project: 'walnut', extra: 7 })
    expect(parsed.data?.rows).toEqual([{ id: 'a', extra: 8 }])
  })

  it('carries description through to the rendered schema', () => {
    expect(rendered({
      type: 'object',
      properties: { who: { type: 'string', description: 'Who to greet' } },
      required: ['who'],
    })).toMatchObject({ properties: { who: { description: 'Who to greet' } } })
  })

  it('falls back to unknown for a construct it does not model', () => {
    for (const schema of [{ type: 'null' }, { oneOf: [{ type: 'string' }] }, 'nonsense', null]) {
      expect(jsonSchemaToZodType(schema).safeParse({ whatever: true }).success).toBe(true)
    }
  })
})

describe('jsonSchemaToZodShape', () => {
  it('marks every property not in required as optional', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { who: { type: 'string' }, loud: { type: 'boolean' } },
      required: ['who'],
    })
    expect(Object.keys(shape)).toEqual(['who', 'loud'])
    expect(shape.who.safeParse(undefined).success).toBe(false)
    expect(shape.loud.safeParse(undefined).success).toBe(true)
  })

  it('enforces a required property whose type fell back to unknown', () => {
    // z.unknown() accepts undefined, so this used to be advertised in `required`
    // and then accepted as missing, handing the handler an undefined argument the
    // contract promised was there.
    const schema = { type: 'object', properties: { id: { oneOf: [{ type: 'string' }] } }, required: ['id'] }
    expect(parseArgs(schema, {}).issues).toEqual(['id: Required'])
    expect(parseArgs(schema, { id: 0 }).ok).toBe(true)
    expect(parseArgs(schema, { id: null }).ok).toBe(true)
    // Still rendered as the same contract: present in `required`, no invented type.
    const json = rendered(schema)
    expect(json.required).toEqual(['id'])
    expect((json.properties as Record<string, unknown>).id).toEqual({})
  })

  it('leaves an OPTIONAL unknown property genuinely optional', () => {
    const schema = { type: 'object', properties: { id: { oneOf: [{ type: 'string' }] } } }
    expect(parseArgs(schema, {}).ok).toBe(true)
    expect(rendered(schema).required).toBeUndefined()
  })

  it('returns an empty shape for a missing, empty, or malformed schema', () => {
    expect(jsonSchemaToZodShape()).toEqual({})
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({})
    expect(jsonSchemaToZodShape({ type: 'object', properties: [] })).toEqual({})
    expect(jsonSchemaToZodShape('nope')).toEqual({})
  })

  it('ignores default, so the rendered contract never gains a value nobody sent', () => {
    const schema = rendered({
      type: 'object',
      properties: { limit: { type: 'integer', default: 20 } },
    })
    expect((schema.properties as Record<string, Record<string, unknown>>).limit.default).toBeUndefined()
  })

  it('round-trips properties and required through opInputJsonSchema', () => {
    const input = {
      type: 'object',
      properties: {
        who: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        loud: { type: 'boolean' },
        mode: { type: 'string', enum: ['plan', 'exec'] },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { deep: { type: 'string' } }, required: ['deep'] },
      },
      required: ['who', 'loud', 'nested'],
    }
    const schema = rendered(input)
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(Object.keys(input.properties))
    expect([...(schema.required as string[])].sort()).toEqual([...input.required].sort())
    expect(schema.type).toBe('object')
    // Types survive as zod renders them: integer stays integer, the enum stays an enum.
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.count.type).toBe('integer')
    expect(properties.mode).toMatchObject({ type: 'string', enum: ['plan', 'exec'] })
    expect(properties.nested).toMatchObject({ type: 'object', required: ['deep'] })
  })
})
