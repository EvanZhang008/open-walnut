export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPhase =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'AGENT_COMPLETE'
  | 'AWAIT_HUMAN_ACTION'
  | 'HUMAN_VERIFIED'
  | 'POST_WORK_COMPLETED'
  | 'COMPLETE';
export type TaskPriority = 'immediate' | 'important' | 'backlog' | 'none';
/** Canonical list of valid priority values — use for runtime validation. */
export const VALID_PRIORITIES: readonly TaskPriority[] = ['immediate', 'important', 'backlog', 'none'] as const;
export type TaskSource = string;

export interface QuickTaskParse {
  title: string;
  due_date?: string;
  start_date?: string;
  pinTier?: string;  // built-in 'focus' | 'satellite' | 'backlog' | 'wait', or a custom tier id ('ct_*')
  priority?: Exclude<TaskPriority, 'none'>;
  starred?: boolean;
  category?: string;
  project?: string;
}

// ── Pin tier routing policy ───────────────────────────────────────────────
// What belongs in which tier. Single source of truth: the quick-task PROMPT
// builds its pinTier rule from this, and the UI shows the same wording as the
// tier tooltips — so the AI's guess and the human's mental model can't drift.
//
// The deliberate asymmetry: only urgent/soon work gets pinned at all. The
// pinned area is a small working set the user actually looks at, so anything
// low-priority or far-off stays OUT of it (no tier) and lives in the task list
// below. Over-pinning is what made the old Focus tier useless.
export interface PinTierPolicyEntry {
  tier: 'focus' | 'satellite' | 'backlog' | 'wait';
  /** Short label shown in pickers. */
  label: string;
  /** One-line "what goes here", shown as the tier's tooltip. */
  guidance: string;
}

export const PIN_TIER_POLICY: readonly PinTierPolicyEntry[] = [
  {
    tier: 'focus',
    label: 'Focus',
    guidance: 'Super important and urgent — work on it now.',
  },
  {
    tier: 'satellite',
    label: 'Satellite',
    guidance: 'Needs doing soon — lower priority than Focus, or due within about a week.',
  },
  {
    tier: 'backlog',
    label: 'Backlog',
    guidance: 'Keep on the list but not soon — someday/low-priority work you still want pinned.',
  },
  {
    tier: 'wait',
    label: 'Wait',
    guidance: 'Parked — pinned but blocked or waiting on someone else.',
  },
] as const;

/** The "leave it unpinned" half of the policy — no tier is a real answer. */
export const PIN_TIER_NONE_GUIDANCE =
  'Not worth tracking in the pinned working set at all — leave it unpinned.';

// ── Session model registry ────────────────────────────────────────────────
// Single source of truth for the set of selectable Claude Code session models.
// Both backend (CLI --model mapping, web RPC allowlist) and frontend (picker,
// settings dropdown) derive from this — adding a new model means one edit here.
//
// Walnut passes only the SHORT alias (e.g. 'fable', 'fable[1m]') to `claude
// --model`; the CLI resolves it to a full Bedrock ID via ~/.claude/settings.json.
// NOTE: opus/sonnet/haiku are built-in CLI aliases that resolve unconditionally.
// `fable` is NOT built-in — it resolves only because ANTHROPIC_DEFAULT_FABLE_MODEL
// is set in settings.json. If that env var is missing on a host (e.g. a remote
// daemon host), `fable` will fail there while the other three keep working.
export type SessionModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';
export interface SessionModelEntry {
  /** Picker / config alias, e.g. 'fable-1m'. */
  id: string;
  /** Display label, e.g. 'Fable 1M'. */
  label: string;
  /** Dropdown description. */
  description: string;
  /** Value passed to `claude --model`, e.g. 'fable[1m]'. */
  cliModel: string;
  family: SessionModelFamily;
  /** Whether this entry uses the 1M extended context window. */
  is1m: boolean;
}
export const SESSION_MODELS: readonly SessionModelEntry[] = [
  { id: 'opus',      label: 'Opus',      description: 'Most capable',      cliModel: 'opus',       family: 'opus',   is1m: false },
  { id: 'opus-1m',   label: 'Opus 1M',   description: '1M context window', cliModel: 'opus[1m]',   family: 'opus',   is1m: true  },
  { id: 'sonnet',    label: 'Sonnet',    description: 'Balanced',          cliModel: 'sonnet',     family: 'sonnet', is1m: false },
  { id: 'sonnet-1m', label: 'Sonnet 1M', description: '1M context window', cliModel: 'sonnet[1m]', family: 'sonnet', is1m: true  },
  { id: 'haiku',     label: 'Haiku',     description: 'Fastest',           cliModel: 'haiku',      family: 'haiku',  is1m: false },
  { id: 'fable',     label: 'Fable',     description: 'Fast & capable',    cliModel: 'fable',      family: 'fable',  is1m: false },
  { id: 'fable-1m',  label: 'Fable 1M',  description: '1M context window', cliModel: 'fable[1m]',  family: 'fable',  is1m: true  },
] as const;
/** alias id → CLI --model value. Derived from SESSION_MODELS. */
export const SESSION_MODEL_CLI_MAP: Record<string, string> =
  Object.fromEntries(SESSION_MODELS.map((m) => [m.id, m.cliModel]));
/** Set of valid picker/config alias ids — use for runtime allowlist validation. */
export const VALID_SESSION_MODEL_IDS: ReadonlySet<string> =
  new Set(SESSION_MODELS.map((m) => m.id));
/** Distinct model families — used by raw-model-string parsers (formatModelName, etc.). */
export const SESSION_MODEL_FAMILIES: readonly SessionModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable'] as const;
// NOTE: there is intentionally NO default session/CLI model constant. "Auto" means
// Walnut passes no --model and Claude Code resolves its own settings-layer default.
// A session's model is a runtime (picker) choice, never a Walnut config-time default.

// NOTE: Codex (engine='codex') has NO hard-coded model catalog by design —
// models/modes are discovered at runtime from ACP capabilities. See
// docs/plan/coding-agent-acp-provider.md.

// ── Reasoning effort (maps to the `claude -p --effort <level>` CLI flag) ──
// The CLI accepts low/medium/high/xhigh/max (verified against binary 2.1.170:
// EFFORT_LEVELS = ['low','medium','high','xhigh','max']). When no --effort is
// passed the API resolves to 'high'. `xhigh` and `max` are honored only by a
// subset of models (see MODEL_EFFORT_FAMILY_DEFAULTS); the CLI silently
// downgrades an unsupported level to 'high', so we grey them out in the picker
// to keep the UI honest.
export type SessionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface SessionEffortEntry {
  /** Picker / CLI value. */
  id: SessionEffort;
  /** Display label. */
  label: string;
  /** Dropdown / tooltip description. */
  description: string;
}
export const SESSION_EFFORTS: readonly SessionEffortEntry[] = [
  { id: 'low',    label: 'Low',    description: 'Quick, minimal reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced speed & depth' },
  { id: 'high',   label: 'High',   description: 'Deep reasoning (API default)' },
  { id: 'xhigh',  label: 'X-High', description: 'Extended exploration (select models only)' },
  { id: 'max',    label: 'Max',    description: 'Deepest reasoning, no limit (select models only)' },
] as const;
/** Ordered effort ids — also the CLI-accepted values. */
export const SESSION_EFFORT_IDS: readonly SessionEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Set of valid effort ids — runtime allowlist validation. */
export const VALID_SESSION_EFFORT_IDS: ReadonlySet<string> = new Set(SESSION_EFFORT_IDS);
/** Effort level the API falls back to when no --effort flag is sent. */
export const DEFAULT_SESSION_EFFORT: SessionEffort = 'high';

