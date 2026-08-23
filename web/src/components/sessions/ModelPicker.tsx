import React from 'react';
import { createPortal } from 'react-dom';
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
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { formatModelName } from '@/hooks/useSessionUsage';
import { sortByModelStrength } from '@/utils/model-strength-order';

const EFFORTS = SESSION_EFFORTS;

/** Row label with the REAL version — "Opus 4.8 1M", not "Opus". The catalog's
 *  displayName is bare family (upstream generates it that way), but the row
 *  value/resolvedModel carries the full ID, so derive the versioned name from
 *  it. Falls back to displayName when no version is derivable (legacy alias
 *  rows like 'opus', GPT rows whose displayName is already right). */
export function catalogRowLabel(m: SessionModelCatalogEntry): string {
  const derived = formatModelName(m.resolvedModel ?? m.value);
  const versioned = /^(Opus|Sonnet|Haiku|Fable) \d/.test(derived) ? derived : null;
  if (m.value === 'default') {
    return versioned ? `Default (${versioned})` : (m.displayName || 'Default');
  }
  return versioned ?? m.displayName ?? m.value;
}

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

/**
 * ACP encodes reasoning effort INTO the model id — "openai.gpt-5.6-sol[xhigh]"
 * — so a raw catalog renders as a wall of family×effort rows. Split the two
 * axes back apart: familyId is the id without the [effort] suffix, effort is
 * the suffix (null when the id carries none, e.g. mock/test models).
 */
export function parseCodexModelId(modelId: string): { familyId: string; effort: string | null } {
  const m = /^(.*)\[([a-z]+)\]$/.exec(modelId);
  return m ? { familyId: m[1], effort: m[2] } : { familyId: modelId, effort: null };
}

