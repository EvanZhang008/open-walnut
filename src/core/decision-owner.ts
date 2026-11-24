/** Resolve a same-decision pointer to its open root, within one task team and incoming-item area. */
import type { Task } from './types.js';
import type { StatusReport } from './user-status.js';
import { askKey, FOLDABLE_SOURCES, type RelativeAsk } from './same-ask.js';
import { tasksByIdOf, treeAround } from './same-ask-tree.js';
import { sameTaskArea } from './router/same-area.js';
import { reportDecision } from './ask-decision.js';

type Ref = NonNullable<StatusReport['decision_owner']>;

/** Stored decision identity still belongs to this task, even while its visible status is a pointer. */
function holds(task: Task, ref: Ref): boolean {
  const s = task.user_status;
  const decision = s?.decision ?? reportDecision(task.status_report, task.due_date);
  const ask = s?.state === 'needs' ? s.ask : task.status_report?.state === 'needs' ? task.status_report.ask : undefined;
  return !!ask && (ref.decisionId ? decision?.id === ref.decisionId : askKey(ask) === ref.askKey);
}

export function resolveDecisionOwner(task: Task, ownerId: string, all: readonly Task[], binding?: Ref): RelativeAsk | undefined {
  const byId = tasksByIdOf(all);
  // A completed root can still hold an answered decision. Include it only for team membership.
  const allowed = new Set(treeAround(task.id, all, { allOpen: true }).map((row) => row.task.id));
  const seen = new Set([task.id]);
  let id = ownerId;
  let ref = binding;
  let settled: RelativeAsk | undefined;
  for (let hops = 0; hops < 12; hops++) {
    const owner = byId.get(id);
    if (!owner || seen.has(id) || !allowed.has(id) || !sameTaskArea(task, owner)
      || (ref && !holds(owner, ref))) return undefined;
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
    if (s?.state !== 'needs' || !s.ask || !s.source || !FOLDABLE_SOURCES.has(s.source)) return undefined;
    return { id: owner.id, title: owner.title, ask: s.ask, ...(s.decision ? { decision: s.decision } : {}) };
  }
  return undefined;
}

export function bindDecisionOwner(task: Task, report: StatusReport, all: readonly Task[]): StatusReport | null {
  if (!report.same_as || report.state !== 'needs') return report;
  const owner = resolveDecisionOwner(task, report.same_as, all);
  if (!owner || owner.answered) return null;
  return { ...report, same_as: owner.id, decision_owner: { taskId: owner.id,
    ...(owner.decision?.id ? { decisionId: owner.decision.id } : {}), askKey: askKey(owner.ask) } };
}
