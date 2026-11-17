/**
 * A fork's history is its ancestors' transcript followed by its own. Read here for every reader
 * that joins them: the web full read, its older page that reaches the fork's own start, and the
 * /api/v1 rich history.
 *
 * The ancestors are joined only to a read of the fork's own transcript that holds its start.
 * 2026-11-17: two forks past the byte ceiling were served as [parent][4 MB tail of the fork],
 * months of the fork's own turns missing between the two; each new turn moved the tail's start,
 * so every refresh took rows out of the middle of what the reader was looking at.
 */
import { log } from '../../logging/index.js'
import { getSessionByClaudeId } from '../session-tracker.js'
import { rewriteHistoryRemoteImages, type SessionHistoryMessage } from '../session-history.js'
import type { SessionRecord } from '../types.js'

export interface ForkPrefix {
  messages: SessionHistoryMessage[]
  /** An ancestor was itself read as a window: the joined history is windowed too. */
  windowed: boolean
  finishedAgentIds: string[]
}

const MAX_FORK_DEPTH = 5 // backstop against pathological/cyclic chains

/**
 * The ancestors' history, root first, cut at a rewind point. The pointer walk is serial (a local
 * lookup); the transcripts are read in parallel (the expensive host part).
 */
export async function readForkPrefix(record: SessionRecord, sessionId: string): Promise<ForkPrefix> {
  // Lazy: session-lifecycle reads forks through this module.
  const { readProviderSessionHistory } = await import('./session-lifecycle.js')
  const ancestors: SessionRecord[] = []
  const visited = new Set<string>([sessionId])
  let currentForkId: string | undefined = record.forkedFromSessionId
  while (currentForkId && !visited.has(currentForkId) && ancestors.length < MAX_FORK_DEPTH) {
    visited.add(currentForkId)
    const sourceRecord = await getSessionByClaudeId(currentForkId)
    if (!sourceRecord) break
    ancestors.push(sourceRecord)
    currentForkId = sourceRecord.forkedFromSessionId
  }
  const fetched = await Promise.all([...ancestors].reverse().map(async (sourceRecord) => {
    const src = await readProviderSessionHistory(sourceRecord.claudeSessionId, sourceRecord, sourceRecord.host)
    const messages = sourceRecord.host
      ? await rewriteHistoryRemoteImages(src.messages, sourceRecord.host, sourceRecord.claudeSessionId, sourceRecord.cwd)
      : src.messages
    return { messages, windowed: !!src.windowed, finishedAgentIds: src.finishedAgentIds ?? [] }
  }))
  let messages = fetched.flatMap((f) => f.messages)
  // A rewound session IS a fork, so its parent's FULL transcript came in above, including the
  // turns the human rewound away (the parent's JSONL is never edited). Cut them here.
  if (record.rewoundAtMessageUuid) {
    const { cutAncestorHistoryAtRewindPoint } = await import('./session-rewind.js')
    const cut = cutAncestorHistoryAtRewindPoint(messages, record.rewoundAtMessageUuid)
    messages = cut.messages
    if (!cut.found) {
      log.session.warn('rewind: rewind point not found in the ancestor transcript — history may show rewound turns', {
        sessionId, rewoundAt: record.rewoundAtMessageUuid, ancestorMessages: messages.length,
      })
    } else if (cut.dropped > 0) {
      log.session.debug('rewind: trimmed ancestor transcript at the rewind point', {
        sessionId, rewoundAt: record.rewoundAtMessageUuid, dropped: cut.dropped,
      })
    }
  }
  return {
    messages,
    windowed: fetched.some((f) => f.windowed),
    finishedAgentIds: fetched.flatMap((f) => f.finishedAgentIds),
  }
}

/**
 * Where the ancestors already sit inside the fork's own rows, or -1. `claude --resume X
 * --fork-session` COPIES the resumed prefix into the fork's JSONL (uuids kept), so a fork that
 * ran a turn already contains its ancestors: prepending them again showed the parent twice.
 * Returns the index of the fork's first own row.
 */
export function embeddedForkBoundary(prefix: readonly SessionHistoryMessage[], own: readonly SessionHistoryMessage[]): number {
  if (prefix.length === 0 || own.length === 0) return -1
  for (let a = prefix.length - 1; a >= 0 && a >= prefix.length - 3; a--) {
    const anchorId = prefix[a]?.msgId
    if (!anchorId) continue
    const idx = own.findIndex((m) => m.msgId === anchorId)
    // A boundary past the rows means the copy's end is not among them (an older page).
    if (idx >= 0) { const at = idx + (prefix.length - 1 - a) + 1; return at <= own.length ? at : -1 }
  }
  return -1
}

/**
 * Join the ancestors to rows read from the START of the fork's own transcript: the rows, and
 * where the fork's own part begins. Callers holding only a later window of the fork never call
 * this: the ancestors are older than everything in it, one "Load earlier" away.
 */
export function joinForkPrefix(prefix: readonly SessionHistoryMessage[], own: SessionHistoryMessage[]): { messages: SessionHistoryMessage[]; forkBoundaryIndex?: number } {
  const embedded = embeddedForkBoundary(prefix, own)
  if (embedded >= 0) return { messages: own, forkBoundaryIndex: embedded }
  // The rows open with the ancestors' own first rows: the fork copied them, and the end of the
  // copy lies past these rows (an older page of a long fork). Nothing to join, no boundary here.
  const headIds = new Set(prefix.slice(0, 3).map((m) => m.msgId).filter(Boolean))
  if (own.slice(0, 3).some((m) => m.msgId && headIds.has(m.msgId))) return { messages: own }
  if (prefix.length === 0) return { messages: own }
  return { messages: [...prefix, ...own], forkBoundaryIndex: prefix.length }
}
