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
