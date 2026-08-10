import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ProjectSourceBadge } from './ProjectSourceBadge';
import { ProjectKebabMenu } from './ProjectHeaderMenus';

export interface RailProjectItem {
  /** Canonical project name (registry spelling when known). */
  name: string;
  /** Provider source ('local' | 'ms-todo' | 'jira' | …); undefined renders no badge. */
  source?: string;
  favorite: boolean;
  openCount: number;
}

interface TasksPageRailProps {
  /** Ordered project list (projectOrder first, then alphabetical). Excludes Inbox. */
  projects: RailProjectItem[];
  allOpenCount: number;
  inboxOpenCount: number;
  /** null = All Tasks, '' = Inbox, otherwise a project name. */
  activeKey: string | null;
  onSelect: (key: string | null) => void;
  onCreateProject: (name: string) => void | Promise<void>;
  /** Persist a new full project order after a rail drag. */
  onReorderProjects: (order: string[]) => void;
  onToggleFavorite: (project: string) => void;
  /** A rail-menu rename/delete landed — refresh the registry and fix selection. */
  onProjectChanged: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
}

const LS_RAIL_WIDTH = 'walnut-tasks-rail-width';
const RAIL_MIN = 160;
const RAIL_MAX = 420;

function readRailWidth(): number {
  try {
    const v = Number(localStorage.getItem(LS_RAIL_WIDTH));
    if (Number.isFinite(v) && v >= RAIL_MIN && v <= RAIL_MAX) return v;
  } catch { /* ignore */ }
  return 220;
}

/** One draggable project row. Drag activates after 6px so plain clicks select.
 *  A <div role=button> (from useSortable's attributes), NOT a <button>: the row
 *  hosts the kebab <button>, and buttons cannot nest. */
function SortableRailItem({ p, active, onSelect, onToggleFavorite, onProjectChanged }: {
  p: RailProjectItem;
  active: boolean;
  onSelect: () => void;
  onToggleFavorite: (project: string) => void;
  onProjectChanged: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `railproj:${p.name}`,
    data: { type: 'rail-project', project: p.name },
  });
  return (
    <div
      ref={setNodeRef}
      className={`tp-rail-item${active ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      title={p.name}
      data-rail-project={p.name}
      {...attributes}
      {...listeners}
    >
      <span className="tp-ri-icon">📁</span>
      <span className="tp-ri-name">{p.name}</span>
      <ProjectSourceBadge source={p.source} />
      {p.favorite && <span className="tp-ri-fav">★</span>}
      <span className="tp-ri-count">{p.openCount}</span>
      {/* Hover ⋮ + row right-click, one menu definition (ProjectKebabMenu):
          Favorite / Rename… / Delete…. */}
      <ProjectKebabMenu
        project={p.name}
        isFavorite={p.favorite}
        onToggleFavorite={onToggleFavorite}
        onChanged={onProjectChanged}
        rowSelector="[data-rail-project]"
        wrapClassName="tp-rail-kebab-wrap"
        btnClassName="tp-rail-kebab-btn"
      />
    </div>
  );
}

/** Left rail of the /tasks workspace: All Tasks → projects (drag to reorder) →
 *  Inbox, a pinned "＋ New Project" affordance, and a drag-resizable width. */
export function TasksPageRail({
  projects,
  allOpenCount,
  inboxOpenCount,
  activeKey,
  onSelect,
  onCreateProject,
  onReorderProjects,
  onToggleFavorite,
  onProjectChanged,
}: TasksPageRailProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // ── resizable width ──
  const [width, setWidth] = useState(readRailWidth);
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startW: width };
    setResizing(true);
  }, [width]);

  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      const s = resizeRef.current;
      if (!s) return;
      const w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, s.startW + (e.clientX - s.startX)));
      setWidth(w);
    };
    const up = () => {
      setResizing(false);
      resizeRef.current = null;
      setWidth((w) => {
        try { localStorage.setItem(LS_RAIL_WIDTH, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [resizing]);

  // ── project drag reorder — 6px activation keeps plain clicks as selects ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const names = projects.map((p) => p.name);
    const from = names.indexOf(String(active.id).slice('railproj:'.length));
    const to = names.indexOf(String(over.id).slice('railproj:'.length));
    if (from === -1 || to === -1) return;
    const next = [...names];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorderProjects(next);
  }, [projects, onReorderProjects]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const cancelCreate = () => {
    setCreating(false);
    setDraft('');
  };

  const handleCreateKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME confirm ≠ submit
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelCreate();
    } else if (e.key === 'Enter') {
      const name = draft.trim();
      if (!name) { cancelCreate(); return; }
      cancelCreate();
      void onCreateProject(name);
    }
  };

  const itemClass = (key: string | null) =>
    `tp-rail-item${activeKey === key ? ' active' : ''}`;

  return (
    <aside className="tp-rail" data-testid="tasks-rail" style={{ width }}>
      <div className="tp-rail-title">Projects</div>
      <div className="tp-rail-scroll">
        <button type="button" className={itemClass(null)} onClick={() => onSelect(null)}>
          <span className="tp-ri-icon">☰</span>
          <span className="tp-ri-name">All Tasks</span>
          <span className="tp-ri-count">{allOpenCount}</span>
        </button>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={projects.map((p) => `railproj:${p.name}`)}
            strategy={verticalListSortingStrategy}
          >
            {projects.map((p) => (
              <SortableRailItem
                key={p.name}
                p={p}
                active={activeKey === p.name}
                onSelect={() => onSelect(p.name)}
                onToggleFavorite={onToggleFavorite}
                onProjectChanged={onProjectChanged}
              />
            ))}
          </SortableContext>
        </DndContext>
        <button type="button" className={itemClass('')} onClick={() => onSelect('')}>
          <span className="tp-ri-icon">📥</span>
          <span className="tp-ri-name">Inbox</span>
          <span className="tp-ri-count">{inboxOpenCount}</span>
        </button>
      </div>

      <div className="tp-rail-newproj-wrap">
        {creating ? (
          <input
            ref={inputRef}
            className="tp-rail-newproj-input"
            placeholder="Project name…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleCreateKey}
            onBlur={cancelCreate}
          />
        ) : (
          <button type="button" className="tp-rail-newproj-btn" onClick={() => setCreating(true)}>
            ＋ New Project
          </button>
        )}
      </div>

      {/* resize handle — right edge of the rail */}
      <div
        className={`tp-rail-resizer${resizing ? ' active' : ''}`}
        onPointerDown={startResize}
        title="Drag to resize"
      />
    </aside>
  );
}