/**
 * Reasoning-effort capability of a model: whether it accepts an effort level at
 * all, and whether it accepts the higher `xhigh` / top `max` levels specifically.
 * Nesting: max ⊇ xhigh ⊇ effort (a model with `max` always has `xhigh` + `effort`).
 */
export interface ModelEffortCapability {
  /** Accepts an effort parameter (low/medium/high) at all. */
  effort: boolean;
  /** Accepts the `xhigh` effort level (extended exploration). */
  xhigh: boolean;
  /** Accepts the top `max` effort level. */
  max: boolean;
}

/**
 * Per-FAMILY defaults — the fallback a model inherits when no explicit
 * per-model override matches. This is what makes the map forward-compatible:
 * a brand-new version (e.g. a surprise "opus-4-9") automatically inherits its
 * series' capabilities without a code change. Keyed by SessionModelFamily.
 *
 * Verified by decompiling the real CLI binary (2.1.170) — the two allowlists are:
 *  - xhigh (`XJH`, label "Fable 5, Opus 4.8/4.7 only"):
 *      opus-4-8, opus-4-7, fable-5, sonnet-5 (+ mythos-5) → true; everything else false.
 *  - max   (`gNH`, label "Fable 5, Opus 4.6+, Sonnet 4.6"):
 *      opus-4-6/4-7/4-8, sonnet-4-6, fable-5 (+ mythos-5) → true; else false.
 *
 * Family defaults chosen to match the FLAGSHIP/latest member of each family so a
 * surprise future version is covered generously (per-model overrides below pin
 * older members that deviate):
 *  - opus:   effort + xhigh + max (4.7/4.8 have all three; 4.6 lacks xhigh — see override).
 *  - sonnet: effort + max, xhigh only on Sonnet 5 (4.6 has max but not xhigh — see override).
 *  - fable:  effort + xhigh + max (Fable 5 has all three).
 *  - haiku:  none (fastest tier; passing --effort errors on the CLI).
 */
export const MODEL_EFFORT_FAMILY_DEFAULTS: Record<SessionModelFamily, ModelEffortCapability> = {
  opus:   { effort: true,  xhigh: true,  max: true  },
  sonnet: { effort: true,  xhigh: true,  max: true  },
  fable:  { effort: true,  xhigh: true,  max: true  },
  haiku:  { effort: false, xhigh: false, max: false },
};

/**
 * Per-MODEL overrides — ONLY list a specific version here when it deviates from
 * its family default above. Matched by case-insensitive substring against the
 * model id/string, most-specific first. Empty by default: today every shipped
 * version matches its family default, so the family table alone is correct.
 * (This is the escape hatch for "version X of family Y behaves differently" —
 * e.g. if a future Sonnet gained `max`, add `{ match: 'sonnet-4-9', max: true }`.)
 */
export const MODEL_EFFORT_OVERRIDES: ReadonlyArray<{ match: string } & Partial<ModelEffortCapability>> = [
  // Older shipping members that deviate from their family flagship (verified
  // against binary 2.1.170's XJH/gNH allowlists). Matched most-specific first.
  // Opus 4.6: has `max` but was released before `xhigh` existed.
  { match: 'opus-4-6', xhigh: false },
  // Sonnet 4.6: has `max`, no `xhigh` (xhigh arrived with Sonnet 5).
  { match: 'sonnet-4-6', xhigh: false },
  // Legacy Claude 4 pre-effort models: no xhigh, no max (only base effort, if any).
  { match: 'opus-4-5',   xhigh: false, max: false },
  { match: 'opus-4-1',   xhigh: false, max: false },
  { match: 'opus-4-0',   xhigh: false, max: false },
  { match: 'sonnet-4-5', xhigh: false, max: false },
  { match: 'sonnet-4-0', xhigh: false, max: false },
];

/** Resolve a model string/alias to which SessionModelFamily it belongs to. */
function effortFamilyOf(model: string): SessionModelFamily | undefined {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  return undefined;
}

/**
 * Full effort capability of a model (picker alias id OR raw model string).
 * Resolution order: explicit per-model override → per-family default → a
 * permissive fallback for unrecognized first-party strings (matches the CLI,
 * which defaults unknown 1P models to effort-capable). This is the single
 * source of truth behind both modelSupportsEffort and modelSupportsMaxEffort.
 */
export function modelEffortCapability(model?: string): ModelEffortCapability {
  if (!model) return { effort: true, xhigh: false, max: false };
  const m = model.toLowerCase();
  // 1) Most-specific: an explicit per-model override wins.
  const override = MODEL_EFFORT_OVERRIDES.find((o) => m.includes(o.match.toLowerCase()));
  const family = effortFamilyOf(m);
  const base: ModelEffortCapability = family
    ? MODEL_EFFORT_FAMILY_DEFAULTS[family]
    // 2) Unknown family → permissive effort (CLI defaults unknown 1P to true), no xhigh/max.
    : { effort: true, xhigh: false, max: false };
  return {
    effort: override?.effort ?? base.effort,
    xhigh: override?.xhigh ?? base.xhigh,
    max: override?.max ?? base.max,
  };
}

/**
 * Whether a model supports the effort parameter at all. Thin wrapper over the
 * capability map so the picker grey-out logic reads clearly.
 */
export function modelSupportsEffort(model?: string): boolean {
  return modelEffortCapability(model).effort;
}

/**
 * Whether a model supports the `xhigh` effort level (extended exploration).
 * Per binary 2.1.170: Fable 5, Opus 4.7/4.8, Sonnet 5 (+ Mythos 5).
 */
export function modelSupportsXhighEffort(model?: string): boolean {
  return modelEffortCapability(model).xhigh;
}

/**
 * Whether a model supports the top `max` effort level specifically. `max` is a
 * strict subset of `effort` (a model with max always has effort). We grey `max`
 * out in the picker for models whose capability map says max=false.
 */
export function modelSupportsMaxEffort(model?: string): boolean {
  return modelEffortCapability(model).max;
}

