import React from 'react';
import {
  SESSION_MODELS,
  SESSION_EFFORTS,
  DEFAULT_SESSION_EFFORT,
  modelSupportsEffort,
  modelSupportsXhighEffort,
  modelSupportsMaxEffort,
} from '@open-walnut/core';
import type { SessionEffort } from '@open-walnut/core';
import { fetchSessionLiveSettings } from '@/api/sessions';
import type { SessionLiveSettings } from '@/api/sessions';

// Picker options derived from the single source of truth (core/types.ts).
const MODELS = SESSION_MODELS;
const EFFORTS = SESSION_EFFORTS;

/** Normalize a raw model string (e.g. init event model) to our picker IDs */
function normalizeModelId(raw?: string | null): string {
  if (!raw) return 'opus';
  const lower = raw.toLowerCase();
  const is1m = lower.includes('[1m]');
  if (lower.includes('haiku')) return 'haiku';  // haiku has no 1M variant
  if (lower.includes('sonnet')) return is1m ? 'sonnet-1m' : 'sonnet';
  if (lower.includes('fable')) return is1m ? 'fable-1m' : 'fable';
  return is1m ? 'opus-1m' : 'opus';
}

/** Short display form of a full runtime model ID (e.g. "us.anthropic.claude-sonnet-4-6[1m]" → "sonnet-4-6 1M"). */
function shortModelLabel(raw?: string | null): string {
  if (!raw) return '—';
  const is1m = raw.includes('[1m]');
  const short = raw.replace(/^.*\.claude-/, '').replace(/[-_]v\d+.*$/, '').replace(/\[1m\]/g, '');
  return `${short}${is1m ? ' 1M' : ''}`;
}

