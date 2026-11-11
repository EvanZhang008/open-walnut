/**
 * Background: the home task list's group for long-running work (2026-11-11, the user: "它无论 task
 * 是什么 status，它不会出来", a CR review or a cron job that he puts there himself, "我不想 be
 * smart"). It is no status: an open task with `background_at` is drawn in Background only.
 *
 * The class guard: every user status Walnut gives (each state, each wait kind, snoozed, limited,
 * To read), under every placement rule the panel uses (Flat with Not started split out, the lists
 * of By project, Recent and Projects, a row held in its exit grace), lands in Background and in no
 * other section. The sections are read from STATUS_SECTION_ORDER, so a section added later is
 * checked too, and a model without a list for it fails. Completed goes under Completed; Watching
 * wins when both marks are set; the worker fold never moves a Background task out of it.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import type { UserStatus } from '../../src/core/user-status';
import {
  STATUS_SECTION_LABELS,
  STATUS_SECTION_ORDER,
  backgroundNeedsCount,
  buildStatusSections,
  isBackground,
  stateSectionNoNeeds,
  statusSectionOf,
  type DrawnSectionKey,
  type StatusSectionsModel,
} from '../../web/src/components/tasks/status-sections';
import { PANEL_DESIGNS, bottomStatusSections, foldTasksByProject } from '../../web/src/components/tasks/panel-design';
import { STATUS_SECTION_FOLD } from '../../web/src/components/tasks/section-fold-rule';
import { DEFAULT_WORKER_FOLD, WORKER_FOLD_KEEP, foldSections } from '../../web/src/components/tasks/worker-fold';
import { locatePlaceSig } from '../../web/src/components/tasks/locate-hold';

const AT = '2026-11-11T19:10:00.000Z';
let n = 0;
const task = (patch: Partial<Task> & { us?: UserStatus } = {}): Task => {
  const { us, ...rest } = patch;
  return {
    id: `t${++n}`, title: `Task ${n}`, status: 'todo', phase: 'IN_PROGRESS', priority: 'none', project: 'Garden',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    ...(us ? { user_status: us } : {}), ...rest,
  } as Task;
};

const WAIT_KINDS = ['not-started', 'task', 'time', 'machine', 'outside', 'own', 'you', 'lead', 'stuck', 'other'] as const;
/** Every user status a task can carry, with a phase that gives it. */
const STATUSES: Array<{ phase: Task['phase']; us?: UserStatus }> = [
  { phase: 'NEED_ACTION', us: { state: 'needs', needs: 'Approve the deploy?' } as UserStatus },
  { phase: 'NEED_ACTION', us: { state: 'read', toRead: 'result', waitingOn: 'The run finished' } as UserStatus },
  { phase: 'IN_PROGRESS', us: { state: 'working' } as UserStatus },
  { phase: 'IN_PROGRESS', us: { state: 'waiting', kind: 'stuck', limit: { resetsAt: '2099-01-01T00:00:00Z' } } as unknown as UserStatus },
  ...WAIT_KINDS.map((kind) => ({ phase: (kind === 'not-started' ? 'TODO' : 'WAITING') as Task['phase'], us: { state: 'waiting', kind, waitingOn: 'something' } as UserStatus })),
  { phase: 'WAITING', us: { state: 'waiting', kind: 'time', snoozed: { until: '2099-01-01' } } as unknown as UserStatus },
  // Not derived yet (an older server): the phase alone.
  { phase: 'TODO' }, { phase: 'NEED_ACTION' }, { phase: 'WAITING' }, { phase: 'IN_PROGRESS' },
];

/** The rows of every section in the model, read by the section keys themselves. */
function placesOf(model: StatusSectionsModel, id: string): string[] {
  return STATUS_SECTION_ORDER.filter((key) => {
    const rows = (model as unknown as Record<string, Task[] | undefined>)[key];
    expect(Array.isArray(rows), `the model has no list for section "${key}"`).toBe(true);
    return rows!.some((t) => t.id === id);
  });
}

/** The ways the panel places a task (TodoPanel's buildStatusSections inputs). */
const PLACEMENTS: Array<{ name: string; input: (t: Task) => Parameters<typeof buildStatusSections>[0] }> = [
  { name: 'Flat', input: (t) => ({ scope: [t], passes: () => true, splitNotStarted: true }) },
  { name: 'Flat, snoozed by Date', input: (t) => ({ scope: [t], passes: () => true, splitNotStarted: true, snoozed: () => true }) },
  { name: 'a list design', input: (t) => ({ scope: [t], passes: () => true, placeOf: (x) => stateSectionNoNeeds(x) }) },
  { name: 'held in its exit grace', input: (t) => ({ scope: [t], passes: () => true, placeOf: () => 'needs' as DrawnSectionKey }) },
];