// ── Per-session model catalog (from the CLI `initialize` control request) ──
// The CLI's initialize control_response carries `models[]` — the session's TRUE
// selectable catalog: already filtered by the host's availableModels allowlist
// and already mapped through modelOverrides. Each row's `value` is the ONLY
// universally-safe string to send to set_model / --model (aliases get rejected
// under an allowlist; canonical short IDs pass validation but 400 at the wire).
// SESSION_MODELS above remains the FALLBACK for old CLIs (no initialize answer),
// the create-time picker (no session exists yet), and cron/routines (session-less).
export interface SessionModelCatalogEntry {
  /** Model identifier to switch to — send VERBATIM to set_model / --model. */
  value: string;
  /** Canonical wire model id this row's value resolves to (active-row matching). */
  resolvedModel?: string;
  /** Human-readable display name (e.g. "Fable", "Opus 4.6 (1M context)"). */
  displayName: string;
  /** Capability description shown under the name. */
  description?: string;
  /** Visible but not selectable (e.g. excluded by org policy). */
  disabled?: boolean;
  /** Whether this model accepts effort levels at all. */
  supportsEffort?: boolean;
  /** Exact effort levels the model accepts — drives the picker's effort buttons. */
  supportedEffortLevels?: SessionEffort[];
}

export function normalizeSessionModelCatalogId(model: string): string {
  return model.toLowerCase().replace(/\[1m\]$/, '').replace(/[-_]v\d+(:\d+)?$/, '');
}

/** Find the catalog row for a runtime model id. Match ORDER is load-bearing:
 *  exact value → concrete row by resolvedModel → 'default' row by resolvedModel
 *  → normalized (strips '[1m]' + provider version suffixes, which the CLI's
 *  runtime id carries but catalog values may not). A concrete row must beat the
 *  'default' row that shares its resolvedModel — 'default' means "CLI picks",
 *  and reporting it as the active row would hide the real row's effort
 *  capabilities. Reordering these steps selects the wrong active picker row. */
export function matchSessionModelCatalogEntry(
  models: SessionModelCatalogEntry[],
  model?: string | null,
): SessionModelCatalogEntry | null {
  if (!model) return null;
  const exact = models.find((entry) => entry.value === model);
  if (exact) return exact;
  const resolved = models.find((entry) => entry.value !== 'default' && entry.resolvedModel === model);
  if (resolved) return resolved;
  const defaultEntry = models.find((entry) => entry.value === 'default' && entry.resolvedModel === model);
  if (defaultEntry) return defaultEntry;
  const needle = normalizeSessionModelCatalogId(model);
  return models.find((entry) =>
    normalizeSessionModelCatalogId(entry.value) === needle
    || (entry.resolvedModel ? normalizeSessionModelCatalogId(entry.resolvedModel) === needle : false),
  ) ?? null;
}

/**
 * SESSION_MODELS rendered in catalog shape — the degraded-mode source when the
 * CLI can't answer initialize (old build / dead session / timeout). `value` is
 * the LEGACY PICKER ALIAS (e.g. 'sonnet-1m'), NOT cliModel: a fallback-mode
 * switch must round-trip through the existing alias path in
 * resolveModelSwitchValue untouched, byte-identical to today's behavior.
 */
export function sessionModelsAsCatalog(): SessionModelCatalogEntry[] {
  return SESSION_MODELS.map((m) => {
    const cap = modelEffortCapability(m.cliModel);
    const levels: SessionEffort[] = cap.effort
      ? SESSION_EFFORT_IDS.filter((e) =>
          (e !== 'xhigh' || cap.xhigh) && (e !== 'max' || cap.max))
      : [];
    return {
      value: m.id,
      displayName: m.label,
      description: m.description,
      supportsEffort: cap.effort,
      supportedEffortLevels: levels,
    };
  });
}

/**
 * Resolve a user/UI-supplied model switch value to the string handed to
 * applyModel / persisted as record.cliModel — the ONE validator shared by the
 * HTTP route (POST /:id/model) and the WS RPC (session:send). Returns null for
 * garbage (caller decides 400 vs silent-drop).
 *  - Legacy picker alias ('sonnet-1m') → its CLI mapping ('sonnet[1m]'), exactly
 *    as today, so the fallback picker and older UIs keep working.
 *  - Anything catalog-value-shaped (a CLI-provided ModelInfo.value like
 *    'global.anthropic.claude-fable-5[1m]' or 'default') → passthrough verbatim.
 *    Shape check only — the CLI is the authority on whether it's allowed; it
 *    lands in apply_flag_settings JSON and later in `--model` argv on a cold
 *    resume, hence the conservative charset.
 *
 * ── WHICH STRING TO SEND — the CLI's model-resolution pipeline in one place ──
 * (verified against CLI 2.1.199/2.1.208 binaries + live stream-json probes;
 * this is why the catalog `value` is the ONLY universally-safe switch string)
 *
 * The CLI resolves models through a 5-layer pipeline:
 *   L1 hardcoded model registry  — per-model provider IDs, e.g. opus-4-8 has
 *      bedrock:"us.anthropic.claude-opus-4-8" (only us.*; global.* cross-region
 *      profiles do NOT exist in the registry — that's what modelOverrides add)
 *   L2 picker-row generation     — rows are GENERATED from the registry (incl.
 *      which models get a "(1M context)" row via a per-model flag); a model can
 *      be switchable yet have NO row (upstream registry gaps)
 *   L3 settings.modelOverrides   — rewrites each row's value string; keys MUST
 *      exactly match the registry's first-party canonical ID (usually undated
 *      like "claude-opus-4-8", but haiku is DATED: "claude-haiku-4-5-20251001").
 *      A mismatched key is SILENTLY ignored — no error, no warning.
 *   L4 settings.availableModels  — pure FILTER over generated rows: can only
 *      remove rows, never add. An allowlist entry for a row that was never
 *      generated (L2) does nothing.
 *   L5 output                    — /model menu = initialize response models[]
 *      = what Walnut's catalog shows. set_model/--model validation is a
 *      SEPARATE path that checks the raw string against the same allowlist,
 *      so "menu lacks the row but switching works" is normal.
 *
 * THREE NAMESPACES — each settings field accepts exactly ONE form, mismatches
 * are silently ignored (no error, no warning):
 *   ┌──────────────────────────┬──────────────┬───────────────────────────────┐
 *   │ string form              │ example      │ valid in                      │
 *   ├──────────────────────────┼──────────────┼───────────────────────────────┤
 *   │ family alias             │ fable        │ model / --model / set_model   │
 *   │                          │              │ (BEST: full pipeline resolve) │
 *   │ canonical first-party ID │ claude-      │ modelOverrides KEY only       │
 *   │                          │ fable-5      │ (⚠️ haiku's is DATED; [1m]-   │
 *   │                          │              │ suffixed keys are invalid)    │
 *   │ full provider ID         │ global.anth… │ modelOverrides VALUE, and     │
 *   │                          │ fable-5[1m]  │ direct model/--model input    │
 *   └──────────────────────────┴──────────────┴───────────────────────────────┘
 *
 * Therefore a raw model string must be an ALIAS or the FINAL provider-ready ID:
 *   ✅ the modelOverrides VALUE when overrides are configured
 *      ("global.anthropic.claude-fable-5[1m]")
 *   ✅ the registry's native provider ID when they aren't
 *      ("us.anthropic.claude-opus-4-8")
 *   ⚠️ NEVER the canonical short ID ("claude-fable-5[1m]") — it passes the
 *      allowlist AND acks success AND echoes in get_settings, but goes to the
 *      wire verbatim, 400s at the provider, and silently falls back to another
 *      model ("three layers lie"). Ground truth is the assistant message's
 *      `model` field / the read-back in refreshAppliedSettings.
 * Catalog rows' `value` is already the post-override final ID — sending it
 * verbatim can never hit these traps.
 *
 * 1M-CONTEXT GOTCHAS (registry flags, verified on Bedrock 2.1.208):
 *   - `native_1m` alone only applies to the first-party API. A model is 1M on
 *     Bedrock/Vertex only with `native_1m_3p` (sonnet-5 has it; fable-5 does
 *     NOT — plain fable-5 on Bedrock is 200K, the [1m] suffix is REQUIRED).
 *   - Only models with `supports_1m_suffix` grow a "(1M context)" menu row
 *     (opus-4-x, sonnet-4-x families; fable-5/sonnet-5 don't) — so fable-1m is
 *     switchable but has NO row. Recommended user config when only the 1M
 *     variant is wanted: point the BASE key at the 1M value
 *     ("claude-fable-5": "global.anthropic.claude-fable-5[1m]") — every path
 *     (alias, menu row, default) then lands on 1M with a clean display name.
 *
 * KNOWN UPSTREAM CLI BUGS Walnut deliberately does NOT paper over (we mirror
 * the CLI's catalog truthfully; the picker's custom-ID input is the escape
 * hatch, with explicit ack errors + read-back as the safety net):
 *   1. Registry gaps → switchable models with no menu row (fable-1m above).
 *   2. Allowlist prefix-matching never strips provider prefixes, so rows whose
 *      value is an alias (Haiku's is "haiku") resolve to "us.anthropic.…" and
 *      fail entries like "claude-haiku-4-5" → row wrongly filtered. Workaround
 *      in user config: use the bare family alias ("haiku") as the entry.
 *   3. modelOverrides key mismatches are silently ignored (dated haiku key,
 *      [1m]-suffixed keys).
 * Net guarantee: Walnut's menu is exactly as correct as the customer's CLI —
 * that ceiling is structural — and the custom input + read-back cover
 * everything above it.
 */
