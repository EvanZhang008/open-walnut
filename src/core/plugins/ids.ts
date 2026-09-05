const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

export function validatePluginId(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${JSON.stringify(pluginId)}`)
  }
  return pluginId
}

export function namespacePluginId(pluginId: string, localId: string): string {
  validatePluginId(pluginId)
  if (!LOCAL_ID_PATTERN.test(localId)) {
    throw new Error(`Invalid plugin contribution id: ${JSON.stringify(localId)}`)
  }
  return `${pluginId}:${localId}`
}

export function isPluginNamespacedId(pluginId: string, value: string): boolean {
  return value.startsWith(`${validatePluginId(pluginId)}:`)
}

const OP_NAME_PATTERN = /^[a-z0-9_]{1,64}$/

/**
 * The plugin-op HTTP route gates invocation on `^[a-z0-9_]{1,128}$`, so a longer
 * FINAL name would register fine and then be permanently unreachable. Refusing it
 * at declaration is the honest failure.
 */
const MAX_OP_NAME_LENGTH = 128

/**
 * The final registry name for a plugin op: `<plugin id with punctuation folded>_<local name>`.
 *
 * The separator is `_`, NOT the `:` used by every other namespaced contribution:
 * an op name doubles as an MCP tool name and a CLI word, and both allow only
 * `[a-z0-9_]`. Do not "fix" this to match the others.
 *
 * A name that already carries the prefix is left alone (same convention as
 * pluginToolName), so a plugin named `mail` declaring `search` and one declaring
 * `mail_search` both land on `mail_search`.
 */
export function pluginOpName(pluginId: string, name: string): string {
  if (!OP_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid plugin op name: ${JSON.stringify(name)} (allowed: ${OP_NAME_PATTERN.source})`)
  }
  const prefix = `${validatePluginId(pluginId).replace(/[^a-z0-9_]/g, '_')}_`
  const opName = name.startsWith(prefix) ? name : `${prefix}${name}`
  if (opName.length > MAX_OP_NAME_LENGTH) {
    throw new Error(`Plugin op name ${JSON.stringify(opName)} exceeds ${MAX_OP_NAME_LENGTH} characters`)
  }
  return opName
}
