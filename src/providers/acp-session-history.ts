import path from 'node:path'
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
  if (record.acpJournalPath) return record.acpJournalPath
  if (!record.acpRuntimeId) return null
  const daemonDir = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
  const streamsDir = process.env.WALNUT_STREAMS_DIR || `${daemonDir}-streams`
  return path.join(streamsDir, `${record.acpRuntimeId}.acp.jsonl`)
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
  const journalPath = getAcpJournalPath(record)
  if (!runtimeId || !journalPath) return { messages: [], journalExists: false }
  const reader = options.reader ?? new DaemonFileReader(record.host ?? '__local__')
  const content = await reader.readFile(journalPath)
  if (content === null) return { messages: [], journalExists: false }
  return {
    messages: projectAcpJournalHistory(runtimeId, parseAcpJournal(content)),
    journalExists: true,
  }
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
