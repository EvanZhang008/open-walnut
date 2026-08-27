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
 *   header             title + Draft badge + (bound task) + ✕
 *   body               nothing but one centered muted line of "what happens next"
 *   DraftLaunchBar     quick-access folder chips → provider/task row (engine ·
 *                      pin tier · ⋯ More) → cwd pill · project pill (fixed last),
 *                      with the folder picker POPPING OUT over the page (fixed,
 *                      anchored to the cwd pill — a ~300px column can't contain it)
 *   composer           shared ChatInput; its controls row holds the model select
 *                      and the two verbs
 *
 * Row shape + launch-memory rules live in ./draft-column (shared with MainPage).
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { ImageAttachment } from '@/api/chat';
import { quickParseTask, type QuickTaskParse } from '@/api/tasks';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { DraftLaunchBar } from './DraftLaunchBar';
import { useModelOptions } from './path-selector/MetaFooter';
import { ModelPicker } from './ModelPicker';
import { draftComposerKey, type DraftColumn } from './draft-column';
import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';

const PLACEHOLDER = 'What should this session do?';
const HINT = 'Nothing runs yet — send to start, or keep it as a task for later.';
const BOUND_HINT = 'Start a session on this task — type the first instruction, or press Start to send its title.';
const FORK_HINT = 'Forks the source conversation into a sibling session — type where it should go next (or Start to just branch).';
const FORK_PLACEHOLDER = 'Message for the forked session (optional)';

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

/**
 * DraftModelPill — the draft composer's model control: a pill (same classes as
 * a real session's model pill) opening the SHARED two-pane picker
 * (provider rail | models). One pattern everywhere; on a draft BOTH providers
 * are clickable (the engine is still a choice here), picking Codex clears the
 * model (ACP discovers models at session start).
 */
function DraftModelPill({ meta, onMetaChange, host }: {
  meta: QuickStartTaskMeta;
  onMetaChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  host?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // The clicked pill — anchor for the popout picker (portalled, clip-proof).
  const pillRef = useRef<HTMLElement | null>(null);
  const { options, autoResolved } = useModelOptions(host);
  const remoteHost = !!host && host !== '__local__';
  // Remote tabs always launch Claude (codex is local-only; quick-start drops a
  // stale codex flag) — mirror effective behavior, same rule as EngineToggle.
  const isCodex = meta.engine === 'codex' && !remoteHost;
  const selectedLabel = meta.model
    ? options.find((o) => o.value === meta.model)?.label ?? meta.model
    : autoResolved ? `Auto (${autoResolved})` : 'Auto';
  return (
    <>
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill draft-model-select"
        title={isCodex
          ? 'Codex (via ACP) — models are discovered at session start. Click to change provider.'
          : `Session model: ${selectedLabel} — click to switch model / provider`}
        data-model={meta.model ?? ''}
        onClick={(e) => { pillRef.current = e.currentTarget; setOpen((v) => !v); }}
      >
        {isCodex ? 'Codex' : selectedLabel}
      </button>
      {open && (
        <ModelPicker
          currentModel={meta.model}
          host={host ?? undefined}
          engine={isCodex ? 'codex' : 'claude'}
          onSwitch={(model) => {
            setOpen(false);
            onMetaChange((m) => ({ ...m, model: model || undefined }));
          }}
          onClose={() => setOpen(false)}
          // A draft can still change provider — flipping clears the model:
          // the two catalogs don't overlap, and Codex has no pre-start rows.
          onProviderSwitch={(provider) => {
            onMetaChange((m) => ({ ...m, engine: provider === 'codex' ? 'codex' : undefined, model: undefined }));
          }}
          providerLockReason={(provider) =>
            provider === 'codex' && remoteHost ? 'Codex sessions are local-only for now' : null}
          autoRow={{ resolvedLabel: autoResolved, active: !meta.model }}
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
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  /** Launch-meta edit from the bar. Takes an UPDATER (not a value) so rapid
   *  clicks fold onto the freshest row instead of a props snapshot; the owner
   *  also flips `metaTouched` here — every path into it is a user edit. */
  onMetaChange: (draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  /** Registry membership (case-insensitive) — the launch bar badges a project
   *  that doesn't exist yet ("new"), e.g. the folder-derived default. */
  isKnownProject: (name: string) => boolean;
  /** A landed background parse of the composer text. The owner decides what it is
   *  allowed to write (see draft-column's applyDraftParse) — the panel only
   *  delivers it. Omit to disable the backfill entirely. */
  onAiParse?: (draftId: string, parse: QuickTaskParse) => void;
}

export function DraftSessionPanel({
  draft, autoFocus, onStart, onSaveAsTask, onClose,
  onPathChange, onProjectChange, onMetaChange, isKnownProject, onAiParse,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A Start was refused because no folder is chosen (only reachable on a cold
  // working-dirs cache, where the draft can't be given a default). Drives the
  // one-line notice above the launch bar — see startWith.
  const [needsFolder, setNeedsFolder] = useState(false);
  // Slash-command palette, same source a real session's composer uses: no folder
  // yet → the LOCAL list (skills + built-ins, no project commands); once a
  // folder/host is picked the list follows it (a remote host shows that host's
  // skills). Globally cached + SWR, so the common keys are usually already warm;
  // the fetch is background and gates nothing — the palette is simply empty
  // until it lands. The message itself travels as plain text either way (the
  // CLI interprets /commands natively), so this is purely a discovery surface.
  const {
    items: slashCommands, search: searchSlashCommands, refresh: refreshSlashCommands,
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

  const focusComposer = useCallback(() => {
    rootRef.current?.querySelector<HTMLTextAreaElement>('.chat-input-textarea')?.focus();
  }, []);

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

  // The notice describes a condition, so it retires the moment the condition
  // does — a folder picked by any route (picker, quick chip, project default)
  // must not leave "choose a folder" on screen next to a chosen folder.
  useEffect(() => {
    if (draft.cwd) setNeedsFolder(false);
  }, [draft.cwd]);

  // ── Background AI backfill of the launch pills (R9) ──
  //
  // Debounced parse of what the user is typing, mirroring QuickTaskComposer: the
  // draft column IS a task-create surface, so the same sentence that starts the
  // session can also say which project and tier it belongs to. STRICTLY additive —
  // nothing waits on it, nothing blocks on it, and every failure (no provider
  // configured → the route 500s; offline; 400) is swallowed, leaving the draft
  // exactly as the user left it.
  //
  // The draft OPEN path stays network-free by construction: this effect only fires
  // on non-empty text, and text can only appear by typing.
  // Ordering: every request takes the next seq; a response applies only if no
  // NEWER response has already landed (appliedSeq). A plain "latest nonce wins"
  // guard would discard every eager response — the user typing one more character
  // bumps the nonce before the response lands, which is precisely the eager case.
  const parseSeqRef = useRef(0);
  const parseAppliedSeqRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const onAiParseRef = useRef(onAiParse);
  onAiParseRef.current = onAiParse;
  // When the last EAGER (mid-typing) parse fired, for the throttle window.
  const lastEagerParseRef = useRef(0);
  useEffect(() => {
    if (!onAiParseRef.current || isFork) return;
    const requested = text.trim();
    // Empty composer → invalidate everything in flight and stop.
    if (!requested) { parseAppliedSeqRef.current = ++parseSeqRef.current; return; }

    const fire = (eager: boolean) => {
      const seq = ++parseSeqRef.current;
      quickParseTask(requested.slice(0, PARSE_MAX_CHARS))
        .then((result) => {
          // Out-of-order guard: never let an older response overwrite a newer one.
          if (seq <= parseAppliedSeqRef.current) return;
          // The trailing parse additionally requires the sentence to still be
          // what it described (same rule as QuickTaskComposer). The EAGER parse
          // deliberately skips this — it is by definition of a prefix the user
          // is still extending, and filling pills from that prefix is the point.
          // User picks are protected by ownership flags, not by recency.
          if (!eager && requested !== textRef.current.trim()) return;
          parseAppliedSeqRef.current = seq;
          onAiParseRef.current?.(draft.id, result);
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
  }, [draft.id, text, isFork]);

  // `async` on purpose: every exit path resolves a Promise<boolean>, so the
  // no-cwd case (open the picker, keep the text) can never degrade into the
  // sync-false branch of dispatchSend that wipes the draft. See Props.onStart.
  const startWith = useCallback(async (body: string, images?: ImageAttachment[]): Promise<boolean> => {
    if (!draft.cwd) {
      // Opening the picker is the RECOVERY, not the explanation. On its own this
      // read as a dead Start button: the click produced a file browser, no
      // request, and nothing that said why — which is how "it can't start" got
      // reported. Say the reason out loud, next to the pill the user has to fix.
      // Cleared as soon as a folder lands (the effect below), so the notice can
      // never outlive the condition it describes.
      setNeedsFolder(true);
      setPickerOpen(true);
      return false;
    }
    return onStart(draft.id, body, images);
  }, [draft.cwd, draft.id, onStart]);

  // "Start ↵" is Enter by another name: when anything is composed, click
  // ChatInput's own send button (scoped to THIS column via rootRef) so attached
  // IMAGES ride along and dispatchSend's draft-settle rules apply — we only
  // mirror text, so a hand-rolled call would silently drop pasted screenshots.
  // That button's `disabled` is exactly "nothing composed". The fallback passes
  // the mirrored TEXT, never '': if the selector ever drifts the worst case must
  // be "images lost", not "message replaced by empty". (An EMPTY composer on a
  // bound draft resolves to the task title — in the owner, so every route in
  // gets it.)
  const handleStartClick = useCallback(() => {
    const sendBtn = rootRef.current?.querySelector<HTMLButtonElement>('.chat-send-btn-icon');
    if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
    void startWith(text.trim());
  }, [startWith, text]);

  return (
    <div className="session-panel draft-session-panel" ref={rootRef} data-draft-id={draft.id}>
      <div className="session-panel-header">
        <div className="session-panel-header-top">
          <div className="session-panel-title-area">
            <span className="session-panel-title">{isFork ? 'Fork Session' : 'New Session'}</span>
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

      {/* Empty body = ONE muted line of "what happens next". Everything
          actionable lives in the bottom stack, within reach of the composer. */}
      <div className="draft-session-body">
        <div className="draft-quick-hint">{isFork ? FORK_HINT : isBound ? BOUND_HINT : HINT}</div>
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
          onMetaChange={onMetaChange}
          isKnownProject={isKnownProject}
          onAfterQuickPick={focusComposer}
        />
        <ChatInput
          onSend={(body, images) => startWith(body, images)}
          onValueChange={setText}
          draftKey={draftComposerKey(draft.id)}
          placeholder={isFork ? FORK_PLACEHOLDER : PLACEHOLDER}
          showCommands={false}
          sessionCommands={slashCommands}
          searchSessionCommands={searchSlashCommands}
          onRefreshSessionCommands={refreshSlashCommands}
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
              />
              {/* A bound draft is already a task, and a fork's sibling task is
                  the fork route's job — offering "create task" on either would
                  make a duplicate. */}
              {!isBound && !isFork && (
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
                  the CLI starts, initializes and waits on stdin. */}
              <button
                className="draft-start-btn"
                onClick={handleStartClick}
                title={isFork
                  ? 'Fork the source session (an empty message just branches the conversation)'
                  : isBound
                    ? 'Start the session on this task (an empty message sends the task title)'
                    : 'Start the session (an empty message is fine — the agent spawns and waits)'}
              >
                {isFork ? 'Fork ↵' : 'Start ↵'}
              </button>
            </div>
          )}
        />
      </div>
    </div>
  );
}
