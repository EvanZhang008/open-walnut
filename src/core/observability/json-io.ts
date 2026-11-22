/**
 * How much JSON each data file costs to read and write, over the last JSON_IO_WINDOW_MS.
 *
 * Why (2026-11-21): in the CPU profiles the stall recorder kept on the live server,
 * JSON.parse inside readJsonFile was the single largest cost (about 18 s of 400 s
 * sampled), and the stringify of writeJsonFile came next, yet nothing said which
 * files. A parse of a big file is also memory: its text and every object it builds
 * are garbage a moment later. readJsonFile and writeJsonFile (src/utils/fs.ts) note
 * each call here; the memory ledger's sample line and burst line name the files that
 * moved the most text.
 */

import { registerBurstContext, registerMemoryHolder, registerSampleNote } from './memory-ledger.js';

export const JSON_IO_WINDOW_MS = 10 * 60_000;
const MAX_EVENTS = 50_000;

interface Event { at: number; file: string; read: boolean; chars: number }
const events: Event[] = [];

/** One readJsonFile or writeJsonFile of `chars` characters. Cheap: an array push. */
export function noteJsonIo(file: string, read: boolean, chars: number, now = Date.now()): void {
  events.push({ at: now, file, read, chars });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export interface JsonIoRow { file: string; reads: number; readMB: number; writes: number; writeMB: number }

/** The files that moved the most JSON text in the window, biggest first. */
export function jsonIoTop(limit = 10, now = Date.now()): JsonIoRow[] {
  while (events.length > 0 && now - events[0]!.at > JSON_IO_WINDOW_MS) events.shift();
  const by = new Map<string, { reads: number; readChars: number; writes: number; writeChars: number }>();
  for (const e of events) {
    const row = by.get(e.file) ?? { reads: 0, readChars: 0, writes: 0, writeChars: 0 };
    if (e.read) { row.reads += 1; row.readChars += e.chars; } else { row.writes += 1; row.writeChars += e.chars; }
    by.set(e.file, row);
  }
  const mb = (c: number) => Math.round((c / 1048576) * 10) / 10;
  return [...by]
    .map(([file, r]) => ({ file, reads: r.reads, readMB: mb(r.readChars), writes: r.writes, writeMB: mb(r.writeChars) }))
    .sort((a, b) => b.readMB + b.writeMB - (a.readMB + a.writeMB))
    .slice(0, limit);
}

/** The last two path segments are enough to name a data file and keep home paths out of the line. */
function shortName(file: string): string {
  return file.split(/[\\/]/).slice(-2).join('/');
}

registerBurstContext('jsonFiles', () => jsonIoTop(10).map((r) => ({ ...r, file: shortName(r.file) })));
registerSampleNote('jsonTop', () => jsonIoTop(5)
  .map((r) => `${shortName(r.file)}=r${r.reads}/${r.readMB}MB,w${r.writes}/${r.writeMB}MB`).join(' '));

registerMemoryHolder({
  name: 'json-io.events',
  budgetBytes: 16 * 1048576,
  // One event is a small object plus a path string the caller already holds.
  read: () => ({ entries: events.length, bytes: events.length * 64 }),
});

/** Tests only. */
export function _resetJsonIoForTesting(): void { events.length = 0; }