export function resolveModelSwitchValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (VALID_SESSION_MODEL_IDS.has(trimmed)) return SESSION_MODEL_CLI_MAP[trimmed];
  if (!trimmed || trimmed.length > 256) return null;
  // Reject whitespace, quotes and control chars (shell-argv + JSON safety);
  // allow the charset real provider IDs use: letters, digits, . _ : / - [ ]
  if (!/^[A-Za-z0-9._:/\-[\]]+$/.test(trimmed)) return null;
  return trimmed;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  project: string;
  /** @deprecated Backward-compat legacy field. Before the 2-slot model, a task could
   *  accumulate unbounded session IDs. Now we use plan_session_id + exec_session_id
   *  as the source of truth (one slot per type). This array is kept for migration
   *  compatibility but is NOT actively used — do not rely on it for new features. */
  session_ids: string[];
  /** Single session slot — replaces plan_session_id + exec_session_id. */
  session_id?: string;
  /** Enrichment-only (not stored): live status of the linked session. */
  session_status?: {
    process_status: ProcessStatus;
    activity?: string;
    mode?: SessionMode;
    provider?: SessionProvider;
    engine?: SessionEngine;
    planCompleted?: boolean;
  };
  /** @deprecated Use session_id instead. Kept for backward compat during migration. */
  plan_session_id?: string;
  /** @deprecated Use session_id instead. Kept for backward compat during migration. */
  exec_session_id?: string;
  /** @deprecated Use session_status instead. Kept for backward compat during migration. */
  plan_session_status?: { process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider; engine?: SessionEngine; planCompleted?: boolean };
  /** @deprecated Use session_status instead. Kept for backward compat during migration. */
  exec_session_status?: { process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider; engine?: SessionEngine };
  parent_task_id?: string;     // If set, this is a child task of the parent
  /** Local-only virtual grouping. Tasks sharing a group_id render as ONE visual
   *  group in the list (boxed together, ordered after the group's lead task) —
   *  this is NOT a parent/subtask relationship: the tasks stay flat and fully
   *  independent (separate lifecycles). All members must share the same
   *  category + project. Never pushed to external sync backends; round-trips via
   *  the SQLite `payload` blob (not a dedicated column). The human-readable group
   *  name lives in TaskStore.task_groups. */
  group_id?: string;
  depends_on?: string[];       // Full IDs of tasks that must complete before this one
  description: string;
  /** DERIVED short text — auto-extracted from the note's "## Executive Summary"
   *  section by the turn-complete self-report flow. Kept because list views,
   *  search, sync and the frozen iOS /api/v1 contract consume a short field.
   *  Never author it directly; edit the note instead. */
  summary: string;
  /** The task's single AI-maintained living document (5 sections: Executive
   *  Summary / Goal / Context / Progress / Work Log). See session-hooks/builtins.ts. */
  note: string;
  conversation_log?: string;  // Append-only markdown log of user↔agent interactions
  // `milestones` was removed 2026-07-18 — the note's Work Log section replaced it.
  // Old data still carries the key harmlessly inside the payload blob.
  phase: TaskPhase;
  sprint?: string;
  tags?: string[];
  source: TaskSource;
  external_url?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  due_date?: string;
  /** When to START working on the task (ISO date or datetime). Drives the "Now"
   *  view: a task with a future start_date is deferred (hidden) until that time
   *  arrives. due_date is the deadline; start_date is the activation time. */
  start_date?: string;
  starred?: boolean;
  pinned?: boolean;
  pin_order?: number;  // lower = higher in list, undefined = not pinned
  focus_tier?: string;  // undefined = satellite (default); 'focus' | 'backlog' | 'wait' built-ins, or a custom tier id ('ct_*')
  needs_attention?: boolean;
  /** Last sync error message — set on push failure, cleared on success. */
  sync_error?: string;
  /** ISO timestamp — last session interaction (start/resume). Drives "Recent" sort in sidebar. */
  last_session_update?: string;
  /** Task-level working directory override. Takes precedence over project default_cwd in session resolution. */
  cwd?: string;
  /** Set by the cwd rename detector / turn-end check when task.cwd no longer exists on disk.
   *  UI surfaces a warning; cleared when cwd is updated to a valid path. */
  cwd_missing?: boolean;
  /** ISO timestamp — server-side lastModified from last successful push response.
   *  Used for echo detection on pull. Local-only, never pushed to remote. */
  _syncedAt?: string;
  /** Plugin-specific extension data. Keys are plugin IDs (e.g. 'ms-todo', 'plugin-a'). */
  ext?: Record<string, unknown>;
}

