/**
 * What the thread check (thread-audit.ts) remembers, in `WALNUT_HOME/org/thread-audit.json`:
 *   nodes   per node: when it was last checked, the findings told to it (a key told is not told
 *           again for TELL_AGAIN_MS, and is counted fixed once a later pass no longer finds it), and
 *           the model's verdict on each pair it judged (kept while the two cards read the same, at
 *           most TELL_AGAIN_MS, so an unchanged pair costs no second call);
 *   days    per day (UTC) and per node: passes, findings found, told and seen fixed per kind, the
 *           model calls made and their milliseconds. Kept DAYS_KEPT days. These counts are how the
 *           other parts of the Threads plan are judged (2026-11-25).
 * A lost file only means findings told once more and a day's counts gone.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { AUDIT_KINDS, TELL_AGAIN_MS, type AuditFinding, type AuditKind, type PairVerdict } from './thread-audit-rules.js';

export const DAYS_KEPT = 60;
const DAY_MS = 24 * 3_600_000;

export type KindCounts = Record<AuditKind, number>;
export interface DayCounts { passes: number; found: KindCounts; reported: KindCounts; fixed: KindCounts; calls: number; callMs: number }
export interface NodeAudit {
  lastPassAt?: string;
  /** `on`: a repeat's thread ids that are the node's own (a merge removes one from its file). */
  told: Record<string, { kind: AuditKind; at: string; on?: string[] }>;
  judged: Record<string, { verdict: PairVerdict; sig: string; at: string; reason?: string }>;
  /** The last note that rides the node's next message: its session and the findings it holds (thread-audit.ts unreadRide). */
  ride?: { sid: string; keys: string[] };
}
export interface AuditFile { version: 1; nodes: Record<string, NodeAudit>; days: Record<string, Record<string, DayCounts>> }

export const auditFilePath = (): string => path.join(WALNUT_HOME, 'org', 'thread-audit.json');
const emptyFile = (): AuditFile => ({ version: 1, nodes: {}, days: {} });
export const zeroKinds = (): KindCounts => Object.fromEntries(AUDIT_KINDS.map((k) => [k, 0])) as KindCounts;
const zeroDay = (): DayCounts => ({ passes: 0, found: zeroKinds(), reported: zeroKinds(), fixed: zeroKinds(), calls: 0, callMs: 0 });
export const emptyNode = (): NodeAudit => ({ told: {}, judged: {} });

/** A stored file as read: anything missing or malformed reads as empty. Pure. */
export function normalizeAudit(raw: unknown): AuditFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AuditFile>;
  const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {});
  const nodes: Record<string, NodeAudit> = {};
  for (const [id, n] of Object.entries(obj<Partial<NodeAudit>>(r.nodes))) nodes[id] = { ...n, told: obj(n?.told), judged: obj(n?.judged) };
  return { version: 1, nodes, days: obj(r.days) };
}

export const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * The node's told findings after a pass: each told one found again stays (and is told again only
 * after TELL_AGAIN_MS, pickToTell), one in `standing` stays (a repeat the pass did not judge
 * again), any other is fixed. Then the ones told now are stamped. Pure.
 */
export function settleTold(node: NodeAudit, found: readonly AuditFinding[], standing: ReadonlySet<string>, toldNow: readonly AuditFinding[], now: number): { node: NodeAudit; fixed: KindCounts } {
  const fixed = zeroKinds();
  const still = new Set(found.map((f) => f.key));
  const told: NodeAudit['told'] = {};
  for (const [key, v] of Object.entries(node.told)) {
    if (still.has(key) || standing.has(key)) told[key] = v;
    else if ((AUDIT_KINDS as readonly string[]).includes(v.kind)) fixed[v.kind]++;
  }
  const at = new Date(now).toISOString();
  for (const f of toldNow) {
    const node = f.onTask ? f.other?.taskId : f.thread.taskId;
    const on = f.kind === 'repeat' ? [f.thread, f.other].filter((c) => !!c && c.taskId === node).map((c) => c!.id) : [];
    told[f.key] = { kind: f.kind, at, ...(on.length ? { on } : {}) };
  }
  return { node: { ...node, told }, fixed };
}

