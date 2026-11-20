/**
 * A node's MEMORY.md (sessions/agent-memory.ts) as a file: `artifacts/nodes/<taskId>/MEMORY.md`, its
 * only place since 2026-11-20 (the user: "only use now location please, migrate all"). Before, it
 * lived on the task row (`agent_memory`). A row may still carry one (an older release wrote it after
 * a roll back, a sync brought one): every read and write of that memory takes it in first, merged
 * with the file so neither loses a line, and clears it from the row (migrate.ts takeLegacyMemory).
 *
 * Format: front matter of Walnut's fields (each value a JSON string, valid YAML too), then the text
 * the agent wrote. A person may change the text by hand; Walnut reads it, dated by the file's time
 * when the text no longer matches the hash Walnut wrote with it (a sync or a touch that only moves
 * the file's time changes nothing). `ops` holds the offline writes already applied
 * (offline-merge/apply-agent-memory.ts), so a journal replayed twice writes once.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentMemory } from '../sessions/agent-memory.js';
import { withFileLock } from '../../utils/file-lock.js';
import { writeTextFile } from '../../utils/fs.js';
import { isFollower } from '../server-role.js';
import { artifactsDir, memoryCopyOf, TASK_ID_RE } from './paths.js';

export interface StoredMemory extends AgentMemory {
  /** Offline op keys applied, newest last. */
  ops?: string[];
}

/** What the file holds: nothing, the read copy the release before wrote (no fields), or a memory. */
export type MemoryFileRead = { format: 'none' } | { format: 'copy'; memory: StoredMemory } | { format: 'file'; memory: StoredMemory };

const OPS_KEPT = 200;

const textHash = (text: string): string => crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);

export function renderMemoryFile(m: StoredMemory): string {
  const head = [`at: ${JSON.stringify(m.at)}`];
  if (m.by) head.push(`by: ${JSON.stringify(m.by)}`);
  if (m.by_name) head.push(`by_name: ${JSON.stringify(m.by_name)}`);
  if (m.by_at) head.push(`by_at: ${JSON.stringify(m.by_at)}`);
  if (m.refused) head.push(`refused_at: ${JSON.stringify(m.refused.at)}`, `refused_chars: ${JSON.stringify(String(m.refused.chars))}`);
  if (m.ops?.length) head.push(`ops: ${JSON.stringify(m.ops.slice(-OPS_KEPT).join(' '))}`);
  head.push(`hash: ${JSON.stringify(textHash(m.text))}`, 'kind: "memory"');
  return `---\n${head.join('\n')}\n---\n\n${m.text.trim()}\n`;
}

function value(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try { const s = JSON.parse(v); if (typeof s === 'string') return s; } catch { /* a bare value */ }
  }
  return v.replace(/^'(.*)'$/, '$1');
}

/** The file's text read back. Pure; `mtimeMs` dates a hand edit. */
export function parseMemoryFile(text: string, mtimeMs: number): MemoryFileRead {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (kv) fields[kv[1]] = value(kv[2]);
  }
  if (!m || fields.kind !== 'memory') {
    // The release before's read copy: a comment line, then the text.
    const body = text.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
    return body ? { format: 'copy', memory: { text: body, at: new Date(mtimeMs).toISOString() } } : { format: 'none' };
  }
  const body = m[2].trim();
  // Changed by hand since Walnut wrote it (or no date at all): dated by the file's time.
  const edited = !fields.at || !Number.isFinite(Date.parse(fields.at)) || (!!fields.hash && fields.hash !== textHash(body));
  const at = edited ? new Date(mtimeMs).toISOString() : fields.at!;
  const chars = Number(fields.refused_chars);
  const memory: StoredMemory = {
    text: body, at,
    ...(fields.by ? { by: fields.by as StoredMemory['by'] } : {}),
    ...(fields.by_name ? { by_name: fields.by_name } : {}),
    ...(fields.by_at ? { by_at: fields.by_at } : {}),
    ...(fields.refused_at && Number.isFinite(chars) ? { refused: { at: fields.refused_at, chars } } : {}),
    ...(fields.ops ? { ops: fields.ops.split(/\s+/).filter(Boolean) } : {}),
  };
  return { format: 'file', memory };
}

/** The file as it is. Any error but a missing file throws: a read that fails for a moment never reads as empty. */
export async function readMemoryFileAt(file: string): Promise<MemoryFileRead> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([fsp.readFile(file, 'utf-8'), fsp.stat(file).then((st) => st.mtimeMs)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { format: 'none' };
    throw err;
  }
  return parseMemoryFile(text, mtimeMs);
}

const publicOf = (m: StoredMemory | undefined): AgentMemory | undefined => {
  if (!m || !m.text.trim()) return undefined;
  const { ops: _ops, ...rest } = m;
  return rest;
};

/** The change a writer asks: the new memory, or null for none. Its `ops` are kept when it names none. */
export type MemoryChange = (current: StoredMemory | undefined) => StoredMemory | null;