describe('Background holds an open task whatever its status', () => {
  it('every status, every placement: Background and no other section', () => {
    for (const s of STATUSES) {
      for (const p of PLACEMENTS) {
        const t = task({ phase: s.phase, us: s.us, background_at: AT, unread: true });
        const label = `${p.name} / ${s.phase} / ${s.us?.state ?? 'underived'} ${s.us && 'kind' in s.us ? s.us.kind : ''}`;
        expect(placesOf(buildStatusSections(p.input(t)), t.id), label).toEqual(['background']);
        expect(statusSectionOf(t), label).toBe('background');
      }
    }
  });

  it('without the mark the same tasks are never in Background (no rule puts them there)', () => {
    for (const s of STATUSES) {
      const t = task({ phase: s.phase, us: s.us, tags: ['cron'], cron_job_id: 'job-1' } as Partial<Task>);
      const places = placesOf(buildStatusSections({ scope: [t], passes: () => true, splitNotStarted: true }), t.id);
      expect(places).not.toContain('background');
      expect(places).toHaveLength(1);
    }
  });

  it('a completed task with the mark goes under Completed; Watching wins over Background', () => {
    const done = task({ phase: 'COMPLETE', status: 'done', background_at: AT });
    expect(isBackground(done)).toBe(false);
    expect(placesOf(buildStatusSections({ scope: [done], passes: () => true, splitNotStarted: true }), done.id)).toEqual(['done']);
    const both = task({ phase: 'NEED_ACTION', background_at: AT, watched_at: AT });
    expect(placesOf(buildStatusSections({ scope: [both], passes: () => true, splitNotStarted: true }), both.id)).toEqual(['watching']);
  });

  it('a Background task completed a moment ago fades out in Background (its exit grace), never in Working', () => {
    const done = task({ phase: 'COMPLETE', status: 'done', background_at: AT });
    const model = buildStatusSections({ scope: [done], passes: () => true, splitNotStarted: true, placeOf: () => 'background' });
    expect(placesOf(model, done.id)).toEqual(['background']);
  });

  it('a chip still narrows it, and a Status filter that hides the sections draws it in the list', () => {
    const t = task({ phase: 'NEED_ACTION', background_at: AT });
    expect(placesOf(buildStatusSections({ scope: [t], passes: () => false }), t.id)).toEqual([]);
    expect(placesOf(buildStatusSections({ scope: [t], passes: () => true, statesActive: false }), t.id)).toEqual([]);
  });

  it('its heading dot counts only the tasks that ask the user something', () => {
    const rows = [
      task({ phase: 'NEED_ACTION', background_at: AT, us: { state: 'needs', needs: 'Merge?' } as UserStatus }),
      task({ phase: 'NEED_ACTION', background_at: AT, us: { state: 'read', toRead: 'result' } as UserStatus }),
      task({ background_at: AT, us: { state: 'working' } as UserStatus }),
    ];
    expect(backgroundNeedsCount(rows)).toBe(1);
    // The one that asks leads the group.
    const model = buildStatusSections({ scope: [...rows].reverse(), passes: () => true, splitNotStarted: true });
    expect(model.background[0].id).toBe(rows[0].id);
  });
});

describe('Background in every layout', () => {
  it('every view of every layout draws Background, folded, right above Completed', () => {
    for (const { id: design } of PANEL_DESIGNS) {
      for (const view of ['all', 'focus', 'satellite', 'tasks', 'recent']) {
        const keys = bottomStatusSections(design, view);
        expect(keys.slice(-2), `${design} / ${view}`).toEqual(['background', 'done']);
      }
    }
    expect(STATUS_SECTION_FOLD.background).toBe('auto');
    expect(STATUS_SECTION_LABELS.background).toBe('Background');
  });

  it('By project never folds a Background task into a project\'s Waiting', () => {
    const t = task({ phase: 'WAITING', background_at: AT, us: { state: 'waiting', kind: 'time' } as UserStatus });
    expect(foldTasksByProject([t], () => true).size).toBe(0);
  });

  it('the worker fold neither moves a Background leader out nor folds a Background worker into another section', () => {
    expect(WORKER_FOLD_KEEP.has('background')).toBe(true);
    const lead = task({ id: 'lead', background_at: AT, us: { state: 'waiting', kind: 'task' } as UserStatus, phase: 'WAITING' });
    const worker = task({ id: 'w1', parent_task_id: 'lead', us: { state: 'working' } as UserStatus });
    const model = buildStatusSections({ scope: [lead, worker], passes: () => true, splitNotStarted: true });
    const folded = foldSections([lead, worker], STATUS_SECTION_ORDER.map((k) => [k, (model as unknown as Record<string, Task[]>)[k]] as const), DEFAULT_WORKER_FOLD, WORKER_FOLD_KEEP);
    expect(folded.rows.background.map((t) => t.id)).toEqual(['lead']);
    expect(folded.movedFrom.has('lead')).toBe(false);
    for (const k of STATUS_SECTION_ORDER) if (k !== 'background') expect(folded.rows[k].some((t) => t.id === 'lead'), k).toBe(false);

    const needsLead = task({ id: 'nl', phase: 'NEED_ACTION', us: { state: 'needs', needs: 'Pick one' } as UserStatus });
    const bgWorker = task({ id: 'bw', parent_task_id: 'nl', background_at: AT, us: { state: 'working' } as UserStatus });
    const m2 = buildStatusSections({ scope: [needsLead, bgWorker], passes: () => true, splitNotStarted: true });
    const f2 = foldSections([needsLead, bgWorker], STATUS_SECTION_ORDER.map((k) => [k, (m2 as unknown as Record<string, Task[]>)[k]] as const), DEFAULT_WORKER_FOLD, WORKER_FOLD_KEEP);
    expect(f2.rows.background.map((t) => t.id)).toEqual(['bw']);
  });

  it('a held locate runs again when the mark changes (its place moved)', () => {
    const facts = { tier: 'focus', passes: true, held: false } as Parameters<typeof locatePlaceSig>[1];
    const t = task({ phase: 'NEED_ACTION' });
    expect(locatePlaceSig({ ...t, background_at: AT } as Task, facts)).not.toBe(locatePlaceSig(t, facts));
  });
});
