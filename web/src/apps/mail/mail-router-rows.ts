/**
 * The routers Mail lists in its sidebar: the central task each area's mail goes to first, with its
 * live state, so the person sees from Mail where routing happens and opens it in one click
 * (2026-11-08, the user: "the mail router should be also visible, the central task visible in the
 * mail plugin, as well as a router in the Org level").
 */
import type { Task } from '@open-walnut/core';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { areaIdWords } from '@/components/org/org-channels-model';

export type RouterRowTone = 'paused' | 'working' | 'needs' | 'ready';

export interface MailRouterRow {
  taskId: string;
  name: string;
  area: string;
  tone: RouterRowTone;
  /** One or two words: Paused, Working, Needs you, Ready. */
  state: string;
  /** The Org page path of its own node. */
  path: string;
}

// Working and Needs you are the task states' own names; Paused and Ready are the router's.
const STATE: Record<RouterRowTone, string> = { paused: 'Paused', working: USER_STATE_LABELS.working, needs: USER_STATE_LABELS.needs, ready: 'Ready' };

/** A router's live state: Paused first (it reads nothing), then what its task is doing now. */
export function routerTone(task: Pick<Task, 'router_paused' | 'user_status'>): RouterRowTone {
  if (task.router_paused !== false) return 'paused';
  const state = task.user_status?.state;
  if (state === 'working') return 'working';
  if (state === 'needs') return 'needs';
  return 'ready';
}

/** Every open router, in area order (Personal, Work, then the rest by name). */
export function mailRouterRows(tasks: readonly Task[], areaNames: Readonly<Record<string, string>> = {}): MailRouterRow[] {
  const order = (area: string | undefined) => (area === 'personal' ? 0 : area === 'work' ? 1 : 2);
  return tasks
    .filter((t) => t.org_role === 'router' && t.phase !== 'COMPLETE')
    .sort((a, b) => order(a.router_area_id) - order(b.router_area_id) || (a.org_name || a.title).localeCompare(b.org_name || b.title))
    .map((t) => {
      const tone = routerTone(t);
      const areaId = t.router_area_id ?? '';
      return {
        taskId: t.id,
        name: t.org_name || t.title,
        area: areaId ? areaNames[areaId] || areaIdWords(areaId) : 'No area',
        tone,
        state: STATE[tone],
        path: `/org?node=${encodeURIComponent(`router:${t.id}`)}`,
      };
    });
}
