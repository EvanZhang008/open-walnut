/**
 * Who a plugin's own op call is (server-api.ts callPluginOp stamps `plugin:<id>` as its caller):
 * an App the user installed, named as such, never "an unidentified process". A session reading
 * a message from it (a role change, a move to another problem) must know it is the App the
 * person works in, not some program on the host (2026-11-07: a practice App's "you are now the
 * interviewer" note read as unidentified, and the session refused the role).
 */

const PREFIX = 'plugin:'
const names = new Map<string, string>()

/** The plugin's display name, set as its API is built. */
export function notePluginName(pluginId: string, name: string): void {
  names.set(pluginId, name)
}

/** The App's name when `callerSid` is a plugin's own call, else undefined. */
export function pluginCallerName(callerSid: string | undefined): string | undefined {
  if (!callerSid?.startsWith(PREFIX)) return undefined
  const id = callerSid.slice(PREFIX.length)
  return id ? names.get(id) ?? id : undefined
}
