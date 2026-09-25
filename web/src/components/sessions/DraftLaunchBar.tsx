/**
 * DraftLaunchBar: the draft column's launch config, stacked directly ABOVE the
 * composer (bottom-up, the approved v4 layout): a normal chat has no
 * folder/project controls inside its composer, so these live just outside it,
 * closest to the two verbs they configure.
 *
 * Rows, top → bottom (R6 order):
 *   1. quick access: a "Quick folders" caption, then the folder chips (label =
 *      the folder BASENAME), then a divider. TOPMOST because this is the row whose
 *      CONTENT changes most across launches (top-4-by-use + 4-most-recent, see
 *      `quickDirsFor`): a row that moves between sessions must not sit where the
 *      user aims for a fixed control. Within one draft the row is STABLE:
 *      membership is a pure function of the cache, picks never reshuffle it (the
 *      current folder's chip just renders active). The caption + divider are what
 *      let the row hold eight chips: unlabelled and flush against the rows below,
 *      the whole stack read as one wall of buttons with no way to tell which button
 *      answered which question (user feedback).
 *   2. path + project: the cwd/host pill and the project pill, LEFT-ALIGNED.
 *      FIXED as the last row: "where does this run" is the statement the composer
 *      answers, so it stays glued to it and never moves.
 * Plus:  the folder picker, POPPED OUT of the column: portalled to <body>
 *        (a ~300px column can't contain a browsing surface, and any in-column
 *        placement gets painted over by sibling panels) but ANCHORED to the
 *        cwd pill via useMenuPlacement, so it opens from where you clicked.
 *
 * Between the two, only when there is something to say:
 *    . the legend "✦ = decided by Walnut", over non-empty text while anything on
 *      the bar carries a ✦ (draftDecisionsKeyVisible);
 *    . the decision chips (tier, priority, start, due, unread; draft-decisions.ts),
 *      each decided field on its own fixed slot, ✦ when the background parse
 *      decided it. Their OWN row above the pills, so a parse that adds chips
 *      pushes only the rows above it and the folder pill never moves.
 *   The pills row ends with More. More and every chip open the ONE draft menu
 *   (DraftTaskMenuPopover, controller in DraftDecisionRow) anchored where the
 *   click was; its rows are the board kebab's. The old always-visible tier row
 *   (removed 2026-09-15 as "complicated for people") and the header ⋮ that
 *   replaced it (2026-09-23) are both gone: a decision is shown only once one
 *   was made, and questioned where it is shown.
 *   Ask Walnut (with its tab) gets its own row, `.draft-walnut-meta-row`, with
 *   the chips the user set and More, and no folder/project pills. Bound, fork,
 *   repair and pinned-walnut drafts get neither (the owner omits
 *   onTaskFieldChange): a bound draft's task already exists and its header shows
 *   the real task's kebab; a fork inherits the source task's meta. The folder
 *   picker's footer (SessionPathSelector, MetaFooter) edits the same meta and is
 *   rebased per field on confirm (the snapshot taken when it opened rides along
 *   as onPathChange's 4th argument). The model stays in the composer's controls
 *   row, where a real session's model pill sits.
 *
 * The pills keep their original class names AND the `.draft-composer-bar`
 * container marker: that pair is the documented DOM hook the browser specs use to
 * reach them, and moving the row must not force every spec to re-learn where it
 * lives.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ProjectPickerFlyout } from '@/components/tasks/TaskKebabMenu';
import type { WorkingDirEntry } from '@/api/sessions';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useShowPriorityState } from '@/hooks/useShowPriority';
import { SessionPathSelector, type QuickStartPath, type QuickStartTaskMeta } from './SessionPathSelector';
import {
  applyLaunchMemory, quickDirsFor,
  type DraftAiField, type DraftColumn, type DraftTaskField, type DraftTaskFieldPatch,
} from './draft-column';
import {
  customTierLabelLookup, draftDecisionChips, draftDecisionsKeyVisible, draftSuggestionLabel, draftWalnutPicks,
  type DraftDecisionCtx,
} from './draft-decisions';
import { DraftDecisionChips, DraftMoreButton, useDraftDecisionMenu } from './DraftDecisionRow';
import { DraftTaskMenuPopover } from './DraftTaskMenu';

/** The owner map of a draft whose task fields nobody owns yet. */
const NO_OWNERS: NonNullable<DraftColumn['fieldOwner']> = Object.freeze({});

