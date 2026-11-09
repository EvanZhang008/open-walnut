/**
 * The task started on the fallback engine because the default engine was out of usage
 * (server: src/core/agents/fallback-engine.ts, Task.engine_fallback). Shown above the composer of
 * the task's session while it runs on that engine:
 *
 *   [Fallback] Started on Codex (gpt-5.5) · The Claude 5-hour limit was reached · resets 3:00 PM
 *              Claude Code, your default engine, was out of usage, so ... it waits for the reset.
 *              [Switch to Claude Code]                                                        [×]
 *
 * Switch to Claude Code is the engine switch the model picker does (core/sessions/engine-switch.ts):
 * the task's new session carries the conversation, and if the limit still holds there it waits for
 * the reset and continues by itself (the usage-limit wait). The × takes the note off.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EngineFallbackNote } from '@open-walnut/core';
import { fallbackBannerWords } from '@open-walnut/user-status';
import { switchTaskEngine, SwitchSuperseded } from '@/api/engine-switch';
import { dismissEngineFallback } from '@/api/engine-fallback';
import { setSessionModel } from '@/api/sessions';
import { log } from '@/utils/log';
import { useEngineDefaultModel, withDefaultModel } from './engine-default-model';
import { acpModelDisplayName } from './acp-model-id';
import '@/styles/engine-fallback.css';

/** The switched task's first message on the default engine. */
export const SWITCH_BACK_TEXT = 'Continue the task from where you stopped.';

/** Is the banner for this session: the task's note, and the session runs on the note's engine. */
export function showsEngineFallback(note: EngineFallbackNote | null | undefined, sessionEngine: string | undefined, archived?: boolean): boolean {
  if (!note || archived) return false;
  return (sessionEngine || 'claude') === note.to;
}

export function EngineFallbackBanner({ taskId, sessionId, note, runsOn, onGone }: {
  taskId: string;
  /** The session the banner sits on: a same-engine fallback switches its model back. */
  sessionId: string;
  note: EngineFallbackNote;
  /** The model the session runs, as its record names it (acpModel, acpModelName). */
  runsOn?: { id?: string; name?: string };
  /** The note was taken off here (dismissed), before the task's own update arrives. */
  onGone?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<'switch' | 'dismiss' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The reset passes while it is open: the words turn to "has reset" on their own.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => { setFailure(null); setBusy(null); }, [note.at]);

  const sameEngine = note.from === note.to;
  const switchBack = useCallback(async () => {
    setBusy('switch');
    setFailure(null);
    try {
      if (sameEngine) {
        // Another model of the same engine: its next turns go back to the default model.
        await setSessionModel(sessionId, 'default');
        await dismissEngineFallback(taskId);
        log.info('session-panel', 'fallback engine: back on the default model', { taskId, sessionId });
        onGone?.();
        return;
      }
      // With a continue, so the moved task goes on: at once, or once the limit resets (the usage-limit
      // wait holds a turn the limit stops and continues it then).
      const out = await switchTaskEngine(taskId, { engine: note.from, text: SWITCH_BACK_TEXT });
      log.info('session-panel', 'fallback engine: switch back asked', { taskId, engine: note.from, state: out.state });
      // The panel follows the task to its new session (EngineSwitch.tsx) and the note goes with the
      // switch; a switch that waits for the running turn shows its own line in the composer.
      setBusy(null);
    } catch (err) {
      if (err instanceof SwitchSuperseded) { setBusy(null); return; }
      const body = (err as { body?: { error?: unknown } } | null)?.body;
      const message = body && typeof body.error === 'string' ? body.error : err instanceof Error ? err.message : String(err);
      log.warn('session-panel', 'fallback engine: switch back failed', { taskId, engine: note.from, error: message });
      setFailure(message);
      setBusy(null);
    }
  }, [taskId, sessionId, note.from, sameEngine, onGone]);

  const dismiss = useCallback(async () => {
    setBusy('dismiss');
    setFailure(null);
    try {
      await dismissEngineFallback(taskId);
      onGone?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('session-panel', 'fallback engine: dismiss failed', { taskId, error: message });
      setFailure(`Couldn't close it: ${message}`);
      setBusy(null);
    }
  }, [taskId, onGone]);

  // A setting that names no model runs the engine's default: the session's own model when its record
  // names it (the composer's words under this banner), else the engine's default read from its list.
  const own = !note.model && runsOn?.id ? { id: runsOn.id, name: acpModelDisplayName(runsOn.id, runsOn.name) ?? runsOn.id } : undefined;
  const defaultModel = useEngineDefaultModel(note.model || own ? undefined : note.to);
  const words = fallbackBannerWords(withDefaultModel(note, own ?? defaultModel), now);
  return (
    // session-error-banner: placement under the glass header; engine-fallback.css: its own look.
    <div className="session-error-banner engine-fallback-banner" data-testid="engine-fallback-banner" role="status">
      <span className="engine-fallback-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.5 5.5h9.5M9.5 3l2.5 2.5L9.5 8M13.5 10.5H4M6.5 8L4 10.5 6.5 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="engine-fallback-body">
        <div className="engine-fallback-head">
          <span className="engine-fallback-tag">Fallback</span> <span data-testid="engine-fallback-head">{words.head}</span>
          <span className="engine-fallback-sep" aria-hidden="true"> · </span><span className="engine-fallback-why" data-testid="engine-fallback-why">{words.why}</span>
        </div>
        <div className="engine-fallback-detail" data-testid="engine-fallback-detail">{words.detail}</div>
        {failure && <div className="engine-fallback-failure" role="alert">{failure}</div>}
      </div>
      <button type="button" className="engine-fallback-close" onClick={() => void dismiss()} disabled={busy !== null}
        aria-label="Close" title="Close: the task stays on this engine" data-testid="engine-fallback-dismiss">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {(!sameEngine || note.from === 'claude') && <div className="engine-fallback-actions">
        <button type="button" className="engine-fallback-btn" onClick={() => void switchBack()} disabled={busy !== null} data-testid="engine-fallback-switch">
          {busy === 'switch' ? 'Switching…' : words.action}
        </button>
      </div>}
    </div>
  );
}
