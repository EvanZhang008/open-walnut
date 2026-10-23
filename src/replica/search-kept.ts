/**
 * Whether a search on this replica leaves something out (docs/plan/walnut-companion-unified-replica.md,
 * 4f): the user left notes out of its copy (a folder, one note) or turned its notes, memory or
 * skills off. The Mac sends a replica's search copy only the docs it keeps
 * (core/replication/search-replica-keep.ts), so such a search says so (`partial`), and the
 * companion's console search goes to the Mac while it answers. A note over the size cap is in
 * the search copy (only the notes copy leaves it out), so it changes nothing here. On the Mac,
 * and on a replica that keeps everything (the default): false, and nothing changes.
 */

export const PARTIAL_RESULTS = Object.freeze({
  why: 'not_kept_here',
  message: 'Some of your notes, memory or skills are kept only on your Mac, so they are not in these results.',
})

export async function searchLeavesOut(): Promise<boolean> {
  const { followerKind, isHostReplicaProgram } = await import('../core/server-role.js')
  const companion = followerKind() === 'companion'
  if (!companion && !isHostReplicaProgram()) return false
  if (companion) {
    const notes = await import('../core/companion-notes.js')
    if (notes.companionNotesSearchIsPartial()) return true
    const { companionCopyOff } = await import('../core/companion-host-replica.js')
    return companionCopyOff('memory') || companionCopyOff('skills')
  }
  const src = (await import('./notes-source.js')).replicaNotesSource()
  if (!src) return false
  try {
    const st = await src.copyState()
    return st.off || st.exclude.length > 0 || st.offKinds.length > 0
  } catch { return false }
}
