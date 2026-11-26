/**
 * The new task draft's v6 layout (experiment `project_first_start`; spec: the approved v6
 * design), under the draft's header:
 *
 *            [ >_ Start task ]  [ (W) Quick chat ]          tiles, centred
 *                       (empty: tasks like this one, notices)
 *   [PROJECT ...........] [WHERE host › Auto ........]      row (or Quick chat's block), right
 *   line under the row                                       above the composer (2026-11-24, Evan:
 *   [ composer ...................... Start task ↑ ]        "put these 2 down")
 *   Recent [..] [..] [..]          Save as task   More       lower row
 *
 * One content column, at most 960 px wide and centred. Every slot has a fixed size, so switching
 * mode, project, host or folder, opening a menu or typing never moves the composer or the lower
 * row. The row's state is useDraftWhere's; this component only lays the parts out and reports to
 * the panel whether Start can run (`blockedRef`).
 */
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { setDraftWorkspace, useDraftWorkspace } from '@/components/workspaces/draft-workspace-store';
import { DraftWorkspaceRow } from '@/components/workspaces/DraftWorkspaceRow';
import type { DraftColumn, DraftTaskField, DraftTaskFieldPatch } from './draft-column';
import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';
import { DraftModeTiles, QuickChatBlock } from './DraftModeTiles';
import { DraftWhereRow, type RowMenu } from './DraftWhereRow';
import { DraftLowerRow, type TryChip } from './DraftLowerRow';
import { DraftFixWalnutRow, DraftFixWalnutSlot } from './DraftFixWalnutRow';
import { isFixWalnutDraft, leaveFixWalnut } from './draft-fix-walnut';
import type { WalnutRepairTarget } from '@/pages/repair-target';
import { useDraftWhere, type DraftRowUpdate } from './useDraftWhere';
import { DraftTaskMatches, useTaskMatches } from './DraftTaskMatches';
import '@/styles/draft-v6.css';
import '@/styles/draft-v6-menus.css';

/** Narrower than this, the row shows the host and the folder name only (spec: narrow rules). */
const NARROW_PX = 760;

