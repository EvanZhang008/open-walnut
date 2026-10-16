/**
 * Which ui-prefs keys travel (web/routes/ui-prefs.ts, the client sync layer's
 * allowlist) and which the prefs copy kind may hold (replication/kinds/prefs.ts):
 * one rule, so a machine-local family added later stays off every replica too.
 */

/**
 * Key families that are LAYOUT-shaped but MACHINE-specific: the key itself
 * embeds an absolute filesystem path (`...-file-explorer-selected:local:/Users/...`),
 * so the entry is meaningless on another device: at best dead weight, at worst
 * the Files panel restoring a path that doesn't exist there. Excluded from the
 * synced file both going forward (syncableKey) and retroactively (the route's
 * migration strips whatever is already on disk).
 */
export const MACHINE_LOCAL_PREFIXES: readonly string[] = ['open-walnut-file-explorer-selected:']

export const MAX_KEY_LEN = 200

/** True when a key is layout-shaped but describes THIS machine only. */
export function machineLocalKey(key: string): boolean {
  return MACHINE_LOCAL_PREFIXES.some((p) => key.startsWith(p))
}

// Same allowlist as the client sync layer: layout state only. Rejecting
// everything else keeps auth tokens, drafts, and per-session blobs out.
export function syncableKey(key: string): boolean {
  if (key.startsWith('open-walnut-diff-review:')) return false
  if (key === 'open-walnut-ui-prefs-sync-meta') return false
  if (machineLocalKey(key)) return false
  return key.startsWith('open-walnut-') || key.startsWith('walnut-todo-')
}
