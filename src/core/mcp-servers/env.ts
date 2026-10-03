/**
 * The environment an MCP server process starts with: an ALLOWLIST, never the server's own.
 *
 * The Walnut server's environment holds provider keys and bearer tokens; a helper that only needs
 * to find its binary, its home directory and a proxy has no business receiving them. What a server
 * needs beyond this list its plugin passes explicitly in the definition's `env`.
 */

const EXACT = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'TZ',
  // A corporate proxy's CA: without it every HTTPS call from the server fails.
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
])

export function mcpServerEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (EXACT.has(key) || key.startsWith('LC_') || /^(?:https?|all|no)_proxy$/i.test(key)) out[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
