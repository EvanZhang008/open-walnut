/**
 * The offline drain's conflict log (docs/plan/walnut-replica-servers-impl.md section 5,
 * "Conflict log"). Every conflict of one drain of one host (kind, id, both values in
 * full, base, times) is made durable BEFORE its record is acked, so a crash after the ack
 * loses nothing. The letter is built from the log, keyed by its drain id, and marked sent
 * in it; a log whose letter was never marked sent is lettered again by the next drain.
 *
 * Append only, so a drain of N conflicts writes each entry once (O(N), not O(N^2)): a
 * whole-file rewrite per record, inside the task write lock, wrote 768 MB for 150
 * conflicts of 20 KB and stalled the event loop about 80 ms per record. Two files in
 * `WALNUT_HOME/offline-conflicts/` (durable, not tmp):
 *   - `<drainId>.json`, the small header (drain id, host, home, start, the letter mark),
 *     replaced whole (tmp, fsync, rename);
 *   - `<drainId>.ndjson`, one line per entry `{"i":n,"e":entry}`, appended and fdatasynced
 *     line by line, and `{"drop":[n]}` lines that take entries back. A torn last line (a
 *     crash mid-append) is skipped; a line written again under the same `i` replaces it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

export type ConflictKind =
  | 'task-field'      // both sides changed a field to different values
  | 'task-deleted'    // the Mac deleted the task; the queued write carried a value
  | 'refused'         // the Mac refused the write (the answer an online call gets)
  | 'given-up'        // the write threw three times; it and later writes of its task are attached
  | 'actor-dropped'   // the device that made it is no longer paired with this Mac
  | 'parent-refused'  // a parent link the Mac refused (missing, a cycle, too deep)
  | 'create-collision'// a created task's id was taken; it got a new id
  | 'board'           // a Board edit that conflicted (the Mac's html kept)
  | 'note';           // a note write made while away that needed a choice (WP11, offline-merge/notes.ts)

export interface ConflictEntry {
  kind: ConflictKind;
  seq: number;
  opId?: string;
  recordKind: string;
  taskId?: string;
  boardTaskId?: string;
  field?: string;
  base?: unknown;
  mac?: unknown;
  replica?: unknown;
  kept?: 'mac' | 'replica';
  why?: string;
  macAt?: number;
  replicaAt?: number;
  reason?: string;
  actor?: unknown;
  /** The record as the host journaled it, for given-up and dropped writes ("the change is attached"). */
  record?: unknown;
  /** note: the vault path the record landed at, and the conflict copy holding the other version. */
  notePath?: string;
  copyPath?: string;
  /** note: the host no longer held the record's text when it was lettered (nothing is attached). */
  bodiesLost?: boolean;
  /** note: the version that lost a region ('mac' or a host's record). */
  lostVersion?: string;
}

export interface ConflictLogFile {
  v: 2;
  drainId: string;
  hostKey: string;
  home: string;
  startedAt: string;
  entries: ConflictEntry[];
  letter?: { sentAt: string; letterId?: string };
}

/** The directory the logs live in (WALNUT_HOME, never tmp). */
export function conflictDir(): string {
  return path.join(WALNUT_HOME, 'offline-conflicts');
}

function headerOf(drainId: string): string {
  return path.join(conflictDir(), `${drainId}.json`);
}

function linesOf(drainId: string): string {
  return path.join(conflictDir(), `${drainId}.ndjson`);
}

function fsyncDir(dir: string): void {
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* a dir fsync is best effort on some file systems */ }
}

