/**
 * DraftSessionPanel — an EMPTY session column the user just opened with "+".
 *
 * Nothing exists server-side yet (0 bytes): column, cwd/host, project, launch
 * meta and text are pure client state until a send (→ `pending:` → real session)
 * or "Save as todo" (→ a task); closing leaves no trace. Same chrome
 * classes as SessionPanel/PendingSessionPanel. Imported normally (never
 * React.lazy): instant-open cannot wait on a chunk fetch.
 *
 * Layout (top → bottom) — the approved v4 shape, everything stacked upward from
 * the composer, because a normal chat has NO folder/project controls inside it:
 *   header             title + Draft badge + (bound task: its real task kebab) + ✕
 *   body               nothing but one centered muted line of "what happens next"
 *   DraftLaunchBar     quick-access folder chips, then the decision chips row
 *                      (every tier / priority / date Walnut or the user decided),
 *                      then the bar: cwd pill, project pill, More. The folder
 *                      picker POPS OUT over the page (fixed, anchored to the cwd
 *                      pill; a ~300px column can't contain it)
 *   composer           shared ChatInput; its controls row holds the model select
 *                      and "Save as todo". Its send arrow (Enter) is the one way
 *                      to START: the old "Start ↵" twin was removed on 2026-09-29
 *                      (it did the same thing). Mod+. here opens the More menu.
 *
 * Row shape, launch-memory and field-ownership rules live in ./draft-column and
 * ./draft-ownership (shared with MainPage). This panel only delivers parses with
 * their kind ('eager' / 'trailing' / 'clear') and never imports the chip row or
 * its menu itself: DraftLaunchBar owns both.
 *
 * ZERO NETWORK on open is a hard requirement of this design, so everything the
 * bar reads is either client state or the working-dirs MODULE CACHE
 * (`peekWorkingDirs`, warmed once by MainPage on mount) — never a fetch from here.
 * Two documented exceptions, both background SWR that gate nothing:
 *   - the model dropdown subscribes to the host model-catalog store, whose
 *     `subscribe` kicks a GET /api/sessions/host-model-catalogs when the last
 *     hydrate is >30s old (rows render instantly from the localStorage-seeded
 *     cache, else the static registry);
 *   - the slash-command palette (useSlashCommands) revalidates
 *     GET /api/slash-commands for the draft's cwd/host — globally cached, so the
 *     common keys are warm; until it lands "/" simply shows nothing.
 * Nothing LAUNCH-critical — working-dirs, list-dirs, tasks, quick-start — is
 * ever touched on open.
 */

import { formatModelName } from '@/utils/model-name';
import { usePhoneLayerWithBar } from './phone-session-layer';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { ImageAttachment } from '@/api/chat';
import { quickParseTask, updateTask, fetchTask } from '@/api/tasks';
import { useQuickParseEnabled, setQuickParseEnabled, ensureQuickParseLoaded } from '@/hooks/useQuickParse';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { DraftLaunchBar } from './DraftLaunchBar';
import { HostGateErrorBar, useRestoreImages, type DraftGateError } from './HostGateErrorBar';
import { useModelOptions } from './path-selector/model-options';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { useClaudeLaunchMode } from '@/hooks/useClaudeLaunchMode';
import { nextSessionMode } from './session-mode-cycle';
import { DEFAULT_SESSION_MODE, SESSION_EFFORTS, SESSION_MODES, modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXhighEffort, SESSION_MODE_LABELS, type SessionEffort, type SessionEngine, type SessionMode } from '@open-walnut/core';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useHostEngineAvailability } from '@/hooks/useHostEngineAvailability';
import {
  engineEntry,
  hostEngineLockReason,
  launchEngineForHost,
  normalizeEngine,
  resolveEngine,
  resolveEngineForHost,
} from '@/utils/engines';
import { DraftFallbackNotice, draftFallbackPill, useDraftFallback } from './DraftFallbackNotice';
import { ModelPicker, shortAcpModelName } from './ModelPicker';
import { useAcpModelName } from './engine-default-model';
import { LaunchSourceNote } from './LaunchSourceNote';
import { useFallbackModels } from '@/components/settings/sections/FallbackEngineRow';
import { engineName } from '@/components/settings/sections/DefaultEngineRow';
import { useProjectLaunchDefaults } from '@/hooks/useProjectRegistry';
import {
  defaultEngineRuns, draftLaunchChoice, draftLaunchPayload, launchSourceRows, unnamedLaunchIsNotClaude, useGlobalDefaultEngine, type LaunchSourceRow,
} from '@/utils/launch-source';
import { fetchEngineModelCatalog } from '@/api/sessions';
import {
  draftComposerKey, type DraftColumn, type DraftParseInput, type DraftParseKind, type DraftTaskField,
  type DraftTaskFieldPatch,
} from './draft-column';
import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';
import { GENERAL_AGENT_ID } from '@/components/chat/ask-walnut-slot-model';
import { TaskQuickActions } from './TaskQuickActions';
import * as ICONS from '@/components/common/Icons';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import '@/styles/walnut-agent.css';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { useFocusRequest } from '@/utils/focus-when-shown';
import { repairHint, type WalnutRepairTarget } from '@/pages/repair-target';

/** Files attached before the session exists (api/file-upload.ts). */
const NO_SESSION_YET = {} as const;
import { orgDisplayTitle } from '@open-walnut/org-tree';

const PLACEHOLDER = 'What should this session do?';
const HINT = 'Nothing runs yet: send to start, or save it as a todo.';
const BOUND_HINT = 'Start a session on this task: type the first instruction, or send with nothing typed to use its title.';
/** A project lead's column: what the lead is, so the first message is a chat, not a task brief. */
function orgLeadHint(title: string | undefined, project: string | undefined): string {
  const who = title ? leadShown(title) : 'This VP';
  return project
    ? `${who} leads ${project}: it reads the project's tasks and reports to the CEO. Ask how it is going, or hand it work.`
    : `${who} reads its project's tasks and reports to the CEO. Ask how it is going, or hand it work.`;
}
/** A lead's title as shown ("Walnut lead" reads "Walnut VP"); the draft keeps the real one, which
 *  may become the first message. */
const leadShown = (title: string) => orgDisplayTitle({ title, org_role: 'lead' });
const BOUND_WALNUT_HINT = 'Ask a quick question about this task: type what you need, or send with nothing typed to use its title.';
const FORK_HINT = 'Forks the source conversation into a sibling session: type where it should go next, or send with nothing typed to just branch.';
const FORK_PLACEHOLDER = 'Message for the forked session (optional)';
const WALNUT_PLACEHOLDER = 'Ask a quick question…';
/** The general agent's draft name: the header, the mode card and the send button's title. */
const QUICK_QUESTION = 'Quick question';
/** "Customize Walnut" (the repair draft): the guidance the old chat-anchored repair bar carried. The draft
 *  otherwise looks exactly like an ordinary new session, so nothing would tell the
 *  user their sentence is about to be read as a bug report. */
const REPAIR_PLACEHOLDER =
  'Describe what to change or fix, e.g. "sessions panel keeps spinning". Paste a screenshot (⌘V) to help.';

/** The Ask Walnut tab's quick actions: Walnut's one-tap composer seeds.
 *  Prefill only, never auto-send: the user finishes the sentence (or edits it)
 *  and presses Ask themselves. The inserted text must MATCH the label: a chip
 *  that inserts less than it promises reads as a bug. Every label is whole words:
 *  the first starts a sentence for the user to finish (its text ends in a space),
 *  and its label says what it is for rather than showing the unfinished sentence,
 *  which read as cut off with an ellipsis and as a form with a drawn blank
 *  (reviews 2026-11-06, a 400 px side panel); the other two are complete asks.
 *  Line icons, not emoji, like every other control. */
/** `iconName` names the icon in words, for a drawing of this composer elsewhere (the browser
 *  extension's placeholder, web/src/popout/ext-snapshot.ts), which carries text only. */
const WALNUT_SUGGESTS: readonly { label: string; icon: ReactNode; iconName: string; text: string }[] = [
  { label: 'Find a task', icon: ICONS.ICON_SEARCH, iconName: 'search', text: 'Find a task about ' },
  { label: 'Schedule my day', icon: ICONS.ICON_CALENDAR, iconName: 'calendar', text: 'Schedule my day' },
  { label: 'What ran today', icon: ICONS.ICON_SECTION_RECENT, iconName: 'clock', text: 'What ran today?' },
];

