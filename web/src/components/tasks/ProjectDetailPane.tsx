/**
 * Inline detail pane for ONE project registry row (`task_projects`).
 *
 * Project is the single grouping layer, so this is the only detail pane — Inbox is
 * the ABSENCE of a project (no registry row), which is why TodoPanel never opens
 * this for `project === ''`.
 *
 * Counts render immediately from the already-loaded `tasks` prop; the registry row
 * (source / settings / AI summary / memory) arrives from GET /api/projects/:name/metadata.
 */

import { useState, useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import type { Task } from '@open-walnut/core';
import { useIntegrations, getIntegrationMeta } from '../../hooks/useIntegrations';
import {
  fetchProjectDetail,
  saveProjectMetadata,
  regenerateProjectSummary,
  type ProjectMetadata,
} from '@/api/projects';

interface ProjectDetailPaneProps {
  /** Never '' — Inbox has no registry row. */
  project: string;
  tasks: Task[];
  onClose: () => void;
  style?: CSSProperties;
}

export function ProjectDetailPane({ project, tasks, onClose, style }: ProjectDetailPaneProps) {
  const integrations = useIntegrations();
  const [metadata, setMetadata] = useState<ProjectMetadata>({});
  const [memorySummary, setMemorySummary] = useState<string | null>(null);
  // Canonical spelling + claim come from the registry, which is the authority on
  // both (a task's `source` can lag a claim change).
  const [source, setSource] = useState('local');
  const [displayName, setDisplayName] = useState(project);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);

  const refreshSummary = useCallback(async () => {
    setSummaryRefreshing(true);
    try {
      const data = await regenerateProjectSummary(project);
      setMetadata((prev) => ({
        ...prev,
        summary: data.summary ?? undefined,
        summary_task_count: data.summary_task_count ?? undefined,
      }));
    } catch { /* keep the old summary */ } finally {
      setSummaryRefreshing(false);
    }
  }, [project]);

  // Counts from the loaded task list. Project identity is case-insensitive server-side,
  // so compare that way here too or a differently-cased task would go uncounted.
  const counts = useMemo(() => {
    const key = project.toLowerCase();
    const result = { todo: 0, active: 0, done: 0, total: 0 };
    for (const t of tasks) {
      if ((t.project ?? '').toLowerCase() !== key) continue;
      if (t.phase === 'TODO') result.todo++;
      else if (t.phase === 'COMPLETE') result.done++;
      else result.active++;
      result.total++;
    }
    return result;
  }, [tasks, project]);

  useEffect(() => {
    let cancelled = false;
    setDisplayName(project);
    fetchProjectDetail(project)
      .then((detail) => {
        if (cancelled) return;
        setMetadata(detail.metadata ?? {});
        setMemorySummary(detail.memorySummary ?? null);
        setSource(detail.source ?? 'local');
        if (detail.name) setDisplayName(detail.name);
      })
      .catch(() => { /* non-critical — counts above still render */ });
    return () => { cancelled = true; };
  }, [project]);

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
      // Clearing sends null, NOT undefined: JSON.stringify DROPS undefined
      // properties, so the PUT body would be `{}` and the merge a no-op — the
      // old value came straight back and the field appeared to revert itself.
      const merged = await saveProjectMetadata(project, { [field]: newValue || null });
      setMetadata(merged);
    } catch {
      // Revert on failure
      setMetadata((prev) => ({ ...prev, [field]: oldValue || undefined }));
    }
  }, [editValue, metadata, project]);

  return (
    <div className="todo-detail-pane project-detail-pane" style={style}>
      <div className="todo-detail-header">
        <span className="todo-detail-project">{displayName}</span>
        {(() => {
          const meta = getIntegrationMeta(integrations, source);
          return meta ? (
            <span className="detail-source-badge" style={{ background: `color-mix(in srgb, ${meta.badgeColor} 15%, transparent)`, color: meta.badgeColor }}>{meta.name}</span>
          ) : (
            <span className={`detail-source-badge source-${source}`}>{source}</span>
          );
        })()}
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
              onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') saveEdit('default_cwd'); if (e.key === 'Escape') setEditingField(null); }}
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
              onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') saveEdit('default_host'); if (e.key === 'Escape') setEditingField(null); }}
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

        {/* MS To-Do alias: a migrated project keeps pushing to its old remote list. */}
        {metadata.remote_list && metadata.remote_list !== displayName && (
          <div className="detail-setting-row">
            <span className="detail-setting-label">Remote List</span>
            <span className="detail-setting-value text-muted">{metadata.remote_list}</span>
          </div>
        )}
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

      {/* AI project summary (project-summary.ts, refreshed at task-count thresholds) */}
      <div className="detail-section">
        <div className="detail-section-title">
          About
          <button
            className="detail-summary-refresh"
            onClick={refreshSummary}
            disabled={summaryRefreshing}
            title="Regenerate the AI summary from the current task list"
          >
            {summaryRefreshing ? '…' : '↻'}
          </button>
        </div>
        {metadata.summary
          ? <p className="detail-memory-text">{metadata.summary}</p>
          : <p className="detail-memory-text text-muted">No summary yet — generated automatically as tasks accumulate, or click ↻.</p>}
      </div>

      {/* Memory summary — memory/projects/<project>/MEMORY.md header */}
      {memorySummary && (
        <div className="detail-section">
          <div className="detail-section-title">Memory</div>
          <p className="detail-memory-text">{memorySummary}</p>
        </div>
      )}
    </div>
  );
}
