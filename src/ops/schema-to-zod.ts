/**
 * JSON Schema -> zod object shape, for ops declared OUTSIDE this repo.
 *
 * Core ops are written in TypeScript and declare `input` as a zod shape
 * directly. A plugin cannot: `@open-walnut/plugin-api` has no zod dependency on
 * purpose (a plugin must not have to match the host's zod major), so the public
 * `registry.op` spec carries a JSON Schema `inputSchema` exactly like
 * `registry.tool` does, and the host converts it here.
 *
 * Pure: no I/O, no registry access. The supported subset is deliberately small
 * and everything outside it degrades to `z.unknown()` rather than throwing, so a
 * schema this file does not understand still yields a callable op. Degrading must
 * not weaken the contract, though: a REQUIRED property is still required, and a
 * nested object still keeps the keys the caller sent.
 */

import { z } from 'zod'

type JsonSchema = Record<string, unknown>

function asSchema(value: unknown): JsonSchema | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchema : undefined
}

function stringEnum(schema: JsonSchema): z.ZodTypeAny | undefined {
  if (!Array.isArray(schema.enum)) return undefined
  const values = schema.enum.filter((value): value is string => typeof value === 'string')
  if (values.length === 0 || values.length !== schema.enum.length) return undefined
  return z.enum(values as [string, ...string[]])
}

/** True when a type is the unsupported-construct fallback rather than a real type. */
function isUnknownFallback(type: z.ZodTypeAny): boolean {
  return type instanceof z.ZodUnknown
}

/** One property's type. Unsupported constructs become `z.unknown()`. */
export function jsonSchemaToZodType(input: unknown): z.ZodTypeAny {
  const schema = asSchema(input)
  if (!schema) return z.unknown()

  const described = (type: z.ZodTypeAny): z.ZodTypeAny =>
    typeof schema.description === 'string' && schema.description
      ? type.describe(schema.description)
      : type

  const enumType = stringEnum(schema)
  if (enumType) return described(enumType)

  switch (schema.type) {
    case 'string': return described(z.string())
    case 'number': return described(z.number())
    case 'integer': return described(z.number().int())
    case 'boolean': return described(z.boolean())
    case 'array': return described(z.array(schema.items === undefined ? z.unknown() : jsonSchemaToZodType(schema.items)))
    // JSON Schema objects allow extra keys unless told otherwise; zod's `object`
    // STRIPS them. Stripping would silently empty a freeform payload bag on its
    // way to the handler, so nested objects stay loose and a `type: 'object'`
    // with no declared properties becomes a plain string-keyed record.
    case 'object': return described(
      asSchema(schema.properties)
        ? z.looseObject(jsonSchemaToZodShape(schema))
        : z.record(z.string(), z.unknown()),
    )
    default: return described(z.unknown())
  }
}

/**
 * The `properties`/`required` pair of a JSON Schema object as a zod shape, which
 * is what `WalnutOp.input` is (executor.ts wraps it in `z.object(...).strict()`).
 *
 * `default` is IGNORED: a zod default silently rewrites the caller's args, and
 * an op's declared input is also its documented contract (opInputJsonSchema
 * renders it for MCP, the CLI, and docs), so a value nobody sent must not appear
 * there. Declare the default in the property's `description` instead.
 */
export function jsonSchemaToZodShape(input?: unknown): Record<string, z.ZodTypeAny> {
  const schema = asSchema(input)
  const properties = asSchema(schema?.properties)
  if (!properties) return {}

  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  )

  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, property] of Object.entries(properties)) {
    const type = jsonSchemaToZodType(property)
    if (!required.has(name)) {
      shape[name] = type.optional()
      continue
    }
    // `z.unknown()` accepts undefined, so a required property whose type fell back
    // to it would be advertised in `required` and then accepted as missing — the
    // handler reads undefined for an argument the contract promised. Refine it back
    // into a real presence check; it still renders as `{}`.
    shape[name] = isUnknownFallback(type)
      ? type.refine((value) => value !== undefined, 'Required')
      : type
  }
  return shape
}
