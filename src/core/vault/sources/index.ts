/**
 * Sync sources: other password managers the vault can pull items from, one way. The vault core
 * knows only this list; each source keeps its own code under sources/<id>/ and does nothing until
 * the person adds it in Settings (`passwords.sources` in config.yaml). Bitwarden is the only one
 * today. A source is not a plugin: its export holds every password in plain text and stays inside
 * this process.
 */
export interface SyncSource {
  id: string
  label: string
  /** Its daily timer (primary only); the timer reads the settings when it fires. */
  startDaily(): Promise<{ stop: () => void }>
}

export const SYNC_SOURCES: readonly SyncSource[] = [
  {
    id: 'bitwarden',
    label: 'Bitwarden',
    startDaily: async () => (await import('./bitwarden/run.js')).startDailyBitwardenSync(),
  },
]

/**
 * Whether the person added a source. Once Settings wrote `passwords.sources` that list decides (a
 * removed source stays removed); a config from before the list counts a source added when its daily
 * sync is on or (`synced`) it ever synced.
 */
export function sourceAdded(cfg: { sources?: unknown; bitwarden_daily?: unknown } | undefined, id: string, synced = false): boolean {
  if (Array.isArray(cfg?.sources)) return cfg!.sources.includes(id)
  return id === 'bitwarden' && (cfg?.bitwarden_daily === true || synced)
}

export async function startSourceTimers(): Promise<{ stop: () => void }> {
  const timers = await Promise.all(SYNC_SOURCES.map((s) => s.startDaily()))
  return { stop: () => { for (const t of timers) t.stop() } }
}
