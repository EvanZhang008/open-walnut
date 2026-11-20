/**
 * A node's threads when its JSON file changed outside (an older build, a sync pull, a hand edit) while
 * the database still held changes not yet written to that file (threads-sync.ts). Neither side is
 * dropped whole: the file is the base, and the database's threads come back where they are newer.
 *
 *  - A thread only the database holds is kept (added after the file's threads).
 *  - A thread both hold: the copy changed last (`updatedAt`) wins, and the other copy's messages it
 *    lacks are added, in time order, so no message of the user's is lost either way.
 *  - A thread only the file holds stays.
 *
 * Pure: the caller saves the database's copy aside before it writes this (org/threads-backup/conflicts/).
 */
import type { OrgThread, ThreadsFile } from './threads-model.js'

function withMessagesOf(base: OrgThread, other: OrgThread): OrgThread {
  const have = new Set(base.messages.map((m) => m.id))
  const missing = other.messages.filter((m) => !have.has(m.id))
  if (!missing.length) return base
  // A stable sort by time keeps the base's own order among messages of the same moment.
  const messages = [...base.messages, ...missing].map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at.localeCompare(b.m.at) || a.i - b.i).map((x) => x.m)
  return { ...base, messages }
}

export function mergeThreadsConflict(file: ThreadsFile, db: ThreadsFile): { file: ThreadsFile; fromDb: number } {
  const dbById = new Map(db.threads.map((t) => [t.id, t] as const))
  const inFile = new Set(file.threads.map((t) => t.id))
  let fromDb = 0
  const threads = file.threads.map((f) => {
    const d = dbById.get(f.id)
    if (!d) return f
    if (d.updatedAt > f.updatedAt) { fromDb += 1; return withMessagesOf(d, f) }
    const merged = withMessagesOf(f, d)
    if (merged !== f) fromDb += 1
    return merged
  })
  for (const d of db.threads) if (!inFile.has(d.id)) { threads.push(d); fromDb += 1 }
  return { file: { ...file, threads }, fromDb }
}
