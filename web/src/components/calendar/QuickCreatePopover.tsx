/**
 * QuickCreatePopover — clicking/drag-selecting empty calendar space opens
 * this portal-anchored creator. Task tab wraps QuickTaskComposer with the
 * slot's dates pre-seeded; Event tab arrives with Phase 2 (external
 * calendars) and is hidden until an event API is wired in.
 */
import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTasksContext } from '@/contexts/TasksContext';
import { QuickTaskComposer } from '@/components/tasks/QuickTaskComposer';
import type { CreateTaskInput } from '@/api/tasks';

export interface CreateSeed {
  /** Slot's date ("YYYY-MM-DD") or datetime ("…T09:00:00"). */
  start: string;
  /** Present when the user drag-selected a range. */
  end?: string;
  /** Element to anchor the popover to (small anchors: month cells, all-day cells). */
  anchorEl?: HTMLElement;
  /**
   * Pointer coords to anchor to instead — REQUIRED for time-grid slots: the
   * column element is a day tall, so an element anchor would place the popover
   * at the column's bottom, far from the clicked slot (and off screen).
   */
  anchorPoint?: { x: number; y: number };
}

interface Props {
  seed: CreateSeed;
  onClose: () => void;
  onCreateTask: (input: CreateTaskInput) => Promise<Task>;
}

export function QuickCreatePopover({ seed, onClose, onCreateTask }: Props) {
  const { tasks, star } = useTasksContext();
  const anchorRef = useRef<HTMLElement | null>(seed.anchorEl ?? null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef, {
    anchorPoint: seed.anchorPoint ?? null,
  });

  const projectOptions = useMemo(() => {
    const options = new Map<string, Set<string>>();
    for (const task of tasks) {
      if (task.title.startsWith('.metadata') || task.project === task.category) continue;
      let projects = options.get(task.category);
      if (!projects) {
        projects = new Set();
        options.set(task.category, projects);
      }
      projects.add(task.project);
    }
    return Object.fromEntries(
      [...options.entries()].map(([category, projects]) => [category, [...projects].sort((a, b) => a.localeCompare(b))])
    );
  }, [tasks]);

  const initialDates = useMemo(
    () => ({ start: seed.start, due: seed.end }),
    [seed.start, seed.end]
  );

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} />
      <div className="cal-create-popover" ref={menuRef} style={menuPlacementStyle(placement)}>
        <QuickTaskComposer
          open
          onClose={onClose}
          projectOptions={projectOptions}
          initialDates={initialDates}
          onCreate={async (input) => {
            // pinnedTier needs the Focus Bar plumbing MainPage owns — out of
            // scope on the calendar; starred still applies post-create.
            const task = await onCreateTask({
              title: input.title,
              priority: input.priority,
              category: input.category,
              project: input.project,
              due_date: input.due_date,
              start_date: input.start_date,
            });
            if (input.starred && task?.id) star(task.id);
            onClose();
          }}
        />
      </div>
    </>,
    document.body
  );
}
