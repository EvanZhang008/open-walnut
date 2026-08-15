import React from 'react';
import {
  SESSION_EFFORTS,
  DEFAULT_SESSION_EFFORT,
  sessionModelsAsCatalog,
  resolveModelSwitchValue,
  modelSupportsEffort,
  modelSupportsXhighEffort,
  modelSupportsMaxEffort,
  matchSessionModelCatalogEntry,
  normalizeSessionModelCatalogId,
} from '@open-walnut/core';
import type { SessionEffort, SessionModelCatalogEntry } from '@open-walnut/core';
import { fetchCodexModelCatalog, fetchSessionLiveSettings, fetchSessionModelCatalog } from '@/api/sessions';
import type { CodexModelInfo, SessionLiveSettings, SessionModelCatalog } from '@/api/sessions';
import { useHostModelCatalog, seedHostCatalog } from '@/hooks/useModelCatalog';

const EFFORTS = SESSION_EFFORTS;

// ── Provider rail (the picker's LEFT pane) ──────────────────────────────────
// One pattern for every session surface: provider | models. On a LIVE session
// the other provider is greyed out + locked (an engine is a spawn-time fact —
// switching means a new session); a DRAFT passes onSwitch and both are
// clickable. Stroke/fill SVGs, no emoji (house rule).

export type ProviderId = 'claude' | 'codex';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="#d97757" aria-hidden>
      <path d="M12 3l1.2 5.1L17 4.9l-2.2 4.7 5.2-.4-4.5 2.8 4.5 2.8-5.2-.4L17 19.1l-3.8-3.2L12 21l-1.2-5.1L7 19.1l2.2-4.7-5.2.4 4.5-2.8-4.5-2.8 5.2.4L7 4.9l3.8 3.2z" />
    </svg>
  );
}

function CodexMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 4.5v15M4.9 8.2l14.2 7.6M4.9 15.8l14.2-7.6" />
    </svg>
  );
}

const PROVIDER_ICONS: Record<ProviderId, React.FC> = {
  claude: ClaudeMark,
  codex: CodexMark,
};

