/**
 * DraftLaunchBar — the draft column's launch config, stacked directly ABOVE the
 * composer (bottom-up, the approved v4 layout): a normal chat has no
 * folder/project controls inside its composer, so these live just outside it,
 * closest to the two verbs they configure.
 *
 * Rows, top → bottom (R6 order):
 *   1. quick access — a "Quick folders" caption, then the folder chips (label =
 *      the folder BASENAME), then a divider. TOPMOST because this is the row whose
 *      CONTENT changes most across launches (top-4-by-use + 4-most-recent, see
 *      `quickDirsFor`): a row that moves between sessions must not sit where the
 *      user aims for a fixed control. Within one draft the row is STABLE —
 *      membership is a pure function of the cache, picks never reshuffle it (the
 *      current folder's chip just renders active). The caption + divider are what
 *      let the row hold eight chips: unlabelled and flush against the rows below,
 *      the whole stack read as one wall of buttons with no way to tell which button
 *      answered which question (user feedback).
 *   2. task — pin tier · "⋯ More" (priority / dates / unread). The SAME MetaFooter
 *      the folder picker uses, minus its model select AND engine toggle
 *      (`hideModel`): the model belongs with the message, so the draft renders it
 *      inside the composer's controls row, exactly where a real session's model
 *      pill sits — and the provider rides along inside that same picker rather
 *      than being asked a second time up here.
 *   3. path + project — the cwd/host pill and the project pill, LEFT-ALIGNED.
 *      FIXED as the last row: "where does this run" is the statement the composer
 *      answers, so it stays glued to it and never moves.
 * Plus:  the folder picker — POPPED OUT of the column: portalled to <body>
 *        (a ~300px column can't contain a browsing surface, and any in-column
 *        placement gets painted over by sibling panels) but ANCHORED to the
 *        cwd pill via useMenuPlacement, so it opens from where you clicked.
 *
 * The pills keep their original class names AND the `.draft-composer-bar`
 * container marker: that pair is the documented DOM hook the browser specs use to
 * reach them, and moving the row must not force every spec to re-learn where it
 * lives.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectPickerFlyout } from '@/components/tasks/TaskKebabMenu';
import type { WorkingDirEntry } from '@/api/sessions';
import { MetaFooter } from './path-selector/MetaFooter';
import { SessionPathSelector, type QuickStartPath, type QuickStartTaskMeta } from './SessionPathSelector';
import { applyLaunchMemory, quickDirsFor, type DraftAiField, type DraftColumn } from './draft-column';

/** `host::cwd` — one directory's identity (same as draft-column's dirKey). */
function chipKey(d: { cwd: string; host: string | null }): string {
  return `${d.host ?? '__local__'}::${d.cwd}`;
}

interface Props {
  draft: DraftColumn;
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta) => void;
  onProjectChange: (draftId: string, project: string) => void;
  onMetaChange: (draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
  /** Registry membership (case-insensitive) — drives the project pill's "new"
   *  badge when the launch will auto-create the project (folder-derived name). */
  isKnownProject: (name: string) => boolean;
  /** Called after a chip pick so the owner can put the caret back in the composer. */
  onAfterQuickPick?: () => void;
}

/** ✦ — this value came from the background parse of what the user is typing, not
 *  from them. Same badge (and same meaning) as the Quick Task confirm panel. */
function AiBadge({ on }: { on: boolean }) {
  return on ? <span className="draft-ai-badge" aria-label="AI suggested">✦</span> : null;
}

/** "walnut · clouddev" — folder basename plus the host alias when remote. */
function pathLabel(draft: DraftColumn): string {
  if (!draft.cwd) return 'Choose folder…';
  const dir = basename(draft.cwd);
  const host = draft.hostLabel ?? draft.host;
  return host ? `${dir} · ${host}` : dir;
}

/** Trailing-slash-tolerant basename — the chip label and the pill label. */
function basename(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || '/';
}