/** "openai.gpt-5.6-sol" → "GPT 5.6 Sol" — family half of a Codex model id. */
function codexFamilyName(familyId: string): string {
  return familyId
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

/** Display form of a full Codex/ACP model id — "GPT 5.6 Sol · X-High".
 *  (Pill labels in SessionPanel + the lane composer use it.) */
export function shortCodexModelName(modelId: string): string {
  const { familyId, effort } = parseCodexModelId(modelId);
  const family = codexFamilyName(familyId);
  if (!effort) return family;
  const label = SESSION_EFFORTS.find((e) => e.id === effort)?.label
    ?? effort.charAt(0).toUpperCase() + effort.slice(1);
  return `${family} · ${label}`;
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
  /** POP OUT of the host column: portal to <body>, placed by useMenuPlacement
   *  against this anchor (the clicked pill). Without it the picker renders
   *  in place (position:absolute above the mode bar) and a narrow session
   *  column CLIPS it — set the ref from the pill's onClick
   *  (`anchorRef.current = e.currentTarget`). */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function ModelPicker({
  currentModel, currentEffort, sessionId, host, onSwitch, onEffortSwitch, onClose,
  engine = 'claude', onProviderSwitch, providerLockReason, codexCurrentModelId, onCodexSwitch, autoRow,
  anchorRef,
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

  // ── Live details: collapsed by default, but PREFETCHED in the background
  // the moment the picker opens — the pull is slow (get_context_usage
  // tokenizes the CLI's whole tool surface, ~15s), and making the user click
  // "details" and THEN wait it out reads as broken (user report 2026-08-16).
  // Opening the section mid-flight just shows the loading line briefly.
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [details, setDetails] = React.useState<SessionLiveSettings['details'] | null>(null);
  const [detailsPulling, setDetailsPulling] = React.useState(false);
  React.useEffect(() => {
    if (!sessionId || isCodexPane) return;
    let cancelled = false;
    setDetailsPulling(true);
    fetchSessionLiveSettings(sessionId, { details: true })
      .then((s) => {
        if (cancelled) return;
        setDetails(s.details ?? { contextUsage: null, usage: null, binaryVersion: null });
        setLiveSettings(s); // refresh the strip from the same round-trip
      })
      .catch(() => { if (!cancelled) setDetails({ contextUsage: null, usage: null, binaryVersion: null }); })
      .finally(() => { if (!cancelled) setDetailsPulling(false); });
    return () => { cancelled = true; };
  }, [sessionId, isCodexPane]);
  const toggleDetails = () => setDetailsOpen((v) => !v);

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

  // ── POPOUT (anchorRef callers): portal to <body>, placed by useMenuPlacement
  // against the clicked pill — a narrow session column can no longer clip the
  // panel (user report 2026-08-15: half the picker was cut off). preferSide
  // 'up' because every pill lives in a bottom mode bar. Outside-click closes;
  // the pill's own click is exempt (it already toggles).
  const popRef = React.useRef<HTMLDivElement>(null);
  const popped = !!anchorRef;
  const placement = useMenuPlacement(popped, anchorRef ?? popRef, popRef, {
    // Centered ON the clicked pill (user call 2026-08-15), flipped up from
    // the bottom mode bar, clamped to the viewport by the hook.
    preferSide: 'up', align: 'center', margin: 12, onAnchorLost: onClose,
  });
  React.useEffect(() => {
    if (!popped) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popped, onClose, anchorRef]);

  // ── Codex pane rows (live: ACP catalog; draft: explanatory placeholder).
  // ACP encodes effort into the model id (…-sol[xhigh]), which as raw rows is a
  // 25-entry wall. Regroup to the SAME two flat columns the claude pane has:
  // Model = one row per family, Effort = the shared ladder (rows the active
  // family doesn't offer render disabled). A family/effort click composes the
  // full id back (family switch keeps the current effort when offered).
  const codexFamilies = React.useMemo(() => {
    const fams = new Map<string, { familyId: string; label: string; byEffort: Map<string | null, CodexModelInfo> }>();
    for (const m of codexModels ?? []) {
      const { familyId, effort } = parseCodexModelId(m.modelId);
      let fam = fams.get(familyId);
      if (!fam) {
        // Prefer the server's own name minus its "(effort)" tail — it keeps
        // punctuation the id lost (e.g. "GPT-5.6 Sol", mock model names).
        const label = m.name.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, '').trim()
          || codexFamilyName(familyId);
        fam = { familyId, label, byEffort: new Map() };
        fams.set(familyId, fam);
      }
      fam.byEffort.set(effort, m);
    }
    return sortByModelStrength(
      [...fams.values()],
      (family) => `${family.familyId} ${family.label}`,
    );
  }, [codexModels]);
  const codexActive = codexCurrent ? parseCodexModelId(codexCurrent) : null;
  const codexActiveFamily = codexActive
    ? codexFamilies.find((f) => f.familyId === codexActive.familyId)
    : undefined;
  // Hide the effort column entirely when NO family has effort variants (mock
  // catalogs) — mirrors the claude pane hiding effort for draft callers.
  const codexHasEfforts = codexFamilies.some((f) => [...f.byEffort.keys()].some((e) => e !== null));

  const switchCodexFamily = (fam: { familyId: string; byEffort: Map<string | null, CodexModelInfo> }) => {
    if (!onCodexSwitch) return;
    // Keep the current effort when the target family offers it; else fall to
    // medium, a suffix-less id, or the family's first variant.
    const target = (codexActive?.effort ? fam.byEffort.get(codexActive.effort) : undefined)
      ?? fam.byEffort.get('medium')
      ?? fam.byEffort.get(null)
      ?? [...fam.byEffort.values()][0];
    if (target && target.modelId !== codexCurrent) onCodexSwitch(target.modelId);
  };

  type ClaudeModelRow =
    | { kind: 'current'; model: string }
    | { kind: 'auto'; resolvedLabel: string; active: boolean }
    | { kind: 'catalog'; model: SessionModelCatalogEntry };
  const claudeModelRows = sortByModelStrength<ClaudeModelRow>([
    ...(liveModel && !activeRow && !autoRow
      ? [{ kind: 'current' as const, model: liveModel }]
      : []),
    ...(autoRow
      ? [{ kind: 'auto' as const, ...autoRow }]
      : []),
    ...models
      .filter((model) => !(autoRow && model.value === 'default'))
      .map((model) => ({ kind: 'catalog' as const, model })),
  ], (row) => {
    if (row.kind === 'current') return row.model;
    if (row.kind === 'auto') return `auto ${row.resolvedLabel}`;
    return `${row.model.value} ${row.model.resolvedModel ?? ''} ${catalogRowLabel(row.model)}`;
  });

  const codexPane = (
    <>
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">
          Current: {codexCurrent ? shortCodexModelName(codexCurrent) : 'Codex'}
        </span>
        <button className="model-picker-close" onClick={onClose} type="button">&times;</button>
      </div>
      <div className="model-picker-columns">
        <div className="model-picker-col model-picker-col-models" role="listbox" aria-label="Model">
          <div className="model-picker-col-title">Model</div>
          {onCodexSwitch ? (
            codexLoading ? (
              <div className="model-picker-status">Loading Codex models…</div>
            ) : codexFamilies.length === 0 ? (
              <div className="model-picker-status">No Codex models reported by this session.</div>
            ) : (
              codexFamilies.map((fam) => {
                const isActive = fam.familyId === codexActive?.familyId;
                const sample = [...fam.byEffort.values()][0];
                return (
                  <button
                    key={fam.familyId}
                    type="button"
                    className={`model-picker-row${isActive ? ' model-picker-row-active' : ''}`}
                    role="option"
                    aria-selected={isActive}
                    title={sample?.description?.split('.')[0] ?? fam.label}
                    onClick={() => { if (!isActive) switchCodexFamily(fam); }}
                  >
                    <span className="model-picker-row-check" aria-hidden>{isActive ? '✓' : ''}</span>
                    <span className="model-picker-row-name">{fam.label}</span>
                  </button>
                );
              })
            )
          ) : (
            <div className="model-picker-status">
              Codex models come from ACP discovery when the session starts — the launch uses the Codex default.
            </div>
          )}
        </div>
        {onCodexSwitch && codexHasEfforts && (
          <div className="model-picker-col model-picker-col-effort" role="listbox" aria-label="Reasoning effort">
            <div className="model-picker-col-title">Effort</div>
            {EFFORTS.map((e) => {
              const variant = codexActiveFamily?.byEffort.get(e.id);
              const disabled = !variant;
              const active = codexActive?.effort === e.id;
              return (
                <button
                  key={e.id}
                  type="button"
                  className={`model-picker-row${active ? ' model-picker-row-active' : ''}`}
                  role="option"
                  aria-selected={active}
                  disabled={disabled}
                  title={disabled
                    ? `Not offered by ${codexActiveFamily?.label ?? 'this model'}`
                    : e.description}
                  onClick={() => {
                    if (!active && variant && variant.modelId !== codexCurrent) onCodexSwitch(variant.modelId);
                  }}
                >
                  <span className="model-picker-row-check" aria-hidden>{active ? '✓' : ''}</span>
                  <span className="model-picker-row-name">{e.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  const panel = (
    <div
      className={`model-picker${popped ? ' model-picker-popout' : ''}`}
      ref={popRef}
      style={popped ? menuPlacementStyle(placement) : undefined}
      // Portal menus still bubble React events into the host row's drag
      // sensors — stop pointerdown at the boundary (menu hard rule).
      onPointerDown={popped ? (e) => e.stopPropagation() : undefined}
    >
      <ProviderRail active={engine} onSwitch={onProviderSwitch} lockReason={providerLockReason} />
      <div className="model-picker-pane">
      {isCodexPane ? codexPane : (<>
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">
          Current: {activeRow
            ? catalogRowLabel(activeRow)
            : (autoRow && !liveModel
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
                  {' '}⚠ requested{modelMismatch ? ` ${requestedRow ? catalogRowLabel(requestedRow) : shortModelLabel(liveSettings?.requested?.model ?? currentModel)}` : ''}{effortMismatch ? ` · effort ${requestedEffort}` : ''} not applied
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
                  {/* Name the denominator's origin. A window the user's own env
                      capped (e.g. CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 on a 1M
                      model) otherwise reads as a Walnut miscount — that confusion
                      is exactly what the 2026-08-23 report was about. */}
                  {details.contextUsage.autocompactSource
                    && details.contextUsage.autocompactSource !== 'model-default' && (
                    <div className="model-picker-details-row model-picker-details-note">
                      <span>window</span>
                      <span>
                        {details.contextUsage.autocompactSource === 'env'
                          ? 'capped by CLAUDE_CODE_AUTO_COMPACT_WINDOW'
                          : `capped by auto-compact setting (${details.contextUsage.autocompactSource})`}
                      </span>
                    </div>
                  )}
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

      {/* Two flat columns: Model | Effort. One row per choice, click the row
          to switch, ✓ marks the active one — no descriptions, no per-row
          Switch buttons (design pick, 2026-08-15). The effort column hides
          when the caller has no effort channel (a draft: the CLI's own
          settings decide at spawn). */}
      <div className="model-picker-columns">
        <div className="model-picker-col model-picker-col-models" role="listbox" aria-label="Model">
          <div className="model-picker-col-title">Model</div>
          {claudeModelRows.map((row) => {
            if (row.kind === 'current') {
              return (
                <div
                  key={`current:${row.model}`}
                  className="model-picker-row model-picker-row-active"
                  data-testid="picker-out-of-catalog"
                  role="option"
                  aria-selected="true"
                  title="Current model — not in this session's selectable catalog"
                >
                  <span className="model-picker-row-check" aria-hidden>✓</span>
                  <span className="model-picker-row-name">{shortModelLabel(row.model)}</span>
                </div>
              );
            }
            if (row.kind === 'auto') {
              return (
                <button
                  key="auto"
                  type="button"
                  className={`model-picker-row${row.active ? ' model-picker-row-active' : ''}`}
                  data-testid="picker-auto-row"
                  role="option"
                  aria-selected={row.active}
                  title="No --model flag — the CLI/config default decides"
                  onClick={() => { if (!row.active) onSwitch(''); }}
                >
                  <span className="model-picker-row-check" aria-hidden>{row.active ? '✓' : ''}</span>
                  <span className="model-picker-row-name">{row.resolvedLabel ? `Auto (${row.resolvedLabel})` : 'Auto'}</span>
                </button>
              );
            }

            const m = row.model;
            const isActive = activeRow?.value === m.value;
            const isRequestedNotApplied = modelMismatch && requestedRow?.value === m.value;
            return (
              <button
                key={m.value}
                type="button"
                className={`model-picker-row${isActive ? ' model-picker-row-active' : ''}${m.disabled ? ' model-picker-row-disabled' : ''}`}
                role="option"
                aria-selected={isActive}
                disabled={m.disabled}
                title={m.disabled
                  ? 'Restricted by your organization\'s settings'
                  : isRequestedNotApplied
                  ? 'You requested this model but the CLI is not using it'
                  : m.description ?? catalogRowLabel(m)}
                onClick={() => { if (!isActive && !m.disabled) onSwitch(m.value); }}
              >
                <span className="model-picker-row-check" aria-hidden>{isActive ? '✓' : ''}</span>
                <span className="model-picker-row-name">
                  {catalogRowLabel(m)}
                  {isRequestedNotApplied && <span className="model-picker-option-requested"> ⚠</span>}
                </span>
              </button>
            );
          })}
        </div>
        {onEffortSwitch && (
          <div className="model-picker-col model-picker-col-effort" role="listbox" aria-label="Reasoning effort">
            <div className="model-picker-col-title">Effort</div>
            {EFFORTS.map((e) => {
              const disabled = !effortSupported
                || (e.id === 'xhigh' && !xhighSupported)
                || (e.id === 'max' && !maxSupported);
              const active = effortSupported && e.id === activeEffort;
              const requestedNotApplied = effortMismatch && e.id === requestedEffort;
              const title = !effortSupported
                ? `Not supported by ${activeRow ? catalogRowLabel(activeRow) : shortModelLabel(liveModel)}`
                : e.id === 'xhigh' && !xhighSupported
                ? 'X-High needs Fable 5 / Opus 4.7+ / Sonnet 5'
                : e.id === 'max' && !maxSupported
                ? 'Max needs Fable 5 / Opus 4.6+ / Sonnet 4.6'
                : requestedNotApplied
                ? 'You requested this level but the CLI is not using it'
                : e.description;
              return (
                <button
                  key={e.id}
                  type="button"
                  className={`model-picker-row${active ? ' model-picker-row-active' : ''}${requestedNotApplied ? ' model-picker-row-requested' : ''}`}
                  role="option"
                  aria-selected={active}
                  disabled={disabled}
                  title={title}
                  onClick={() => { if (!disabled && e.id !== activeEffort) onEffortSwitch(e.id); }}
                >
                  <span className="model-picker-row-check" aria-hidden>{active ? '✓' : ''}</span>
                  <span className="model-picker-row-name">{e.label}{requestedNotApplied ? ' ⚠' : ''}</span>
                </button>
              );
            })}
          </div>
        )}
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

  // Anchored callers get a portal (clipping-proof); legacy callers keep the
  // in-place absolute panel.
  return popped ? createPortal(panel, document.body) : panel;
}