export interface CategoryRecord {
  source: TaskSource;
}

export interface TaskStore {
  /** Legacy on-disk version marker. Preserved for existing tasks.json files
   *  and tests; no live code reads it. */
  version?: 1 | 2 | 3 | 4;
  tasks: Task[];
  categories?: Record<string, CategoryRecord>;
  /** Virtual task-group name registry: group_id → { label }. Maps the local-only
   *  Task.group_id to a human-readable (AI-generated) group name. Groups with
   *  fewer than 2 live members are pruned. Local-only; never synced. */
  task_groups?: Record<string, TaskGroupRecord>;
  /** User-defined focus tiers (ordered). Ids are `ct_` + 8 base36 chars; a task's
   *  focus_tier may reference one. Tasks pointing at a deleted/unknown tier
   *  self-heal to satellite. Local-only; never synced. */
  custom_tiers?: CustomTierRecord[];
}

export interface CustomTierRecord {
  /** Stable id (`ct_` + 8 lowercase base36 chars), stored in Task.focus_tier. */
  id: string;
  /** Display name shown in pickers and Settings. */
  label: string;
}

export interface TaskGroupRecord {
  /** Human-readable group name (AI-generated on creation; user-renamable). */
  label: string;
  /** When true, the group is collapsed/hidden from the Focus (pinned) area — its
   *  members and membership are untouched, only the pinned rendering skips them.
   *  The group still renders normally on the /tasks page; unhide via a member's
   *  kebab menu. Local-only, never synced. */
  hidden?: boolean;
}

export interface CacheConfig {
  enabled?: boolean;
  pruneEnabled?: boolean;
  pruneOptions?: {
    keepLastNTurns?: number;
    softTrimThreshold?: number;
    softTrimKeep?: number;
  };
}

export type ContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log'
  | 'main_global_memory' | 'main_daily_log'
  | 'journal_recent'
  | 'working_memory';

export interface ContextSourceConfig {
  id: ContextSourceId;
  enabled: boolean;
  token_budget?: number;  // override default budget
}

export interface AgentStatefulConfig {
  /** Project memory path (e.g. "life/tracker"). */
  memory_project: string;
  /** Max tokens of memory injected per call. Default: 4000. */
  memory_budget_tokens?: number;
  /** Source tag for memory writes. Default: agent id. */
  memory_source?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  runner: 'embedded' | 'cli';
  model?: string;
  /** Provider name — maps to config.providers[name]. Falls back to subagent default. */
  provider?: string;
  region?: string;
  max_tokens?: number;
  max_tool_rounds?: number;
  system_prompt?: string;
  denied_tools?: string[];
  allowed_tools?: string[];
  working_directory?: string;
  /** Context sources to inject when invoked with a task. */
  context_sources?: ContextSourceConfig[];
  /** Stateful mode: agent accumulates persistent memory across invocations. */
  stateful?: AgentStatefulConfig;
  /** Selective list of skill directory names to inject into this agent's prompt. */
  skills?: string[];
  /** True for agents that appear in the main chat console (AgentSwitcher). */
  console?: boolean;
  source: 'builtin' | 'config';
  /** True when a config entry overrides (shadows) a builtin agent with the same ID. */
  overrides_builtin?: boolean;
}

export interface SubagentGlobalConfig {
  model?: string;
  /** Provider name for subagents. Maps to config.providers[name]. */
  provider?: string;
  region?: string;
  max_tokens?: number;
  max_concurrent?: number;
  max_tool_rounds?: number;
  denied_tools?: string[];
}

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'error';

export interface AgentRun {
  runId: string;
  agentId: string;
  task: string;
  taskId?: string;
  runner: 'embedded' | 'cli';
  status: AgentRunStatus;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
  history?: unknown[];
}

export interface AgentConfig {
  model?: string;
  region?: string;
  maxTokens?: number;
  cache?: CacheConfig;
  subagent?: SubagentGlobalConfig;
  agents?: Omit<AgentDefinition, 'source'>[];
  /** Agent ID to use for session summarization (defined in config.yaml agent.agents[]). */
  session_summarizer_agent?: string;
  /** LEGACY: agentId recognised when classifying turn-complete summary events.
   *  The triage subagent was deleted (2026-07) — session self-report + deterministic
   *  PHASE_SIGNAL lookup replaced it — so this no longer selects any agent; it only
   *  affects event classification in server.ts. */
  session_triage_agent?: string;
  /**
   * Triage throttling. Turn-complete triage trailing-debounces by `debounce_minutes`
   * (default 4) so a burst of interactive turns collapses into one end-of-interaction
   * triage. `notify_mode` gates the expensive main-agent notification:
   *   - 'off' (default): never wake the main agent; task.summary still updates (poll model)
   *   - 'buffered': don't wake in real time, but nudge the heartbeat to review soon
   *   - 'realtime': enqueue a main-agent turn immediately on each Outcome-B milestone
   */
  triage?: {
    debounce_minutes?: number;
    notify_mode?: 'off' | 'buffered' | 'realtime';
  };
  /** Predefined model IDs shown in the agent form dropdown. Supports both string[] (legacy Bedrock IDs)
   *  and ModelEntry[] (new multi-provider format). */
  available_models?: string[] | import('../agent/providers/types.js').ModelEntry[];
  /** Default reasoning-effort passed as --effort to claude CLI sessions (low/medium/high/max).
   *  Unset = let the CLI/API pick its default (resolves to 'high'). */
  session_effort?: SessionEffort;
  /** Model ID for the main AI agent. Defaults to DEFAULT_MODEL (Opus 5). */
  main_model?: string;
  /** Model ID for cheap background parses (quick-task parse, fork/conversation titles); unset = first haiku in the provider catalog. */
  fast_model?: string;
  /** Default provider name for the main agent. Maps to config.providers[name]. */
  main_provider?: string;
  /**
   * Background self-review: every N clean main-butler turns, fork the conversation
   * (same cache prefix) and let the butler review the window for skill/memory updates.
   * The counter resets when the butler used skill_manage itself during the window.
   */
  background_review?: {
    enabled?: boolean;   // default: true
    interval?: number;   // default: 10 turns
  };
}

