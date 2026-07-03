import { useState, useCallback } from 'react';
import { useRoutines, useExecutors } from '@/hooks/useRoutines';
import { RoutineComposer } from './RoutineComposer';
import { RoutineForm } from './RoutineForm';
import { RoutineCard } from './RoutineCard';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { Routine, CreateRoutineInput } from '@/api/routines';

/**
 * Shared Routines surface — NL composer on top, drafted/manual form, then the
 * routine list. Used by both the homepage side panel (primary) and the
 * /routines page (secondary).
 */
export function RoutinesView({ compact = false }: { compact?: boolean }) {
  const { routines, loading, error, create, update, toggle, remove, runNow } = useRoutines(true);
  const { executors, options } = useExecutors();
  const [draft, setDraft] = useState<CreateRoutineInput | undefined>(undefined);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Routine | undefined>(undefined);

  const executorLabels = Object.fromEntries(executors.map((e) => [e.type, e.label]));

  const handleDraft = useCallback((d: CreateRoutineInput) => {
    setDraft(d);
    setEditing(undefined);
    setShowForm(true);
  }, []);

  const handleDraftFailed = useCallback(() => {
    setDraft(undefined);
    setEditing(undefined);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(async (input: CreateRoutineInput) => {
    if (editing) {
      await update(editing.id, input);
    } else {
      await create(input);
    }
    setShowForm(false);
    setDraft(undefined);
    setEditing(undefined);
  }, [editing, create, update]);

  const handleEdit = useCallback((routine: Routine) => {
    setEditing(routine);
    setDraft(undefined);
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setDraft(undefined);
    setEditing(undefined);
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className={`routines-view${compact ? ' routines-view-compact' : ''}`}>
      {!showForm && (
        <RoutineComposer onDraft={handleDraft} onDraftFailed={handleDraftFailed} />
      )}

      {showForm && (
        <RoutineForm
          draft={draft}
          routine={editing}
          executors={executors}
          options={options}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}

      {error && <div className="cron-form-error">{error}</div>}

      {routines.length === 0 && !showForm ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#9889;</div>
          <p>No routines yet</p>
          <p className="text-sm mt-2">Describe what you want automated above</p>
        </div>
      ) : (
        <div className="cron-job-list routine-list">
          {routines.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              executorLabels={executorLabels}
              onToggle={toggle}
              onRunNow={runNow}
              onEdit={handleEdit}
              onDelete={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
