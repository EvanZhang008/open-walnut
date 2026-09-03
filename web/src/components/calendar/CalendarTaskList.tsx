/**
 * CalendarTaskList — the left rail of unscheduled tasks (no own start_date),
 * each row a dnd-kit draggable that can be dropped onto any calendar surface.
 * Pinned tiers lead (Focus / Satellite / … — the same priority structure as
 * the homepage pinned area), then everything else grouped by project.
 * Deliberately slim (NOT a TodoPanel embed — that component owns its own
 * DndContexts and nesting them invites sensor conflicts).
 */
import { memo, useDeferredValue, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task } from '@open-walnut/core';
import { PIN_TIER_POLICY } from '@open-walnut/core';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { PriorityBadge } from '@/components/common/PriorityBadge';

const DONE_PHASES = new Set(['COMPLETE', 'CANCELLED']);

/** Stable identity, so the deferred first pass doesn't re-trigger itself. */
const NO_TASKS: Task[] = [];

interface Props {
  tasks: Task[];
}

export const TaskListChip = memo(function TaskListChip({
  task,
  overlay,
}: {
  task: Task;
  overlay?: boolean;
}) {
  return (
    <div className={`cal-rail-chip${overlay ? ' cal-rail-chip-overlay' : ''}`}>
      <PriorityBadge priority={task.priority} />
      <span className="cal-rail-chip-title">{task.title}</span>
    </div>
  );
});

const RailRow = memo(function RailRow({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `cal-task:${task.id}`,
    data: { task },
  });
  return (
    <div
      ref={setNodeRef}
      className={`cal-rail-row${isDragging ? ' dragging' : ''}`}
      data-task-id={task.id}
      {...listeners}
      {...attributes}
    >
      <TaskListChip task={task} />
    </div>
  );
});

interface RailSection {
  key: string;
  label: string;
  /** 'tier' sections get the colored tier dot; 'project' sections don't. */
  kind: 'tier' | 'project';
  /** Built-in tier name for the dot color class ('custom' for ct_*). */
  tier?: string;
  tasks: Task[];
}

export const CalendarTaskList = memo(function CalendarTaskList({ tasks }: Props) {
  const [filter, setFilter] = useState('');
  // Safe variant: the rail renders fine without the provider (tests, popouts) —
  // it just degrades to project-only grouping.
  const focusBar = useFocusBarContextSafe();
  const customTiers = focusBar?.customTiers ?? [];

  // The rail renders one row per unscheduled task, and on a real dataset that is 2,890
  // rows / 11,618 elements: measured, building it costs 194-214ms of DOM and layout even
  // as plain markup with no React and no dnd-kit involved. Paid inside the blocking
  // render, that was the whole 266ms hitch when opening Calendar — the calendar grid
  // itself is cheap. So let the page paint first and fill the rail in on a low-priority
  // pass. React 19's second argument is what makes this work on the FIRST render (a
  // one-argument useDeferredValue only defers updates, and the first render is the
  // expensive one here).
  //
  // Chosen over the two alternatives on evidence, not taste. `content-visibility: auto`
  // barely helped the open (266 -> 237ms) and took scrolling from 87-100 fps to 28-40 at
  // every speed, while quietly changing the rail's own height (141,666 -> 134,318px), so
  // the scrollbar became a moving lie. Windowing — which is what fixed the tasks table —
  // does not transfer: rows are 32px or 46px depending on whether the title wraps under
  // `-webkit-line-clamp: 2`, so offsets cannot be arithmetic, and every row is a dnd-kit
  // draggable, so unmounting rows under a drag risks the rail's entire purpose.
  const deferredTasks = useDeferredValue(tasks, NO_TASKS);
  /** True while the real list has not been rendered yet. */
  const settling = deferredTasks !== tasks;

  const sections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const unscheduled = deferredTasks.filter(
      (t) => !DONE_PHASES.has(t.phase) && !t.start_date && (!q || t.title.toLowerCase().includes(q))
    );

    const out: RailSection[] = [];

    // ── Pinned tiers first — same structure and order as the homepage pinned
    // area, so "schedule my Focus tasks" is a glance, not a hunt.
    let remaining = unscheduled;
    if (focusBar) {
      const tierOrder: { key: string; label: string; tier: string; ids: string[] }[] = [
        ...PIN_TIER_POLICY.map((p) => ({
          key: p.tier,
          label: p.label,
          tier: p.tier,
          ids: p.tier === 'focus' ? focusBar.focusIds
            : p.tier === 'satellite' ? focusBar.satelliteIds
            : p.tier === 'backlog' ? focusBar.backlogIds
            : focusBar.waitIds,
        })),
        ...customTiers.map((ct) => ({
          key: ct.id,
          label: ct.label,
          tier: 'custom',
          ids: focusBar.customTierIds[ct.id] ?? [],
        })),
      ];
      const byId = new Map(unscheduled.map((t) => [t.id, t]));
      const pinnedShown = new Set<string>();
      for (const { key, label, tier, ids } of tierOrder) {
        const members = ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
        if (members.length === 0) continue;
        for (const t of members) pinnedShown.add(t.id);
        out.push({ key: `t:${key}`, label, kind: 'tier', tier, tasks: members });
      }
      remaining = unscheduled.filter((t) => !pinnedShown.has(t.id));
    }

    // ── Then by project. Inbox is the ABSENCE of a project, so its bucket key
    // is '' (the same sentinel the rest of the app uses) and the "Inbox" label
    // is applied only at render — keying on the literal 'Inbox' would silently
    // merge a real project of that name into the no-project bucket. '' sorts last.
    const byProject = new Map<string, Task[]>();
    for (const t of remaining) {
      const key = t.project || '';
      const list = byProject.get(key);
      if (list) list.push(t);
      else byProject.set(key, [t]);
    }
    const projects = [...byProject.entries()].sort((a, b) =>
      a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0]));
    for (const [project, list] of projects) {
      // Prefixed key: '' is a legal-but-ambiguous React key, and the prefix
      // also keeps a project literally named 'inbox' distinct from the bucket.
      out.push({ key: `p:${project}`, label: project || 'Inbox', kind: 'project', tasks: list });
    }
    return out;
  }, [deferredTasks, filter, focusBar, customTiers]);

  return (
    <div className="cal-rail" data-testid="cal-rail">
      <div className="cal-rail-header">
        <span className="cal-rail-title">Unscheduled</span>
        <input
          className="cal-rail-search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="cal-rail-scroll">
        {/* Only claim the rail is empty once we've actually looked: during the deferred
            first pass `sections` is empty because the list hasn't rendered yet, and
            flashing "No unscheduled tasks" at someone who has 2,890 of them is worse
            than showing nothing for a frame. */}
        {sections.length === 0 && !settling && (
          <div className="cal-rail-empty">No unscheduled tasks</div>
        )}
        {sections.map((s) => (
          <div key={s.key} className="cal-rail-group" data-rail-section={s.key}>
            <div className={`cal-rail-group-label${s.kind === 'tier' ? ' cal-rail-tier-label' : ''}`}>
              {s.kind === 'tier' && <span className={`cal-rail-tier-dot cal-rail-tier-${s.tier}`} />}
              {s.label}
            </div>
            {s.tasks.map((t) => (
              <RailRow key={t.id} task={t} />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-rail-hint">Drag a task onto the calendar to schedule it</div>
    </div>
  );
});