export function DraftV6Body({
  draft, panelRef, composer, notices, startWhy, onUpdate, onPathChange, onWalnutToggle, blockedRef, shiftEnterRef, onBlocked, openWhereNonce,
  tryChips, composerText, getComposer, openMenuNonce, onTaskFieldChange, onReturnFieldToWalnut, onSaveAsTask, saveBusy, quickTitle, quickLine,
  onCustomizeWalnut, onOpenAsk, repairTarget,
}: {
  draft: DraftColumn;
  panelRef: RefObject<HTMLDivElement | null>;
  /** The composer (ChatInput), built by the panel: one composer for both layouts. */
  composer: ReactNode;
  /** Why the last Start did not start (a host's refusal, a launch error, the fallback engine): over the gap. */
  notices: ReactNode;
  /** Start was pressed while the row says it cannot run: the reason, near the button. */
  startWhy: string | null;
  onUpdate: DraftRowUpdate;
  onPathChange: (draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta) => void;
  onWalnutToggle: (walnut: boolean) => void;
  /** Written every render: the panel's Start reads it. */
  blockedRef: MutableRefObject<string | null>;
  /** Written every render: the composer's Shift+Enter opens the first task like this one, when it holds. */
  shiftEnterRef?: MutableRefObject<(() => boolean) | null>;
  /** Told when that changes: the panel draws its send arrow off while Start is held. */
  onBlocked?: (blocked: boolean) => void;
  /** Bumped by the owner when a Start needs a place (a draft with no folder): opens the Where menu. */
  openWhereNonce?: number;
  tryChips: readonly TryChip[];
  composerText: string;
  getComposer: () => HTMLTextAreaElement | null;
  openMenuNonce?: number;
  onTaskFieldChange?: (draftId: string, patch: DraftTaskFieldPatch) => void;
  onReturnFieldToWalnut?: (draftId: string, field: DraftTaskField) => void;
  onSaveAsTask: () => void;
  saveBusy: boolean;
  /** Another console agent's draft names it in the Quick chat block. */
  quickTitle?: string;
  quickLine?: string;
  /** "Fix Walnut": the Project menu's last row turns this draft into the repair draft. */
  onCustomizeWalnut?: () => void;
  /** Quick chat's Recent chats open a chat in the Ask Walnut slot. */
  onOpenAsk?: (taskId: string) => void;
  /** Walnut's own source: with onCustomizeWalnut, the Fix Walnut row under Recent. */
  repairTarget?: WalnutRepairTarget | null;
}) {
  const walnut = !!draft.walnut;
  // Fix Walnut (DraftFixWalnutRow.tsx): the repair draft keeps this layout; any place picked (Recent,
  // a mode switch) takes it back to a plain draft first.
  const repair = isFixWalnutDraft(draft);
  const target = repair ? repairTarget ?? { dir: draft.cwd, cloneNeeded: false, repoUrl: '' } : repairTarget;
  const leaveRepair = () => { onUpdate(draft.id, leaveFixWalnut); getComposer()?.focus({ preventScroll: true }); };
  // Both ways a pick writes the draft (a project or Auto, a folder): out of the repair first.
  const rowUpdate: DraftRowUpdate = repair ? (id, fn) => onUpdate(id, (d) => fn(leaveFixWalnut(d))) : onUpdate;
  // A folder pick takes its engine and model from the draft it lands on: the plain one, not the repair.
  const rowPath: typeof onPathChange = repair
    ? (id, path) => { const plain = leaveFixWalnut(draft); onUpdate(id, leaveFixWalnut); onPathChange(id, path, plain.meta); }
    : onPathChange;
  const rowWhere = useDraftWhere(draft, { onUpdate: rowUpdate, onPathChange: rowPath });
  // Start never starts a repair from a project's code source (projectStartEligible), so it reads the
  // draft's workspace: the notice and the chip say so whatever the project's mode reads.
  const where = repair ? { ...rowWhere, readsWorkspace: true } : rowWhere;
  // The server files a repair under Walnut: its task source is Walnut's.
  const lowerDraft = repair ? { ...draft, project: 'Walnut' } : draft;
  blockedRef.current = walnut || repair ? null : where.blocked;
  const isBlocked = !!blockedRef.current;
  useEffect(() => { onBlocked?.(isBlocked); }, [isBlocked, onBlocked]);
  const [menu, setMenu] = useState<RowMenu>(null);
  const narrow = useNarrow(panelRef, NARROW_PX);
  // The row's menus stay inside the draft's body: under its title, never over it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const startError = useDraftWorkspace(draft.id).startError;
  // Tasks like this one, by Walnut's search: a click or Shift+Enter opens one instead of a second task.
  const taskMatches = useTaskMatches(composerText, !walnut);
  if (shiftEnterRef) shiftEnterRef.current = taskMatches.shiftEnter;
  // A refused Start's words (a folder that is gone, a project without a source) hold until the
  // place changes: another folder, host or project clears them.
  const placeKey = `${draft.host ?? ''}|${draft.cwd ?? ''}|${draft.project ?? ''}`;
  const placeRef = useRef(placeKey);
  useEffect(() => {
    if (placeRef.current === placeKey) return;
    placeRef.current = placeKey;
    if (startError) setDraftWorkspace(draft.id, { startError: undefined });
  }, [placeKey, startError, draft.id]);
  useEffect(() => { if (walnut) setMenu(null); }, [walnut]);
  useEffect(() => { if (openWhereNonce && !walnut) setMenu({ kind: 'where', query: '' }); }, [openWhereNonce, walnut]);

  return (
    <div ref={bodyRef} className={`draft-v6-body${narrow ? ' is-narrow' : ''}${isBlocked ? ' is-blocked' : ''}`} data-testid="draft-v6">
      <DraftModeTiles walnut={walnut} onPick={(w) => { if (w && repair) leaveRepair(); onWalnutToggle(w); }} />
      <div className="draft-v6-col">
        <div className="draft-v6-gap">
          <div className="draft-v6-notices">
            {!walnut && <DraftTaskMatches matches={taskMatches.matches} shiftEnters={taskMatches.strongFirst} onOpen={taskMatches.open} onHide={taskMatches.hide} />}
            {notices}
            {/* The draft's isolated workspace (its default, and the body once turned on in
                More), as in today's draft: over the gap, so it moves nothing. Mounted exactly when
                Start reads it (startReadsDraftWorkspace): a start from a project's code source
                makes its own workspace and reads none of this. */}
            {!walnut && where.readsWorkspace && (
              <DraftWorkspaceRow draftId={draft.id} cwd={draft.cwd} host={draft.host ?? null} boundTaskId={draft.taskId} project={lowerDraft.project} />
            )}
          </div>
        </div>
        {walnut ? <QuickChatBlock title={quickTitle} line={quickLine} /> : repair && target ? (
          <DraftFixWalnutSlot target={target} hostName={where.hostName(where.hostKey)} startError={startError} onLeave={leaveRepair} />
        ) : (
          <DraftWhereRow draft={draft} where={where} boundsRef={bodyRef} narrow={narrow} menu={menu} setMenu={setMenu}
            startError={startError} onUpdate={onUpdate} onCustomizeWalnut={onCustomizeWalnut} />
        )}
        <div className="session-panel-input draft-v6-input">
          {composer}
          {startWhy && <div className="draft-v6-start-why" role="alert" data-testid="draft-v6-start-why">{startWhy}</div>}
        </div>
        <DraftLowerRow draft={lowerDraft} where={where} walnut={walnut} narrow={narrow} tryChips={tryChips} composerText={composerText}
          getComposer={getComposer} openMenuNonce={openMenuNonce} onTaskFieldChange={onTaskFieldChange} onReturnFieldToWalnut={onReturnFieldToWalnut}
          onSaveAsTask={onSaveAsTask} saveBusy={saveBusy} onMoreRecent={() => { if (repair) leaveRepair(); setMenu({ kind: 'where', query: '' }); }} onOpenAsk={onOpenAsk} />
        {target && (repair || onCustomizeWalnut) && (
          <DraftFixWalnutRow target={target} on={repair} hidden={walnut} onClick={repair ? leaveRepair : () => onCustomizeWalnut?.()} />
        )}
      </div>
    </div>
  );
}

/** True while the element is narrower than `px` (a ResizeObserver; the draft is a column of any width). */
function useNarrow(ref: RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  const last = useRef<boolean | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const n = el.clientWidth > 0 && el.clientWidth < px;
      if (n !== last.current) { last.current = n; setNarrow(n); }
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}