/** Compact token counts for the live-details rows: 111177 → "111.2K", 1000000 → "1M". */
function fmtTokens(n?: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

interface ModelPickerProps {
  currentModel?: string;
  /** Active reasoning-effort for the session (undefined = API default = 'high'). */
  currentEffort?: SessionEffort;
  /** Session to pull LIVE settings from (get_settings) when the picker opens.
   *  Omitted (e.g. in tests) → no pull, record props are all we show. */
  sessionId?: string;
  /** Switch model — applied live via apply_flag_settings (no respawn); the NEXT
   *  turn uses the new model. No Now/Next-turn split needed anymore. */
  onSwitch: (model: string) => void;
  /** Switch reasoning effort (same live apply_flag_settings mechanism). */
  onEffortSwitch: (effort: SessionEffort) => void;
  onClose: () => void;
}

export function ModelPicker({ currentModel, currentEffort, sessionId, onSwitch, onEffortSwitch, onClose }: ModelPickerProps) {
  // ── LIVE pull: the moment the picker opens, ask the CLI what it's ACTUALLY
  // using (get_settings → applied). Until it answers (or when the session isn't
  // live), fall back to the record props — but never present those as CLI truth.
  const [liveSettings, setLiveSettings] = React.useState<SessionLiveSettings | null>(null);
  const [pulling, setPulling] = React.useState(false);
  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setPulling(true);
    fetchSessionLiveSettings(sessionId)
      .then((s) => { if (!cancelled) setLiveSettings(s); })
      .catch(() => { /* pull failed → keep record fallback, no claim of truth */ })
      .finally(() => { if (!cancelled) setPulling(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // ── Live details: collapsed by default; expanding lazily pulls the heavier
  // reads (get_context_usage tokenizes the CLI's whole tool surface — too heavy
  // to fire on every picker open). Result is kept until the picker closes.
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [details, setDetails] = React.useState<SessionLiveSettings['details'] | null>(null);
  const [detailsPulling, setDetailsPulling] = React.useState(false);
  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    if (next && !details && !detailsPulling && sessionId) {
      setDetailsPulling(true);
      fetchSessionLiveSettings(sessionId, { details: true })
        .then((s) => {
          setDetails(s.details ?? { contextUsage: null, usage: null, binaryVersion: null });
          setLiveSettings(s); // refresh the strip from the same round-trip
        })
        .catch(() => setDetails({ contextUsage: null, usage: null, binaryVersion: null }))
        .finally(() => setDetailsPulling(false));
    }
  };

  const applied = liveSettings?.live ? liveSettings.applied : null;
  // Active states prefer the LIVE applied values over the (possibly stale) record.
  const activeModelId = normalizeModelId(applied?.model ?? currentModel);
  const requestedModelId = normalizeModelId(liveSettings?.requested?.model ?? currentModel);
  const modelMismatch = applied !== null && activeModelId !== requestedModelId;

  // Effort is a capability of the ACTIVE model (live-aware).
  const capabilityModel = applied?.model ?? currentModel;
  const effortSupported = modelSupportsEffort(capabilityModel);
  const xhighSupported = modelSupportsXhighEffort(capabilityModel);
  const maxSupported = modelSupportsMaxEffort(capabilityModel);

  const requestedEffort: SessionEffort = liveSettings?.requested?.effort ?? currentEffort ?? DEFAULT_SESSION_EFFORT;
  const appliedEffort = (applied?.effort ?? null) as SessionEffort | null;
  // No explicit effort = the API default ('high'). Live value wins when present.
  const activeEffort: SessionEffort = appliedEffort ?? requestedEffort;
  const effortMismatch = applied !== null && appliedEffort !== null && appliedEffort !== requestedEffort;

  // Close on Escape key
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="model-picker">
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">Current: {activeModelId}</span>
        <button className="model-picker-close" onClick={onClose} type="button">&times;</button>
      </div>

      {/* Live-truth strip: what the CLI process is ACTUALLY running right now,
          pulled via get_settings on open. Mismatch (requested ≠ applied) is the
          case this exists for — env override / silent downgrade / ignored value. */}
      {sessionId && (
        <div className={`model-picker-live${modelMismatch || effortMismatch ? ' model-picker-live-warn' : ''}`} data-testid="picker-live-strip">
          {pulling && !liveSettings ? (
            <span className="model-picker-live-checking">Checking live session…</span>
          ) : applied ? (
            <>
              <span className="model-picker-live-dot" aria-hidden>●</span>
              <span>
                Live: <strong>{shortModelLabel(applied.model)}</strong>
                {' · '}effort <strong>{appliedEffort ?? 'default (high)'}</strong>
                {applied.mode ? <>{' · '}mode <strong>{applied.mode}</strong></> : null}
              </span>
              {(modelMismatch || effortMismatch) && (
                <span className="model-picker-live-mismatch" title="The CLI is using different settings than requested (env override or unsupported value silently downgraded/ignored).">
                  {' '}⚠ requested{modelMismatch ? ` ${requestedModelId}` : ''}{effortMismatch ? ` · effort ${requestedEffort}` : ''} not applied
                </span>
              )}
            </>
          ) : (
            <span className="model-picker-live-offline" title="Session process not reachable — showing last known settings; they apply on the next (re)start.">
              ○ Not live — showing saved settings (apply on next start)
            </span>
          )}
          <button
            type="button"
            className="model-picker-details-toggle"
            data-testid="picker-details-toggle"
            onClick={toggleDetails}
            title="Pull the CLI's own context breakdown, cost and version (get_context_usage / get_usage)"
          >
            {detailsOpen ? '▾ details' : '▸ details'}
          </button>
        </div>
      )}

      {/* Live details — collapsed by default. Everything here is the CLI's OWN
          accounting pulled on expand: context breakdown (same source as the
          /context command, incl. the effective window after env clamps), cost per
          model (includes subagent calls Walnut never sees), and binary version. */}
      {sessionId && detailsOpen && (
        <div className="model-picker-details" data-testid="picker-live-details">
          {detailsPulling ? (
            <div className="model-picker-details-loading">Pulling live details from the CLI… (can take ~15s — it tokenizes the full tool surface)</div>
          ) : !details || (!details.contextUsage && !details.usage && !details.binaryVersion) ? (
            <div className="model-picker-details-loading">Not available — session not live (or CLI too old).</div>
          ) : (
            <>
              {details.contextUsage && (
                <div className="model-picker-details-block">
                  <div className="model-picker-details-title">
                    Context — {fmtTokens(details.contextUsage.totalTokens)} / {fmtTokens(details.contextUsage.maxTokens)}
                    {details.contextUsage.percentage != null ? ` (${details.contextUsage.percentage}%)` : ''}
                  </div>
                  {details.contextUsage.categories
                    .filter((c) => c.tokens > 0)
                    .map((c) => (
                      <div key={c.name} className="model-picker-details-row">
                        <span>{c.name}</span>
                        <span>{fmtTokens(c.tokens)}</span>
                      </div>
                    ))}
                </div>
              )}
              {details.usage && (
                <div className="model-picker-details-block">
                  <div className="model-picker-details-title">
                    Cost — {details.usage.total_cost_usd != null ? `$${details.usage.total_cost_usd.toFixed(4)}` : '—'}
                    {details.usage.total_lines_added != null
                      ? ` · +${details.usage.total_lines_added}/-${details.usage.total_lines_removed ?? 0} lines`
                      : ''}
                  </div>
                  {Object.entries(details.usage.model_usage ?? {}).map(([m, u]) => (
                    <div key={m} className="model-picker-details-row">
                      <span>{shortModelLabel(m)}</span>
                      <span>
                        {fmtTokens((u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0))} in
                        {' · '}{fmtTokens(u.outputTokens)} out
                        {u.costUSD != null ? ` · $${u.costUSD.toFixed(4)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {details.binaryVersion?.version && (
                <div className="model-picker-details-row model-picker-details-version">
                  <span>CLI version</span>
                  <span>{details.binaryVersion.version}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Reasoning effort — a session-wide setting, decoupled from which model is picked.
          Applied live via apply_flag_settings; active chip reflects the CLI's true value. */}
      <div className="model-picker-effort">
        <div className="model-picker-effort-label">
          Reasoning effort
          {!effortSupported && (
            <span className="model-picker-effort-hint" title="This model does not support effort levels">
              {' '}— not supported by {activeModelId}
            </span>
          )}
        </div>
        <div className="model-picker-effort-segments" role="group" aria-label="Reasoning effort">
          {EFFORTS.map((e) => {
            const disabled = !effortSupported
              || (e.id === 'xhigh' && !xhighSupported)
              || (e.id === 'max' && !maxSupported);
            const active = effortSupported && e.id === activeEffort;
            const requestedNotApplied = effortMismatch && e.id === requestedEffort;
            const title = e.id === 'xhigh' && !xhighSupported
              ? 'X-High is only supported by select models (Fable 5, Opus 4.7/4.8, Sonnet 5) — others fall back to High'
              : e.id === 'max' && !maxSupported
              ? 'Max is only supported by select models (Fable 5, Opus 4.6+, Sonnet 4.6) — others fall back to High'
              : requestedNotApplied
              ? 'You requested this level but the CLI is not using it (env override or downgrade)'
              : e.description;
            return (
              <button
                key={e.id}
                type="button"
                className={`model-picker-effort-seg${active ? ' model-picker-effort-seg-active' : ''}${requestedNotApplied ? ' model-picker-effort-seg-requested' : ''}`}
                disabled={disabled}
                title={title}
                onClick={() => { if (!disabled && e.id !== activeEffort) onEffortSwitch(e.id); }}
              >
                {e.label}{requestedNotApplied ? ' ⚠' : ''}
              </button>
            );
          })}
        </div>
      </div>

      <div className="model-picker-options">
        {MODELS.map((m) => (
          <div
            key={m.id}
            className={`model-picker-option${m.id === activeModelId ? ' model-picker-option-active' : ''}`}
          >
            <div className="model-picker-option-name">
              {m.label}
              {modelMismatch && m.id === requestedModelId && (
                <span className="model-picker-option-requested" title="You requested this model but the CLI is not using it"> ⚠ requested</span>
              )}
            </div>
            <div className="model-picker-option-desc">{m.description}</div>
            {m.id !== activeModelId && (
              <div className="model-picker-option-actions">
                <button
                  className="btn btn-sm model-picker-btn"
                  onClick={() => onSwitch(m.id)}
                  type="button"
                  title="Applied live — the next turn uses this model (no restart)"
                >
                  Switch
                </button>
              </div>
            )}
            {m.id === activeModelId && (
              <div className="model-picker-option-badge">Active</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
