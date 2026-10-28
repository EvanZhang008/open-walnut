import { z } from 'zod'
import { identifierSchema, immutableJson } from './protocol.js'

const requestSchema = z.union([
  z.strictObject({ type: z.literal('list'), after: identifierSchema.nullable() }),
  z.strictObject({ type: z.literal('lookup'), nodeId: identifierSchema }),
])
export function discoveryRequest(raw: unknown): z.infer<typeof requestSchema> | undefined {
  if (raw === null) return { type: 'list', after: null }
  if (typeof raw !== 'string' || raw.length > 512 || Buffer.byteLength(raw) > 512) return undefined
  try {
    const copied = immutableJson(JSON.parse(raw), 512)
    if (!copied.success) return undefined
    const parsed = requestSchema.safeParse(copied.payload)
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
