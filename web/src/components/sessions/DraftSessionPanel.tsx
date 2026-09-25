/**
 * DraftSessionPanel — an EMPTY session column the user just opened with "+".
 *
 * Nothing exists server-side yet (0 bytes): column, cwd/host, project, launch
 * meta and text are pure client state until Start (→ `pending:` → real session)
 * or "Create task for later" (→ a task); closing leaves no trace. Same chrome
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
 *                      and the two verbs. Mod+. here opens the More menu.
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

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { ImageAttachment } from '@/api/chat';
import { quickParseTask } from '@/api/tasks';
import { useQuickParseEnabled, setQuickParseEnabled, ensureQuickParseLoaded } from '@/hooks/useQuickParse';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { DraftLaunchBar } from './DraftLaunchBar';
import { useModelOptions } from './path-selector/MetaFooter';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import {
  engineEntry,
  engineLockReason,
  normalizeEngine,
  resolveEngineForHost,
} from '@/utils/engines';
import { ModelPicker, shortAcpModelName } from './ModelPicker';
import { fetchEngineModelCatalog } from '@/api/sessions';
import {
  draftComposerKey, type DraftColumn, type DraftParseInput, type DraftParseKind, type DraftTaskField,
  type DraftTaskFieldPatch,
} from './draft-column';
import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';
import { GENERAL_AGENT_ID } from '@/components/chat/ask-walnut-slot-model';
import { TaskQuickActions } from './TaskQuickActions';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useStoreTask } from '@/contexts/TasksContext';
import '@/styles/walnut-agent.css';

const PLACEHOLDER = 'What should this session do?';
const HINT = 'Nothing runs yet — send to start, or keep it as a task for later.';
const BOUND_HINT = 'Start a session on this task — type the first instruction, or press Start to send its title.';
const BOUND_WALNUT_HINT = 'Ask Walnut about this task — type what you need, or press Start to send its title.';
const FORK_HINT = 'Forks the source conversation into a sibling session — type where it should go next (or Start to just branch).';
const FORK_PLACEHOLDER = 'Message for the forked session (optional)';
const WALNUT_PLACEHOLDER = 'Ask Walnut anything…';
/** "Fix Walnut": the guidance the old chat-anchored repair bar carried. The draft
 *  otherwise looks exactly like an ordinary new session, so nothing would tell the
 *  user their sentence is about to be read as a bug report. */
const REPAIR_PLACEHOLDER =
  'Describe what’s wrong — e.g. "sessions panel keeps spinning". Paste a screenshot (⌘V) to help.';
const REPAIR_HINT =
  'Opens a session in Walnut’s own checkout to fix it — paste a screenshot (⌘V) if you have one.';

/** The Ask Walnut tab's one-tap composer seeds — prefill only, never auto-send:
 *  the user finishes the sentence (or edits it) and presses Ask themselves.
 *  The inserted text must MATCH the label (minus the ellipsis) — a chip that
 *  inserts less than it promises reads as a bug. The first is a deliberate
 *  stem (trailing space, ellipsis label); the other two are complete asks. */
