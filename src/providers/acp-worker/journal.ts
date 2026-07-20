/**
 * ACP session journal — append-only NDJSON file, one writer (the worker).
 *
 * Contract (docs/plan/coding-agent-acp-provider.md § Event path):
 * - Records: {kind:'acp', frame} raw inbound ACP frames | {kind:'meta', event}
 *   worker-observed lifecycle facts. Never interpreted state.
 * - One atomic write() per newline-delimited record (record fully serialized
 *   before the syscall, O_APPEND), so a reader can never observe a torn record
 *   boundary at a committed offset.
 * - Byte offset of a line start = the replay cursor (same contract as the
 *   native session JSONL). Readers must stop before a trailing partial line.
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  AcpFrameSource,
  JournalRecord,
  JournalMetaEvent,
} from './protocol.js'

export class AcpJournal {
  private fd: number
  private _offset: number

  constructor(readonly filePath: string) {
    const parent = path.dirname(filePath)
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    fs.chmodSync(parent, 0o700)
    this.fd = fs.openSync(filePath, 'a', 0o600)
    fs.fchmodSync(this.fd, 0o600)
    this._offset = fs.fstatSync(this.fd).size
  }

  /** Byte offset after the last committed record. */
  get offset(): number { return this._offset }

  appendAcpFrame(frame: unknown, source: AcpFrameSource = 'live'): number {
    return this.append({ kind: 'acp', ts: Date.now(), source, frame })
  }

  appendMeta(event: JournalMetaEvent, durable = false): number {
    const offset = this.append({ kind: 'meta', ts: Date.now(), event })
    if (durable) fs.fdatasyncSync(this.fd)
    return offset
  }

  /** Returns the offset AFTER the appended record. */
  private append(record: JournalRecord): number {
    const line = JSON.stringify(record) + '\n'
    // Single write() of the full serialized record — atomicity of the record
    // boundary is what the replay cursor depends on.
    fs.writeSync(this.fd, line)
    this._offset += Buffer.byteLength(line)
    return this._offset
  }

  close(): void {
    try { fs.closeSync(this.fd) } catch { /* already closed */ }
  }
}

export interface JournalReadResult {
  records: Array<{ offset: number; record: JournalRecord }>
  /** Offset to pass as `from` on the next read (end of last COMPLETE line). */
  nextOffset: number
}

/**
 * Read committed records from a journal file starting at byte offset `from`.
 * A trailing line without '\n' is not yet durable — it is ignored and
 * `nextOffset` stops before it (mid-write crash tolerance).
 * Unparseable complete lines are skipped (offset still advances past them) so
 * one corrupt record cannot wedge replay forever.
 */
export function readJournal(filePath: string, from = 0): JournalReadResult {
  let content: Buffer
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (from >= size) return { records: [], nextOffset: from }
      content = Buffer.alloc(size - from)
      fs.readSync(fd, content, 0, content.length, from)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { records: [], nextOffset: from }
  }

  const records: JournalReadResult['records'] = []
  let lineStart = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== 0x0a) continue
    const line = content.subarray(lineStart, i).toString('utf8')
    const offset = from + lineStart
    lineStart = i + 1
    if (!line.trim()) continue
    try {
      records.push({ offset, record: JSON.parse(line) as JournalRecord })
    } catch {
      // Corrupt complete line — skip, but keep advancing the cursor.
    }
  }
  return { records, nextOffset: from + lineStart }
}