/** Trailing debounce after the user pauses. Shorter than QuickTaskComposer's
 *  500ms because the draft also parses DURING typing (see PARSE_THROTTLE_MS) —
 *  this one only finalizes the sentence. */
const PARSE_DEBOUNCE_MS = 350;
/** While the user keeps typing, fire an eager parse at most this often. A pure
 *  trailing debounce never fires until the FIRST pause, so on a long sentence
 *  the pills stayed empty the whole time — the suggestions should be appearing
 *  while the sentence is still being written. */
const PARSE_THROTTLE_MS = 900;
/** Don't ask the model about fewer characters than this — "fix" says nothing
 *  about project or tier, and the eager path would burn a call per draft on it. */
const PARSE_MIN_CHARS = 12;
/** POST /api/tasks/quick-parse rejects >500 chars (400). A draft composer holds a
 *  whole briefing, so the request carries the OPENING of it — the project/tier
 *  signal is in the first sentence, and a 400 would just mean no suggestions. */
const PARSE_MAX_CHARS = 500;

/** Engine catalogs already prefetched this page load (`engine|cwd`) — one
 *  probe warm-up per target is plenty; the server holds the real cache. */
const prefetchedEngineCatalogs = new Set<string>();

/** The picked effort kept across a model pick only while that model takes it; Auto keeps it
 *  (the CLI lowers a level its default model lacks). */
function effortFor(model: string, effort: SessionEffort | undefined): SessionEffort | undefined {
  if (!effort || !model || model === 'default') return effort;
  if (!modelSupportsEffort(model)) return undefined;
  if (effort === 'xhigh' && !modelSupportsXhighEffort(model)) return undefined;
  if (effort === 'max' && !modelSupportsMaxEffort(model)) return undefined;
  return effort;
}

/**
 * DraftModelPill — the draft composer's model control: a pill (same classes as
 * a real session's model pill) opening the SHARED two-pane picker
 * (provider rail | models). One pattern everywhere; on a draft EVERY available
 * provider is clickable (the engine is still a choice here), and picking an ACP
 * engine clears the model (ACP discovers models at session start).
 */
