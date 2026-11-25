/** Resolve a same-decision pointer to its open root, within one task team and incoming-item area. */
import type { Task } from './types.js';
import type { StatusReport } from './user-status.js';
import { askKey, FOLDABLE_SOURCES, type RelativeAsk } from './same-ask.js';
import { tasksByIdOf, treeAround } from './same-ask-tree.js';
import { sameTaskArea } from './router/same-area.js';
import { reportDecision } from './ask-decision.js';
import { decisionOnThread, holderThreadsOf, type HolderThreads, type ThreadDecision } from './org/thread-held-decision.js';

type Ref = NonNullable<StatusReport['decision_owner']>;
/** What a fold reads of a holder's threads (org/thread-held-decision.ts), by task id. */
export type HolderThreadsOf = (taskId: string) => HolderThreads | undefined;

/**
 * Stored decision identity still belongs to this task, even while its visible status is a pointer,
 * or while an open needs thread of its own carries it (`onThread`, org/thread-held-decision.ts).
 */
function holds(task: Task, ref: Ref, onThread: ThreadDecision | null): boolean {
  // Found by the ref itself (decisionOnThread): its id, or the key of its words.
  if (onThread) return true;
  const s = task.user_status;
  const decision = s?.decision ?? reportDecision(task.status_report, task.due_date);
  const ask = s?.state === 'needs' ? s.ask : task.status_report?.state === 'needs' ? task.status_report.ask : undefined;
  return !!ask && (ref.decisionId ? decision?.id === ref.decisionId : askKey(ask) === ref.askKey);
}

/** A decision on a needs thread as the fold reads a shown ask. */
const threadAsk = (owner: Task, d: ThreadDecision): RelativeAsk => ({ id: owner.id, title: owner.title, ask: d.ask, ...(d.id ? { decision: { id: d.id, key: d.id } } : {}) });

/**
 * `hint`: the asking task's own words, for a pointer that names no decision yet (same_as): of the
 * owner's needs threads, the one asking that in other words is the decision it names.
 */
export function resolveDecisionOwner(task: Task, ownerId: string, all: readonly Task[], binding?: Ref, threadsOf?: HolderThreadsOf, hint?: string): RelativeAsk | undefined {
  const byId = tasksByIdOf(all);
  // A completed root can still hold an answered decision. Include it only for team membership.
  const allowed = new Set(treeAround(task.id, all, { allOpen: true }).map((row) => row.task.id));
  const seen = new Set([task.id]);
  let id = ownerId;
  let ref = binding;
  let settled: RelativeAsk | undefined;
  for (let hops = 0; hops < 12; hops++) {
    const owner = byId.get(id);
    const held = owner ? threadsOf?.(id) : undefined;
    // The decision a needs thread of its own carries (org/thread-held-decision.ts): the one the ref names, else the asking words'.
    const want = ref ? { ...(ref.decisionId ? { id: ref.decisionId } : {}), key: ref.askKey } : hint ? { ask: hint } : null;
    const onThread = owner && want ? decisionOnThread(owner, held, want) : null;
    if (!owner || seen.has(id) || !allowed.has(id) || !sameTaskArea(task, owner)
      || (ref && !holds(owner, ref, onThread))) return undefined;
    seen.add(id);
    if (settled) return owner.user_status?.state === 'needs' ? undefined : { ...settled, id: owner.id, title: owner.title };
    if (owner.phase === 'COMPLETE' || owner.status === 'done') return undefined;
    const s = owner.user_status;
    if (s?.sameAsk?.answered) {
      settled = { id: s.sameAsk.id, title: s.sameAsk.title, ask: s.sameAsk.ask, answered: true };
      id = s.sameAsk.id; ref = undefined; continue;
    }
    const stored = owner.status_report?.state === 'needs' ? owner.status_report.decision_owner : undefined;
    if (stored) { id = stored.taskId; ref = stored; continue; }
    if (s?.sameAsk) { id = s.sameAsk.id; ref = undefined; continue; }
    // Legacy self reports may name an owner before this build has bound them.
    if (owner.status_report?.state === 'needs' && owner.status_report.same_as) {
      id = owner.status_report.same_as; ref = undefined; continue;
    }
    // Its decision is on its own thread now, where he answers it: still the one to wait on.
    if (onThread) return threadAsk(owner, onThread);
    if (s?.state === 'needs' && s.ask && s.source && FOLDABLE_SOURCES.has(s.source)) {
      return { id: owner.id, title: owner.title, ask: s.ask, ...(s.decision ? { decision: s.decision } : {}) };
    }
    // A pointer that names no decision, to a task whose only one is on a needs thread of its own: that one.
    const only = !ref ? decisionOnThread(owner, held, null) : null;
    return only ? threadAsk(owner, only) : undefined;
  }
  return undefined;
}

export function bindDecisionOwner(task: Task, report: StatusReport, all: readonly Task[], threadsOf?: HolderThreadsOf): StatusReport | null {
  if (!report.same_as || report.state !== 'needs') return report;
  const owner = resolveDecisionOwner(task, report.same_as, all, undefined, threadsOf, report.ask);
  if (!owner || owner.answered) return null;
  return { ...report, same_as: owner.id, decision_owner: { taskId: owner.id,
    ...(owner.decision?.id ? { decisionId: owner.decision.id } : {}), askKey: askKey(owner.ask) } };
}

/**
 * The tasks a pointer reaches from `id`, itself first: each one's own stored owner, fold or same_as
 * after it, a dozen hops at most (the hops resolveDecisionOwner walks). Pure.
 */
export function ownerChain(id: string, byId: ReadonlyMap<string, Task>): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = id, hops = 0; cur && hops < 12 && !seen.has(cur); hops++) {
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) break;
    out.push(t);
    const r = t.status_report?.state === 'needs' ? t.status_report : undefined;
    cur = r?.decision_owner?.taskId ?? t.user_status?.sameAsk?.id ?? r?.same_as;
  }
  return out;
}

/** bindDecisionOwner with what the named tasks' threads carry: a decision one put on a needs thread of its own binds too, at any hop. */
export async function bindDecisionOwnerNow(task: Task, report: StatusReport, all: readonly Task[]): Promise<StatusReport | null> {
  if (!report.same_as || report.state !== 'needs') return report;
  const held = await holderThreadsOf(ownerChain(report.same_as, tasksByIdOf(all)));
  return bindDecisionOwner(task, report, all, (id) => held.get(id));
}
