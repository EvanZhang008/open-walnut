/**
 * The grey "Fallback" tag of a task row whose task started on the fallback engine (Task.engine_fallback,
 * core/agents/fallback-engine.ts), with the session banner's words on hover. Drawn wherever a row
 * draws the usage-limit pill (limit-row.tsx): the Flat view's status rows, the By project / In one
 * list rows and the Focus cards, so the two read alike in every Home view (2026-11-09 review: By
 * project, the default, drew none). The note goes when the task is switched back or closed.
 */
import type { Task } from '@open-walnut/core';
import { fallbackBannerWords } from '@open-walnut/user-status';
import { useEngineDefaultModel, withDefaultModel } from '../sessions/engine-default-model';
import '@/styles/engine-fallback.css';

export function TaskFallbackTag({ task }: { task: Task }) {
  const note = task.engine_fallback && task.status !== 'done' && task.phase !== 'COMPLETE' ? task.engine_fallback : null;
  // Read only for a row that wears the tag (the catalog is cached across the app).
  const defaultModel = useEngineDefaultModel(note && !note.model ? note.to : undefined);
  if (!note) return null;
  const words = fallbackBannerWords(withDefaultModel(note, defaultModel), Date.now());
  return (
    // The meta line's dot goes on the outer span, outside the tag's fill.
    <span className="status-card-fallback" data-testid="task-row-fallback" title={`${words.head} · ${words.why}`}>
      <span className="status-card-fallback-tag">Fallback</span>
    </span>
  );
}
