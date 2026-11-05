/**
 * An install that had a vault before this version, with no unlock choice written, kept the old
 * 15-minute idle lock. Reading such a config as the new 48-hour default would widen it silently,
 * so the first start of this version writes `passwords.unlock_for: idle` for it once (an older
 * Walnut reads that choice the same way). A new vault's setup writes 48h (vault-v1.ts).
 */
export async function keepOldIdleLock(): Promise<boolean> {
  const { getConfig, updateConfig } = await import('../config-manager.js')
  const cur = (await getConfig()).passwords ?? {}
  if (cur.unlock_for !== undefined || cur.auto_lock_minutes !== undefined) return false
  const { loadFile } = await import('./state.js')
  if (!(await loadFile().catch(() => null))) return false
  await updateConfig({ passwords: { ...cur, unlock_for: 'idle' } })
  return true
}
