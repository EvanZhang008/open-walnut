import path from 'node:path'
import os from 'node:os'
import { log } from '../logging/index.js'
import { DaemonFileReader } from '../core/daemon-file-reader.js'
import type { SessionHistoryMessage } from '../core/session-history.js'
import type { SessionRecord } from '../core/types.js'
import { projectAcpJournalHistory } from './acp-journal-projector.js'
import type { JournalRecord } from './acp-worker/protocol.js'

interface JournalReader {
  readFile(filePath: string): Promise<string | null>
}

export interface ReadAcpSessionHistoryOptions {
  /** Test seam and specialized callers; production uses DaemonFileReader. */
  reader?: JournalReader
}

export interface AcpSessionHistoryState {
  messages: SessionHistoryMessage[]
  /** False only when the journal read API reported a missing file. */
  journalExists: boolean
}

type AcpHistoryRecord = Pick<SessionRecord, 'claudeSessionId'>
  & Partial<Pick<SessionRecord, 'acpRuntimeId' | 'acpJournalPath' | 'host'>>

export function getAcpJournalPath(record: AcpHistoryRecord): string | null {
  return getAcpJournalPathCandidates(record)[0] ?? null
}

/**
 * Candidate journal paths, most likely first. The daemon moved its streams dir
 * (2026-08: /tmp/open-walnut-streams → ~/.open-walnut/tmp/streams) and migrates
 * files on startup, but records persisted BEFORE the move still hold the dead
 * absolute path — 11 of 16 codex records on the incident machine pointed at
 * files that had been migrated away, silently reading as empty history. So:
 * try the recorded path, then re-derive from the runtimeId against the current
 * prod dir, then the legacy dir.
 */
export function getAcpJournalPathCandidates(record: AcpHistoryRecord): string[] {
  const candidates: string[] = []
  const push = (p: string | null | undefined): void => {
    if (p && !candidates.includes(p)) candidates.push(p)
  }
  push(record.acpJournalPath)
  if (record.acpRuntimeId) {
    const file = `${record.acpRuntimeId}.acp.jsonl`
    const daemonDir = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
    if (process.env.WALNUT_STREAMS_DIR) {
      push(path.join(process.env.WALNUT_STREAMS_DIR, file))
    } else if (process.env.WALNUT_DAEMON_DIR) {
      // Isolated daemon (tests/sandbox): streams live in the sibling dir.
      push(path.join(`${daemonDir}-streams`, file))
    }
    // Prod locations — current first, legacy second (mirror daemon-standalone).
    push(path.join(os.homedir(), '.open-walnut', 'tmp', 'streams', file))
    push(path.join('/tmp/open-walnut-streams', file))
  }
  return candidates
}

/**
 * Read one ACP journal through the daemon-uniform file API and return the same
 * history DTO as native sessions. Both route phases (`source=streams` and full)
 * call this helper for engine=codex.
 */
export async function readAcpSessionHistory(
  record: AcpHistoryRecord,
  options: ReadAcpSessionHistoryOptions = {},
): Promise<SessionHistoryMessage[]> {
  return (await readAcpSessionHistoryState(record, options)).messages
}

export async function readAcpSessionHistoryState(
  record: AcpHistoryRecord,
  options: ReadAcpSessionHistoryOptions = {},
): Promise<AcpSessionHistoryState> {
  const runtimeId = record.acpRuntimeId
  const candidates = getAcpJournalPathCandidates(record)
  if (!runtimeId || candidates.length === 0) return { messages: [], journalExists: false }
  const reader = options.reader ?? new DaemonFileReader(record.host ?? '__local__')
  for (const journalPath of candidates) {
    const content = await reader.readFile(journalPath)
    if (content === null) continue
    return {
      messages: projectAcpJournalHistory(runtimeId, parseAcpJournal(content)),
      journalExists: true,
    }
  }
  // Not "empty history" — the journal is genuinely gone. Silent [] here made a
  // stale acpJournalPath indistinguishable from a fresh session (2026-08-10).
  log.session.warn('acp history: journal not found at any candidate path', {
    sessionId: record.claudeSessionId, runtimeId, candidates,
  })
  return { messages: [], journalExists: false }
}

/** Parse complete journal lines only; corrupt/torn lines never poison history. */
export function parseAcpJournal(content: string): JournalRecord[] {
  const records: JournalRecord[] = []
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline < 0) return records
  for (const line of content.slice(0, lastNewline).split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JournalRecord
      if (record?.kind === 'acp' || record?.kind === 'meta') records.push(record)
    } catch {
      // One damaged complete record is skipped; later records remain readable.
    }
  }
  return records
}
