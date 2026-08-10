import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ProjectSourceBadge } from './ProjectSourceBadge';

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
}

/** Left rail of the /tasks workspace: All Tasks → projects → Inbox, with a
 *  pinned "＋ New Project" inline-create affordance at the bottom. */
export function TasksPageRail({
  projects,
  allOpenCount,
  inboxOpenCount,
  activeKey,
  onSelect,
  onCreateProject,
}: TasksPageRailProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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
    <aside className="tp-rail" data-testid="tasks-rail">
      <div className="tp-rail-title">Projects</div>
      <div className="tp-rail-scroll">
        <button type="button" className={itemClass(null)} onClick={() => onSelect(null)}>
          <span className="tp-ri-icon">☰</span>
          <span className="tp-ri-name">All Tasks</span>
          <span className="tp-ri-count">{allOpenCount}</span>
        </button>
        {projects.map((p) => (
          <button
            key={p.name}
            type="button"
            className={itemClass(p.name)}
            onClick={() => onSelect(p.name)}
            title={p.name}
          >
            <span className="tp-ri-icon">📁</span>
            <span className="tp-ri-name">{p.name}</span>
            <ProjectSourceBadge source={p.source} />
            {p.favorite && <span className="tp-ri-fav">★</span>}
            <span className="tp-ri-count">{p.openCount}</span>
          </button>
        ))}
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
    </aside>
  );
}
