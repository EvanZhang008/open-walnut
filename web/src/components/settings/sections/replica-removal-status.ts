/**
 * The shapes GET /api/replicas/status answers (src/web/routes/replicas-status.ts)
 * and the rows Settings shows from them: one per follower and kind whose copy
 * refused, three rounds in a row, a manifest that removes most of its rows
 * (docs/plan/walnut-replica-servers-impl.md, section 4), and one per confirm the
 * user gave that no round has sent yet. Nothing else: a copy that works says
 * nothing here. Pure: ReplicaRemovalGroup renders it, tests read it.
 */

export type ReplicaTargetKind = 'companion' | 'host'

export interface ReplicaRefusal {
  error: string;
  at: number;
  /** The rows this Mac has now. */
  entries: number;
  /** Their key set (what the confirm is bound to). */
  keys?: string;
  /** The rows the copy holds, and how many of them it would remove (an older copy says neither). */
  local?: number;
  removing?: number;
}

export interface ReplicaKindStatus {
  kind: string;
  refusals: number;
  needsConfirm: boolean;
  lastRefusal?: ReplicaRefusal;
  confirmArmed?: { entries: number; keys: string; at: number; expiresAt: number };
}

export interface ReplicaTargetStatus { id: string; kind: ReplicaTargetKind; label: string; kinds: ReplicaKindStatus[] }

export interface ReplicasStatusResponse { ok: boolean; targets: ReplicaTargetStatus[] }

export interface ReplicaRemovalRow {
  /** `<target>/<kind>`: the row's stable id. */
  id: string;
  target: string;
  targetKind: ReplicaTargetKind;
  label: string;
  kind: string;
  state: 'refused' | 'armed';
  text: string;
  /** What the confirm names: the refusal the user read (state `refused` only). */
  confirm?: { target: string; kind: string; entries: number; keys: string };
}

/** What a kind's rows are called in a sentence. */
export function rowNoun(kind: string): string {
  if (kind === 'tasks') return 'tasks';
  if (kind === 'registry') return 'project and folder entries';
  if (kind === 'sessions') return 'sessions';
  if (kind === 'requests') return 'reply requests';
  if (kind === 'boards') return 'boards';
  if (kind === 'inbox') return 'letters';
  if (kind === 'inbox-bodies') return 'letter bodies';
  return `${kind} rows`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function refusedText(kind: string, r: ReplicaRefusal): string {
  const noun = rowNoun(kind);
  const size = typeof r.local === 'number' && typeof r.removing === 'number'
    ? `This Mac has ${r.entries} ${noun} now, and the copy there would drop ${r.removing} of its ${r.local}.`
    : `This Mac has ${r.entries} ${noun} now, far fewer than the copy there.`;
  return `${size} Walnut held off in case this Mac lost them. If you removed them on purpose, remove them there too.`;
}

export function armedText(kind: string, armed: { entries: number; expiresAt: number }): string {
  return `Confirmed: the next copy keeps only this Mac's ${armed.entries} ${rowNoun(kind)} there. The confirmation lapses if they change first, and at ${clock(armed.expiresAt)} at the latest.`;
}

/** The rows to show, for the targets of `only` (all when unset), in the order the status lists them. */
export function replicaRemovalRows(data: ReplicasStatusResponse | null, only?: ReplicaTargetKind): ReplicaRemovalRow[] {
  const out: ReplicaRemovalRow[] = [];
  for (const t of data?.targets ?? []) {
    if (only && t.kind !== only) continue;
    for (const k of t.kinds) {
      const base = { id: `${t.id}/${k.kind}`, target: t.id, targetKind: t.kind, label: t.label, kind: k.kind };
      if (k.confirmArmed) {
        out.push({ ...base, state: 'armed', text: armedText(k.kind, k.confirmArmed) });
      } else if (k.needsConfirm && k.lastRefusal?.keys) {
        const r = k.lastRefusal;
        out.push({ ...base, state: 'refused', text: refusedText(k.kind, r), confirm: { target: t.id, kind: k.kind, entries: r.entries, keys: r.keys! } });
      }
    }
  }
  return out;
}