/** Replace a small file durably: tmp, fsync, rename, then fsync the directory. Throws on failure. */
function writeDurable(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/**
 * Append `text` to `file` and fdatasync it (only these bytes are written). Returns the
 * size before the append. A failed append cuts the file back to that size (best effort),
 * then throws.
 */
function appendDurable(file: string, text: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  let before = 0;
  try {
    before = fs.fstatSync(fd).size;
    try {
      fs.writeSync(fd, text);
      fs.fdatasyncSync(fd);
    } catch (err) {
      try { fs.ftruncateSync(fd, before); } catch { /* the reader skips a torn line */ }
      throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (before === 0) fsyncDir(path.dirname(file));
  return before;
}

function headerText(data: ConflictLogFile): string {
  const { entries: _e, ...head } = data;
  return JSON.stringify(head);
}

/** The line number of each entry of a log read from disk (not serialized). */
const LINES = Symbol('conflictLogLines');

/** A new drain id: host, time and a random tail, safe as a file name. */
export function newDrainId(hostKey: string, now = Date.now()): string {
  const host = hostKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'host';
  return `d-${host}-${now}-${crypto.randomBytes(3).toString('hex')}`;
}

/** One drain's log: entries accumulate in memory; `flush()` makes them durable before an ack. */
export class ConflictLog {
  readonly data: ConflictLogFile;
  /** The line of each entry already on disk. */
  private lineOf = new Map<ConflictEntry, number>();
  private nextLine = 0;
  private headerOnDisk = false;
  /** Entries kept for this drain's letter only, because the log could not be written. */
  private memoryOnly = new Set<ConflictEntry>();

  constructor(hostKey: string, home: string, drainId = newDrainId(hostKey)) {
    this.data = { v: 2, drainId, hostKey, home, startedAt: new Date().toISOString(), entries: [] };
  }

  get drainId(): string { return this.data.drainId; }
  get entries(): readonly ConflictEntry[] { return this.data.entries; }

  add(entry: ConflictEntry): void {
    this.data.entries.push(entry);
    this.told([entry]);
  }

  /** Section 13 observability: one line per conflict, with the item's full id. */
  private told(entries: readonly ConflictEntry[]): void {
    for (const e of entries) {
      log.session.info('offline merge conflict', {
        kind: e.kind, id: e.taskId ?? e.boardTaskId ?? e.opId ?? null, recordKind: e.recordKind, seq: e.seq,
        host: this.data.hostKey, drainId: this.data.drainId,
        ...(e.opId ? { opId: e.opId } : {}), ...(e.field ? { field: e.field } : {}), ...(e.kept ? { kept: e.kept } : {}),
      });
    }
  }

  /** Keep an entry for this drain's letter without writing it (the log cannot be written). */
  addMemoryOnly(entry: ConflictEntry): void {
    this.data.entries.push(entry);
    this.memoryOnly.add(entry);
    this.told([entry]);
  }

  /**
   * Add entries and make them durable at once, BEFORE the write they describe (or the
   * ledger row that would skip a redrain) lands. A failed write takes them back out and
   * throws, so nothing is applied or recorded for them.
   */
  addDurable(entries: readonly ConflictEntry[]): void {
    if (entries.length === 0) return;
    const before = this.data.entries.length;
    this.data.entries.push(...entries);
    try {
      this.flush();
    } catch (err) {
      this.data.entries.splice(before, entries.length);
      throw err;
    }
    this.told(entries);
  }

  /**
   * Take entries back out after the write they describe failed (it is retried, and the
   * retry lists them again): a drop line. Best effort: a log that cannot be written keeps
   * them, and a letter that lists a conflict twice is better than one that misses it.
   */
  retract(entries: readonly ConflictEntry[]): void {
    if (entries.length === 0) return;
    const drop = new Set(entries);
    const kept = this.data.entries.filter((e) => !drop.has(e));
    if (kept.length === this.data.entries.length) return;
    const lines = entries.map((e) => this.lineOf.get(e)).filter((n): n is number => n !== undefined);
    try {
      if (lines.length && !kept.some((e) => this.lineOf.has(e))) {
        // Nothing of this log stays on disk: no file, as before its first entry.
        fs.rmSync(linesOf(this.drainId), { force: true });
        fs.rmSync(headerOf(this.drainId), { force: true });
        this.headerOnDisk = false;
        this.lineOf.clear();
        this.nextLine = 0;
      } else if (lines.length) {
        appendDurable(linesOf(this.drainId), `${JSON.stringify({ drop: lines })}\n`);
      }
      for (const e of entries) { this.lineOf.delete(e); this.memoryOnly.delete(e); }
      this.data.entries = kept;
    } catch (err) {
      log.session.warn('offline drain: could not take back conflict entries of a write that failed', { drainId: this.drainId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Make every entry durable: only the entries not yet on disk are appended. Call BEFORE
   * acking the records the entries are about. Nothing to write writes no file. Throws
   * when the write fails, so the caller does not ack.
   */
  flush(): void {
    const todo = this.data.entries.filter((e) => !this.lineOf.has(e) && !this.memoryOnly.has(e));
    if (todo.length === 0) return;
    if (!this.headerOnDisk) {
      writeDurable(headerOf(this.drainId), headerText(this.data));
      this.headerOnDisk = true;
    }
    const text = todo.map((e, j) => JSON.stringify({ i: this.nextLine + j, e })).join('\n') + '\n';
    appendDurable(linesOf(this.drainId), text);
    todo.forEach((e, j) => this.lineOf.set(e, this.nextLine + j));
    this.nextLine += todo.length;
  }

  /** Record that the letter went out (so no later drain sends it again): the header only. */
  markSent(letterId?: string): void {
    this.data.letter = { sentAt: new Date().toISOString(), ...(letterId ? { letterId } : {}) };
    try {
      writeDurable(headerOf(this.drainId), headerText(this.data));
      this.headerOnDisk = true;
    } catch (err) {
      // A later drain may send it again; better twice than never.
      log.session.warn('offline drain: could not mark the conflict letter sent', { drainId: this.drainId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Take over a log read from disk (its entries are on disk already). */
  adopt(file: ConflictLogFile): void {
    Object.assign(this.data, file, { entries: [...file.entries] });
    const lines = (file as unknown as Record<symbol, number[] | undefined>)[LINES] ?? file.entries.map((_e, i) => i);
    this.data.entries.forEach((e, j) => this.lineOf.set(e, lines[j] ?? j));
    this.nextLine = lines.reduce((m, n) => Math.max(m, n + 1), 0);
    this.headerOnDisk = true;
  }
}

function readHeader(drainId: string): Omit<ConflictLogFile, 'entries'> | null {
  try {
    const head = JSON.parse(fs.readFileSync(headerOf(drainId), 'utf8')) as Omit<ConflictLogFile, 'entries'>;
    return head && head.v === 2 && typeof head.drainId === 'string' ? head : null;
  } catch {
    return null;
  }
}

/** The letter mark a log's header holds on disk, if any (no entry is read). */
export function conflictLetterMark(drainId: string): ConflictLogFile['letter'] | undefined {
  return readHeader(drainId)?.letter;
}

/** Read one log by drain id (the header and its entry lines, folded), or null. */
export function readConflictLog(drainId: string): ConflictLogFile | null {
  const head = readHeader(drainId);
  if (!head) return null;
  let text = '';
  try { text = fs.readFileSync(linesOf(drainId), 'utf8'); } catch { /* no entry yet */ }
  const byLine = new Map<number, ConflictEntry>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: { i?: unknown; e?: unknown; drop?: unknown };
    try { rec = JSON.parse(line) as typeof rec; } catch { continue; } // a torn last line
    if (Array.isArray(rec.drop)) { for (const n of rec.drop) byLine.delete(Number(n)); continue; }
    if (typeof rec.i === 'number' && rec.e && typeof rec.e === 'object') byLine.set(rec.i, rec.e as ConflictEntry);
  }
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const file: ConflictLogFile = { ...head, entries: lines.map((n) => byLine.get(n)!) };
  Object.defineProperty(file, LINES, { value: lines, enumerable: false });
  return file;
}

/**
 * Logs with entries whose letter was never marked sent (a drain that ended before its
 * letter). `onLettered` hears every log whose header says its letter went out, with when,
 * so a caller can skip it on later scans and prune it once old.
 */
export function unsentConflictLogs(
  skip?: (drainId: string) => boolean, onLettered?: (drainId: string, sentAtMs: number) => void,
): ConflictLogFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(conflictDir()); } catch { return []; }
  const out: ConflictLogFile[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (skip?.(id)) continue;
    // The header first: a lettered log's entries are never read.
    const head = readHeader(id);
    if (head?.letter) onLettered?.(id, Date.parse(head.letter.sentAt) || 0);
    if (!head || head.letter) continue;
    const logFile = readConflictLog(id);
    if (logFile && logFile.entries.length > 0 && !logFile.letter) out.push(logFile);
  }
  return out;
}

/** Remove a log (its header and its entries). Never throws: a log left behind is only disk. */
export function removeConflictLog(drainId: string): void {
  for (const f of [linesOf(drainId), headerOf(drainId)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* left for the next prune */ }
  }
}

/** Re-open a log read from disk, to mark its letter sent. */
export function conflictLogFrom(file: ConflictLogFile): ConflictLog {
  const l = new ConflictLog(file.hostKey, file.home, file.drainId);
  l.adopt(file);
  return l;
}
