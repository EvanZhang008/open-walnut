/** Disposable parse checkpoints, shared by both daemon twins. Transcripts stay authoritative. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import type { MainParseState } from './session-changes-core.js';

export const CHANGES_CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024;
export const CHANGES_CHECKPOINT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 64;
const VERSION = 1;
// Runtime codecs are not interchangeable; do not overwrite another twin's usable cache.
const codec = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun';
const key = (jsonlPath: string) => createHash('sha256').update(codec + '|' + jsonlPath).digest('hex') + '.bin';
export interface ChangesCheckpointState extends MainParseState {
  savedOffset?: number;
  subCache?: Map<string, { size: number; mtimeMs?: number; epoch?: string; fileMap: MainParseState['fileMap'] }>;
}

/** Cache bytes never get trusted as a result: the parser checks file identity and tail again. */
export async function loadChangesCheckpoint(dir: string, jsonlPath: string, parserVersion: string): Promise<ChangesCheckpointState | undefined> {
  try {
    const file = path.join(dir, key(jsonlPath));
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > CHANGES_CHECKPOINT_MAX_BYTES) return undefined;
    const record = deserialize(await fs.readFile(file)) as { version?: unknown; parserVersion?: unknown; jsonlPath?: unknown; state?: ChangesCheckpointState };
    const s = record.state;
    if (record.version !== VERSION || record.parserVersion !== parserVersion || record.jsonlPath !== jsonlPath || !s
      || typeof s.epoch !== 'string' || typeof s.tail !== 'string' || typeof s.headBlock !== 'string'
      || !Number.isSafeInteger(s.offset) || s.offset < 0 || !(s.fileMap instanceof Map)) return undefined;
    for (const [name, accum] of s.fileMap) {
      if (typeof name !== 'string' || !accum || accum.filePath !== name || !Array.isArray(accum.ops)) return undefined;
    }
    if (s.subCache !== undefined && !(s.subCache instanceof Map)) return undefined;
    for (const [name, sub] of s.subCache ?? []) {
      if (typeof name !== 'string' || !sub || !(sub.fileMap instanceof Map) || !Number.isSafeInteger(sub.size)) return undefined;
    }
    s.savedOffset = s.offset;
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => {});
    return s;
  } catch { return undefined; }
}

/** Atomic and best effort: a failed or oversized checkpoint never fails the Changed read. */
export async function saveChangesCheckpoint(dir: string, jsonlPath: string, state: ChangesCheckpointState, parserVersion: string): Promise<void> {
  let temp: string | undefined;
  try {
    // Avoid serializing a map that cannot possibly fit. Yield while checking dense maps.
    let estimate = Buffer.byteLength(state.headBlock);
    let n = 0;
    for (const [name, accum] of state.fileMap) {
      estimate += Buffer.byteLength(name) + Buffer.byteLength(JSON.stringify(accum));
      if (estimate > CHANGES_CHECKPOINT_MAX_BYTES) return;
      if (++n % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    for (const sub of state.subCache?.values() ?? []) {
      for (const [name, accum] of sub.fileMap) {
        estimate += Buffer.byteLength(name) + Buffer.byteLength(JSON.stringify(accum));
        if (estimate > CHANGES_CHECKPOINT_MAX_BYTES) return;
        if (++n % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    const bytes = serialize({ version: VERSION, parserVersion, jsonlPath, state });
    if (bytes.length > CHANGES_CHECKPOINT_MAX_BYTES) return;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, key(jsonlPath));
    temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    temp = undefined;
    // Only this module's generated cache files, never transcripts or arbitrary directory entries.
    const files = await fs.readdir(dir);
    const rows = [];
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.bin(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) continue;
      const st = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      if (name.endsWith('.tmp')) {
        if (Date.now() - st.mtimeMs > 60 * 60_000) await fs.unlink(path.join(dir, name)).catch(() => {});
      } else rows.push({ name, size: st.size, time: st.mtimeMs });
    }
    rows.sort((a, b) => b.time - a.time);
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      total += rows[i]!.size;
      if (i >= MAX_FILES || total > CHANGES_CHECKPOINT_TOTAL_BYTES) await fs.unlink(path.join(dir, rows[i]!.name)).catch(() => {});
    }
  } catch { /* a cache is optional */ }
  finally { if (temp) await fs.unlink(temp).catch(() => {}); }
}