/** Drops days past DAYS_KEPT, verdicts past TELL_AGAIN_MS and nodes not checked in DAYS_KEPT days. Pure. */
export function trimAudit(file: AuditFile, now: number): AuditFile {
  const oldestDay = dayOf(now - (DAYS_KEPT - 1) * DAY_MS);
  const days = Object.fromEntries(Object.entries(file.days).filter(([d]) => d >= oldestDay));
  const nodes: Record<string, NodeAudit> = {};
  for (const [id, n] of Object.entries(file.nodes)) {
    if (n.lastPassAt && now - Date.parse(n.lastPassAt) > DAYS_KEPT * DAY_MS) continue;
    const judged = Object.fromEntries(Object.entries(n.judged).filter(([, j]) => now - Date.parse(j.at) < TELL_AGAIN_MS));
    nodes[id] = { ...n, judged };
  }
  return { ...file, days, nodes };
}

/** What one pass adds to its node's day. */
export interface PassCounts { found: readonly AuditFinding[]; reported: readonly AuditFinding[]; fixed: KindCounts; calls: number; callMs: number }

/** The file with one pass recorded: its node's state and its counts on today's row, trimmed. Pure. */
export function recordPass(file: AuditFile, taskId: string, node: NodeAudit, counts: PassCounts, now: number): AuditFile {
  const day = dayOf(now);
  const row = { ...zeroDay(), ...file.days[day]?.[taskId] };
  const add = (into: KindCounts, list: readonly AuditFinding[]) => {
    const out = { ...zeroKinds(), ...into };
    for (const f of list) out[f.kind]++;
    return out;
  };
  const fixed = { ...zeroKinds(), ...row.fixed };
  for (const k of AUDIT_KINDS) fixed[k] += counts.fixed[k];
  const next: DayCounts = {
    passes: row.passes + 1, found: add(row.found, counts.found), reported: add(row.reported, counts.reported), fixed,
    calls: row.calls + counts.calls, callMs: row.callMs + counts.callMs,
  };
  return trimAudit({
    ...file,
    nodes: { ...file.nodes, [taskId]: { ...node, lastPassAt: new Date(now).toISOString() } },
    days: { ...file.days, [day]: { ...file.days[day], [taskId]: next } },
  }, now);
}

export async function readAudit(): Promise<AuditFile> {
  return normalizeAudit(await readJsonFile<unknown>(auditFilePath(), null).catch(() => null));
}

/** Locked read-modify-write of the file. */
export async function updateAudit(mutate: (cur: AuditFile) => AuditFile): Promise<void> {
  await updateJsonFile<unknown>(auditFilePath(), null, (raw) => mutate(normalizeAudit(raw)));
}

export interface AuditCountsView {
  /** Newest day first: each day's totals and its rows per node. */
  days: Array<{ date: string; totals: DayCounts; nodes: Record<string, DayCounts> }>;
  totals: DayCounts;
}

/** The counts of the last `days` days, of one node or of all. Pure. */
export function countsView(file: AuditFile, opts: { days: number; task?: string }, now: number): AuditCountsView {
  const from = dayOf(now - (Math.max(1, opts.days) - 1) * DAY_MS);
  const sum = (into: DayCounts, d: DayCounts): DayCounts => {
    const kinds = (a: KindCounts, b: KindCounts) => Object.fromEntries(AUDIT_KINDS.map((k) => [k, (a[k] ?? 0) + (b?.[k] ?? 0)])) as KindCounts;
    return { passes: into.passes + (d.passes ?? 0), found: kinds(into.found, d.found), reported: kinds(into.reported, d.reported), fixed: kinds(into.fixed, d.fixed), calls: into.calls + (d.calls ?? 0), callMs: into.callMs + (d.callMs ?? 0) };
  };
  let totals = zeroDay();
  const days = Object.keys(file.days).filter((d) => d >= from).sort().reverse().map((date) => {
    const nodes = Object.fromEntries(Object.entries(file.days[date]).filter(([id]) => !opts.task || id === opts.task));
    const dayTotals = Object.values(nodes).reduce(sum, zeroDay());
    totals = sum(totals, dayTotals);
    return { date, totals: dayTotals, nodes };
  }).filter((d) => Object.keys(d.nodes).length);
  return { days, totals };
}
