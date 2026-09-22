/**
 * Inline detail pane for ONE project registry row (`task_projects`).
 *
 * Project is the single grouping layer, so this is the only detail pane — Inbox is
 * the ABSENCE of a project (no registry row), which is why TodoPanel never opens
 * this for `project === ''`.
 *
 * Counts render immediately from the already-loaded `tasks` prop; the registry row
 * (source / settings / AI summary / memory) arrives from GET /api/projects/:name/metadata.
 *
 * NAME / CLAIM / Working Dir / Host come from the shared project registry store
 * whenever it has the row, so an edit here reaches every other surface in the same
 * frame (the draft column's folder pill, `projectForDir`, the pickers) and a rename
 * from the group header kebab retitles this pane instead of stranding it on a name
 * that no longer exists. `project` is the name the HOST captured when it opened the
 * pane; the store resolves it forward through any rename since.
 */

import { useState, useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import type { Task } from '@open-walnut/core';
import { useIntegrations, getIntegrationMeta } from '../../hooks/useIntegrations';
import { useConfirm } from '@/hooks/useConfirm';
import { useProjectEntry, patchProjectLocal, removeProjectLocal } from '@/hooks/useProjectRegistry';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import {
  fetchProjectDetail,
  saveProjectMetadata,
  regenerateProjectSummary,
  deleteProject,
  type ProjectMetadata,
} from '@/api/projects';
import { ProjectTrackingBlock } from './ProjectTrackingBlock';

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
  // both (a task's `source` can lag a claim change). The shared store wins when it
  // has the row; these two are the pre-load / unregistered fallback.
  const [detailSource, setDetailSource] = useState('local');
  const [detailName, setDetailName] = useState(project);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirm = useConfirm();
  const tasksStore = useTasksContextSafe();
  const { name: entryName, row } = useProjectEntry(project);

  const displayName = row?.name ?? detailName;
  const source = row?.source ?? detailSource;

  /** Current value of an editable setting — the store's row when it has one. */
  const settingValue = useCallback((field: string): string => {
    if (row && field === 'default_cwd') return row.defaultCwd ?? '';
    if (row && field === 'default_host') return row.defaultHost ?? '';
    return (metadata as Record<string, string>)[field] ?? '';
  }, [row, metadata]);

  const refreshSummary = useCallback(async () => {
    setSummaryRefreshing(true);
    try {
      const data = await regenerateProjectSummary(entryName);
      setMetadata((prev) => ({
        ...prev,
        summary: data.summary ?? undefined,
        summary_task_count: data.summary_task_count ?? undefined,
      }));
    } catch { /* keep the old summary */ } finally {
      setSummaryRefreshing(false);
    }
  }, [entryName]);

  // Counts from the loaded task list. Project identity is case-insensitive server-side,
  // so compare that way here too or a differently-cased task would go uncounted.
  const counts = useMemo(() => {
    const key = entryName.toLowerCase();
    const result = { todo: 0, active: 0, done: 0, total: 0 };
    for (const t of tasks) {
      if ((t.project ?? '').toLowerCase() !== key) continue;
      if (t.phase === 'TODO') result.todo++;
      else if (t.phase === 'COMPLETE') result.done++;
      else result.active++;
      result.total++;
    }
    return result;
  }, [tasks, entryName]);

  // Keyed on the RESOLVED name: a rename while the pane is open re-fetches the
  // summary/memory under the new name instead of 404-ing on the old one.
  useEffect(() => {
    let cancelled = false;
    setDetailName(entryName);
    fetchProjectDetail(entryName)
      .then((detail) => {
        if (cancelled) return;
        setMetadata(detail.metadata ?? {});
        setMemorySummary(detail.memorySummary ?? null);
        setDetailSource(detail.source ?? 'local');
        if (detail.name) setDetailName(detail.name);
      })
      .catch(() => { /* non-critical — counts above still render */ });
    return () => { cancelled = true; };
  }, [entryName]);

  const startEdit = useCallback((field: string, currentValue: string) => {
    setEditingField(field);
    setEditValue(currentValue);
  }, []);

  // Delete the project. Local claim = row drop, tasks → Inbox (reversible-ish:
  // the data survives). Provider claim = the ?remote=1 CASCADE — the plugin
  // deletes the remote container itself (MS To-Do: the list), which is
  // IRREVERSIBLE, so the confirm copy spells out the provider-specific effect.
  const handleDelete = useCallback(async () => {
    const isClaimed = source !== 'local';
    const ok = await confirm({
      title: `Delete project “${displayName}”?`,
      message: isClaimed
        ? `This project is synced with ${source}. Deleting it ALSO DELETES the remote container (e.g. the MS To-Do list) — this cannot be undone. Local tasks are kept and move to the Inbox.`
        : `Its ${counts.total} task${counts.total === 1 ? '' : 's'} move to the Inbox (nothing is deleted).`,
      confirmLabel: isClaimed ? 'Delete here + remote' : 'Delete project',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteError(null);
    // Drop the row from the shared registry now — the pickers and badges on the
    // other surfaces must not keep offering a project that is being deleted.
    const settleRegistry = removeProjectLocal(displayName);
    // Only a LOCAL claim has a knowable destination (Inbox); a cascade can land
    // its tasks in the plugin's fallback project instead, so let the refetch say.
    const moved = !isClaimed && tasksStore
      ? tasksStore.tasks.filter((t) => (t.project ?? '').toLowerCase() === entryName.toLowerCase())
      : [];
    if (moved.length > 0) {
      tasksStore?.patchTasksLocal(Object.fromEntries(moved.map((t) => [t.id, { project: '' }])));
    }
    try {
      await deleteProject(displayName, isClaimed ? { remote: true } : undefined);
      settleRegistry(true);
      onClose(); // row is gone — the task list refreshes via the task:updated broadcast
    } catch (err) {
      settleRegistry(false);
      // Each row goes back to ITS OWN spelling (project identity is case-insensitive,
      // so two tasks in one project can legitimately differ in case).
      if (moved.length > 0) {
        tasksStore?.patchTasksLocal(Object.fromEntries(moved.map((t) => [t.id, { project: t.project }])));
      }
      // Surface inline: 409 = plugin lacks the cascade hook; 502 = the remote
      // call failed (auth expired…) with local state untouched — retryable.
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [confirm, displayName, entryName, source, counts.total, onClose, tasksStore]);

  const saveEdit = useCallback(async (field: string) => {
    setEditingField(null);
    const newValue = editValue.trim();
    const oldValue = settingValue(field);
    if (newValue === oldValue) return;

    // Optimistic — locally AND in the shared registry store, because the folder a
    // project runs in is read by surfaces that never see this pane (the draft
    // column's folder pill, projectForDir). Waiting for the PUT left them on the
    // old path until a reload.
    setMetadata((prev) => ({ ...prev, [field]: newValue || undefined }));
    const patch = field === 'default_cwd' ? { defaultCwd: newValue || null }
      : field === 'default_host' ? { defaultHost: newValue || null }
        : null;
    const settleRegistry = patch ? patchProjectLocal(entryName, patch) : null;
    try {
      // Clearing sends null, NOT undefined: JSON.stringify DROPS undefined
      // properties, so the PUT body would be `{}` and the merge a no-op — the
      // old value came straight back and the field appeared to revert itself.
      const merged = await saveProjectMetadata(entryName, { [field]: newValue || null });
      setMetadata(merged);
      settleRegistry?.(true);
    } catch {
      // Revert on failure
      setMetadata((prev) => ({ ...prev, [field]: oldValue || undefined }));
      settleRegistry?.(false);
    }
  }, [editValue, settingValue, entryName]);

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
              onClick={() => startEdit('default_cwd', settingValue('default_cwd'))}
              title="Click to edit"
            >
              {settingValue('default_cwd') || <span className="text-muted">not set</span>}
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
              onClick={() => startEdit('default_host', settingValue('default_host'))}
              title="Click to edit"
            >
              {settingValue('default_host') || <span className="text-muted">local</span>}
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

      {/* Tracking note — the project's living status note in the vault. Absent
          entirely until something sets metadata.tracking_note. */}
      <ProjectTrackingBlock notePath={metadata.tracking_note} />

      {/* Memory summary — memory/projects/<project>/MEMORY.md header */}
      {memorySummary && (
        <div className="detail-section">
          <div className="detail-section-title">Memory</div>
          <p className="detail-memory-text">{memorySummary}</p>
        </div>
      )}

      {/* Delete — tasks always survive (they move to Inbox / the provider's
          fallback); what's destroyed is the grouping row and, for a synced
          project, the REMOTE container. */}
      <div className="detail-section project-danger-section">
        <button
          className="project-delete-btn"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? 'Deleting…' : 'Delete Project'}
        </button>
        {source !== 'local' && (
          <p className="project-delete-hint">
            Synced with {source} — also removes the remote container. Tasks move to the Inbox.
          </p>
        )}
        {deleteError && <p className="project-delete-error">{deleteError}</p>}
      </div>
    </div>
  );
}
