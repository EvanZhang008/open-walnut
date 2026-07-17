import React from 'react';
import {
  SESSION_EFFORTS,
  DEFAULT_SESSION_EFFORT,
  sessionModelsAsCatalog,
  resolveModelSwitchValue,
  modelSupportsEffort,
  modelSupportsXhighEffort,
  modelSupportsMaxEffort,
} from '@open-walnut/core';
import type { SessionEffort, SessionModelCatalogEntry } from '@open-walnut/core';
import { fetchSessionLiveSettings, fetchSessionModelCatalog } from '@/api/sessions';
import type { SessionLiveSettings, SessionModelCatalog } from '@/api/sessions';

const EFFORTS = SESSION_EFFORTS;

/** Strip decoration that differs between equivalent model strings: the [1m]
 *  context tag and provider version suffixes (-v1, -v1:0, _v2 …). Used for
 *  loose matching between a live/read-back model ID and catalog rows. */
function stripModelDecoration(s: string): string {
  return s.toLowerCase().replace(/\[1m\]$/, '').replace(/[-_]v\d+(:\d+)?$/, '');
}

/**
 * Find which catalog row is the ACTIVE one for a live model string.
 * Tiers (first hit wins):
 *  1. exact `value` match
 *  2. `resolvedModel` match on a NON-'default' row — a specific row beats the
 *     'default' row, which shares its resolvedModel with whatever it points at
 *  3. `resolvedModel` match on the 'default' row
 *  4. loose match ([1m]/-vN stripped) against value/resolvedModel
 *  5. null — live model is OUT of the catalog (org tightened the allowlist,
 *     refusal fallback, resumed onto something else): show truthfully, select nothing.
 */
