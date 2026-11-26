/**
 * CLI command: open-walnut mcp [--readonly] [--core]
 *
 * Thin adapter between commander options and the stdio MCP server
 * (src/mcp/server.ts). Kept separate so the command module stays lazy-loadable
 * like every other subcommand — importing the MCP SDK costs nothing until
 * someone actually runs `open-walnut mcp`.
 */

interface McpCliOptions {
  readonly?: boolean
  apiUrl?: string
  core?: boolean
}

export async function runMcp(options: McpCliOptions = {}): Promise<void> {
  const { runMcp: serve } = await import('../mcp/server.js')
  // WALNUT_MCP_CORE=1 is how an ACP mount asks (src/providers/acp-worker/protocol.ts withCoreWalnutTools).
  const core = !!options.core || process.env.WALNUT_MCP_CORE === '1'
  const role = core ? undefined : await mountListingRole(process.env)
  await serve({ readonly: !!options.readonly, apiBase: options.apiUrl, core, ...(role ? { role } : {}) })
}

/**
 * The role this mount lists tools for: WALNUT_MCP_ROLE (core/sessions/profiles.ts walnutMcpProfile
 * sets it for Main and the asks), only while the experiment mcp_tools_by_role is on. Read from
 * config.yaml at start, not from the session record, so turning the switch off reaches a session at
 * its next mount start. On by default: a config with no choice, or no config yet, is on; a stored
 * false is off; a config that cannot be read lists everything.
 */
export async function mountListingRole(env: NodeJS.ProcessEnv): Promise<import('../ops/op-groups.js').ListingRole | undefined> {
  const { listingRoleOf, ROLE_LISTING_EXPERIMENT, WALNUT_MCP_ROLE_ENV } = await import('../ops/op-groups.js')
  const role = listingRoleOf(env[WALNUT_MCP_ROLE_ENV])
  if (!role) return undefined
  try {
    const [{ CONFIG_FILE }, { readConfigSnapshot }, { experimentalEnabled }] = await Promise.all([
      import('../constants.js'), import('../core/config-file-io.js'), import('../core/experimental.js'),
    ])
    const snapshot = await readConfigSnapshot(CONFIG_FILE)
    // A config that is there but cannot be read may hold the user's "off": list everything.
    if (!snapshot.doc && snapshot.state !== 'missing') return undefined
    const doc = snapshot.doc
    const flags = doc?.experimental && typeof doc.experimental === 'object' ? doc.experimental as Record<string, boolean> : undefined
    return experimentalEnabled(flags, ROLE_LISTING_EXPERIMENT) ? role : undefined
  } catch {
    return undefined
  }
}
