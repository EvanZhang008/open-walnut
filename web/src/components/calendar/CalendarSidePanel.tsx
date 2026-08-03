/**
 * CalendarSidePanel — the homepage's compact day-agenda: one TimeGrid column
 * for a single day, with chip move + click-to-create working exactly like the
 * full /calendar page. Wrapped in its own DndContext because TimeGrid's
 * droppables need one; rail drags live only on the calendar page (cross-panel
 * drag from TodoPanel is a deliberate non-goal — it owns a separate
 * DndContext and merging them risks its tuned drag setup).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { DndContext } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { useTasksContext } from '@/contexts/TasksContext';
import { parseDateLocal } from '@/components/common/DatePicker';
import { addDays, formatDateOnly } from '@/utils/calendar-date';
import { tasksToCalendarItems, useFrozenWhile } from './calendar-items';
import { TimeGrid, type GridMetrics } from './TimeGrid';
import { QuickCreatePopover, type CreateSeed } from './QuickCreatePopover';

interface Props {
  onClose: () => void;
}

export function CalendarSidePanel({ onClose }: Props) {
  const { tasks, update, create } = useTasksContext();
  const [day, setDay] = useState(() => formatDateOnly(new Date()));
  const anchor = useMemo(() => parseDateLocal(day), [day]);

  const [chipDragging, setChipDragging] = useState(false);
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null);
  const metricsRef = useRef<GridMetrics | null>(null);

  const liveItems = useMemo(() => tasksToCalendarItems(tasks, day, day), [tasks, day]);
  const items = useFrozenWhile(liveItems, chipDragging);

  const moveItem = useCallback(
    (itemId: string, newWhen: string) => {
      const [kind, taskId] = itemId.split(':');
      if (kind === 'task-start') update(taskId, { start_date: newWhen });
      else if (kind === 'task-due') update(taskId, { due_date: newWhen });
    },
    [update]
  );

  const step = (dir: 1 | -1) => setDay(formatDateOnly(addDays(anchor, dir)));
  const isToday = day === formatDateOnly(new Date());

  return (
    <div className="cal-side-panel" data-testid="cal-side-panel">
      <div className="cal-side-header">
        <span className="cal-side-title">
          {isToday ? 'Today' : anchor.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        <div className="cal-side-nav">
          <button onClick={() => step(-1)} aria-label="Previous day">‹</button>
          {!isToday && (
            <button className="cal-side-today" onClick={() => setDay(formatDateOnly(new Date()))}>
              Today
            </button>
          )}
          <button onClick={() => step(1)} aria-label="Next day">›</button>
        </div>
        <Link to={`/calendar?view=day&d=${day}`} className="cal-side-expand" title="Open calendar">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </Link>
        <button className="btn btn-sm" onClick={onClose} title="Close calendar panel">
          ✕
        </button>
      </div>
      <div className="cal-side-body">
        <DndContext>
          <TimeGrid
            days={1}
            anchor={anchor}
            items={items}
            dropPreview={null}
            metricsRef={metricsRef}
            onMoveItem={moveItem}
            onChipDragging={setChipDragging}
            onCreate={setCreateSeed}
          />
        </DndContext>
      </div>
      {createSeed && (
        <QuickCreatePopover seed={createSeed} onClose={() => setCreateSeed(null)} onCreateTask={create} />
      )}
    </div>
  );
}