export function ProviderRail({ active, onSwitch, lockReason }: {
  active: ProviderId;
  /** Called when the user picks the OTHER provider. Omitted = the other
   *  provider is locked (live session: the engine can't change in place). */
  onSwitch?: (provider: ProviderId) => void;
  /** Per-provider lock override — e.g. Codex is local-only, so a remote draft
   *  locks it even though the draft could otherwise switch. Return a reason
   *  string to lock that provider, or null to leave it switchable. */
  lockReason?: (provider: ProviderId) => string | null;
}) {
  return (
    <div className="model-picker-rail" role="tablist" aria-label="Provider">
      {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => {
        const isActive = id === active;
        const reason = isActive ? null
          : lockReason?.(id)
          ?? (onSwitch ? null : `This session runs on ${PROVIDER_LABELS[active]} — start a new session to use ${PROVIDER_LABELS[id]}`);
        const locked = !isActive && reason !== null;
        const Icon = PROVIDER_ICONS[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={locked || undefined}
            className={`provider-rail-item${isActive ? ' provider-rail-item-active' : ''}${locked ? ' provider-rail-item-locked' : ''}`}
            title={locked ? reason! : PROVIDER_LABELS[id]}
            data-provider={id}
            onClick={() => { if (!isActive && !locked) onSwitch?.(id); }}
          >
            <Icon />
            {locked && (
              <span className="provider-rail-lock" aria-hidden>
                <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V7a4 4 0 018 0v4" />
                </svg>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
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

/** "gpt-best" → "GPT Best" — display form of a Codex/ACP model id (moved here
 *  from the retired CodexModelPicker; the pill label in SessionPanel uses it). */
export function shortCodexModelName(modelId: string): string {
  return modelId
    .replace(/^(?:openai|codex|mock)[.:/_\s-]+/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'gpt'
      ? 'GPT'
      : part.toLowerCase() === 'codex'
        ? 'Codex'
        : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface ModelPickerProps {
  currentModel?: string;
  /** Explicit reasoning effort saved for the session; undefined uses the CLI's configured default. */
  currentEffort?: SessionEffort;
  /** Session to pull LIVE settings from (get_settings) when the picker opens.
   *  Omitted (e.g. in tests) → no pull, record props are all we show. */
  sessionId?: string;
  /** Session's host (undefined = local) — selects the host-level catalog cache
   *  so the picker renders CLI-truth rows instantly, before any live pull. */
  host?: string;
  /** Switch model — applied live via apply_flag_settings (no respawn); the NEXT
   *  turn uses the new model. No Now/Next-turn split needed anymore. */
  onSwitch: (model: string) => void;
  /** Switch reasoning effort (same live apply_flag_settings mechanism).
   *  Omitted → the effort section is hidden (a DRAFT has no effort field:
   *  the CLI's own settings decide at spawn). */
  onEffortSwitch?: (effort: SessionEffort) => void;
  onClose: () => void;
  /** Which provider's pane is showing. Default 'claude'. */
  engine?: ProviderId;
  /** Provider switch (rail click). Passed by DRAFT surfaces only — a live
   *  session's engine is a spawn-time fact, so live callers omit it and the
   *  other provider renders greyed + locked. */
  onProviderSwitch?: (provider: ProviderId) => void;
  /** Per-provider extra lock (e.g. Codex is local-only → locked on a remote
   *  draft even though the draft could otherwise switch). */
  providerLockReason?: (provider: ProviderId) => string | null;
  /** Codex pane: the session's current ACP model id (record.acpModel). */
  codexCurrentModelId?: string;
  /** Codex pane: switch the live session's ACP model. */
  onCodexSwitch?: (modelId: string) => void;
  /** DRAFT pane: prepend an "Auto" row (no --model at spawn — the CLI/config
   *  default decides). Picking it calls onSwitch('') — the draft caller maps
   *  '' back to undefined. Also hides the catalog's own 'default' row, which
   *  would duplicate it. */
  autoRow?: { resolvedLabel: string; active: boolean };
}

export function ModelPicker({
  currentModel, currentEffort, sessionId, host, onSwitch, onEffortSwitch, onClose,
  engine = 'claude', onProviderSwitch, providerLockReason, codexCurrentModelId, onCodexSwitch, autoRow,
}: ModelPickerProps) {
  // ── LIVE pull: the moment the picker opens, ask the CLI what it's ACTUALLY
  // using (get_settings → applied). Until it answers (or when the session isn't
  // live), fall back to the record props — but never present those as CLI truth.
  const isCodexPane = engine === 'codex';
  const [liveSettings, setLiveSettings] = React.useState<SessionLiveSettings | null>(null);
  const [pulling, setPulling] = React.useState(false);
  React.useEffect(() => {
    if (!sessionId || isCodexPane) return; // get_settings is a Claude-CLI protocol call
    let cancelled = false;
    setPulling(true);
    fetchSessionLiveSettings(sessionId)
      .then((s) => { if (!cancelled) setLiveSettings(s); })
      .catch(() => { /* pull failed → keep record fallback, no claim of truth */ })
      .finally(() => { if (!cancelled) setPulling(false); });
    return () => { cancelled = true; };
  }, [sessionId, isCodexPane]);

  // ── Codex pane: ACP catalog for a LIVE codex session (onCodexSwitch set).
  // A codex DRAFT has no catalog to offer — ACP discovers models at session
  // start — so the pane renders an explanatory row instead (codexModels null).
  const [codexModels, setCodexModels] = React.useState<CodexModelInfo[] | null>(null);
  const [codexCurrent, setCodexCurrent] = React.useState<string | undefined>(codexCurrentModelId);
  const [codexLoading, setCodexLoading] = React.useState(false);
  React.useEffect(() => { setCodexCurrent(codexCurrentModelId); }, [codexCurrentModelId, sessionId]);
  React.useEffect(() => {
    if (!isCodexPane || !sessionId || !onCodexSwitch) return;
    let cancelled = false;
    setCodexLoading(true);
    fetchCodexModelCatalog(sessionId)
      .then((c) => {
        if (cancelled) return;
        setCodexModels(c.models);
        setCodexCurrent(c.currentModelId);
      })
      .catch(() => { if (!cancelled) setCodexModels([]); })
      .finally(() => { if (!cancelled) setCodexLoading(false); });
    return () => { cancelled = true; };
  }, [isCodexPane, sessionId, onCodexSwitch]);

  // ── Catalog: instant from the host-level cache (localStorage-seeded, WS-live
  // via useHostModelCatalog — the server pushes session:model-catalog on every
  // real list_models fetch, incl. the eager one at session init). The per-open
  // HTTP fetch remains only as a REPAIR path for the cold case (host cache
  // empty — e.g. first run) and its response feeds the same rows. Because the
  // host cache and the CLI answer are the same catalog (host property), the
  // old two-shape flash (static registry → CLI rows) is gone: static rows only
  // ever render when this host has NEVER produced a catalog.
  const hostCatalog = useHostModelCatalog(host);
  const [fetched, setFetched] = React.useState<SessionModelCatalog | null>(null);
  React.useEffect(() => {
    if (!sessionId || hostCatalog || isCodexPane) return; // cache hit → no round-trip needed
    let cancelled = false;
    fetchSessionModelCatalog(sessionId)
      .then((c) => {
        if (cancelled || c.source === 'fallback') return;
        setFetched(c);
        // Seed the shared host store too (manual refresh already does): on a
        // cold host the one-shot eager init fetch can miss, and this repair
        // fetch is then the FIRST real catalog — without seeding, the quick-
        // session dropdown and the "Auto (<resolved>)" labels stay unresolved.
        if (c.source === 'cli') seedHostCatalog(host, c.models, c.fetchedAt);
      })
      .catch(() => { /* keep fallback rows — degraded, never broken */ });
    return () => { cancelled = true; };
  }, [sessionId, hostCatalog, isCodexPane]);
  const models: SessionModelCatalogEntry[] = hostCatalog?.models ?? fetched?.models ?? sessionModelsAsCatalog();
  const catalogIsLive = !!hostCatalog || fetched?.source === 'cli';
  // NOTE on switch failure: the panel closes the picker on Switch, so staleness
  // recovery lives SERVER-side — the /model route invalidates the session's
  // catalog cache on a read-back mismatch, which refetches + pushes the
  // corrected catalog to this cache.

  // ── Manual refresh: the cached host catalog can go stale in ways no event
  // catches (settings.json edited/clobbered while no session respawned, another
  // machine's writer, an interrupted eager fetch). ?refresh=1 forces the CLI
  // round-trip; the response re-seeds the shared host cache directly (plus the
  // server's own push confirms it) and the live strip re-pulls too.
  // Tri-state feedback: spin while in flight, then a ✓/! flash — without it a
  // fast round-trip is indistinguishable from a dead button, and a failure
  // (or a fallback answer: CLI unreachable → NOT fresh data) looks like success.
  const [refreshState, setRefreshState] = React.useState<'idle' | 'refreshing' | 'success' | 'failed'>('idle');
  const refreshing = refreshState === 'refreshing';
  // Unmount guard: the picker is routinely closed while a refresh is in
  // flight — the settled promise must not setState on a dead component.
  const aliveRef = React.useRef(true);
  React.useEffect(() => () => { aliveRef.current = false; }, []);
  const refreshCatalog = () => {
    if (!sessionId || refreshing) return;
    setRefreshState('refreshing');
    // The live-settings re-pull rides along but is best-effort: only the
    // CATALOG fetch decides success/failure — a settings hiccup must not
    // report "failed" when the catalog did refresh (and vice versa the
    // catalog answer must still seed the cache).
    void fetchSessionLiveSettings(sessionId)
      .then((s) => { if (aliveRef.current) setLiveSettings(s); })
      .catch(() => {});
    fetchSessionModelCatalog(sessionId, { refresh: true })
      .then((c) => {
        if (!aliveRef.current) return;
        // Success = the CLI actually answered ('cli'). 'host' (last-known
        // store) and 'fallback' (static registry) both mean the CLI did NOT
        // answer — a refresh that re-read nothing must not flash ✓.
        if (c.source !== 'cli') {
          setRefreshState('failed');
          return;
        }
        setFetched(c);
        seedHostCatalog(host, c.models, c.fetchedAt);
        setRefreshState('success');
      })
      .catch(() => { if (aliveRef.current) setRefreshState('failed'); });
  };
  // Flash ✓/! for 2s, then return to idle. Cleared on unmount/re-trigger.
  React.useEffect(() => {
    if (refreshState !== 'success' && refreshState !== 'failed') return;
    const t = setTimeout(() => setRefreshState('idle'), 2000);
    return () => clearTimeout(t);
  }, [refreshState]);

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
  const activeRow = matchSessionModelCatalogEntry(models, liveModel);
  const requestedModel = liveSettings?.requested?.model ?? currentModel;
  const requestedRow = matchSessionModelCatalogEntry(models, requestedModel);
  // Mismatch = the CLI is NOT running what was requested. Mirrors the server's
  // read-back comparator: 'default' always counts as applied (it can resolve to
  // anything), same catalog row counts, and a legacy alias counts when the live
  // ID contains it ('sonnet' requested → 'global.anthropic.claude-sonnet-5[1m]'
  // live is the alias WORKING, not a mismatch).
  const requestApplied = (() => {
    if (!requestedModel || !liveModel) return true;
    if (requestedModel === 'default') return true;
    if (requestedRow && activeRow && requestedRow.value === activeRow.value) return true;
    const req = normalizeSessionModelCatalogId(requestedModel);
    const liv = normalizeSessionModelCatalogId(liveModel);
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

  const requestedEffort: SessionEffort = liveSettings?.requested?.effort
    ?? currentEffort
    ?? liveSettings?.effective?.effortLevel
    ?? DEFAULT_SESSION_EFFORT;
  const appliedEffort = (applied?.effort ?? null) as SessionEffort | null;
  const configuredEffort = liveSettings?.effective?.effortLevel ?? DEFAULT_SESSION_EFFORT;
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

  // ── Codex pane rows (live: ACP catalog; draft: explanatory placeholder).
  const codexPane = (
    <>
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">
          Current: {codexCurrent ? shortCodexModelName(codexCurrent) : 'Codex'}
        </span>
        <button className="model-picker-close" onClick={onClose} type="button">&times;</button>
      </div>
      <div className="model-picker-options">
        {onCodexSwitch ? (
          codexLoading ? (
            <div className="model-picker-status">Loading Codex models…</div>
          ) : !codexModels || codexModels.length === 0 ? (
            <div className="model-picker-status">No Codex models reported by this session.</div>
          ) : (
            codexModels.map((m) => {
              const isActive = m.modelId === codexCurrent;
              return (
                <div key={m.modelId} className={`model-picker-option${isActive ? ' model-picker-option-active' : ''}`}>
                  <div className="model-picker-option-name">{m.name}</div>
                  <div className="model-picker-option-desc">{m.description ?? ''}</div>
                  {isActive ? (
                    <div className="model-picker-option-badge">Active</div>
                  ) : (
                    <div className="model-picker-option-actions">
                      <button
                        className="btn btn-sm model-picker-btn"
                        type="button"
                        onClick={() => onCodexSwitch(m.modelId)}
                      >
                        Switch
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )
        ) : (
          <div className="model-picker-status">
            Codex models come from ACP discovery when the session starts — the launch uses the Codex default.
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="model-picker">
      <ProviderRail active={engine} onSwitch={onProviderSwitch} lockReason={providerLockReason} />
      <div className="model-picker-pane">
      {isCodexPane ? codexPane : (<>
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">
          Current: {activeRow?.displayName
            ?? (autoRow && !liveModel
              ? (autoRow.resolvedLabel ? `Auto (${autoRow.resolvedLabel})` : 'Auto')
              : shortModelLabel(liveModel))}
        </span>
        {sessionId && (
          <button
            className={`model-picker-refresh model-picker-refresh-${refreshState}`}
            onClick={refreshCatalog}
            disabled={refreshing}
            type="button"
            title={refreshState === 'failed'
              ? 'Refresh failed — click to retry.'
              : refreshState === 'success'
              ? 'Model list refreshed from the CLI'
              : 'Re-read the model list and live settings from the CLI (use after editing settings.json)'}
            aria-label={refreshState === 'failed'
              ? 'Refresh model catalog — last attempt failed'
              : refreshState === 'success'
              ? 'Refresh model catalog — refreshed'
              : 'Refresh model catalog'}
            aria-busy={refreshing}
            data-refresh-state={refreshState}
            data-testid="picker-refresh"
          >
            {refreshState === 'success' ? '✓' : refreshState === 'failed' ? '!' : '⟳'}
          </button>
        )}
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
                {' · '}effort <strong>{appliedEffort ?? `default (${configuredEffort})`}</strong>
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
          Applied live via apply_flag_settings; active chip reflects the CLI's true value.
          Hidden when the caller has no effort channel (a draft: the CLI's own
          settings decide at spawn). */}
      {onEffortSwitch && (
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
      )}

      <div className="model-picker-options">
        {/* Out-of-catalog live model: the session runs something no catalog row
            claims (allowlist tightened mid-session, refusal fallback, resumed
            onto a now-restricted model). Show it truthfully — selected nowhere,
            switchable nowhere — instead of pretending a row is active. */}
        {liveModel && !activeRow && !autoRow && (
          <div className="model-picker-option model-picker-option-active" data-testid="picker-out-of-catalog">
            <div className="model-picker-option-name">{shortModelLabel(liveModel)}</div>
            <div className="model-picker-option-desc">Current model — not in this session's selectable catalog</div>
            <div className="model-picker-option-badge">Active</div>
          </div>
        )}
        {autoRow && (
          <div className={`model-picker-option${autoRow.active ? ' model-picker-option-active' : ''}`} data-testid="picker-auto-row">
            <div className="model-picker-option-name">{autoRow.resolvedLabel ? `Auto (${autoRow.resolvedLabel})` : 'Auto'}</div>
            <div className="model-picker-option-desc">No --model flag — the CLI/config default decides</div>
            {autoRow.active ? (
              <div className="model-picker-option-badge">Active</div>
            ) : (
              <div className="model-picker-option-actions">
                <button className="btn btn-sm model-picker-btn" type="button" onClick={() => onSwitch('')}>
                  Switch
                </button>
              </div>
            )}
          </div>
        )}
        {models.filter((m) => !(autoRow && m.value === 'default')).map((m) => {
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
      </>)}
      </div>{/* .model-picker-pane */}
    </div>
  );
}