export interface Config {
  version: 1;
  user: { name?: string };
  defaults: {
    priority: TaskPriority;
    category: string;
    /** Default platform/source for new tasks created via quick-add. Unset = 'local'
     *  (created locally, never blocks on an external sync round-trip). User picks this
     *  in Settings → General. */
    platform?: TaskSource;
    /** Optional default project for new quick-add tasks. */
    project?: string;
  };
  provider: {
    type: string;
    model?: string;
    bedrock_region?: string;
    bedrock_bearer_token?: string;
  };
  /** Multi-provider configuration. Each key is a provider name, value is protocol + auth config.
   *  When absent, auto-synthesized from legacy `provider.*` fields + env var auto-detection. */
  providers?: Record<string, import('../agent/providers/types.js').ProviderConfig>;
  agent?: AgentConfig;
  local?: {
    /** Category names reserved for local-only tasks (never synced to any external service). */
    categories?: string[];
  };
  /** Plugin configurations. Keys are plugin IDs (e.g. 'ms-todo'). Each plugin defines its own config schema. */
  plugins?: Record<string, Record<string, unknown> & { enabled?: boolean }>;
  /** External calendar display (EventKit — all macOS system-account calendars). */
  calendar?: {
    /** Master toggle. Default: true (source still reports unavailable off-macOS). */
    enabled?: boolean;
    /** Calendar ids the user hid in Settings → Calendar. */
    hidden_calendar_ids?: string[];
    /** Cache TTL / periodic refresh interval. Default: 15. */
    refresh_minutes?: number;
  };
  /** Git repos to install plugins from ("plugin store"). Each repo is cloned under
   *  ~/.open-walnut/plugin-stores/ and scanned for plugin dirs (manifest.json). */
  plugin_sources?: Array<{ url: string; ref?: string; enabled?: boolean }>;
  favorites?: {
    categories?: string[];
    projects?: string[];
    /** Vault-relative note paths (WITH .md), e.g. "PARA/foo.md". Toggled from the notes editor/tree. */
    notes?: string[];
  };
  ordering?: {
    categories?: string[];
    projects?: Record<string, string[]>;
  };
  session_server?: {
    /** Whether to use the SDK session server instead of CLI sessions. Default: false. */
    enabled?: boolean;
    /** Port for the local session server. Default: 7890. */
    port?: number;
    /** Auto-start the session server when Walnut starts. Default: true when enabled. */
    auto_start?: boolean;
  };
  hosts?: Record<string, {
    hostname: string;
    user?: string;
    port?: number;
    label?: string;
    /** Session server WebSocket URL for this host. Overrides CLI for this host. */
    session_server_url?: string;
    /** Shell snippet run before claude on remote sessions (e.g. 'source $HOME/.nvm/nvm.sh').
     *  Use to set up PATH for node managers (nvm, fnm, volta, asdf) or other env. */
    shell_setup?: string;
    /** Whether this host is enabled (shown in session path selector).
     *  Auto-discovered hosts default to true. User can toggle off to hide. */
    enabled?: boolean;
    /** Whether this host was auto-discovered from SSH config (vs manually added).
     *  Informational only — doesn't affect behavior. */
    discovered?: boolean;
  }>;
  /** Per-host maximum concurrent CLI session limits.
   *  'local' key = sessions without a host.
   *  Other keys = host aliases from config.hosts (e.g. 'devbox', 'nas-server').
   *  Default: local=7, remote hosts=20. */
  session_limits?: Record<string, number>;
  session?: {
    /** How many minutes an idle FIFO session stays alive before being auto-killed.
     *  Set to 0 to disable idle timeout entirely. Default: 30. */
    idle_timeout_minutes?: number;
    /** Maximum number of idle sessions per host before evicting the oldest.
     *  Default: local=30, remote=40. Set to 0 to disable idle limit. */
    max_idle?: number;
    /** Enable --permission-prompt-tool stdio for local sessions.
     *  When enabled, Walnut intercepts permission prompts from Claude Code
     *  (sensitive file writes, AskUserQuestion) and handles them:
     *  - Bypass mode + auto_approve_bypass: auto-approves all requests
     *  - Other modes: forwards to UI for user decision
     *  Default: true. */
    permission_prompt?: boolean;
    /** Auto-approve all permission prompts in bypass mode.
     *  Bypass = full trust: Claude can write files, run commands, etc. without asking.
     *  Default: true. Set to false to manually review every permission even in bypass. */
    auto_approve_bypass?: boolean;
    /** Which session modes are available in the mode toggle cycle.
     *  Default: all four ['default', 'bypass', 'plan', 'accept'].
     *  Set to e.g. ['bypass', 'plan'] to only cycle between those two. */
    enabled_modes?: SessionMode[];
    /** Pass --include-partial-messages to `claude -p` so the CLI emits
     *  Anthropic SSE stream_event records (token-level deltas). With this on,
     *  assistant text streams into the UI character-by-character instead of
     *  appearing all at once when the message completes.
     *  Default: true. Set to false to fall back to per-message delivery. */
    stream_partial_messages?: boolean;
  };
  heartbeat?: import('../heartbeat/types.js').HeartbeatConfig;
  tools?: {
    exec?: {
      security?: string;
      deny?: string[];
      allow?: string[];
      timeout?: number;
      max_output?: number;
    };
    slack?: { bot_token?: string; default_channel?: string };
    tts?: { provider?: string; voice?: string };
    web_search?: {
      provider?: string;
      api_key?: string;
      perplexity_api_key?: string;
      perplexity_base_url?: string;
      perplexity_model?: string;
      timeout?: number;
    };
    web_fetch?: {
      max_chars?: number;
      timeout?: number;
    };
  };
  search?: import('./embedding/types.js').EmbeddingConfig;
  git_versioning?: {
    enabled?: boolean;              // default: true
    commit_debounce_ms?: number;    // default: 30000
    push_enabled?: boolean;         // default: false
    push_interval_ms?: number;      // default: 600000 (10 min)
    push_on_session_end?: boolean;  // default: true
  };
  session_hooks?: import('./session-hooks/types.js').SessionHooksConfig;
  developer?: {
    /** Show "UI ONLY" triage messages in chat. Default: false (hidden for less noise). */
    show_ui_only_triage?: boolean;
    /** Show "UI ONLY" session result messages. Default: false. */
    show_ui_only_session?: boolean;
    /** Show "UI ONLY" session error messages. Default: false. */
    show_ui_only_session_error?: boolean;
    /** Show "UI ONLY" subagent result messages. Default: false. */
    show_ui_only_subagent?: boolean;
    /** Show "UI ONLY" heartbeat messages. Default: false. */
    show_ui_only_heartbeat?: boolean;
    /** Show "UI ONLY" agent error messages. Default: false. */
    show_ui_only_agent_error?: boolean;
  };
  ui?: {
    /** How many session panels to show side-by-side: 'auto' (breakpoint-driven) or
     *  an explicit count as a decimal string — the UI offers '1'..'5'. Default: '2'.
     *  Out-of-range or non-numeric values are ignored by the client, which falls
     *  back to auto rather than rendering a broken strip. */
    session_panels?: 'auto' | `${number}`;
  };
  /** Audio capture configuration (system audio recording) */
  audio?: {
    /** Bundle IDs of apps to exclude from recording (e.g. 'com.spotify.client') */
    exclude_apps?: string[];
    /** How often to refresh the app list during recording, in seconds (default: 60) */
    refresh_interval_sec?: number;
    /** Delete WAV after successful transcription. Default: true */
    delete_after_transcription?: boolean;
    /** Auto-delete recordings older than N days. 0 = keep forever. Default: 7 */
    retention_days?: number;
  };
  /** Speech-to-text configuration for voice input */
  stt?: {
    engine?: 'sherpa-onnx' | 'openai' | 'whisper-cpp' | 'whisper-server';
    /** ISO 639-1 language hint (e.g. zh, en). Empty = auto-detect. */
    language?: string;
    // sherpa-onnx — local (SenseVoice / Whisper / Paraformer / other ONNX models)
    sherpa_model_dir?: string;
    sherpa_model_type?: 'sense_voice' | 'whisper' | 'paraformer';
    // OpenAI-compatible — cloud (OpenAI / Groq / Fireworks etc.)
    openai_api_key?: string;
    openai_base_url?: string;
    openai_model?: string;
    // whisper.cpp — local CLI (cold start each call)
    whisper_cpp_path?: string;
    whisper_cpp_model?: string;
    whisper_cpp_vad_model?: string;
    whisper_cpp_prompt?: string;
    // whisper-server — local HTTP daemon (model stays in memory)
    whisper_server_path?: string;
    whisper_server_model?: string;
    whisper_server_vad_model?: string;
    whisper_server_prompt?: string;
    whisper_server_port?: number;
    /** Idle TTL in minutes — server auto-shuts after inactivity (default: 10) */
    whisper_server_idle_ttl_minutes?: number;
  };
  /** API keys for remote client authentication (iOS app, etc.) */
  api_keys?: ApiKeyEntry[];
  /** Registered push notification tokens for mobile clients */
  push_tokens?: PushTokenEntry[];
  /** Daemon → cloud bridge. Default: derived from the data repo's `cloud`
   *  git remote (zero-config when cloud sync is set up). Set enabled:false
   *  to opt out; url overrides the derived wss endpoint. */
  cloud_bridge?: {
    enabled?: boolean;
    url?: string;
  };
}

