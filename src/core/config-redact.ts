/**
 * Config secret masking — shared by the config route (cloud mode) and the
 * bug-report bundler (always). Key-name-based deep masking: any field whose
 * name is in SECRET_FIELDS gets its value replaced with a `••••…last4` stub.
 */

/** Fields that hold provider/API secrets — masked before leaving the box. */
export const SECRET_FIELDS = new Set([
  'bedrock_bearer_token', 'bearer_token', 'api_key', 'perplexity_api_key',
  'openai_api_key', 'aws_secret_access_key', 'aws_access_key_id', 'key',
  'hotspot_password',
])

export function maskSecret(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v
  return v.length > 4 ? '••••••••' + v.slice(-4) : '••••'
}

/**
 * Deep-clone config with every secret-valued field masked. Used in CLOUD mode
 * for `GET /api/config` (reachable by ANY paired device) and unconditionally
 * for bug-report bundles (pasted into public chats/issues).
 */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k) ? maskSecret(v) : redactConfig(v)
    }
    return out
  }
  return value
}