function DraftModelPill({ meta, onMetaChange, host, cwd, walnut, fork, fallbackLabel, fallbackEngine, fallbackModel, sourceNote }: {
  meta: QuickStartTaskMeta;
  onMetaChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  host?: string | null;
  /** Draft folder — the ACP engine probe runs there (per-project provider config). */
  cwd?: string;
  /** Ask Walnut: the profile rides the CLI's system-prompt flags, so only the
   *  claude engine can carry it — other providers render locked with that reason. */
  walnut?: boolean;
  fork?: boolean;
  /** "Codex (fallback)": the launch starts on the fallback engine (DraftFallbackNotice). */
  fallbackLabel?: string | null;
  /** The engine that fallback runs on: the picker opens on its models. */
  fallbackEngine?: SessionEngine | null;
  /** The model the fallback runs (the setting's), ticked on its tab; none = its default row. */
  fallbackModel?: string;
  /** Where the engine, model and mode come from (the picker's top note); absent = say nothing. */
  sourceNote?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The provider tab the picker shows while the launch is on the fallback: it opens on the
  // fallback's models (what runs), and a click on the draft's own tab only looks, it changes
  // nothing. null = the draft's own engine, as always.
  const [fallbackView, setFallbackView] = useState<SessionEngine | null>(null);
  // The clicked pill — anchor for the popout picker (portalled, clip-proof).
  const pillRef = useRef<HTMLElement | null>(null);
  const { options, autoResolved } = useModelOptions(host);
  const catalog = useEngineCatalog();
  // What the draft's host can run: an engine it lacks is greyed out in the rail.
  const hostEngines = useHostEngineAvailability(host);
  // The engine that will actually launch — a remote tab launches the default
  // engine for one that runs on this Mac only (quick-start drops a stale flag).
  // Same rule as MainPage's launch payload: resolveEngineForHost.
  // Walnut mode pins claude outright: the launch payload drops meta.engine, so
  // showing a remembered ACP engine here would be the pill lying about launch.
  const engine = walnut ? 'claude' : resolveEngineForHost(meta.engine, host, catalog);
  const entry = engineEntry(catalog, engine);
  // ACP engines: the server probes the engine's adapter for its catalog, so a
  // draft picks a real model up front (launch wires it through acpConfig).
  // No pick yet → the pill shows the ENGINE (its default model launches).
  const acpModels = entry.capabilities.modelCatalog === 'provider-advertised';
  // PREFETCH the engine's catalog when an ACP engine lands on the draft — the
  // probe takes up to 15s cold, and warming the server cache here turns the
  // picker's first open from "Loading…" into an instant list. Shaped so it
  // can never crowd the browser's 6-connection fetch pool: debounced (a cwd
  // being typed fires nothing), deduped per engine+cwd per page load (also
  // absorbs StrictMode double-mount), and aborted client-side after 4s — the
  // SERVER probe keeps running and still lands in the cache, which is the
  // whole point; the picker's own fetch reads it from there.
  useEffect(() => {
    if (!acpModels) return;
    const key = `${engine}|${cwd ?? ''}`;
    if (prefetchedEngineCatalogs.has(key)) return;
    const timer = window.setTimeout(() => {
      prefetchedEngineCatalogs.add(key);
      fetchEngineModelCatalog(engine, cwd || undefined, { timeoutMs: 4_000 })
        .catch(() => { /* picker shows the real error */ });
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [acpModels, engine, cwd]);
  // 'default' is walnut mode's EXPLICIT Auto (see onSwitch below): shown as
  // Auto, sent as 'default' so the server can tell "reset to Auto" from "no
  // pick" (which launches on the Ask Walnut launch memory instead).
  const isAuto = !meta.model || meta.model === 'default';
  const selectedLabel = !isAuto
    // A remembered id the option list does not carry (yet) reads as a model
    // name, never as a provider id like "global.anthropic.claude-..." (N10).
    ? options.find((o) => o.value === meta.model)?.label ?? formatModelName(meta.model)
    : autoResolved ? `Auto (${autoResolved})` : 'Auto';
  // Named as the picker's row and a running session's composer name it (the engine's own name).
  const acpModelName = useAcpModelName(engine, cwd || undefined, meta.model, acpModels);
  const acpPillLabel = meta.model ? acpModelName ?? shortAcpModelName(meta.model) : entry.displayName;
  const viewing = fallbackView && fallbackLabel ? fallbackView : null;
  // The launch runs Auto: no model picked, or one the fallback takes over (a remembered model).
  const runsAuto = isAuto || !!fallbackLabel;
  const pickerEngine = viewing ?? engine;
  const pickerAcp = engineEntry(catalog, pickerEngine).capabilities.modelCatalog === 'provider-advertised';
  // Reasoning effort is a Claude Code spawn flag (--effort): offered while the draft launches on
  // it, and shown on the pill once picked. No pick = no flag, so the CLI's own settings decide.
  // A fork keeps its source session's settings (the fork route takes no effort).
  const effortOffered = !fork && !viewing && !fallbackLabel && !pickerAcp && engine === 'claude';
  const pickedEffort = effortOffered ? meta.effort : undefined;
  const pickEffort = (effort: SessionEffort | undefined) => {
    setOpen(false);
    backToComposer();
    onMetaChange((m) => ({ ...m, effort }));
  };
  // A pick or Escape hands the caret back to the draft's composer, so the next key types the prompt
  // (it stayed on the pill). A close that put focus somewhere else (a click on another field) keeps it.
  // It runs in the event that closes the menu, never a frame later: on a busy main thread a frame
  // can be long in coming, and the caret sat on the pill meanwhile.
  const backToComposer = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== pillRef.current && !active.closest('.model-picker')) return;
    pillRef.current?.closest('.draft-session-panel')?.querySelector<HTMLTextAreaElement>('textarea.chat-input-textarea')?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill draft-model-select"
        title={fallbackLabel
          ? `${fallbackLabel}: the default engine is out of usage here, so this task starts on the fallback. Pick a model or provider to choose for yourself.`
          : acpModels
          ? `${entry.displayName} (via ACP) — session model: ${meta.model ? acpPillLabel : `${entry.displayName} default`}. Click to switch model / provider.`
          : `Session model: ${selectedLabel} — click to switch model / provider`}
        data-model={meta.model ?? ''}
        data-effort={pickedEffort ?? ''}
        onClick={(e) => {
          pillRef.current = e.currentTarget;
          setFallbackView(fallbackLabel && fallbackEngine && fallbackEngine !== engine ? fallbackEngine : null);
          setOpen((v) => !v);
        }}
      >
        {fallbackLabel ?? (acpModels ? acpPillLabel : selectedLabel)}
        {pickedEffort && (
          <span className="session-detail-effort-badge" title={`Reasoning effort: ${pickedEffort} (the session starts with --effort ${pickedEffort})`}>
            {' · '}{SESSION_EFFORTS.find((e) => e.id === pickedEffort)?.label ?? pickedEffort}
          </span>
        )}
      </button>
      {open && (
        <ModelPicker
          // On the fallback, what runs is Auto's: a remembered model is not the current one.
          currentModel={runsAuto ? undefined : meta.model}
          host={host ?? undefined}
          cwd={cwd}
          engine={pickerEngine}
          {...(sourceNote ? { sourceNote } : {})}
          onSwitch={(model) => {
            setOpen(false);
            backToComposer();
            // Auto ('' from the picker) is `undefined` on a folder draft. In
            // walnut mode it is the sentinel 'default': the launch memory is
            // applied server-side to a launch that names NO model, so a
            // hand-picked Auto must be spelled out or it could never win.
            onMetaChange((m) => ({ ...m, model: model || (walnut ? 'default' : undefined), effort: effortFor(model, m.effort) }));
          }}
          onClose={() => { setOpen(false); backToComposer(); }}
          {...(effortOffered ? {
            currentEffort: meta.effort,
            onEffortSwitch: (effort: SessionEffort) => pickEffort(effort),
            // A draft has no session to read a level from: "Default" is the honest no-pick row.
            onEffortDefault: () => pickEffort(undefined),
            // Ask Walnut's launch without a level takes its remembered one (else medium), not the CLI's.
            effortDefaultTitle: walnut
              ? 'No level picked here: the quick question starts at the level its last one used (medium the first time)'
              : 'No --effort at start: Walnut\'s session effort setting when set, else Claude Code\'s own settings decide',
          } : {})}
          // A draft can still change provider — flipping clears the model: the
          // catalogs don't overlap, and an ACP engine has no pre-start rows.
          onProviderSwitch={(provider) => {
            // On the fallback's tab: the draft's own tab is only a look (the launch stays Auto).
            if (viewing && resolveEngine(provider) === engine) { setFallbackView(null); return; }
            if (viewing && resolveEngine(provider) === viewing) return;
            setFallbackView(null);
            // The effort goes with it: a Claude Code flag, and another engine carries its own.
            onMetaChange((m) => ({ ...m, engine: normalizeEngine(provider), model: undefined, effort: undefined }));
          }}
          providerLockReason={(provider) => (fork && provider !== engine
            ? 'A fork keeps the source session provider'
            : walnut && provider !== 'claude'
              ? 'A quick question runs on the claude engine (the Personal AI profile rides its system prompt)'
              : hostEngineLockReason(engineEntry(catalog, provider), host, hostEngines))}
          // While Auto starts on the fallback, its row says so ("Auto (Codex, fallback)").
          autoRow={{ resolvedLabel: fallbackLabel ? fallbackLabel.replace(/ \(fallback\)$/, ', fallback') : autoResolved, active: runsAuto }}
          // ACP draft: selection lands in meta.model (same field the claude
          // pane uses — the launch payload already carries it) and rides the
          // spawn as acpConfig. '' = back to the engine's default.
          acpCurrentModelId={viewing ? fallbackModel : pickerAcp ? meta.model : undefined}
          {...(viewing ? { acpCurrentNote: 'fallback' } : {})}
          onAcpSwitch={(modelId) => {
            // A model picked on the fallback's tab is the user's own launch on that engine; its
            // default row is what Auto already runs.
            if (viewing) {
              if (modelId && modelId !== fallbackModel) onMetaChange((m) => ({ ...m, engine: normalizeEngine(viewing), model: modelId, effort: undefined }));
              return;
            }
            onMetaChange((m) => ({ ...m, model: modelId || undefined }));
          }}
          anchorRef={pillRef}
        />
      )}
    </>
  );
}

/**
 * DraftModePill — the permission mode the session will START in, in the same
 * spot and dress as a running session's mode pill (`.mode-toggle-pill`, Plan in
 * amber, "⇧Tab" hint). Before any pick it reads the launch default (Bypass),
 * because that is what the spawn does with no mode; a click or Shift+Tab steps
 * through the enabled cycle (Settings › Sessions). A user who starts a task
 * could not see, let alone choose, whether it would run with full trust or in
 * Plan mode until the session was already up (2026-10-01).
 */
function DraftModePill({ mode, onCycle, nextMode, source }: {
  mode: SessionMode;
  nextMode: SessionMode;
  onCycle: () => void;
  /** Where the mode comes from (its project's default, the global one): said in the title, and a
   *  project's default also on the pill. */
  source?: LaunchSourceRow;
}) {
  const label = (SESSION_MODE_LABELS as Record<string, string>)[mode] ?? mode;
  const description = SESSION_MODES.find((m) => m.id === mode)?.description;
  return (
    <button
      type="button"
      className={`mode-toggle-pill draft-mode-pill${mode === 'plan' ? ' plan-active' : ''}`}
      data-mode={mode}
      title={`Starts in ${label} mode${description ? ` (${description.toLowerCase()})` : ''}${source ? `: ${source.words.charAt(0).toLowerCase()}${source.words.slice(1)}` : ''}. Click or Shift+Tab to cycle → ${(SESSION_MODE_LABELS as Record<string, string>)[nextMode] ?? nextMode}`}
      data-source={source?.source}
      aria-label={`Permission mode: ${label}`}
      onClick={onCycle}
    >
      <span className="mode-toggle-pill-label">{label}</span>
      <span className="mode-toggle-pill-shortcut">{'⇧'}Tab</span>
    </button>
  );
}

interface Props {
  draft: DraftColumn;
  /** Focus the composer after mount (the column that "+" just opened). */
  autoFocus?: boolean;
  /** Start the session. MUST resolve `false` (never return a bare SYNC `false`)
   *  when the text has to be kept: ChatInput's `dispatchSend` restores the draft
   *  only on a PROMISE resolving false — a sync falsy return takes the `else`
   *  branch and CLEARS the persisted draft, losing the user's text. */
  onStart: (draftId: string, text: string, images?: ImageAttachment[], opts?: { overrideReadiness?: boolean }) => Promise<boolean>;
  /** Turn the composed text into a task instead (first line = title). May be
   *  async; the owner handles its own success/failure UI. */
  onSaveAsTask: (draftId: string, text: string) => void | Promise<void>;
  onClose: (draftId: string) => void;
  /** Phone layout: the open column over home, a 'draft:<id>' layer (back closes it). */
  phoneLayer?: boolean;
  /** Rendered before the title — the host surface's own control (the Ask Walnut
   *  slot's session switcher), so the draft header reads like the session header
   *  it is about to become. */
  headerLeading?: ReactNode;
  /** A folder pick. `openedMeta` is the meta the full picker opened with (what it
   *  returns is rebased per field against it); a quick folder chip omits it. */
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta, openedMeta?: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  /** Model / engine edit from the composer's model pill. Takes an UPDATER (not a
   *  value) so rapid clicks fold onto the freshest row instead of a props
   *  snapshot; the owner flips `metaTouched` (the folder launch memory) here.
   *  `touched`: the latch's value after the edit (default true). false hands the pair back
   *  to the defaults (Use the fallback, Use project defaults): a launch that names nothing
   *  lets the server decide. */
  onMetaChange: (draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta, opts?: { touched?: boolean }) => void;
  /** The composer's mode pill picked the permission mode the session starts in.
   *  Separate from onMetaChange on purpose: a mode pick is not a model/engine
   *  pick, so the owner must NOT flip `metaTouched` (the folder's remembered
   *  model keeps following the folder). Omit and the pill never renders. */
  onModeChange?: (draftId: string, mode: SessionMode) => void;
  /** A task-field edit from More or a decision chip: the owner makes those fields
   *  the user's. Omit (with onReturnFieldToWalnut) to draw no More and no chips. */
  onTaskFieldChange?: (draftId: string, patch: DraftTaskFieldPatch) => void;
  /** "Use Walnut's pick": give one field back to the AI. */
  onReturnFieldToWalnut?: (draftId: string, field: DraftTaskField) => void;
  /** Registry membership (case-insensitive) — the launch bar badges a project
   *  that doesn't exist yet ("new"), e.g. the folder-derived default. */
  isKnownProject: (name: string) => boolean;
  /** A landed background parse of the composer text, with its kind: 'eager'
   *  (a prefix, may only add or change), 'trailing' (the sentence as it stands),
   *  or 'clear' with `{}` (the composer stayed empty for a debounce). The owner
   *  decides what it may write (draft-column's applyDraftParse); the panel only
   *  delivers it. Omit to disable the backfill entirely. */
  onAiParse?: (draftId: string, parse: DraftParseInput, kind: DraftParseKind) => void;
  /** The Start Task / Ask Walnut tab switch. The owner rewrites the row
   *  (project/tier seed on enter, restore on leave) — the panel only reports. */
  onWalnutToggle?: (draftId: string, walnut: boolean) => void;
  /** Rendered directly above the launch bar: the live host-connect banner, on
   *  the one draft column that hosts it while the chat slot is hidden. */
  hostNotice?: ReactNode;
  /** Rendered at the top of the empty body in place of Walnut's starter suggestions: an ask drawer's
   *  quote of the object being asked about (AskObjectDrawer), where "Plan my day" means nothing. */
  intro?: ReactNode;
  /** The host refused the last Start (409): the draft came back and this says why. */
  gateError?: DraftGateError;
  onGateErrorClear?: (draftId: string) => void;
  /** Images of a refused Start, put back into the composer once on mount. */
  restoreImages?: ImageAttachment[];
  /** "Customize Walnut" quick action: the owner turns THIS draft into the repair
   *  draft. Omit (no repair target on this install) and the chip never renders. */
  onCustomizeWalnut?: (draftId: string) => void;
  /** Where a repair draft runs (Walnut's source, or the clone a first Start
   *  makes): the repair hint names it. */
  repairTarget?: WalnutRepairTarget | null;
  /** A walnut draft's name in the header and placeholder ("CEO" for the main agent); default "Quick question". */
  walnutLabel?: string;
  /**
   * A plain chat's first message (the browser side panel's Ask, SessionPanel's `plainChat`): no
   * draft header, no model pill, no slash commands or "@" palette, `placeholder` in the composer.
   * The host passes no mode fork and no task fields, so none are drawn either.
   */
  plainChat?: boolean;
  /** The composer's placeholder, in place of the draft's own. */
  placeholder?: string;
  /** In plain chat: the host's controls in the composer's bottom row (SessionPanel `composerBar`). */
  composerBar?: ReactNode;
  /** In plain chat: a pill at the top of the composer (SessionPanel `composerPill`). */
  composerPill?: ReactNode;
  /**
   * The host starts a task that names no folder in the task's own directory (the browser
   * extension's New task): no folder bar, no picker, no "pick a folder" notice, and no hint line.
   */
  ownFolder?: boolean;
  /**
   * With `ownFolder`: still draw the launch bar, so the person may pick the folder and the project
   * (a start with none still runs in the task's own directory); the pill says `ownFolderLabel` then.
   * 2026-11-10, the user, of the extension's New task: "we need to be able to choose the folder".
   */
  pickFolder?: boolean;
  ownFolderLabel?: string;
  /** With `pickFolder`: the folder pill's × back to no folder. Such a host makes no isolated workspace, so none is offered. */
  onClearFolder?: (draftId: string) => void;
  /** The host is writing (a save as todo or a start on its way): Save as todo waits, so one click makes one todo. */
  saveBusy?: boolean;
}

export function DraftSessionPanel({
  draft, autoFocus, onStart, onSaveAsTask, onClose, headerLeading,
  onPathChange, onProjectChange, onMetaChange, onModeChange, isKnownProject, onAiParse, onWalnutToggle,
  onTaskFieldChange, onReturnFieldToWalnut, hostNotice, intro, gateError, onGateErrorClear, restoreImages,
  onCustomizeWalnut, repairTarget, phoneLayer, walnutLabel, plainChat, placeholder, composerBar, composerPill, ownFolder, pickFolder, ownFolderLabel, onClearFolder, saveBusy = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const phoneDraft = usePhoneLayerWithBar({
    id: `draft:${draft.id}`, kind: 'draft', active: !!phoneLayer, title: 'New session', withAction: false,
    // A wider window keeps the draft: the desktop shows it as a column (phone-overlay-breakpoint-guard).
    onClose: (info) => { if (!info.breakpoint) onClose(draft.id) },
  });
  // "Start anyway" rides the ordinary send (so images and the settle rules apply) with one flag.
  const overrideNextRef = useRef(false);
  const clearGate = useCallback(() => onGateErrorClear?.(draft.id), [onGateErrorClear, draft.id]);
  useRestoreImages(rootRef, restoreImages);
  const [pickerOpen, setPickerOpen] = useState(false);
  // One-tap composer seeds for the Ask Walnut tab — ChatInput's prefill contract
  // (replace + focus + caret-to-end, re-appliable via the nonce; never sends).
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });
  // A task menu's "Start / Snooze until › Something happens…" on a task with no
  // session seeds this draft (utils/wait-until.ts). Seeded opens never reuse a
  // draft with typed text, so the replace-only prefill loses nothing.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<ComposerInsertDetail>).detail;
      if (!detail || detail.sessionId !== draft.id || detail.handled) return;
      detail.handled = true;
      setPrefill((p) => ({ text: detail.text, nonce: p.nonce + 1 }));
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, [draft.id]);
  // A Start was refused because no folder is chosen. An unseeded draft opens
  // with NO folder by design (the user picks one; nothing is pre-selected), so
  // this is the ordinary "typed first, forgot the folder" path, not an edge
  // case. Drives the one-line notice above the launch bar — see startWith.
  const [needsFolder, setNeedsFolder] = useState(false);
  // Slash-command palette, same source as a real session's composer: no folder
  // yet = the LOCAL list; then it follows the folder/host. Cached + SWR, gates
  // nothing (empty until it lands); the CLI reads /commands natively either way.
  const {
    items: slashCommands, search: searchSlashCommands, refresh: refreshSlashCommands,
    status: slashCommandsStatus, onPaletteOpen: onSlashPaletteOpen,
  } = useSlashCommands(draft.cwd || undefined, draft.host ?? undefined);
  // Read-only mirror of the composer text (ChatInput stays uncontrolled) — the
  // footer buttons need it to enable/disable and to start with an empty send.
  const [text, setText] = useState('');
  // A bound draft already IS a task, so "create task for later" has nothing to
  // create; Start attaches to the existing task instead.
  const isBound = !!draft.taskId;
  // A fork draft continues an existing session: no "task for later" either
  // (the fork route creates the sibling task itself), and no AI backfill —
  // project/folder are immutable facts, so there is nothing for it to fill.
  const isFork = !!draft.forkOf;
  // Ask Walnut tab: project/folder are server-owned, so no AI backfill. Tabs
  // render on a plain AND a bound draft (the binding survives the switch; Start
  // reuses the task either way). Fork and repair drafts show no tabs.
  const isWalnut = !!draft.walnut;
  // A walnut draft for ANOTHER console agent (Mentor, Note Assistant, …): same
  // launch shape, its own name in the header/placeholder, and the Walnut seeds
  // (tasks, schedule) give way to the agent's own description.
  const askAgent = isWalnut && draft.agent && draft.agent.id !== GENERAL_AGENT_ID ? draft.agent : null;
  const askLabel = askAgent ? `${QUICK_QUESTION} · ${askAgent.name}` : walnutLabel || QUICK_QUESTION;
  // "Customize Walnut": pre-armed on Walnut's own checkout with the repair intent. No
  // mode fork: an Ask Walnut launch has no cwd and would drop the repair.
  const isRepair = draft.intent === 'fix-walnut';
  const showTabs = !isFork && !isRepair && !!onWalnutToggle;

  // The permission mode the launch will carry, and the pill that shows it. The
  // pill follows the ENGINE that will actually spawn (the model pill's rule):
  // Walnut's modes are a claude-CLI channel, so an engine whose modes are its
  // own config options (every ACP engine) gets no pill, exactly as a running
  // session of that engine draws none. A fork has none either: the fork route
  // takes no mode, the sibling inherits the source session's.
  const engineCatalog = useEngineCatalog();
  // The project's launch defaults (its settings; server: project-launch-defaults.ts): what a
  // launch that names no engine, model or mode starts on. Ask Walnut and a fork take none; a
  // repair files under Walnut, so Walnut's apply.
  const projectDefaults = useProjectLaunchDefaults(isWalnut || isFork ? '' : isRepair ? 'Walnut' : draft.project);
  const globalEngine = useGlobalDefaultEngine();
  const choice = useMemo(() => (isWalnut || isFork ? null
    : draftLaunchChoice({ meta: draft.meta, metaTouched: draft.metaTouched }, projectDefaults, globalEngine,
      (e) => defaultEngineRuns(e, draft.host, engineCatalog))),
    [isWalnut, isFork, draft.meta, draft.metaTouched, draft.host, projectDefaults, globalEngine, engineCatalog]);
  // What the pills show: the choice's engine and model over the row's own meta.
  const shownMeta = useMemo(() => (choice ? { ...draft.meta, engine: choice.engine, model: choice.model } : draft.meta), [choice, draft.meta]);
  // What the launch sends (MainPage: draftLaunchPayload): the project's values are left to the server.
  const sent = choice ? draftLaunchPayload(choice, draft.meta, unnamedLaunchIsNotClaude(projectDefaults, globalEngine)) : draft.meta;
  // The default engine is out of usage on the draft's host: where a launch that names no engine
  // and no model starts instead (the line above the composer, the model pill). A draft that
  // names the default engine's model (picked here, or the folder's last launch) waits for the
  // reset, and the line says so with the way to the fallback. The project's default engine is
  // the default engine of its drafts.
  const fallbackNow = useDraftFallback(draft.host,
    !isFork && !isBound && sent.engine !== 'claude' && !launchEngineForHost(sent.engine, draft.host, engineCatalog),
    choice?.from.engine === 'project' ? choice.project : undefined);
  // A model the folder remembered (the draft's meta untouched here) gives way to the fallback,
  // as Auto does: only a pick made in this draft keeps the default engine (MainPage's launch drops
  // the remembered model the same way).
  const remembered = !draft.metaTouched && !!fallbackNow?.fallback;
  const fallbackNamed = !remembered && sent.model && sent.model !== 'default' ? formatModelName(sent.model) || sent.model : null;
  // The launch starts on the fallback engine: the pill and the mode follow it.
  const onFallback = !fallbackNamed && fallbackNow?.fallback ? fallbackNow.fallback : null;
  const launchEngine = isWalnut ? 'claude' : resolveEngineForHost(shownMeta.engine, draft.host, engineCatalog);
  const claudeModes = engineEntry(engineCatalog, onFallback?.engine ?? launchEngine).capabilities.modeControl === 'claude-modes';
  const showModePill = !!onModeChange && !isFork && claudeModes;
  const enabledModes = useEnabledModes();
  const defaultClaudeMode = useClaudeLaunchMode(draft.host, draft.cwd, claudeModes);
  // No one picked a mode: Claude Code starts in its own default (claude-launch-mode.ts), another
  // engine in Walnut's.
  const draftMode: SessionMode = choice && choice.from.mode !== 'global' ? choice.mode
    : draft.meta.mode ?? (claudeModes ? defaultClaudeMode : DEFAULT_SESSION_MODE);
  // Where each value comes from, for the model picker's note and the mode pill's title.
  const shownModel = onFallback ? onFallback.model : shownMeta.model;
  // Another engine's models by their names (the picker's list), not their ids.
  const noteEngine = onFallback?.engine ?? launchEngine;
  const noteModels = useFallbackModels(choice && noteEngine !== 'claude' ? noteEngine : null);
  const sourceRows = choice ? launchSourceRows(choice.from, {
    engineName: engineName(engineEntry(engineCatalog, noteEngine).displayName),
    ...(shownModel && shownModel !== 'default' ? {
      modelName: noteModels.options.find((o) => o.value === shownModel)?.label || formatModelName(shownModel) || shownModel,
    } : {}),
    // The pill's word for Claude Code's own default.
    ...(noteEngine === 'claude' ? { defaultModelName: 'Auto' } : {}),
    // Every engine starts in the mode the chain decided (an ACP engine maps it to its own),
    // so the note names it even where no mode pill is drawn.
    mode: draftMode, showMode: !isFork, project: choice.project, onFallback: !!onFallback,
  }) : null;
  // The picker's note: the rows, what a pick here does or why the project's engine gave way, and
  // the way back to the project's values after a pick of this task's own.
  const ownOverProject = !!choice && ((!!projectDefaults.engine && choice.from.engine === 'task')
    || (!!projectDefaults.mode && choice.from.mode === 'task'));
  const resetToProject = useCallback(() => {
    onMetaChange(draft.id, (m) => ({
      ...m,
      ...(projectDefaults.engine ? { engine: undefined, model: undefined } : {}),
      ...(projectDefaults.mode ? { mode: undefined } : {}),
    }), { touched: projectDefaults.engine ? false : !!draft.metaTouched });
  }, [onMetaChange, draft.id, draft.metaTouched, projectDefaults.engine, projectDefaults.mode]);
  const sourceNote = sourceRows ? (
    <LaunchSourceNote rows={sourceRows} title="This new task starts on" project={choice?.project}
      hint={choice?.skipped
        ? `${engineName(engineEntry(engineCatalog, choice.skipped).displayName)}, the default engine of ${choice.project ?? 'this project'}, can't run here, so this task starts Claude Code.`
        : sourceRows.some((r) => r.source === 'project') ? 'A pick here is this task\'s own; the project keeps its defaults.' : undefined}
      {...(ownOverProject ? { action: { label: 'Use project defaults', onClick: resetToProject } } : {})} />
  ) : undefined;
  const nextDraftMode = nextSessionMode(draftMode, enabledModes);
  const cycleDraftMode = useCallback(() => {
    if (!showModePill) return;
    onModeChange?.(draft.id, nextDraftMode);
  }, [showModePill, onModeChange, draft.id, nextDraftMode]);

  // A bound draft's task EXISTS: the header gets its real kebab (live writes; pin
  // state from the Focus Bar store). A plain draft edits its task fields from the
  // launch bar (chips + More), and so does a repair (its project is the server's,
  // so its More has no Project row: DraftLaunchBar). Fork (inherits its meta) and
  // the chat slot's fixed-walnut draft (no toggle, minimal by design) get neither.
  const showDraftMenu = !isBound && !isFork && (!!onWalnutToggle || !isWalnut);
  // Mod+. in the composer opens More (keyboard focus rules): the Mac app's web
  // view skips buttons on Tab without Full Keyboard Access.
  const [openMenuNonce, setOpenMenuNonce] = useState(0);
  const onComposerKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== '.' || e.shiftKey || e.altKey) return;
    const mod = /Mac|iP/.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || !(e.target as Element | null)?.closest?.('.chat-input-textarea')) return;
    e.preventDefault();
    setOpenMenuNonce((n) => n + 1);
  }, []);
  const focusBar = useFocusBarContextSafe();
  const boundTaskId = draft.taskId;
  const boundPinned = !!boundTaskId && !!focusBar?.isPinned(boundTaskId);
  const boundTier = boundPinned && boundTaskId ? focusBar?.tierOf(boundTaskId) : undefined;
  const pinBound = useCallback((id: string) => { focusBar?.pin(id).catch(() => {}); }, [focusBar]);
  const unpinBound = useCallback((id: string) => { focusBar?.unpin(id).catch(() => {}); }, [focusBar]);
  const setBoundTier = useCallback((id: string, tier: string) => { focusBar?.setTier(id, tier).catch(() => {}); }, [focusBar]);
  // The header kebab can MOVE the bound task (its Project row is a live write),
  // and so can the board. The draft's project pill was seeded once at ▶, so it
  // follows the task — but only on a change of the TASK's project: the first
  // observation just records it, and a pill the user edits by hand is left
  // alone until the task itself moves again.
  const boundTask = useStoreTask(boundTaskId);
  const boundProject = boundTask ? boundTask.project ?? '' : null;
  // The launch bar's project chip on a bound draft moves the task NOW, the same
  // write as the header kebab's Project row: Start reuses the existing task and
  // never refiles it, so a draft-only pick would be a control that does nothing.
  const taskStore = useTasksContextSafe();
  const moveBoundTask = useCallback((project: string) => {
    if (!boundTaskId) return;
    if (taskStore && taskStore.tasks.some((t) => t.id === boundTaskId)) {
      taskStore.moveTask(boundTaskId, project);
      return;
    }
    onProjectChange(draft.id, project);
    updateTask(boundTaskId, { project }).catch(() => {
      fetchTask(boundTaskId).then((t) => onProjectChange(draft.id, t.project ?? '')).catch(() => {});
    });
  }, [boundTaskId, taskStore, onProjectChange, draft.id]);
  const lastBoundProject = useRef<string | null>(null);
  useEffect(() => {
    if (boundProject === null) return;
    const prev = lastBoundProject.current;
    lastBoundProject.current = boundProject;
    if (prev !== null && prev !== boundProject) onProjectChange(draft.id, boundProject);
  }, [boundProject, draft.id, onProjectChange]);

  const getComposer = useCallback(
    () => rootRef.current?.querySelector<HTMLTextAreaElement>('.chat-input-textarea') ?? null,
    [],
  );
  const focusComposer = useCallback(() => { getComposer()?.focus(); }, [getComposer]);

  // Focus the textarea AFTER paint, and query inside rootRef only: several draft
  // columns can be open at once, so a document-level query would grab whichever
  // one happens to be first in the DOM.
  // Retried until shown: a draft opened from another page mounts while Home is still hidden.
  // A restored or seeded draft ("Snooze this task until: ") goes on where its text ends;
  // a bare focus() leaves the caret at 0, so typing landed in front of it.
  useFocusRequest(autoFocus, getComposer, (el) => el.setSelectionRange(el.value.length, el.value.length));

  // Owner asked for the folder picker (a Start with no cwd that reached MainPage —
  // see DraftColumn.openPickerNonce). Skips the initial undefined/0 so a freshly
  // opened draft doesn't launch straight into the picker.
  useEffect(() => {
    if (draft.openPickerNonce) setPickerOpen(true);
  }, [draft.openPickerNonce]);

  // Walnut mode has no folder choice (the cwd pill unmounts) — a picker left
  // open across the tab switch would float with a detached anchor, and picking
  // a folder there would override the server-owned 'Ask Walnut' project.
  useEffect(() => {
    if (isWalnut) setPickerOpen(false);
  }, [isWalnut]);

  // The notice describes a condition, so it retires the moment the condition
  // does — a folder picked by any route (picker, quick chip, project default)
  // must not leave "choose a folder" on screen next to a chosen folder.
  useEffect(() => {
    if (draft.cwd) setNeedsFolder(false);
  }, [draft.cwd]);

  // ── Background AI backfill of the launch pills (R9) ──
  // Parse of what the user types, mirroring QuickTaskComposer: the sentence that
  // starts the session can also say its project, tier, priority and dates.
  // STRICTLY additive: nothing waits on it and every failure is swallowed. OFF
  // unless `agent.quick_parse` (the composer "+" toggle; false until config
  // loads). A restored draft opens on text, so this can fire on mount with no
  // keystroke. Every in-flight parse is aborted before its replacement (a result
  // guard alone left six 10s requests holding connection slots). Ordering: each
  // request takes the next seq and applies only if no NEWER one has landed
  // (appliedSeq); "latest nonce wins" would drop every eager answer.
  const aiParseOn = useQuickParseEnabled();
  const parseSeqRef = useRef(0);
  const parseAppliedSeqRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const onAiParseRef = useRef(onAiParse);
  onAiParseRef.current = onAiParse;
  // When the last EAGER (mid-typing) parse fired, for the throttle window.
  const lastEagerParseRef = useRef(0);
  // In-flight parse PER KIND: a replaced request is aborted, not left holding a
  // connection slot. Not one shared controller: the trailing fire would cancel
  // the eager one before it could answer. Ceiling: two in flight per composer.
  const parseAbortRef = useRef<{ eager: AbortController | null; trailing: AbortController | null }>({ eager: null, trailing: null });
  const abortAllParses = useCallback(() => {
    parseAbortRef.current.eager?.abort();
    parseAbortRef.current.trailing?.abort();
    parseAbortRef.current = { eager: null, trailing: null };
  }, []);
  useEffect(() => () => abortAllParses(), [abortAllParses]);
  useEffect(() => {
    if (!onAiParseRef.current || isFork || isWalnut) return;
    const requested = text.trim();
    // Empty composer: invalidate everything in flight, then, only if it STAYS
    // empty for a debounce, report a 'clear' (the decisions made from the text go
    // with it). Not at once: a refused Start (no folder) empties the composer and
    // restores it a moment later, and that round trip must not wipe the chips.
    // The seq bump first, so a parse still in the air can never land after it.
    if (!requested) {
      parseAppliedSeqRef.current = ++parseSeqRef.current;
      abortAllParses();
      const clearTimer = setTimeout(() => {
        if (textRef.current.trim()) return;
        onAiParseRef.current?.(draft.id, {}, 'clear');
      }, PARSE_DEBOUNCE_MS);
      return () => clearTimeout(clearTimer);
    }
    // After the empty check, so opening a draft with an empty composer still costs
    // nothing at all — the flag's own `/api/config` read is triggered HERE, by there
    // being something to parse, and never by a column appearing. `aiParseOn` is a dep,
    // so turning the toggle on with a sentence already typed parses it right away
    // instead of waiting for one more keystroke.
    if (!aiParseOn) { void ensureQuickParseLoaded(); return; }

    const fire = (eager: boolean) => {
      const seq = ++parseSeqRef.current;
      const kind = eager ? 'eager' : 'trailing';
      parseAbortRef.current[kind]?.abort();
      const controller = new AbortController();
      parseAbortRef.current[kind] = controller;
      quickParseTask(requested.slice(0, PARSE_MAX_CHARS), controller.signal)
        .then((result) => {
          // Out-of-order guard: never let an older response overwrite a newer one.
          if (seq <= parseAppliedSeqRef.current) return;
          // Only a parse of the sentence AS IT STANDS may take a decision back
          // ('trailing'). An eager parse, or a trailing one the user has typed
          // past, describes a prefix: it may add or change a chip, never remove
          // one. User picks are protected by field ownership, not by recency.
          const landed: DraftParseKind = !eager && requested === textRef.current.trim() ? 'trailing' : 'eager';
          parseAppliedSeqRef.current = seq;
          onAiParseRef.current?.(draft.id, result, landed);
        })
        .catch(() => { /* no provider / offline / 400 — degrade silently */ });
    };

    // EAGER path: enough text to guess from and the throttle window has passed —
    // parse NOW so the pills fill while the user is still typing, instead of
    // only after the first pause.
    const now = Date.now();
    if (requested.length >= PARSE_MIN_CHARS && now - lastEagerParseRef.current >= PARSE_THROTTLE_MS) {
      lastEagerParseRef.current = now;
      fire(true);
    }

    // TRAILING path: the pause finalizes the sentence (and covers short inputs
    // the eager path skipped).
    const timer = setTimeout(() => fire(false), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft.id, text, isFork, isWalnut, aiParseOn, abortAllParses]);

  // `async` on purpose: every exit path resolves a Promise<boolean>, so the
  // no-cwd case (open the picker, keep the text) can never degrade into the
  // sync-false branch of dispatchSend that wipes the draft. See Props.onStart.
  const startWith = useCallback(async (body: string, images?: ImageAttachment[]): Promise<boolean> => {
    // Ask Walnut needs no folder — the server owns the cwd (WALNUT_HOME); nor does a host that
    // starts such a task in its own directory.
    if (!draft.cwd && !draft.walnut && !ownFolder) {
      // The picker is the RECOVERY, not the explanation (alone it read as a dead
      // Start button), so say why next to the pill. Cleared once a folder lands.
      setNeedsFolder(true);
      setPickerOpen(true);
      return false;
    }
    const override = overrideNextRef.current;
    overrideNextRef.current = false;
    return onStart(draft.id, body, images, override ? { overrideReadiness: true } : undefined);
  }, [draft.cwd, draft.walnut, draft.id, onStart, ownFolder]);

  // "Start anyway" (the host gate's override) is a send by another name: click
  // ChatInput's own send button (in THIS column) so pasted IMAGES ride along and
  // dispatchSend's settle rules apply; its `disabled` is exactly "nothing to
  // send". The fallback passes the mirrored TEXT, never '' (worst case "images
  // lost", not "message emptied"). An empty bound composer resolves to the task
  // title in the owner.
  const handleStartClick = useCallback(() => {
    const sendBtn = rootRef.current?.querySelector<HTMLButtonElement>('.chat-send-btn-icon');
    if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
    void startWith(text.trim());
  }, [startWith, text]);

  return (
    <div
      className={`session-panel draft-session-panel${isWalnut ? ' draft-session-panel-walnut' : ''}${plainChat ? ' is-plain-chat' : ''}`}
      ref={rootRef}
      data-draft-id={draft.id}
      onKeyDownCapture={showDraftMenu && onTaskFieldChange ? onComposerKeyDown : undefined}
    >
      {!plainChat && <div className="session-panel-header">
        {/* Beside session columns on Home the draft's header is as tall as theirs: an empty tool
            row of the same make stands where theirs is, so the header lines meet across the strip. */}
        <div className="session-meta-row-2 draft-header-tool-row" aria-hidden="true">
          <span className="session-panel-window-controls"><span className="task-action-btn draft-header-tool-spacer" /></span>
        </div>
        <div className="session-panel-header-top">
          {headerLeading && <div className="session-panel-header-leading">{headerLeading}</div>}
          <div className="session-panel-title-area">
            <span className="session-panel-title">
              {/* A plain draft makes a task (its "Save as todo" makes nothing else), so
                  it says so; a BOUND draft adds a session to an existing task and
                  creates none, so it keeps "New Session" beside its "for:" line. */}
              {isFork ? 'Fork Session' : isRepair ? 'Customize Walnut' : isWalnut ? askLabel : isBound ? 'New Session' : 'New task'}
            </span>
            <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Draft</span>
            {isBound && (
              <span className="draft-bound-task" title={`This session will attach to the existing task "${draft.boundTaskTitle}" — no second task is created`}>
                for: {draft.orgLead && draft.boundTaskTitle ? leadShown(draft.boundTaskTitle) : draft.boundTaskTitle}
              </span>
            )}
            {isFork && draft.forkOf?.title && (
              <span className="draft-bound-task" title="The conversation this fork continues — its history rides along">
                fork of: {draft.forkOf.title}
              </span>
            )}
          </div>
          {isBound && focusBar && (
            <TaskQuickActions
              taskId={draft.taskId}
              slot="kebab"
              isPinned={boundPinned}
              pinnedTier={boundTier}
              onPinTask={pinBound}
              onUnpinTask={unpinBound}
              onSetTier={setBoundTier}
            />
          )}
          <button
            className="task-action-btn session-panel-close"
            onClick={phoneDraft.close}
            title="Discard this draft"
            aria-label="Discard draft session"
          >
            {ICONS.ICON_CLOSE}
          </button>
        </div>
      </div>}

      {/* Empty body. On a plain draft it carries the ENTRY FORK, made before
          the first keystroke: two big intent cards (the approved mockup's
          grammar — user: not a thin tab strip, "two big rounded ones"). Start Task is
          pre-selected so the common case costs zero clicks; Ask Walnut opts
          into the Personal-AI session. Bound/fork drafts are already committed
          to a shape and keep the one-line hint instead. */}
      {!ownFolder && <div className="draft-session-body">
        {showTabs || isWalnut ? (
          <div className="draft-intent-stack">
            {/* The fork itself only renders where there is a choice to make. A
                draft that IS walnut mode with no toggle (the home page's Ask
                Walnut slot, which is that mode by definition) keeps the seeds
                below and skips the cards. */}
            {showTabs && (
              <div className="draft-intent-cards" role="group" aria-label="Draft mode">
                <button
                  type="button"
                  aria-pressed={!isWalnut}
                  className={`draft-intent-card${!isWalnut ? ' is-active' : ''}`}
                  onClick={() => { if (isWalnut) { onWalnutToggle?.(draft.id, false); focusComposer(); } }}
                >
                  <span className="draft-intent-ic" aria-hidden="true">{ICONS.ICON_TERMINAL}</span>
                  <span className="draft-intent-t">Start Task</span>
                  <span className="draft-intent-d">A coding session with Claude Code, Codex, OpenCode, etc.</span>
                </button>
                <button
                  type="button"
                  aria-pressed={isWalnut}
                  className={`draft-intent-card draft-intent-card-walnut${isWalnut ? ' is-active' : ''}`}
                  onClick={() => { if (!isWalnut) { onWalnutToggle?.(draft.id, true); focusComposer(); } }}
                >
                  <span className="draft-intent-ic" aria-hidden="true">
                    <img src="/walnut-icon.png" alt="" className="draft-intent-walnut-mark" />
                  </span>
                  <span className="draft-intent-t">{QUICK_QUESTION}</span>
                  <span className="draft-intent-d">
                    {isBound
                      ? 'Hand this task to Walnut: plan it, research it, or organize it.'
                      : 'Search tasks, find notes, schedule your day, or ask anything.'}
                  </span>
                </button>
              </div>
            )}
            {/* Composer seeds — prefill, never send. Only while the composer is
                EMPTY: prefill is replace-only (ChatInput contract), so a visible
                chip next to typed text is an invitation to silently destroy it. */}
            {/* The bound task keeps its one-line "what Start does" under the
                cards — the cards say which agent, this says what gets sent. */}
            {isBound && (
              <div className="draft-quick-hint">{isWalnut ? BOUND_WALNUT_HINT : BOUND_HINT}</div>
            )}
            {askAgent && (
              <p className="draft-agent-desc" data-testid="draft-agent-desc">
                {askAgent.description || `A session with ${askAgent.name}.`}
              </p>
            )}
            {/* Not on a bound draft: "plan my day" / "organize tasks" seeds have
                nothing to do with the one task this column is about. */}
            {intro}
            {/* The quick-action row under the cards belongs to the tab that is
                up: Ask Walnut shows the Walnut seeds; Start Task shows "Customize
                Walnut", a coding session in Walnut's own source (an npm install
                gets the clone on Start), which turns THIS draft into the repair
                draft. Both show only while there is nothing typed to lose; the
                Customize chip also needs a repair target from the owner. */}
            {isWalnut && !intro && !askAgent && !isBound && !text.trim() && (
              <div className="draft-walnut-suggests" role="group" aria-label="Quick actions">
                {WALNUT_SUGGESTS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="session-action-chip"
                    data-icon={s.iconName}
                    onClick={() => setPrefill((p) => ({ text: s.text, nonce: p.nonce + 1 }))}
                  >
                    <span className="session-action-chip-ic" aria-hidden="true">{s.icon}</span>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            {showTabs && !isWalnut && !isBound && onCustomizeWalnut && !text.trim() && (
              <div className="draft-walnut-suggests" role="group" aria-label="Quick actions">
                <button
                  type="button"
                  className="session-action-chip"
                  data-testid="draft-customize-walnut"
                  title="Open a session in Walnut's own source code to change or fix Walnut"
                  onClick={() => { onCustomizeWalnut(draft.id); focusComposer(); }}
                >
                  <span className="session-action-chip-ic" aria-hidden="true">{ICONS.ICON_SLIDERS}</span>
                  Customize Walnut
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="draft-quick-hint" {...(draft.orgLead ? { 'data-testid': 'draft-org-lead-hint' } : {})}>
            {isFork ? FORK_HINT : isRepair ? repairHint(repairTarget)
              : draft.orgLead ? orgLeadHint(draft.boundTaskTitle, draft.project)
                : isBound ? BOUND_HINT : HINT}
          </div>
        )}
      </div>}

      <div className="session-panel-input">
        {/* Why the last Start didn't start. Above the launch bar so it sits
            directly over the folder pill that resolves it. */}
        {hostNotice}
        {gateError && (
          <HostGateErrorBar
            gate={gateError}
            draftHost={draft.host}
            label={draft.hostLabel || gateError.body.host}
            onClear={clearGate}
            onStartAnyway={() => { overrideNextRef.current = true; handleStartClick(); }}
          />
        )}
        {needsFolder && !draft.cwd && (
          <div className="draft-needs-folder" role="status" data-testid="draft-needs-folder">
            Pick a folder first — the session runs in it.
          </div>
        )}
        {(!ownFolder || pickFolder) && <DraftLaunchBar
          draft={draft}
          pickerOpen={pickerOpen}
          onOpenPicker={() => setPickerOpen(true)}
          onClosePicker={() => {
            setPickerOpen(false);
            // Escape (or a pick) hands the caret back to the composer, as the model menu does, in
            // the same event (a frame later lost it to the page when the picker's input went); a
            // close that put focus somewhere else (a click on another field) keeps it there.
            const active = document.activeElement;
            if (!active || active === document.body || active.closest('.session-path-selector, .draft-launch-bar, .draft-composer-bar')) focusComposer();
          }}
          onPathChange={onPathChange}
          onProjectChange={onProjectChange}
          isKnownProject={isKnownProject}
          onBoundProjectMove={isBound ? moveBoundTask : undefined}
          onAfterQuickPick={focusComposer}
          // Decision chips + More only where the header kebab used to be.
          onTaskFieldChange={showDraftMenu ? onTaskFieldChange : undefined}
          onReturnFieldToWalnut={showDraftMenu ? onReturnFieldToWalnut : undefined}
          composerText={text}
          getComposer={getComposer}
          openMenuNonce={openMenuNonce}
          {...(ownFolder ? { emptyFolder: ownFolderLabel ?? 'its own', alwaysProject: true, workspaces: false, ...(onClearFolder ? { onClearFolder } : {}) } : {})}
        />}
        {/* The default engine is out of usage here: where this task starts instead. */}
        <DraftFallbackNotice now={fallbackNow} named={fallbackNamed}
          onUseFallback={() => onMetaChange(draft.id, (m) => ({ ...m, model: undefined, engine: undefined }), { touched: false })} />
        <ChatInput
          onSend={(body, images) => startWith(body, images)}
          // No session yet: files land on this machine and go to the session's host with its first message.
          fileTarget={NO_SESSION_YET}
          onValueChange={setText}
          // The arrow is the ONE start affordance, so an empty composer may send
          // only where '' means something: a bound draft sends its task's title, a
          // fork just branches. A plain draft needs words (spawn-and-idle is legal,
          // but an accidental Enter must not start a CLI on nothing).
          allowEmptySend={(isBound && !draft.orgLead) || isFork}
          sendTitle={isFork
            ? 'Fork the source session (an empty message just branches the conversation)'
            : isBound && isWalnut
              ? 'Ask a quick question about this task (an empty message sends the task title)'
              : draft.orgLead
                ? `Send to ${draft.boundTaskTitle ? leadShown(draft.boundTaskTitle) : 'the VP'}`
                : isBound
                ? 'Start the session on this task (an empty message sends the task title)'
                : isWalnut
                  ? askLabel
                  : 'Start the session'}
          // Only offered where the parse actually runs. A fork has nothing to
          // guess at, Ask Walnut has no launch pills, and a column with no
          // onAiParse has nowhere to put the answer — a switch that changes
          // nothing about the composer in front of you is worse than none.
          plusMenuToggles={onAiParse && !isFork && !isWalnut ? [{
            id: 'quick-parse',
            // Kept as short as its neighbours ("Attach image", "Commands") so the
            // row stays one line; the cost of turning it on lives in the tooltip.
            label: 'Auto-fill fields',
            on: aiParseOn,
            title: aiParseOn
              ? 'A model reads what you type and fills the folder, project and date pills. Off by default: on a Claude Code provider each guess starts a whole CLI process, which is slow enough to hold up the rest of the page.'
              : 'Off. Turn on to let a model read what you type and fill the folder, project and date pills — one background request per sentence.',
            onToggle: setQuickParseEnabled,
            // The other half of "mounting a composer costs nothing": the flag is
            // read when the menu that draws this switch opens, so the row tells the
            // truth for someone who turned it on and reloaded without typing yet.
            onMenuOpen: ensureQuickParseLoaded,
          }] : undefined}
          draftKey={draftComposerKey(draft.id)}
          placeholder={placeholder ?? (isFork ? FORK_PLACEHOLDER
            : isRepair ? REPAIR_PLACEHOLDER
              : askAgent ? `Ask ${askAgent.name} a quick question…` : isWalnut ? (walnutLabel ? `Ask ${walnutLabel} anything…` : WALNUT_PLACEHOLDER)
                : draft.orgLead ? `Message ${draft.boundTaskTitle ? leadShown(draft.boundTaskTitle) : 'the VP'}…` : PLACEHOLDER)}
          prefillText={prefill.text}
          prefillNonce={prefill.nonce}
          showCommands={false}
          {...(plainChat ? {} : {
            sessionCommands: slashCommands,
            searchSessionCommands: searchSlashCommands,
            onRefreshSessionCommands: refreshSlashCommands,
            onSessionCommandsPaletteOpen: onSlashPaletteOpen,
            sessionCommandsStatus: slashCommandsStatus,
          })}
          // The same "@" palette a running session has: Tasks and Files, in
          // every draft. Before a folder is picked the Files group browses the
          // host's home (the server and the daemon both expand `~`), so the
          // palette never loses a group. A picked task lands in the text as
          // `@[title]`; the launch message carries the tag and the server
          // appends its reference card.
          mentionCwd={draft.cwd || '~'}
          mentionHost={draft.host ?? undefined}
          enableEntityMention={!plainChat}
          mentionSelfTaskId={draft.taskId}
          // Shift+Tab cycles the permission mode, as it does in a running session.
          onToggleMode={showModePill ? cycleDraftMode : undefined}
          {...(plainChat && composerPill ? { contextPill: composerPill } : {})}
          // A plain chat (the browser side panel) picks its mode and model as every composer does
          // (2026-11-09, the user: "why can't i choose model, and mode etc"), after its own chips.
          controlsSlot={plainChat ? (
            <>
              {composerBar}
              <div className="session-mode-bar draft-actions-bar is-plain-chat-pickers">
                {showModePill && <DraftModePill mode={draftMode} nextMode={nextDraftMode} onCycle={cycleDraftMode} />}
                <DraftModelPill
                  meta={draft.meta}
                  onMetaChange={(updater) => onMetaChange(draft.id, updater)}
                  host={draft.host}
                  cwd={draft.cwd || undefined}
                  walnut={isWalnut}
                  fork={isFork}
                />
              </div>
            </>
          ) : (
            <div className="session-mode-bar draft-actions-bar">
              {/* The row reads like a running session's: mode first, then model.
                  The mode is the one launch choice that changes what the session
                  MAY do, so it is never hidden behind a menu. */}
              {showModePill && (
                <DraftModePill mode={draftMode} nextMode={nextDraftMode} onCycle={cycleDraftMode}
                  source={sourceRows?.find((r) => r.key === 'mode')} />
              )}
              {/* The model belongs with the message — same place a real session
                  keeps its model pill (the mode bar). Opens the SHARED two-pane
                  provider|models picker, so every composer offers the same
                  surface; on a draft both providers stay clickable. */}
              <DraftModelPill
                meta={shownMeta}
                // A pick starts from what the pill shows: the project's or the global engine
                // becomes this task's own pair (the updater sees it, never the row's raw meta).
                onMetaChange={(updater) => onMetaChange(draft.id, (m) => updater(choice ? { ...m, engine: choice.engine, model: choice.model } : m))}
                sourceNote={sourceNote}
                host={draft.host}
                cwd={draft.cwd || undefined}
                walnut={isWalnut}
                fork={isFork}
                fallbackLabel={onFallback ? draftFallbackPill(fallbackNow) : null}
                fallbackEngine={onFallback?.engine ?? null}
                fallbackModel={onFallback?.model}
              />
              {/* No "Start ↵" here: the composer's send arrow (and Enter) already
                  starts the session, and two buttons for one action read as two
                  actions (user, 2026-09-29). */}
            </div>
          )}
          // "Save as todo" is the text's other exit, so it sits beside the send
          // arrow, not among the launch settings on the left (user, 2026-10-03).
          // A bound draft is already a task, and a fork's sibling task is the
          // fork route's job — offering "create task" on either would make a
          // duplicate. Walnut mode hides it too: it would file the QUESTION as a
          // Walnut/Focus task with no session to answer it.
          sendSlot={!isBound && !isFork && !isWalnut ? (
            <button
              className="draft-later-btn"
              disabled={!text.trim() || saveBusy}
              aria-busy={saveBusy || undefined}
              onClick={() => { void onSaveAsTask(draft.id, text); }}
              title="Save as todo: creates a todo from this text (first line becomes the title). No session starts."
              aria-label="Save as todo"
            >
              {/* Three widths, chosen by the controls row (CSS container query):
                  the full words, "Todo", or the glyph alone in a ~270px column. */}
              <span className="draft-later-glyph" aria-hidden="true">◌</span>
              <span className="draft-later-words">Save as todo</span>
              <span className="draft-later-short" aria-hidden="true">Todo</span>
            </button>
          ) : undefined}
        />
      </div>
    </div>
  );
}