const WALNUT_SUGGESTS: readonly { label: string; text: string }[] = [
  { label: '🔍 Which task is…', text: 'Which task is ' },
  { label: '🗓 Schedule my day', text: 'Schedule my day' },
  { label: '🧠 What ran today', text: 'What ran today?' },
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

/**
 * DraftModelPill — the draft composer's model control: a pill (same classes as
 * a real session's model pill) opening the SHARED two-pane picker
 * (provider rail | models). One pattern everywhere; on a draft EVERY available
 * provider is clickable (the engine is still a choice here), and picking an ACP
 * engine clears the model (ACP discovers models at session start).
 */
function DraftModelPill({ meta, onMetaChange, host, cwd, walnut }: {
  meta: QuickStartTaskMeta;
  onMetaChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  host?: string | null;
  /** Draft folder — the ACP engine probe runs there (per-project provider config). */
  cwd?: string;
  /** Ask Walnut: the profile rides the CLI's system-prompt flags, so only the
   *  claude engine can carry it — other providers render locked with that reason. */
  walnut?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The clicked pill — anchor for the popout picker (portalled, clip-proof).
  const pillRef = useRef<HTMLElement | null>(null);
  const { options, autoResolved } = useModelOptions(host);
  const catalog = useEngineCatalog();
  // The engine that will actually launch — a remote tab launches the default
  // engine (ACP engines are local-only; quick-start drops a stale flag). Same
  // rule as EngineToggle and MainPage's launch payload: resolveEngineForHost.
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
    ? options.find((o) => o.value === meta.model)?.label ?? meta.model
    : autoResolved ? `Auto (${autoResolved})` : 'Auto';
  const acpPillLabel = meta.model ? shortAcpModelName(meta.model) : entry.displayName;
  return (
    <>
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill draft-model-select"
        title={acpModels
          ? `${entry.displayName} (via ACP) — session model: ${meta.model ? acpPillLabel : `${entry.displayName} default`}. Click to switch model / provider.`
          : `Session model: ${selectedLabel} — click to switch model / provider`}
        data-model={meta.model ?? ''}
        onClick={(e) => { pillRef.current = e.currentTarget; setOpen((v) => !v); }}
      >
        {acpModels ? acpPillLabel : selectedLabel}
      </button>
      {open && (
        <ModelPicker
          currentModel={isAuto ? undefined : meta.model}
          host={host ?? undefined}
          cwd={cwd}
          engine={engine}
          onSwitch={(model) => {
            setOpen(false);
            // Auto ('' from the picker) is `undefined` on a folder draft. In
            // walnut mode it is the sentinel 'default': the launch memory is
            // applied server-side to a launch that names NO model, so a
            // hand-picked Auto must be spelled out or it could never win.
            onMetaChange((m) => ({ ...m, model: model || (walnut ? 'default' : undefined) }));
          }}
          onClose={() => setOpen(false)}
          // A draft can still change provider — flipping clears the model: the
          // catalogs don't overlap, and an ACP engine has no pre-start rows.
          onProviderSwitch={(provider) => {
            onMetaChange((m) => ({ ...m, engine: normalizeEngine(provider), model: undefined }));
          }}
          providerLockReason={(provider) => (walnut && provider !== 'claude'
            ? 'Ask Walnut runs on the claude engine (the Personal AI profile rides its system prompt)'
            : engineLockReason(engineEntry(catalog, provider), host))}
          autoRow={{ resolvedLabel: autoResolved, active: isAuto }}
          // ACP draft: selection lands in meta.model (same field the claude
          // pane uses — the launch payload already carries it) and rides the
          // spawn as acpConfig. '' = back to the engine's default.
          acpCurrentModelId={acpModels ? meta.model : undefined}
          onAcpSwitch={(modelId) => {
            onMetaChange((m) => ({ ...m, model: modelId || undefined }));
          }}
          anchorRef={pillRef}
        />
      )}
    </>
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
  onStart: (draftId: string, text: string, images?: ImageAttachment[]) => Promise<boolean>;
  /** Turn the composed text into a task instead (first line = title). May be
   *  async; the owner handles its own success/failure UI. */
  onSaveAsTask: (draftId: string, text: string) => void | Promise<void>;
  onClose: (draftId: string) => void;
  /** Rendered before the title — the host surface's own control (the Ask Walnut
   *  slot's session switcher), so the draft header reads like the session header
   *  it is about to become. */
  headerLeading?: ReactNode;
  /** A folder pick. `openedMeta` is the meta the full picker opened with (its
   *  footer edits are rebased per field against it); a quick folder chip omits it. */
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta, openedMeta?: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  /** Model / engine edit from the composer's model pill. Takes an UPDATER (not a
   *  value) so rapid clicks fold onto the freshest row instead of a props
   *  snapshot; the owner flips `metaTouched` (the folder launch memory) here. */
  onMetaChange: (draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
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
}

export function DraftSessionPanel({
  draft, autoFocus, onStart, onSaveAsTask, onClose, headerLeading,
  onPathChange, onProjectChange, onMetaChange, isKnownProject, onAiParse, onWalnutToggle,
  onTaskFieldChange, onReturnFieldToWalnut,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // One-tap composer seeds for the Ask Walnut tab — ChatInput's prefill contract
  // (replace + focus + caret-to-end, re-appliable via the nonce; never sends).
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });
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
  const askLabel = askAgent ? `Ask ${askAgent.name}` : 'Ask Walnut';
  // "Fix Walnut": pre-armed on Walnut's own checkout with the repair intent. No
  // mode fork: an Ask Walnut launch has no cwd and would drop the repair.
  const isRepair = draft.intent === 'fix-walnut';
  const showTabs = !isFork && !isRepair && !!onWalnutToggle;

  // A bound draft's task EXISTS: the header gets its real kebab (live writes; pin
  // state from the Focus Bar store). A plain draft edits its task fields from the
  // launch bar (chips + More). Fork (inherits its meta), repair (server-filed) and
  // the chat slot's fixed-walnut draft (no toggle, minimal by design) get neither.
  const showDraftMenu = !isBound && !isFork && !isRepair && (!!onWalnutToggle || !isWalnut);
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
  useEffect(() => {
    if (!autoFocus) return;
    const raf = requestAnimationFrame(() => { focusComposer(); });
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, focusComposer]);

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
    // Ask Walnut needs no folder — the server owns the cwd (WALNUT_HOME).
    if (!draft.cwd && !draft.walnut) {
      // The picker is the RECOVERY, not the explanation (alone it read as a dead
      // Start button), so say why next to the pill. Cleared once a folder lands.
      setNeedsFolder(true);
      setPickerOpen(true);
      return false;
    }
    return onStart(draft.id, body, images);
  }, [draft.cwd, draft.walnut, draft.id, onStart]);

  // "Start" is Enter by another name: click ChatInput's own send button (in THIS
  // column) so pasted IMAGES ride along and dispatchSend's settle rules apply;
  // its `disabled` is exactly "nothing composed". The fallback passes the mirrored
  // TEXT, never '' (worst case "images lost", not "message emptied"). An empty
  // bound composer resolves to the task title in the owner.
  const handleStartClick = useCallback(() => {
    const sendBtn = rootRef.current?.querySelector<HTMLButtonElement>('.chat-send-btn-icon');
    if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
    void startWith(text.trim());
  }, [startWith, text]);

  return (
    <div
      className={`session-panel draft-session-panel${isWalnut ? ' draft-session-panel-walnut' : ''}`}
      ref={rootRef}
      data-draft-id={draft.id}
      onKeyDownCapture={showDraftMenu && onTaskFieldChange ? onComposerKeyDown : undefined}
    >
      <div className="session-panel-header">
        <div className="session-panel-header-top">
          {headerLeading && <div className="session-panel-header-leading">{headerLeading}</div>}
          <div className="session-panel-title-area">
            <span className="session-panel-title">
              {isFork ? 'Fork Session' : isRepair ? '\u{1F527} Fix Walnut' : isWalnut ? askLabel : 'New Session'}
            </span>
            <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Draft</span>
            {isBound && (
              <span className="draft-bound-task" title={`This session will attach to the existing task "${draft.boundTaskTitle}" — no second task is created`}>
                for: {draft.boundTaskTitle}
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
            onClick={() => onClose(draft.id)}
            title="Discard this draft"
            aria-label="Discard draft session"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Empty body. On a plain draft it carries the ENTRY FORK, made before
          the first keystroke: two big intent cards (the approved mockup's
          grammar — user: not a thin tab strip, "two big rounded ones"). Start Task is
          pre-selected so the common case costs zero clicks; Ask Walnut opts
          into the Personal-AI session. Bound/fork drafts are already committed
          to a shape and keep the one-line hint instead. */}
      <div className="draft-session-body">
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
                  <span className="draft-intent-ic" aria-hidden="true">🛠</span>
                  <span className="draft-intent-t">Start Task</span>
                  <span className="draft-intent-d">A coding session in any folder, with any agent: Claude, Codex, and more.</span>
                </button>
                <button
                  type="button"
                  aria-pressed={isWalnut}
                  className={`draft-intent-card draft-intent-card-walnut${isWalnut ? ' is-active' : ''}`}
                  onClick={() => { if (!isWalnut) { onWalnutToggle?.(draft.id, true); focusComposer(); } }}
                >
                  <span className="draft-intent-ic" aria-hidden="true">🥜</span>
                  <span className="draft-intent-t">Ask Walnut</span>
                  <span className="draft-intent-d">
                    {isBound
                      ? 'Hand this task to Walnut: plan it, research it, or organize it with your tasks, notes and memory in reach.'
                      : 'A quick session with Walnut: organize tasks, plan your day, configure Walnut, ask or search anything.'}
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
            {isWalnut && !askAgent && !isBound && !text.trim() && (
              <div className="draft-walnut-suggests" role="group" aria-label="Ask Walnut suggestions">
                {WALNUT_SUGGESTS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="session-action-chip"
                    onClick={() => setPrefill((p) => ({ text: s.text, nonce: p.nonce + 1 }))}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="draft-quick-hint">
            {isFork ? FORK_HINT : isRepair ? REPAIR_HINT : isBound ? BOUND_HINT : HINT}
          </div>
        )}
      </div>

      <div className="session-panel-input">
        {/* Why the last Start didn't start. Above the launch bar so it sits
            directly over the folder pill that resolves it. */}
        {needsFolder && !draft.cwd && (
          <div className="draft-needs-folder" role="status" data-testid="draft-needs-folder">
            Pick a folder first — the session runs in it.
          </div>
        )}
        <DraftLaunchBar
          draft={draft}
          pickerOpen={pickerOpen}
          onOpenPicker={() => setPickerOpen(true)}
          onClosePicker={() => setPickerOpen(false)}
          onPathChange={onPathChange}
          onProjectChange={onProjectChange}
          isKnownProject={isKnownProject}
          onAfterQuickPick={focusComposer}
          // Decision chips + More only where the header kebab used to be.
          onTaskFieldChange={showDraftMenu ? onTaskFieldChange : undefined}
          onReturnFieldToWalnut={showDraftMenu ? onReturnFieldToWalnut : undefined}
          composerText={text}
          getComposer={getComposer}
          openMenuNonce={openMenuNonce}
        />
        <ChatInput
          onSend={(body, images) => startWith(body, images)}
          onValueChange={setText}
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
          placeholder={isFork ? FORK_PLACEHOLDER
            : isRepair ? REPAIR_PLACEHOLDER
              : askAgent ? `${askLabel} anything…` : isWalnut ? WALNUT_PLACEHOLDER : PLACEHOLDER}
          prefillText={prefill.text}
          prefillNonce={prefill.nonce}
          showCommands={false}
          sessionCommands={slashCommands}
          searchSessionCommands={searchSlashCommands}
          onRefreshSessionCommands={refreshSlashCommands}
          onSessionCommandsPaletteOpen={onSlashPaletteOpen}
          sessionCommandsStatus={slashCommandsStatus}
          mentionCwd={draft.cwd || undefined}
          mentionHost={draft.host ?? undefined}
          controlsSlot={(
            <div className="session-mode-bar draft-actions-bar">
              {/* The model belongs with the message — same place a real session
                  keeps its model pill (the mode bar). Opens the SHARED two-pane
                  provider|models picker, so every composer offers the same
                  surface; on a draft both providers stay clickable. */}
              <DraftModelPill
                meta={draft.meta}
                onMetaChange={(updater) => onMetaChange(draft.id, updater)}
                host={draft.host}
                cwd={draft.cwd || undefined}
                walnut={isWalnut}
              />
              {/* A bound draft is already a task, and a fork's sibling task is
                  the fork route's job — offering "create task" on either would
                  make a duplicate. Walnut mode hides it too: it would file the
                  QUESTION as a Walnut/Focus task with no session to answer it. */}
              {!isBound && !isFork && !isWalnut && (
                <button
                  className="draft-later-btn"
                  disabled={!text.trim()}
                  onClick={() => { void onSaveAsTask(draft.id, text); }}
                  title="Creates a task from this text — first line becomes the title. No session starts."
                >
                  ◌ Create task for later
                </button>
              )}
              {/* Enabled even with an empty composer: spawn-and-idle is legal —
                  the CLI starts, initializes and waits on stdin. Ask Walnut has
                  NO extra button (user: keep it minimal — the composer's send arrow, amber
                  in this mode, is the one send affordance; an empty ask is
                  pointless anyway). */}
              {/* A BOUND walnut draft keeps it: its empty composer still has
                  something to send (the task title), and losing the button on the
                  tab switch would read as the ask having no way to start. */}
              {(!isWalnut || isBound) && (
                <button
                  className="draft-start-btn"
                  onClick={handleStartClick}
                  title={isFork
                    ? 'Fork the source session (an empty message just branches the conversation)'
                    : isBound && isWalnut
                      ? 'Ask Walnut about this task (an empty message sends the task title)'
                      : isBound
                        ? 'Start the session on this task (an empty message sends the task title)'
                        : 'Start the session (an empty message is fine — the agent spawns and waits)'}
                >
                  {isFork ? 'Fork ↵' : 'Start ↵'}
                </button>
              )}
            </div>
          )}
        />
      </div>
    </div>
  );
}