function matchCatalogRow(models: SessionModelCatalogEntry[], live?: string | null): SessionModelCatalogEntry | null {
  if (!live) return null;
  const exact = models.find((m) => m.value === live);
  if (exact) return exact;
  const byResolved = models.find((m) => m.value !== 'default' && m.resolvedModel === live);
  if (byResolved) return byResolved;
  const viaDefault = models.find((m) => m.value === 'default' && m.resolvedModel === live);
  if (viaDefault) return viaDefault;
  const needle = stripModelDecoration(live);
  return models.find((m) =>
    stripModelDecoration(m.value) === needle
    || (m.resolvedModel ? stripModelDecoration(m.resolvedModel) === needle : false),
  ) ?? null;
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

  // ── Catalog pull (parallel to the live-settings pull): the session's TRUE
  // selectable models from the CLI's initialize response — already filtered by
  // the host's availableModels and mapped through modelOverrides. Until it
  // answers (or with no sessionId, e.g. tests), render the static registry in
  // catalog shape — identical rows to the pre-catalog picker.
  const [catalog, setCatalog] = React.useState<SessionModelCatalog | null>(null);
  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSessionModelCatalog(sessionId)
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch(() => { /* keep fallback rows — degraded, never broken */ });
    return () => { cancelled = true; };
  }, [sessionId]);
  const models: SessionModelCatalogEntry[] = catalog?.models ?? sessionModelsAsCatalog();
  const catalogIsLive = catalog?.source === 'cli';
  // NOTE on switch failure: the panel closes the picker on Switch, so staleness
  // recovery lives SERVER-side — the /model route invalidates the session's
  // catalog cache on a read-back mismatch, and the next picker open refetches.

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
  // Active row = catalog row matching the LIVE model (applied wins over record).
  // No match ⇒ the session runs a model OUTSIDE the catalog — we show that
  // truthfully (synthetic row below) instead of pretending a row is active.
  const liveModel = applied?.model ?? currentModel;
  const activeRow = matchCatalogRow(models, liveModel);
  const requestedModel = liveSettings?.requested?.model ?? currentModel;
  const requestedRow = matchCatalogRow(models, requestedModel);
  // Mismatch = the CLI is NOT running what was requested. Mirrors the server's
  // read-back comparator: 'default' always counts as applied (it can resolve to
  // anything), same catalog row counts, and a legacy alias counts when the live
  // ID contains it ('sonnet' requested → 'global.anthropic.claude-sonnet-5[1m]'
  // live is the alias WORKING, not a mismatch).
  const requestApplied = (() => {
    if (!requestedModel || !liveModel) return true;
    if (requestedModel === 'default') return true;
    if (requestedRow && activeRow && requestedRow.value === activeRow.value) return true;
    const req = stripModelDecoration(requestedModel);
    const liv = stripModelDecoration(liveModel);
    return req === liv || liv.includes(req) || req.includes(liv);
  })();
  const modelMismatch = applied !== null && !requestApplied;

  // Effort is a capability of the ACTIVE model. The catalog row (CLI truth) wins
  // when it carries capability fields; otherwise fall back to the static
  // substring-based tables (which already understand full provider IDs).
  const capabilityModel = liveModel;
  const rowLevels = activeRow?.supportedEffortLevels;
  const effortSupported = activeRow?.supportsEffort !== undefined
    ? activeRow.supportsEffort
    : rowLevels !== undefined ? rowLevels.length > 0 : modelSupportsEffort(capabilityModel);
  const xhighSupported = rowLevels !== undefined ? rowLevels.includes('xhigh') : modelSupportsXhighEffort(capabilityModel);
  const maxSupported = rowLevels !== undefined ? rowLevels.includes('max') : modelSupportsMaxEffort(capabilityModel);

  const requestedEffort: SessionEffort = liveSettings?.requested?.effort ?? currentEffort ?? DEFAULT_SESSION_EFFORT;
  const appliedEffort = (applied?.effort ?? null) as SessionEffort | null;
  // No explicit effort = the API default ('high'). Live value wins when present.
  const activeEffort: SessionEffort = appliedEffort ?? requestedEffort;
  const effortMismatch = applied !== null && appliedEffort !== null && appliedEffort !== requestedEffort;

  // ── Custom model ID input — parity with the terminal's `/model <id>`.
  // The catalog only lists rows the CLI's picker GENERATES; the switch
  // validator accepts more (e.g. an allowlisted model whose menu row the
  // upstream registry forgot — fable-5[1m] on Bedrock). Any string that
  // passes the same shape check the server uses is sent verbatim; the CLI
  // remains the authority (explicit ack error / read-back on the way back).
  // WHAT TO TYPE: the FINAL provider-ready ID — the modelOverrides VALUE if
  // the host configures overrides ("global.anthropic.claude-fable-5[1m]"),
  // else the native provider ID ("us.anthropic.claude-opus-4-8"). NEVER the
  // canonical short ID ("claude-fable-5[1m]"): it acks success but 400s at
  // the wire and silently falls back — full pipeline in the doc comment on
  // resolveModelSwitchValue (src/core/types.ts).
  const [customValue, setCustomValue] = React.useState('');
  const customResolved = customValue.trim() ? resolveModelSwitchValue(customValue) : null;
  const submitCustom = () => { if (customResolved) onSwitch(customResolved); };

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
        <span className="model-picker-current">Current: {activeRow?.displayName ?? shortModelLabel(liveModel)}</span>
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
                  {' '}⚠ requested{modelMismatch ? ` ${requestedRow?.displayName ?? shortModelLabel(liveSettings?.requested?.model ?? currentModel)}` : ''}{effortMismatch ? ` · effort ${requestedEffort}` : ''} not applied
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
              {' '}— not supported by {activeRow?.displayName ?? shortModelLabel(liveModel)}
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
        {/* Out-of-catalog live model: the session runs something no catalog row
            claims (allowlist tightened mid-session, refusal fallback, resumed
            onto a now-restricted model). Show it truthfully — selected nowhere,
            switchable nowhere — instead of pretending a row is active. */}
        {liveModel && !activeRow && (
          <div className="model-picker-option model-picker-option-active" data-testid="picker-out-of-catalog">
            <div className="model-picker-option-name">{shortModelLabel(liveModel)}</div>
            <div className="model-picker-option-desc">Current model — not in this session's selectable catalog</div>
            <div className="model-picker-option-badge">Active</div>
          </div>
        )}
        {models.map((m) => {
          const isActive = activeRow?.value === m.value;
          const isRequestedNotApplied = modelMismatch && requestedRow?.value === m.value;
          return (
            <div
              key={m.value}
              className={`model-picker-option${isActive ? ' model-picker-option-active' : ''}${m.disabled ? ' model-picker-option-disabled' : ''}`}
            >
              <div className="model-picker-option-name">
                {m.displayName}
                {isRequestedNotApplied && (
                  <span className="model-picker-option-requested" title="You requested this model but the CLI is not using it"> ⚠ requested</span>
                )}
              </div>
              <div className="model-picker-option-desc">{m.description ?? ''}</div>
              {!isActive && !m.disabled && (
                <div className="model-picker-option-actions">
                  <button
                    className="btn btn-sm model-picker-btn"
                    onClick={() => onSwitch(m.value)}
                    type="button"
                    title={catalogIsLive
                      ? 'Applied live — the next turn uses this model (no restart)'
                      : 'Applied live via the legacy alias path — the next turn uses this model'}
                  >
                    Switch
                  </button>
                </div>
              )}
              {!isActive && m.disabled && (
                <div className="model-picker-option-badge model-picker-option-badge-disabled" title="Restricted by your organization's settings — visible but not selectable">
                  Restricted
                </div>
              )}
              {isActive && (
                <div className="model-picker-option-badge">Active</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Custom model ID — same escape hatch as the terminal's `/model <id>`.
          Works for allowlisted models missing a catalog row (upstream registry
          gaps), org-specific inference profiles, brand-new model IDs. */}
      <div className="model-picker-custom" data-testid="picker-custom-model">
        <input
          className="model-picker-custom-input"
          type="text"
          placeholder="Custom model ID… (e.g. global.anthropic.claude-fable-5[1m])"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitCustom(); e.stopPropagation(); }}
          spellCheck={false}
        />
        <button
          className="btn btn-sm model-picker-btn"
          type="button"
          disabled={!customResolved}
          onClick={submitCustom}
          title="Sent verbatim to the CLI — it validates against your settings (allowlist / overrides) and reports back the true applied model"
        >
          Switch
        </button>
      </div>
    </div>
  );
}