export interface ApiKeyEntry {
  name: string;
  key: string;
  created_at: string;
}

export interface PushTokenEntry {
  /** Expo push token (e.g. ExponentPushToken[...]) */
  token: string;
  /** Platform: ios or android */
  platform: 'ios' | 'android';
  /** Name of the API key this token is bound to */
  key_name: string;
  /** Registration timestamp */
  registered_at: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentContentBlock[];
}

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface DashboardData {
  urgent_tasks: Task[];
  today_tasks: Task[];
  recent_tasks: Task[];
  recent_sessions: SessionSummary[];
  stats: { total: number; todo: number; in_progress: number; done: number };
}

export interface SessionSummary {
  id: string;
  project: string;
  slug: string;
  summary: string;
  status: string;
  date: string;
  task_ids: string[];
}

export interface GlobalOptions {
  json: boolean;
}

export interface DisplayMessageBlock {
  type: 'thinking' | 'tool_call' | 'text';
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string;
  status?: 'calling' | 'done';
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  blocks?: DisplayMessageBlock[];
  timestamp: string;
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat' | 'quick-start';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
}

/**
 * Unified chat entry — single source of truth replacing parallel apiMessages/displayMessages.
 * - tag 'ai': model-facing message (Anthropic ContentBlock[] format). Included in model context unless compacted.
 * - tag 'ui': display-only message (notifications, cron, session results). Never sent to model.
 */
export interface ChatEntry {
  tag: 'ai' | 'ui';
  role: 'user' | 'assistant';
  content: unknown;           // Full Anthropic ContentBlock[] for 'ai', string for 'ui'
  timestamp: string;
  // For AI user messages where displayed text differs from model content (e.g. context prefix stripped)
  displayText?: string;
  // UI metadata (present on both tags, optional)
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat' | 'quick-start';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
  sessionId?: string;          // Linked session ID (e.g. embedded triage run ID)
  // Compaction marker
  compacted?: boolean;         // true = excluded from model context, kept for scroll-back
  // Per-field content hashes for task context dedup (keys like "note:{taskId}", "pm:life/tax")
  contextHashes?: Record<string, string>;
  // Unique turn ID for eager-persist dedup (prevents double-write on error paths)
  turnId?: string;
}

export interface ChatHistoryStore {
  version: 1 | 2;
  lastUpdated: string;
  compactionCount: number;
  compactionSummary: string | null;
  // v1 fields (kept for migration detection)
  apiMessages?: unknown[];
  displayMessages?: DisplayMessage[];
  // v2 field
  entries?: ChatEntry[];
}

/**
 * Metadata for one conversation under an agent. The conversation's actual
 * messages live in a separate ChatHistoryStore file ({conversationId}.json);
 * this is the lightweight registry entry used for listing/sorting/distill.
 */
export interface ConversationMeta {
  id: string;                          // 'conv-<uuid>'
  agentId: string;
  title: string;                       // auto from 1st user msg (≤60 chars), renameable
  createdAt: string;                   // ISO
  lastMessageAt: string;               // ISO — sort key (desc)
  messageCount: number;                // logical message count (approx, for display)
  pinned?: boolean;
  /** Exactly ONE conversation per agent is the "main" one (invariant). It receives
   *  background/system notifications (cron, heartbeat, triage, subagent results) and
   *  cannot be deleted via the UI. */
  isMain?: boolean;
  /** LEGACY (distiller removed 2026-07): kept for on-disk index.json compatibility; always null/0 for new data. */
  lastDistilledAt: string | null;
  lastDistilledMessageCount: number;
  /** True once the title has been set by the LLM auto-titler OR by a manual rename.
   *  Gates one-shot auto-titling so we neither re-label nor clobber a user's title. */
  titleAutoGenerated?: boolean;
}

/** Per-agent conversation registry, persisted as _index.json. */
export interface ConversationIndex {
  version: 1;
  activeConversationId: string | null; // currently-selected conversation for this agent
  conversations: ConversationMeta[];   // sorted lastMessageAt desc by convention
}

export type ProcessStatus = 'running' | 'idle' | 'stopped' | 'error';
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';
/** Which coding-agent CLI binary backs a 'cli' session (claude-code vs codex vs future engines). */
export type SessionEngine = 'claude' | 'codex';
export type SessionType = 'interactive' | 'triage' | 'hook' | 'cron' | 'subagent';

export type StatusReason =
  /** Record seeded by a start route before the CLI process exists (its id was
   *  pre-assigned so the UI can open the real panel immediately). Marks the row
   *  as "no pid YET" so liveness checks don't mistake it for a dead process. */
  | 'awaiting_spawn'
  | 'session_started'
  | 'turn_completed'
  | 'message_sent'
  | 'normal_completion'
  | 'idle_timeout'
  | 'idle_eviction'
  | 'server_restart'
  | 'process_exited_no_result'
  | 'remote_unreachable'
  | 'api_error'
  | 'liveness_check_failed'
  | 'orphan_no_pid'
  | 'daemon_reported_exit'
  | 'daemon_reconnected'
  | 'retry_reconnect'
  | 'reconciled_authoritative'
  | 'streaming_evidence_self_heal'
  | 'turn_interrupted'
  | 'user_stopped';