/** `host::cwd`: one directory's identity (same as draft-column's dirKey). */
function chipKey(d: { cwd: string; host: string | null }): string {
  return `${d.host ?? '__local__'}::${d.cwd}`;
}

interface Props {
  draft: DraftColumn;
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  /** `openedMeta`: the row's meta when the folder picker OPENED, so the owner can
   *  rebase per field (a parse that landed meanwhile is not overwritten by the
   *  picker's stale copy). Absent for a quick folder chip. */
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta, openedMeta?: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  /** Registry membership (case-insensitive): drives the project pill's "new"
   *  badge when the launch will auto-create the project (folder-derived name). */
  isKnownProject: (name: string) => boolean;
  /** Called after a chip pick so the owner can put the caret back in the composer. */
  onAfterQuickPick?: () => void;
  /** A More or chip edit of task fields. Present = decision chips + More + the
   *  menu; absent (bound, fork, repair, pinned walnut drafts) = none of them. */
  onTaskFieldChange?: (draftId: string, patch: DraftTaskFieldPatch) => void;
  /** "Use Walnut's pick": hand one field back to the background parse. */
  onReturnFieldToWalnut?: (draftId: string, field: DraftTaskField) => void;
  /** The composer's current text: gates the ✦ legend, and typing closes the menu. */
  composerText: string;
  /** The composer textarea: a mouse-opened menu puts the caret back there. */
  getComposer: () => HTMLTextAreaElement | null;
  /** Bumped by the composer's Mod+. shortcut: opens the menu from More. */
  openMenuNonce?: number;
}

/** ✦: this value came from the background parse of what the user is typing, not
 *  from them. Same badge (and same meaning) as the Quick Task confirm panel. */
function AiBadge({ on }: { on: boolean }) {
  return on ? <span className="draft-ai-badge" aria-label="AI suggested">✦</span> : null;
}

/** "walnut · devbox": folder basename plus the host alias when remote. */
function pathLabel(draft: DraftColumn): string {
  if (!draft.cwd) return 'Choose folder…';
  const dir = basename(draft.cwd);
  const host = draft.hostLabel ?? draft.host;
  return host ? `${dir} · ${host}` : dir;
}

/** Trailing-slash-tolerant basename: the chip label and the pill label. */
function basename(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || '/';
}

