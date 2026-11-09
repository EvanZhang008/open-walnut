/**
 * A new task's draft, while the default engine is out of usage on the draft's host and a fallback
 * engine is set (core/agents/fallback-engine.ts): one line right above the composer says where
 * this task will start, and the model pill reads "Codex (fallback)" instead of "Auto".
 *
 *   The Claude 5-hour limit is reached here (resets 3:00 PM): this task starts on Codex.
 *   The Claude 5-hour limit is reached here (resets 3:00 PM): on Sonnet this task waits for the
 *     reset.  [Start on Codex instead]
 *   The Claude 5-hour limit is reached here (resets 3:00 PM), and it covers Sonnet too: this task
 *     waits for the reset.
 *
 * Only a launch that names no engine falls back (the server's rule). One that names a model of the
 * default engine (picked here, or the folder's last launch) waits, and the line says so with the
 * way to the fallback. Read when the draft opens or changes host, and again every minute while it
 * is open (a reset passes).
 */
import { useEffect, useState } from 'react';
import { fallbackEngineName, fallbackModelName, limitName, limitTimeWords } from '@open-walnut/user-status';
import { fetchEngineFallbackNow, type EngineFallbackNow } from '@/api/engine-fallback';
import { useEngineDefaultModel, withDefaultModel } from './engine-default-model';

const REFRESH_MS = 60_000;

/** The line in parts: `strong` is what runs (or waits), `action` the button's words. */
export interface DraftFallbackLine {
  before: string;
  strong?: string;
  after?: string;
  /** The launch waits for the reset (the line is a warning, not news). */
  waits: boolean;
  /** "Start on Codex instead": drops the draft's model so the launch falls back. */
  action?: string;
}

/** Where the fallback runs: "Codex (Mock GPT Best)", or the model alone on the same engine. */
function fallbackRunsOn(fb: NonNullable<EngineFallbackNow['fallback']>): string {
  const model = fallbackModelName(fb.note);
  if (fb.engine === fb.note.from && model) return model;
  return `${fallbackEngineName(fb.engine)}${model ? ` (${model})` : ''}`;
}

/**
 * The line, or null when the draft starts on the default engine with nothing to say. `named` is
 * the default engine's model the draft names (its label), or null when it names none.
 */
export function draftFallbackLine(now: EngineFallbackNow | null, nowMs: number, named?: string | null): DraftFallbackLine | null {
  if (!now) return null;
  const fb = now.fallback;
  const from = fb?.note.from ?? now.defaultEngine;
  const limit = fb ? { window: fb.note.window, resetsAt: fb.note.resets_at } : now.limit;
  if (!from || !limit || !now.setting) return null;
  const when = limitTimeWords(limit.resetsAt, nowMs);
  const head = `The ${limitName({ engine: from, window: limit.window })} is reached here${when ? ` (resets ${when})` : ''}`;
  if (named) {
    // The fallback is blocked too: still say it waits, with nothing to offer.
    if (!fb) return now.skip ? { before: `${head}: on `, strong: named, after: ' this task waits for the reset.', waits: true } : null;
    return { before: `${head}: on `, strong: named, after: ' this task waits for the reset.', waits: true, action: `Start on ${fallbackRunsOn(fb)} instead` };
  }
  if (fb) return { before: `${head}: this task starts on `, strong: fallbackRunsOn(fb), after: '.', waits: false };
  const engine = fallbackEngineName(now.setting.engine);
  switch (now.skip) {
    case 'shares_limit': return { before: `${head}, and it covers ${fallbackModelName(now.setting) ?? 'that model'} too: this task waits for the reset.`, waits: true };
    case 'limited_too': return { before: `${head}, and ${engine} is out of usage too: this task waits for the reset.`, waits: true };
    case 'not_runnable': return { before: `${head}, and ${engine} is not installed here: this task waits for the reset.`, waits: true };
    // Another Claude model helps only under one model's weekly limit (Settings' Model help says so):
    // under one that covers them all, picking a Claude model would not help.
    case 'needs_model': return now.setting.engine === 'claude' && !/^seven_day_(opus|sonnet)$/.test(now.limit?.window ?? '')
      ? { before: `${head}, and it covers every Claude model: this task waits for the reset (another engine, or a model of another provider, can take it: Settings > Sessions).`, waits: true }
      : { before: `${head}: this task waits for the reset (the fallback needs a model, Settings > Sessions).`, waits: true };
    default: return null;
  }
}

/** The line's words as one string (tests, titles). */
export function draftFallbackWords(now: EngineFallbackNow | null, nowMs: number, named?: string | null): string | null {
  const line = draftFallbackLine(now, nowMs, named);
  return line ? `${line.before}${line.strong ?? ''}${line.after ?? ''}` : null;
}

/** The model pill's words while the draft would start on the fallback: "Codex (fallback)". */
export function draftFallbackPill(now: EngineFallbackNow | null): string | null {
  const fb = now?.fallback;
  if (!fb) return null;
  const model = fallbackModelName(fb.note);
  return `${fb.engine === fb.note.from && model ? model : fallbackEngineName(fb.engine)} (fallback)`;
}

/** The server's answer for the draft's host while it applies, read again every minute. */
export function useDraftFallback(host: string | null | undefined, applies: boolean): EngineFallbackNow | null {
  const [now, setNow] = useState<EngineFallbackNow | null>(null);
  useEffect(() => {
    if (!applies) { setNow(null); return; }
    let live = true;
    const read = () => fetchEngineFallbackNow(host).then((n) => { if (live) setNow(n); }, () => {});
    void read();
    const id = window.setInterval(() => { void read(); }, REFRESH_MS);
    return () => { live = false; window.clearInterval(id); };
  }, [host, applies]);
  return applies ? now : null;
}

export function DraftFallbackNotice({ now, named, onUseFallback }: {
  now: EngineFallbackNow | null;
  named?: string | null;
  /** The action: the draft's model goes, so the launch names none and falls back. */
  onUseFallback?: () => void;
}) {
  // A setting that names no model runs the engine's default: named as the model picker names it.
  const defaultModel = useEngineDefaultModel(now?.fallback && !now.fallback.note.model ? now.fallback.engine : undefined);
  const shown = now?.fallback ? { ...now, fallback: { ...now.fallback, note: withDefaultModel(now.fallback.note, defaultModel) } } : now;
  const line = draftFallbackLine(shown, Date.now(), named);
  if (!line) return null;
  return (
    <div className={`draft-fallback-notice${line.waits ? ' is-wait' : ''}`} role="status" data-testid="draft-fallback-notice">
      <span>{line.before}{line.strong && <strong>{line.strong}</strong>}{line.after}</span>
      {line.action && onUseFallback && (
        <button type="button" className="draft-fallback-use" data-testid="draft-fallback-use" onClick={onUseFallback}>{line.action}</button>
      )}
    </div>
  );
}
