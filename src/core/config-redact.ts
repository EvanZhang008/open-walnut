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
  // Not the APNs private key itself (config only ever stores a PATH to it), but
  // the path names a file worth protecting and rides bug-report bundles that get
  // pasted into public issues.
  'key_path',
])

/**
 * Fields masked only inside a specific parent, because the field NAME alone is
 * too generic to put in the global denylist.
 *
 * `push_tokens[].token` is the case: a push device token is a send capability
 * (with the APNs key it puts a notification on the user's lock screen), so it
 * must not ride a bug report. But masking every key called `token` anywhere
 * would rewrite unrelated config, and a masked value read back and saved would
 * PERSIST the mask — turning a redaction into data loss.
 */
const SECRET_FIELDS_BY_PARENT: Record<string, Set<string>> = {
  push_tokens: new Set(['token']),
}

export function maskSecret(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v
  return v.length > 4 ? '••••••••' + v.slice(-4) : '••••'
}

/**
 * Deep-clone config with every secret-valued field masked. Used in CLOUD mode
 * for `GET /api/config` (reachable by ANY paired device) and unconditionally
 * for bug-report bundles (pasted into public chats/issues).
 */
export function redactConfig(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, parentKey))
  if (value && typeof value === 'object') {
    const scoped = parentKey ? SECRET_FIELDS_BY_PARENT[parentKey] : undefined
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k) || scoped?.has(k) ? maskSecret(v) : redactConfig(v, k)
    }
    return out
  }
  return value
}
