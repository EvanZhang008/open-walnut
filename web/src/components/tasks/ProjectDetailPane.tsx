import { useState, useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import type { Task } from '@walnut/core';

interface ProjectMetadata {
  default_cwd?: string;
  default_host?: string;
  [key: string]: unknown;
}

interface ProjectDetailPaneProps {
  category: string;
  project: string;
  tasks: Task[];
  onClose: () => void;
  style?: CSSProperties;
}

export function ProjectDetailPane({ category, project, tasks, onClose, style }: ProjectDetailPaneProps) {
  const [metadata, setMetadata] = useState<ProjectMetadata>({});
  const [memorySummary, setMemorySummary] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Compute task counts from props
  const counts = useMemo(() => {
    const result = { todo: 0, active: 0, done: 0, total: 0 };
    for (const t of tasks) {
      if (t.category !== category) continue;
      if ((t.project || t.category) !== project) continue;
      if (t.phase === 'TODO') result.todo++;
      else if (t.phase === 'COMPLETE') result.done++;
      else result.active++;
      result.total++;
    }
    return result;
  }, [tasks, category, project]);

  // Determine source from tasks
  const source = useMemo(() => {
    const t = tasks.find((t) => t.category === category && (t.project || t.category) === project);
    return t?.source ?? 'local';
  }, [tasks, category, project]);

  // Fetch metadata + memory from API
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/categories/${encodeURIComponent(category)}/projects`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const proj = data.projects?.find((p: { name: string }) => p.name === project);
        if (proj) {
          setMetadata(proj.metadata ?? {});
          setMemorySummary(proj.memorySummary ?? null);
        }
      })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [category, project]);

  const startEdit = useCallback((field: string, currentValue: string) => {
    setEditingField(field);
    setEditValue(currentValue);
  }, []);

  const saveEdit = useCallback(async (field: string) => {
    setEditingField(null);
    const newValue = editValue.trim();
    const oldValue = (metadata as Record<string, string>)[field] ?? '';
    if (newValue === oldValue) return;

    // Optimistic update
    setMetadata((prev) => ({ ...prev, [field]: newValue || undefined }));
    try {
      await fetch(`/api/categories/${encodeURIComponent(category)}/projects/${encodeURIComponent(project)}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: newValue || undefined }),
      });
    } catch {
      // Revert on failure
      setMetadata((prev) => ({ ...prev, [field]: oldValue || undefined }));
    }
  }, [editValue, metadata, category, project]);

  return (
    <div className="todo-detail-pane project-detail-pane" style={style}>
      <div className="todo-detail-header">
        <span className="todo-detail-category">{category} / {project}</span>
        <span className={`detail-source-badge source-${source}`}>{source}</span>
        <button className="todo-detail-close" onClick={onClose} title="Close">&times;</button>
      </div>

      {/* Settings section */}
      <div className="detail-section">
        <div className="detail-section-title">Settings</div>

        <div className="detail-setting-row">
          <span className="detail-setting-label">Working Dir</span>
          {editingField === 'default_cwd' ? (
            <input
              className="detail-setting-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => saveEdit('default_cwd')}
              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit('default_cwd'); if (e.key === 'Escape') setEditingField(null); }}
              autoFocus
            />
          ) : (
            <span
              className="detail-setting-value"
              onClick={() => startEdit('default_cwd', metadata.default_cwd ?? '')}
              title="Click to edit"
            >
              {metadata.default_cwd || <span className="text-muted">not set</span>}
            </span>
          )}
        </div>

        <div className="detail-setting-row">
          <span className="detail-setting-label">Host</span>
          {editingField === 'default_host' ? (
            <input
              className="detail-setting-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => saveEdit('default_host')}
              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit('default_host'); if (e.key === 'Escape') setEditingField(null); }}
              autoFocus
            />
          ) : (
            <span
              className="detail-setting-value"
              onClick={() => startEdit('default_host', metadata.default_host ?? '')}
              title="Click to edit"
            >
              {metadata.default_host || <span className="text-muted">local</span>}
            </span>
          )}
        </div>
      </div>

      {/* Task statistics */}
      <div className="detail-section">
        <div className="detail-section-title">Tasks</div>
        <div className="detail-stat-grid">
          <div className="detail-stat-item">
            <span className="detail-stat-number">{counts.todo}</span>
            <span className="detail-stat-label">Todo</span>
          </div>
          <div className="detail-stat-item">
            <span className="detail-stat-number">{counts.active}</span>
            <span className="detail-stat-label">Active</span>
          </div>
          <div className="detail-stat-item">
            <span className="detail-stat-number">{counts.done}</span>
            <span className="detail-stat-label">Done</span>
          </div>
        </div>
      </div>

      {/* Memory summary */}
      {memorySummary && (
        <div className="detail-section">
          <div className="detail-section-title">Memory</div>
          <p className="detail-memory-text">{memorySummary}</p>
        </div>
      )}
    </div>
  );
}
