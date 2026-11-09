/**
 * The grey "Fallback" tag of a task row whose task started on the fallback engine (Task.engine_fallback,
 * core/agents/fallback-engine.ts), with the session banner's words on hover. Drawn wherever a row
 * draws the usage-limit pill (limit-row.tsx): the Flat view's status rows, the By project / In one
 * list rows and the Focus cards, so the two read alike in every Home view (2026-11-09 review: By
 * project, the default, drew none). The note goes when the task is switched back or closed.
 */
import type { Task } from '@open-walnut/core';
import { fallbackBannerWords, fallbackEngineName, fallbackModelName } from '@open-walnut/user-status';
import { useEngineDefaultModel, withDefaultModel } from '../sessions/engine-default-model';
import '@/styles/engine-fallback.css';

/** The engine banner's mark (EngineFallbackBanner.tsx), for a row too narrow for the word. */
const MARK = <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 5.5h9.5M9.5 3l2.5 2.5L9.5 8M13.5 10.5H4M6.5 8L4 10.5 6.5 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** "Codex", or the model for a fallback on the same engine ("Sol"). */
function runsOn(note: NonNullable<Task['engine_fallback']>): string {
  return note.to === note.from ? fallbackModelName(note) ?? fallbackEngineName(note.to) : fallbackEngineName(note.to);
}

/** `compact`: the mark alone, after the title (the narrow Pinned strip, where the word cut the title short). */
export function TaskFallbackTag({ task, compact }: { task: Task; compact?: boolean }) {
  const note = task.engine_fallback && task.status !== 'done' && task.phase !== 'COMPLETE' ? task.engine_fallback : null;
  // Read only for a row that wears the tag (the catalog is cached across the app).
  const defaultModel = useEngineDefaultModel(note && !note.model ? note.to : undefined);
  if (!note) return null;
  const words = fallbackBannerWords(withDefaultModel(note, defaultModel), Date.now());
  return (
    // The meta line's dot goes on the outer span, outside the tag's fill.
    <span className="status-card-fallback" data-testid="task-row-fallback" title={`${words.head} · ${words.why}`}>
      {compact
        ? <span className="status-card-fallback-mark" role="img" aria-label="Fallback">{MARK}</span>
        : <>
          <span className="status-card-fallback-tag">Fallback</span>
          {/* Where it runs, as the Limited pill says its reset: readable without the hover. */}
          <span className="status-card-fallback-words">on {runsOn(note)}</span>
        </>}
    </span>
  );
}