export function DraftLaunchBar({
  draft, pickerOpen, onOpenPicker, onClosePicker,
  onPathChange, onProjectChange, isKnownProject, onAfterQuickPick,
  onTaskFieldChange, onReturnFieldToWalnut, composerText, getComposer, openMenuNonce,
}: Props) {
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  // Anchor for the folder picker's POPOUT: the panel portals to <body> (so the
  // column can't clip it and siblings can't paint over it) but opens FROM this
  // pill: "pops from where you clicked", not a centered modal.
  const cwdPillRef = useRef<HTMLButtonElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menu = useDraftDecisionMenu({ getComposer, composerText, openMenuNonce, moreRef });

  // The row's meta at the moment the folder picker opened: the owner rebases
  // the picker's returned meta against it field by field (onPathChange's 4th
  // argument). Captured in the commit that opens it, the same one whose
  // `initialMeta` the picker seeds its footer from.
  const pickerOpenMetaRef = useRef<QuickStartTaskMeta | null>(null);
  useLayoutEffect(() => {
    pickerOpenMetaRef.current = pickerOpen ? draft.meta : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot at open only
  }, [pickerOpen]);

  // Decision chips: data from the pure catalog, words from the app's tables.
  const decisionsOn = !!onTaskFieldChange;
  const focusBar = useFocusBarContextSafe();
  const priorityVisible = useShowPriorityState();
  const customTiers = focusBar?.customTiers;
  const tierLabel = useMemo(() => customTierLabelLookup(customTiers ?? []), [customTiers]);
  const ctx: DraftDecisionCtx = {
    tierLabel,
    // Outside the provider (isolated surfaces) there are no custom tiers to wait for.
    customTiersLoaded: focusBar ? focusBar.customTiersLoaded : true,
    priorityVisible,
    now: new Date(),
  };
  const decisionChips = decisionsOn ? draftDecisionChips(draft, ctx) : [];
  const keyVisible = draftDecisionsKeyVisible(draft, composerText, decisionChips);
  const walnutPicks = useMemo(() => {
    if (!decisionsOn || !onReturnFieldToWalnut) return undefined;
    const raw = draftWalnutPicks(draft, { priorityVisible });
    const labels: Partial<Record<DraftTaskField, string>> = {};
    for (const [f, v] of Object.entries(raw) as [DraftTaskField, string][]) {
      labels[f] = draftSuggestionLabel(f, v, { tierLabel, now: new Date() });
    }
    return labels;
  }, [decisionsOn, onReturnFieldToWalnut, draft, priorityVisible, tierLabel]);
  const handleTaskFieldChange = useCallback(
    (patch: DraftTaskFieldPatch) => onTaskFieldChange?.(draft.id, patch),
    [onTaskFieldChange, draft.id],
  );
  const handleReturnToWalnut = useCallback(
    (field: DraftTaskField) => onReturnFieldToWalnut?.(draft.id, field),
    [onReturnFieldToWalnut, draft.id],
  );

  // The project flyout is portalled to <body> and owns no closer (its usual host
  // is a kebab menu that provides one), so this bar does, exempting the portal
  // itself or every click inside it would self-close.
  useEffect(() => {
    if (!projectOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (projectBtnRef.current?.contains(t)) return;
      if (t.closest?.('.task-kebab-project-flyout')) return;
      setProjectOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProjectOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [projectOpen]);

  // A quick chip is a full path pick: it goes through the SAME onPathChange the
  // picker uses (so it pins the cwd and can't be overwritten by a late project
  // default), carrying that folder's remembered model/engine unless the user has
  // already edited the meta. The PROJECT rides the same write: the owner's
  // handleDraftPathChange derives it from the folder (registry owner, else the
  // basename the launch will auto-create; see projectForFolderPick), so one click
  // configures both, which is the whole point of the row.
  const pickDir = useCallback((d: WorkingDirEntry) => {
    onPathChange(
      draft.id,
      { cwd: d.cwd, host: d.host, ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}) },
      draft.metaTouched ? draft.meta : applyLaunchMemory(draft.meta, d.lastLaunch),
    );
    onAfterQuickPick?.();
  }, [draft.id, draft.meta, draft.metaTouched, onPathChange, onAfterQuickPick]);

  const isFork = !!draft.forkOf;
  // Ask Walnut: folder and project are server-owned facts (WALNUT_HOME /
  // 'Walnut'), so the pills render read-only, the same treatment as a fork.
  const isWalnut = !!draft.walnut;
  // The pill's project doesn't exist yet: launching will create it (the
  // folder-derived default, or a name the AI invented). Same badge + meaning as
  // the Quick Task confirm panel's. Never on a fork: its project is the source
  // task's, already real.
  const projectIsNew = !isFork && !isWalnut && !!draft.project && !isKnownProject(draft.project);
  // No quick chips on a fork draft: the folder is immutable, so a row of other
  // folders would be five inert buttons (or worse, five ways to break the fork).
  // Same for Ask Walnut.
  const chips = isFork || isWalnut ? [] : quickDirsFor();
  const currentKey = chipKey({ cwd: draft.cwd, host: draft.host ?? null });
  const isAi = (field: DraftAiField) => !!draft.aiFields?.has(field);

  return (
    <div className="draft-launch-bar">
      {/* ROW 1: the volatile row goes on top (see the header note).
          The row's MEMBERSHIP never changes on a pick: the chip for the draft's
          current folder stays, rendered active, and clicking it is a no-op. The
          first shape removed it, which reshuffled every other chip under the
          cursor 21ms after a pick; a double-click then re-picked the folder the
          user had just left. */}
      {chips.length > 0 && (
        <div className="draft-quick-block">
          {/* The group's CAPTION, on its own line ABOVE the chips.
              Not decoration: these chips are folders and the row below is folder
              + project: eight unlabelled pills stacked on another unlabelled row
              is where the panel stopped being readable (user feedback). It sits
              above rather than inline because an inline key indents only the
              FIRST wrapped line: at eight chips the row wraps, and rows two and
              three then started a key-width to the left of row one while the
              pills started somewhere else again. Above the group, every row in
              the stack shares ONE left edge and the chips get the full width. A
              caption, not a control: no tab stop, no click target. */}
          <span className="draft-quick-key">Quick folders</span>
          <div className="draft-quick-chips" role="group" aria-label="Quick folders">
            {chips.map(d => {
              const active = chipKey({ cwd: d.cwd, host: d.host ?? null }) === currentKey;
              return (
                <button
                  key={`${d.host ?? '__local__'}::${d.cwd}`}
                  className={`draft-quick-chip${active ? ' draft-quick-chip-active' : ''}`}
                  aria-pressed={active}
                  // Truly disabled (not a click-less button): a focusable control
                  // that ignores Enter is a keyboard dead end. The active style
                  // sets its own colors, so no default disabled dimming shows.
                  disabled={active}
                  onClick={() => pickDir(d)}
                  title={d.host ? `${d.cwd} (on ${d.hostLabel ?? d.host})` : d.cwd}
                >
                  {basename(d.cwd)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* The ✦ legend: a key, not a heading. It explains the mark and claims no
          pill, so a folder the user picked (no ✦) is not read as Walnut's. */}
      {keyVisible && (
        <span className="draft-decisions-key">
          <span className="draft-decisions-key-mark">✦</span> = decided by Walnut
        </span>
      )}

      {/* The decision chips: their OWN row above the pills (see the header). */}
      {decisionsOn && !isWalnut && <DraftDecisionChips chips={decisionChips} menu={menu} />}

      {/* Ask Walnut: the chips the user set, and More. Deliberately NOT a
          `.draft-composer-bar` (that marker means "the folder/project row"). */}
      {decisionsOn && isWalnut && (
        <div className="draft-launch-pills draft-walnut-meta-row">
          <DraftDecisionChips chips={decisionChips} menu={menu} />
          <DraftMoreButton menu={menu} moreRef={moreRef} priorityVisible={priorityVisible} />
        </div>
      )}

      {/* ROW 2, FIXED last: directly above the composer, always.
          A FORK draft resumes the source conversation in place, so its folder
          and project are facts, not choices; both pills render read-only.
          Ask Walnut renders NO pills at all: folder and project are server
          facts ('Ask Walnut' / WALNUT_HOME), and a read-only pill in the
          folder pill's usual slot read as "runs in that folder" (user). */}
      {!isWalnut && (
        <div className="draft-launch-pills draft-composer-bar">
          {/* OPEN-only, never a toggle (matches the chat launcher pill): the
              picker's own document-level mousedown closer has already fired by the
              time this click runs, so a toggle would read the freshly-closed state
              and re-open. Close via Esc / outside click / picking a path. */}
          <button
            ref={cwdPillRef}
            className={`session-action-chip${pickerOpen ? ' session-action-chip-active' : ''}${isAi('cwd') ? ' session-action-chip-ai' : ''}`}
            onClick={isFork ? undefined : onOpenPicker}
            disabled={isFork}
            title={isFork
              ? `A fork continues the source session, so it runs in its folder: ${draft.cwd}`
              : draft.cwd ? `Working folder: ${draft.cwd}` : 'Pick the folder this session runs in'}
          >
            {pathLabel(draft)}
            <AiBadge on={isAi('cwd')} />
          </button>
          <button
            ref={projectBtnRef}
            className={`session-action-chip${projectOpen ? ' session-action-chip-active' : ''}${isAi('project') ? ' session-action-chip-ai' : ''}`}
            onClick={isFork ? undefined : () => setProjectOpen(o => !o)}
            disabled={isFork}
            title={isFork
              ? 'The forked task files as a sibling of the source task, in its project'
              : projectIsNew
                ? `Project "${draft.project}" doesn't exist yet. Starting will create it`
                : 'Project the new task files under'}
          >
            {draft.project || 'Inbox'}
            {projectIsNew && <span className="qtc-confirm-new">new</span>}
            <AiBadge on={isAi('project')} />
          </button>
          {projectOpen && (
            <ProjectPickerFlyout
              open
              anchorRef={projectBtnRef}
              current={draft.project ?? ''}
              onPick={(project) => onProjectChange(draft.id, project)}
              onClose={() => setProjectOpen(false)}
              // UPWARD like the folder picker beside it: both pills live at the
              // column's bottom, and one row opening two directions reads broken.
              preferSide="up"
            />
          )}
          {/* LAST element child of the row, unwrapped (the specs assert it). */}
          {decisionsOn && <DraftMoreButton menu={menu} moreRef={moreRef} priorityVisible={priorityVisible} />}
        </div>
      )}

      {decisionsOn && (
        <DraftTaskMenuPopover
          open={menu.open}
          anchorEl={menu.anchor}
          menuRef={menu.menuRef}
          meta={draft.meta}
          tierDecided={decisionChips.some((c) => c.field === 'pinTier')}
          priorityVisible={priorityVisible}
          walnutPicks={walnutPicks}
          onChange={handleTaskFieldChange}
          onReturnToWalnut={onReturnFieldToWalnut ? handleReturnToWalnut : undefined}
          onClose={menu.close}
          onAnchorLost={menu.onAnchorLost}
          // Only a keyboard open moves focus into the menu (C26, C40).
          focusNonce={menu.mode === 'keyboard' ? menu.focusNonce : 0}
        />
      )}

      <SessionPathSelector
        open={pickerOpen}
        onClose={onClosePicker}
        onSelect={(path, meta) => {
          onPathChange(draft.id, path, meta, pickerOpenMetaRef.current ?? undefined);
          onClosePicker();
        }}
        // POP OUT of the column (user: the panel need not stay inside this one
        // component, it should jump out; and it should pop from where you clicked,
        // never go fullscreen): portalled to <body> (siblings can't paint over it)
        // but anchored to the cwd pill, so it opens from the click point instead
        // of centering.
        popoutAnchor={cwdPillRef}
        initialPath={draft.cwd ? { cwd: draft.cwd, host: draft.host } : undefined}
        // ALWAYS the row's current meta: a tier "+" seed and any AI-filled date
        // ride `draft.meta` and nothing in this bar shows them, so a picker that
        // started from the defaults would silently reset them on the very folder
        // pick a seeded draft has to make before it can Start (the picker's
        // onSelect meta replaces the row's wholesale).
        initialMeta={draft.meta}
        // Launch memory (per-directory model/engine) keeps applying until the user
        // has edited the meta. The gate is `metaTouched`, NOT "a path was picked":
        // gating on the path would freeze the model at the first folder's memory
        // and every later folder change would launch with it.
        lockLaunchMemory={!!draft.metaTouched}
        // The footer's More badge counts only fields the user owns (C65). A
        // draft nobody has edited has no owner map yet: that is "owns nothing",
        // never "no ownership", which would count every AI-written date.
        ownedFields={draft.fieldOwner ?? NO_OWNERS}
      />
    </div>
  );
}