/**
 * One change to a node's memory under its file's lock, the row's old memory taken in first.
 * `shouldWrite`, checked under the lock, refuses the change (a completed task's memory is kept as
 * it was). Answers the memory after it, as a read now would (undefined for none).
 */
export async function changeNodeMemory(taskId: string, change: MemoryChange, opts: { shouldWrite?: () => Promise<boolean> } = {}): Promise<StoredMemory | undefined> {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  // Only the primary writes: a replica reads the file its sync brought.
  if (isFollower()) throw new Error('A task\'s MEMORY.md is written on the primary box');
  const file = memoryCopyOf(taskId);
  return withFileLock(file, async () => {
    const read = await readMemoryFileAt(file);
    const { takeLegacyMemory } = await import('./migrate.js');
    const base = read.format === 'none' ? undefined : read.memory;
    const taken = await takeLegacyMemory(taskId, base, read.format === 'copy');
    const current = taken ? taken.memory : base;
    const asked = opts.shouldWrite && !(await opts.shouldWrite()) ? null : change(current);
    const next = asked && !asked.ops && current?.ops ? { ...asked, ops: current.ops } : asked;
    // Durable: the file is the memory's only copy.
    if (next && next.text.trim()) await writeTextFile(file, renderMemoryFile(next), { durable: true });
    else if (taken || read.format === 'copy') {
      if (current?.text.trim()) await writeTextFile(file, renderMemoryFile(current), { durable: true });
      else await fsp.rm(file, { force: true });
    }
    // Cleared from the row only once the file holds it.
    if (taken) await taken.clearRow();
    // The followers' copies of the task carry it (replicaRows): a round now.
    if (next || taken) void import('../replication/task-replica.js').then((m) => m.taskReplicaRoundNow()).catch(() => {});
    const after = await readMemoryFileAt(file);
    return after.format === 'none' ? undefined : after.memory;
  });
}

/** A node's memory, or undefined when it has none. */
export async function readNodeMemory(taskId: string): Promise<AgentMemory | undefined> {
  if (!TASK_ID_RE.test(taskId)) return undefined;
  if (isFollower()) {
    // A replica reads the memory its copy of the task carries (replicaRows), or a file a sync brought.
    const { getTask } = await import('../task-manager.js');
    const row = (await getTask(taskId).catch(() => null)) as { agent_memory?: AgentMemory } | null;
    if (row?.agent_memory?.text?.trim()) return row.agent_memory;
    const read = await readMemoryFileAt(memoryCopyOf(taskId)).catch(() => ({ format: 'none' as const }));
    return read.format === 'none' ? undefined : publicOf(read.memory);
  }
  const read = await readMemoryFileAt(memoryCopyOf(taskId));
  const { hasLegacyMemory } = await import('./migrate.js');
  const legacy = await hasLegacyMemory(taskId);
  if (!legacy && read.format === 'file') return publicOf(read.memory);
  if (!legacy && read.format === 'none') return undefined;
  // The row's old memory, or the release before's read copy: taken in once, then read as a file.
  return publicOf(await changeNodeMemory(taskId, () => null));
}

/**
 * The task rows a follower's copy gets (replication/task-replica.ts): each row of a task with a
 * MEMORY.md carries it as `agent_memory`, as rows did before the file, so a replica (the companion,
 * a host while the Mac is away, one on an older release) reads it from its copy. Only the copy: the
 * primary's own rows never hold it. A row's object is kept while neither it nor its file changed,
 * so an unchanged round hashes nothing new.
 */
const projected = new WeakMap<object, { mtimeMs: number; row: object }>();
export async function replicaRows<T extends { id: string }>(tasks: readonly T[]): Promise<readonly T[]> {
  const nodes = path.join(artifactsDir(), 'nodes');
  const ids = new Set((await fsp.readdir(nodes).catch(() => [] as string[])).filter((n) => TASK_ID_RE.test(n)));
  if (!ids.size) return tasks;
  const out: T[] = [];
  for (const t of tasks) {
    if (!ids.has(t.id)) { out.push(t); continue; }
    const mtimeMs = await fsp.stat(memoryCopyOf(t.id)).then((st) => st.mtimeMs, () => 0);
    if (!mtimeMs) { out.push(t); continue; }
    const hit = projected.get(t);
    if (hit && hit.mtimeMs === mtimeMs) { out.push(hit.row as T); continue; }
    const read = await readMemoryFileAt(memoryCopyOf(t.id)).catch(() => ({ format: 'none' as const }));
    const memory = read.format === 'none' ? undefined : publicOf(read.memory);
    const row = memory ? { ...t, agent_memory: memory } : t;
    projected.set(t, { mtimeMs, row });
    out.push(row);
  }
  return out;
}

/** The op keys a memory already applied (offline-merge). */
export const appliedOps = (m: StoredMemory | undefined): readonly string[] => m?.ops ?? [];
export const withAppliedOp = (ops: readonly string[] | undefined, key: string): string[] => [...(ops ?? []).filter((k) => k !== key), key].slice(-OPS_KEPT);