export type StatusChangedBy =
  | 'health-monitor'
  | 'reconciler'
  | 'session-runner'
  | 'subagent-runner'
  | 'daemon'
  | 'user'
  | 'system';

export interface StatusTransition {
  timestamp: string;
  process_status: ProcessStatus;
  reason: StatusReason;
  changed_by: StatusChangedBy;
  message?: string | null;
}

/**
 * Complete, versioned session status projection.
 *
 * `sessionId` is the provider session ID (`claudeSessionId` on SessionRecord).
 * Every session:status-changed event and status hydration response carries this
 * full shape so clients can compare revisions instead of merging partial state.
 */
export interface SessionStatusSnapshot {
  sessionId: string;
  taskId: string | null;
  process_status: ProcessStatus;
  activity: string | null;
  mode: SessionMode;
  planCompleted: boolean;
  archived: boolean;
  errorMessage: string | null;
  provider: SessionProvider;
  engine: SessionEngine;
  statusRevision: number;
  statusUpdatedAt: string;
}

/** Stable subset of ACP initialize capabilities used by routes and UI guards. */
export interface AcpSessionCapabilities {
  loadSession: boolean;
  promptImages: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  listSessions: boolean;
  deleteSession: boolean;
  additionalDirectories: boolean;
  forkSession: boolean;
  resumeSession: boolean;
  closeSession: boolean;
}

export interface SessionRecord {
  claudeSessionId: string;
  taskId: string;
  project: string;
  process_status: ProcessStatus;
  mode: SessionMode;
  provider?: SessionProvider;
  /** Which coding-agent CLI backs this session. Only set when provider='cli'. Undefined = 'claude' (default). */
  engine?: SessionEngine;
  /** ACP sessions only: immutable runtime id keying the daemon worker + journal
   *  (claudeSessionId holds the provider's ACP session id, which is what
   *  session/load needs — both are required to re-attach after a restart). */
  acpRuntimeId?: string;
  /** ACP journal location on the execution host. Persisted because test/demo
   *  daemons may use an isolated streams directory instead of the default. */
  acpJournalPath?: string;
  /** Capability snapshot from the adapter's initialize response. */
  acpCapabilities?: AcpSessionCapabilities;
  /** ACP sessions only: current base model selected through session/set_config_option. */
  acpModel?: string;
  /** ACP sessions only: last values successfully applied through session/set_config_option. */
  acpConfig?: Record<string, string>;
  /** Idempotency key of the most recently committed ACP prompt acceptance. */
  lastAcceptedAcpCommandId?: string;
  /** Session type — determines lifecycle and cleanup behavior. Undefined = 'interactive'. */
  type?: SessionType;
  activity?: string;
  last_status_change?: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  cwd?: string;
  host?: string;
  /** Full hostname resolved from config.hosts (for display tooltips). Not persisted. */
  hostname?: string;
  title?: string;
  description?: string;
  pid?: number;
  outputFile?: string;
  planFile?: string;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
  /** Source session ID when this session was forked from another session. */
  forkedFromSessionId?: string;
  human_note?: string;
  /** Claude model used by this session (e.g. "claude-opus-4-6"). Display only. */
  model?: string;
  /** CLI model string passed to --model (e.g. "opus[1m]"). Preserves [1m] suffix for resume. */
  cliModel?: string;
  /** REQUESTED reasoning-effort level (low/medium/high/xhigh/max) — what the user/config
   *  asked for. Set live via apply_flag_settings control_request; persisted for cold
   *  --resume --effort fallback. NOTE: this is intent, not ground truth — the CLI can
   *  silently override it (env CLAUDE_CODE_EFFORT_LEVEL) or downgrade an unsupported
   *  level to 'high', and still ACK success. For what the model ACTUALLY uses, see
   *  `effectiveEffort` below. */
  effort?: SessionEffort;
  /** TRUE runtime effort as reported by the CLI's get_settings (`applied.effort`),
   *  read back at session start, each turn-end, and after every effort change. This is
   *  the authoritative value the model actually uses — it already reflects env overrides
   *  and model downgrades. The badge shows this (falling back to `effort`, then the API
   *  default). Undefined until the first successful read-back (or on an old CLI that
   *  doesn't answer get_settings). May legitimately differ from `effort` (= override). */
  effectiveEffort?: SessionEffort;
  /** Archived — hidden from UI but data preserved. */
  archived?: boolean;
  /** Why this session was archived (e.g. "plan_executed", user-provided reason). */
  archive_reason?: string;
  /** Plan text stored on execution session (from the archived plan session). */
  planContent?: string;
  /** Session gist for search indexing. Backfilled for free from the task summary by
   *  turn-complete triage (the dedicated full-transcript LLM summarizer was removed). */
  summary?: string;
  /** ISO timestamp of last summary backfill. */
  summaryGeneratedAt?: string;
  /** ONE-LINE recap of the session's latest turn(s) — "what just happened here".
   *  Written by the turn-complete self-report (same pass as the note update, zero
   *  extra cost); shown as a small tip under the session in the UI so the user
   *  doesn't have to re-read a long transcript to re-orient. */
  recap?: string;
  /** ISO timestamp of the last recap update. */
  recapAt?: string;
  /** Error message when process_status is 'error' — persisted for post-mortem display. */
  errorMessage?: string;
  /** Why the last process_status change happened (K8s condition style). */
  status_reason?: StatusReason;
  /** Who triggered the last process_status change. */
  status_changed_by?: StatusChangedBy;
  /** Recent status transitions, newest first. Max 10 entries. */
  status_history?: StatusTransition[];
  /** Monotonic version of the canonical SessionStatusSnapshot projection. */
  statusRevision?: number;
  /** ISO timestamp at which statusRevision last changed. */
  statusUpdatedAt?: string;
  /** Pending permission request — persisted so it survives server crashes.
   *  Set when Claude Code emits control_request, cleared on resolve. */
  pendingPermission?: {
    requestId: string;
    subtype?: string;     // control_request subtype (e.g. 'can_use_tool')
    toolName?: string;
    input?: Record<string, unknown>;
    reason?: string;
    receivedAt: string;  // ISO timestamp — for stale detection
  };
  /** Consumed-offset watermark: byte position (the daemon's `v`) of the last
   *  turn-lifecycle event this server PROCESSED (result handled / turn completed).
   *  Survives restarts so replay-vs-new is decided by position, not by a boolean:
   *  a replayed result with v > this was never processed and must go through
   *  (incident 10e7df54 — the resultEmitted proxy lied and swallowed a real
   *  result forever). Monotonic: writes only ever advance it. Reset (cleared)
   *  on session-ID rename — the new stream file has its own coordinates.
   *  Number.MAX_SAFE_INTEGER is a transport-layer sentinel and must NEVER be
   *  persisted here. */
  consumedOffset?: number;
}