export function DraftLaunchBar({
  draft, pickerOpen, onOpenPicker, onClosePicker,
  onPathChange, onProjectChange, onMetaChange, isKnownProject, onAfterQuickPick,
}: Props) {
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  // Anchor for the folder picker's POPOUT: the panel portals to <body> (so the
  // column can't clip it and siblings can't paint over it) but opens FROM this
  // pill — "pops from where you clicked", not a centered modal.
  const cwdPillRef = useRef<HTMLButtonElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);

  // The project flyout is portalled to <body> and owns no closer (its usual host
  // is a kebab menu that provides one) — so this bar does, exempting the portal
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
  // already edited the meta. The PROJECT rides the same write — the owner's
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
  // 'Walnut'), so the pills render read-only — the same treatment as a fork.
  const isWalnut = !!draft.walnut;
  // The pill's project doesn't exist yet — launching will create it (the
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
  // The meta row carries ONE badge for its AI-fillable fields (tier / priority /
  // the More menu's dates) — see the row's comment below.
  const metaHasAi = isAi('pinTier') || isAi('priority')
    || isAi('dueDate') || isAi('startDate') || isAi('endDate');

  return (
    <div className="draft-launch-bar">
      {/* ROW 1 — the volatile row goes on top (see the header note).
          The row's MEMBERSHIP never changes on a pick: the chip for the draft's
          current folder stays, rendered active, and clicking it is a no-op. The
          first shape removed it, which reshuffled every other chip under the
          cursor 21ms after a pick — a double-click then re-picked the folder the
          user had just left. */}
      {chips.length > 0 && (
        <div className="draft-quick-block">
          {/* The group's CAPTION, on its own line ABOVE the chips.
              Not decoration: these chips are folders, the row below is tiers, and
              the one below that is folder + project — eight unlabelled pills
              stacked on two more unlabelled rows is where the panel stopped being
              readable (user feedback). It sits above rather than inline because an
              inline key indents only the FIRST wrapped line: at eight chips the
              row wraps, and rows two and three then started a key-width to the
              left of row one while the tier row and the pills each started
              somewhere else again. Above the group, every row in the stack shares
              ONE left edge and the chips get the full width. A caption, not a
              control: no tab stop, no click target. */}
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

      {/* ROW 2 — HIDDEN while the picker is open: the picker carries its own copy
          of this footer, and two identical control rows ~40px apart is both
          confusing and a duplicated control on the page. Hidden on a FORK draft
          too: the fork API takes only message+model (no tier/priority/
          engine — the sibling task inherits from the source), so every control
          in this row would be a lie. The model select lives in the composer. */}
      {!pickerOpen && !isFork && (
        <div className="draft-meta-row">
          {/* ONE badge for the whole row rather than three inside MetaFooter: the
              tier/priority controls are SHARED with the picker's footer, and
              teaching them about a draft-only concept would leak it everywhere.
              The slot is an absolute OVERLAY on the row's right edge (see the
              CSS): out of the flex flow, so it can neither indent this row
              relative to its neighbours nor nudge the controls when a
              suggestion lands. */}
          <span
            className="draft-meta-ai-slot"
            aria-hidden={!metaHasAi || undefined}
            aria-label={metaHasAi ? 'AI suggested' : undefined}
          >
            {metaHasAi ? '✦' : ''}
          </span>
          <MetaFooter
            meta={draft.meta}
            onChange={(updater) => onMetaChange(draft.id, updater)}
            compact
            host={draft.host}
            // The model lives in the composer's controls row for a draft (mirroring
            // a real session, where the model pill sits in the mode bar).
            hideModel
          />
        </div>
      )}

      {/* ROW 3 — FIXED last: directly above the composer, always.
          A FORK draft resumes the source conversation in place, so its folder
          and project are facts, not choices — both pills render read-only. */}
      <div className="draft-launch-pills draft-composer-bar">
        {/* OPEN-only, never a toggle (matches the chat launcher pill): the
            picker's own document-level mousedown closer has already fired by the
            time this click runs, so a toggle would read the freshly-closed state
            and re-open. Close via Esc / outside click / picking a path.
            Hidden on Ask Walnut — its folder is a server fact, not a choice. */}
        {!isWalnut && (
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
        )}
        <button
          ref={projectBtnRef}
          className={`session-action-chip${projectOpen ? ' session-action-chip-active' : ''}${isAi('project') ? ' session-action-chip-ai' : ''}`}
          onClick={isFork || isWalnut ? undefined : () => setProjectOpen(o => !o)}
          disabled={isFork || isWalnut}
          title={isFork
            ? 'The forked task files as a sibling of the source task, in its project'
            : isWalnut
              ? 'Ask Walnut tasks file under the Walnut project'
              : projectIsNew
                ? `Project "${draft.project}" doesn't exist yet — starting will create it`
                : 'Project the new task files under'}
        >
          {isWalnut ? 'Walnut' : draft.project || 'Inbox'}
          {projectIsNew && <span className="qtc-confirm-new">new</span>}
          {/* Suppressed in walnut mode: the pill shows the hard-coded 'Walnut',
              so a leftover ✦ from a pre-toggle AI fill would credit the AI with
              a value it didn't pick. The badge set survives for the restore. */}
          <AiBadge on={!isWalnut && isAi('project')} />
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
      </div>

      <SessionPathSelector
        open={pickerOpen}
        onClose={onClosePicker}
        onSelect={(path, meta) => { onPathChange(draft.id, path, meta); onClosePicker(); }}
        // POP OUT of the column (user: the panel "没有必要只放在这一个 component
        // 里面…它应该直接跳出来" + "你点哪里它就从哪里 pop 出来,不应该全屏"):
        // portalled to <body> (siblings can't paint over it) but anchored to the
        // cwd pill, so it opens from the click point instead of centering.
        popoutAnchor={cwdPillRef}
        initialPath={draft.cwd ? { cwd: draft.cwd, host: draft.host } : undefined}
        // ONLY once the user has edited the launch meta. The picker reads a
        // non-undefined initialMeta as "the user already chose — don't touch
        // model/engine", which switches OFF per-directory launch memory (its
        // withLaunchMemory + preview effect both bail on it). The gate is
        // `metaTouched`, NOT "a path was picked": with the meta now visible in the
        // bar, gating on the path would freeze the model at the first folder's
        // memory and every later folder change would launch with it.
        initialMeta={draft.metaTouched ? draft.meta : undefined}
      />
    </div>
  );
}
