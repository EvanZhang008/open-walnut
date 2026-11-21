/**
 * Reading and writing a node's pain registry files (pains.ts holds the model). Every write runs under
 * the registry's lock (a user-file lock, kept under WALNUT_HOME/locks: the files sit in his notes),
 * and a registry is never written over what it could not read:
 *  - a pains.json that does not parse (a stray comma in a hand edit, a half-written file) is never
 *    rewritten: the write is refused (PainsUnwritable) until someone fixes the file, so his words in
 *    it are never lost;
 *  - one a newer release wrote (a higher schemaVersion) is refused the same way, so an older server
 *    never downgrades it;
 *  - a field this release does not read is kept as written, and an entry it cannot read is kept
 *    verbatim at the end.
 * Temp files are named `.open-walnut-<hex>.tmp`, which the data sync ignores.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { withUserFileLock } from '../../../utils/user-file-lock.js';
import {
  guardRunFileOf, guardRunOf, normalizePain, painsFileOf, painsMarkdownOf, renderPains, resolvePainPath,
  PAIN_KNOWN_KEYS, PAIN_SCHEMA_VERSION, type GuardRun, type PainEntry,
} from './pains.js';

export class PainsUnwritable extends Error {
  constructor(readonly file: string, why: string) {
    super(`The pain registry ${file} is not changed: ${why}. Fix or move the file; nothing in it was touched.`);
    this.name = 'PainsUnwritable';
  }
}

type Raw = Record<string, unknown>;
export type PainsRead =
  | { state: 'missing' }
  | { state: 'bad'; why: string }
  | { state: 'ok'; entries: PainEntry[]; extras: Map<string, Raw>; unreadable: unknown[] };

const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : null);

/** The registry file as read: missing, unreadable (with why), or its entries with what this release does not read. */
export async function readPainsFile(nodeId: string): Promise<PainsRead> {
  let text: string;
  try {
    text = await fsp.readFile(painsFileOf(nodeId), 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'bad', why: `it cannot be read (${(err as NodeJS.ErrnoException)?.code ?? err})` };
  }
  let f: Raw | null;
  try { f = obj(JSON.parse(text)); } catch (err) { return { state: 'bad', why: `it is not valid JSON (${err instanceof Error ? err.message : err})` }; }
  if (!f || !Array.isArray(f.entries)) return { state: 'bad', why: 'it has no entries list' };
  if (typeof f.schemaVersion === 'number' && f.schemaVersion > PAIN_SCHEMA_VERSION) return { state: 'bad', why: `a newer Walnut wrote it (schemaVersion ${f.schemaVersion})` };
  const entries: PainEntry[] = [];
  const extras = new Map<string, Raw>();
  const unreadable: unknown[] = [];
  for (const raw of f.entries) {
    const e = normalizePain(raw);
    if (!e || entries.some((x) => x.id === e.id)) { unreadable.push(raw); continue; }
    entries.push(e);
    const extra = Object.fromEntries(Object.entries(raw as Raw).filter(([k]) => !PAIN_KNOWN_KEYS.has(k)));
    if (Object.keys(extra).length) extras.set(e.id, extra);
  }
  return { state: 'ok', entries, extras, unreadable };
}

/** The registry's entries, [] when there is none or it cannot be read (painsHealth says which). */
export async function readPains(nodeId: string): Promise<PainEntry[]> {
  const r = await readPainsFile(nodeId);
  return r.state === 'ok' ? r.entries : [];
}

export async function readGuardRun(nodeId: string): Promise<GuardRun | null> {
  try {
    return guardRunOf(JSON.parse(await fsp.readFile(guardRunFileOf(nodeId), 'utf-8')));
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.open-walnut-${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text, 'utf-8');
  await fsp.rename(tmp, file).catch(async (err) => { await fsp.rm(tmp, { force: true }); throw err; });
}

/** Under the lock: the registry and its Markdown, from entries already read. */
async function writeRegistry(nodeId: string, nodeName: string, read: Extract<PainsRead, { state: 'ok' }> | { state: 'missing' }, entries: readonly PainEntry[], nowMs: number): Promise<void> {
  const extras = read.state === 'ok' ? read.extras : new Map<string, Raw>();
  const unreadable = read.state === 'ok' ? read.unreadable : [];
  const file = painsFileOf(nodeId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const data = {
    schemaVersion: PAIN_SCHEMA_VERSION, nodeId, nodeName, updatedAt: new Date(nowMs).toISOString(),
    entries: [...entries.map((e) => ({ ...extras.get(e.id), ...e })), ...unreadable],
  };
  await writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  await writeAtomic(painsMarkdownOf(nodeId), renderPains(nodeName, entries, await readGuardRun(nodeId), (p) => resolvePainPath(nodeId, p)));
}

/** Change the registry under its lock; `change` gets the entries as read. Throws PainsUnwritable on a file it cannot read. */
export async function updatePains(nodeId: string, nodeName: string, change: (entries: PainEntry[]) => PainEntry[], nowMs: number): Promise<PainEntry[]> {
  const file = painsFileOf(nodeId);
  let out: PainEntry[] = [];
  await withUserFileLock(file, async () => {
    const read = await readPainsFile(nodeId);
    if (read.state === 'bad') throw new PainsUnwritable(file, read.why);
    out = change(read.state === 'ok' ? [...read.entries] : []);
    await writeRegistry(nodeId, nodeName, read, out, nowMs);
  });
  return out;
}

/** Keep a guard run's results and show them in pains.md, under the registry's lock. */
export async function writeGuardRun(nodeId: string, nodeName: string, run: GuardRun, nowMs: number): Promise<void> {
  const file = painsFileOf(nodeId);
  await withUserFileLock(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(guardRunFileOf(nodeId), `${JSON.stringify(run, null, 2)}\n`);
    const read = await readPainsFile(nodeId);
    // The Markdown follows the registry: an unreadable one is left as it is, and only the run is kept.
    if (read.state === 'ok') await writeRegistry(nodeId, nodeName, read, read.entries, nowMs);
  });
}
