/**
 * The row under the v6 draft's composer (experiment `project_first_start`):
 *
 *   Start task:                                           [Task source: Tracker]  ☑ Save as task  More ▾
 *                (Recent / Most used and five places under it: DraftRecentList)
 *   Quick chat:  Try [⌕ Find a task] [▦ Schedule my day] …  |  Recent chats [▢ Plan my Friday] …   More ▾
 *
 * Start task lists the places used before, Recent or Most used, five rows under the row;
 * "Start with" and a few projects for someone who has none yet; Quick chat's Recent chats are the agent's newest
 * quick chats (the Ask Walnut drawer's list), a click opens one there. A chip that does not fit whole
 * is not shown. More is the draft's one menu (tier, priority,
 * dates) plus the task's source for a project that syncs; the tag shows while that service is
 * chosen. A fixed height: nothing here grows or moves the composer.
 */
import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { GENERAL_ASK_AGENT, recentAsks, toAskAgent, type AskAgent, type RecentAsk } from '@/components/chat/ask-walnut-slot-model';
import * as ICONS from '@/components/common/Icons';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { projectDisplayName } from '@/utils/project-display';
import { SyncChoiceMenuRow, SyncChoiceTag } from '@/components/tasks/SyncChoice';
import { DraftWorkspaceMenuItem } from '@/components/workspaces/DraftWorkspaceMenuItem';
import { DraftWorkspaceAutoChip } from '@/components/workspaces/DraftWorkspaceRow';
import { DraftMoreButton } from './DraftDecisionRow';
import { DraftTaskMenuPopover } from './DraftTaskMenu';
import { WhereIcon, whereKindOf, type WhereKind } from './DraftWhereIcons';
import type { DraftColumn, DraftTaskField, DraftTaskFieldPatch } from './draft-column';
import type { DraftWhere } from './useDraftWhere';
import { useDraftMoreMenu } from './useDraftMoreMenu';
import { projectMenuOrder, recentPlaces } from './draft-work-in';
import { DraftRecentList } from './DraftRecentList';

export interface TryChip { label: string; icon: ReactNode; onClick: () => void }

/** Recent chats shown beside Try (one in a narrow row). */
const RECENT_CHATS = 2;

export function DraftLowerRow({
  draft, where, walnut, narrow, tryChips, composerText, getComposer, openMenuNonce, onTaskFieldChange, onReturnFieldToWalnut,
  onSaveAsTask, saveBusy, onMoreRecent, onOpenAsk,
}: {
  draft: DraftColumn;
  where: DraftWhere;
  /** Quick chat: Try chips instead of Recent, no Save as task. */
  walnut: boolean;
  narrow: boolean;
  tryChips: readonly TryChip[];
  composerText: string;
  getComposer: () => HTMLTextAreaElement | null;
  openMenuNonce?: number;
  onTaskFieldChange?: (draftId: string, patch: DraftTaskFieldPatch) => void;
  onReturnFieldToWalnut?: (draftId: string, field: DraftTaskField) => void;
  onSaveAsTask: () => void;
  saveBusy: boolean;
  /** "Browse folders" under the row: every folder, in the Where picker. */
  onMoreRecent: () => void;
  /** Opens a quick chat in the Ask Walnut slot; without it there are no Recent chats. */
  onOpenAsk?: (taskId: string) => void;
}) {
  const more = useDraftMoreMenu(draft, { getComposer, composerText, openMenuNonce, onTaskFieldChange, onReturnFieldToWalnut });
  const { favoriteByName } = useProjectRegistry();
  const byName = new Map(where.rows.map((r) => [r.name.toLowerCase(), r]));
  const recent = recentPlaces(where.dirs, (n) => byName.get(n.toLowerCase())?.name ?? null);
  const fresh = recent.length === 0;
  const starters = fresh ? projectMenuOrder(where.rows, (n) => favoriteByName.has(n.toLowerCase()), '').slice(0, 3) : [];
  const local = draft.meta.sync !== 'project';
  const openMore = () => { if (more.moreRef.current) more.menu.openFrom(more.moreRef.current, { detail: 1 }); };
  const chats = useRecentAsks(draft.agent ? toAskAgent(draft.agent) : GENERAL_ASK_AGENT, walnut && !!onOpenAsk, narrow ? 1 : RECENT_CHATS);
  const quickRef = useRef<HTMLDivElement>(null);
  useFitWhole(quickRef, `${walnut}:${narrow}:${chats.map((c) => c.id).join(',')}`);
  // Recent too: a tag at the row's end (the Task source) never cuts a chip, it hides it whole.
  const recentRef = useRef<HTMLDivElement>(null);
  useFitWhole(recentRef, `${walnut}:${narrow}:${draft.meta.sync ?? ''}:${starters.map((r) => r.name).join(',')}`);

  return (
    <>
    <div className="draft-v6-lower" data-testid="draft-v6-lower">
      {walnut ? (
        <div ref={quickRef} className="draft-v6-chips" data-testid="draft-v6-quick-lower">
          {/* Two Try chips when Recent chats follow, so a chat chip fits whole beside "Task settings". */}
          <span className="draft-v6-chip-group" role="group" aria-label="Try">
            <span className="draft-v6-lower-key" data-fit="key">Try</span>
            {tryChips.slice(0, narrow || chats.length > 0 ? 2 : 3).map((c) => (
              <button key={c.label} type="button" className="btn btn-sm draft-v6-place" data-fit="chip" onMouseDown={(e) => e.preventDefault()} onClick={c.onClick}>
                <span className="draft-v6-place-ic" aria-hidden="true">{c.icon}</span>{c.label}
              </button>
            ))}
          </span>
          {chats.length > 0 && (
            <span className="draft-v6-chip-group" role="group" aria-label="Recent chats" data-testid="draft-v6-recent-chats">
              <span className="draft-v6-lower-sep" data-fit="key" aria-hidden="true" />
              <span className="draft-v6-lower-key" data-fit="key">Recent chats</span>
              {chats.map((c) => (
                <button key={c.id} type="button" className="btn btn-sm draft-v6-place" data-fit="chip" data-testid="draft-v6-recent-chat"
                  title={`${c.title}: open this chat`} onMouseDown={(e) => e.preventDefault()} onClick={() => onOpenAsk?.(c.id)}>
                  <span className="draft-v6-place-ic" aria-hidden="true">{ICONS.ICON_CHAT}</span>{c.title}
                </button>
              ))}
            </span>
          )}
        </div>
      ) : (
        // Only someone with no places yet has chips here ("Start with"); the places used before are
        // DraftRecentList's rows under the row, so an empty row is no labelled group.
        <div ref={recentRef} className="draft-v6-chips" role={fresh ? 'group' : undefined} aria-label={fresh ? 'Start with' : undefined} data-testid="draft-v6-recent">
          {fresh && <span className="draft-v6-lower-key" data-fit="key">Start with</span>}
          {fresh && starters.map((r) => (
            <StartChip key={r.name} kind={r.startSource ? whereKindOf(r.startSource) : 'folder'} label={projectDisplayName(r.name)}
              current={where.project.toLowerCase() === r.name.toLowerCase()} onClick={() => where.pickProject(r.name)} />
          ))}
        </div>
      )}
      <span className="draft-v6-lower-end">
        {/* A folder start that isolates by default says so, with its × (today's chip). */}
        {!walnut && where.readsWorkspace && draft.cwd && <DraftWorkspaceAutoChip draftId={draft.id} />}
        {!walnut && more.decisionsOn && (
          <SyncChoiceTag project={draft.project} local={local} onOpen={openMore} />
        )}
        {!walnut && (
          <button type="button" className="btn btn-sm draft-v6-save" data-testid="draft-v6-save-todo" disabled={!composerText.trim() || saveBusy}
            aria-busy={saveBusy || undefined} title="Save as task: creates a task from this text (first line becomes the title). No session starts."
            onMouseDown={(e) => e.preventDefault()} onClick={onSaveAsTask}>
            <span aria-hidden="true">{ICONS.ICON_CHECK}</span>Save as task
          </button>
        )}
        {more.decisionsOn && <DraftMoreButton menu={more.menu} moreRef={more.moreRef} priorityVisible={more.priorityVisible} />}
      </span>
      {more.decisionsOn && (
        <DraftTaskMenuPopover
          open={more.menu.open}
          anchorEl={more.menu.anchor}
          menuRef={more.menu.menuRef}
          meta={draft.meta}
          priorityVisible={more.priorityVisible}
          walnutPicks={more.walnutPicks}
          onChange={more.handleTaskFieldChange}
          onReturnToWalnut={onReturnFieldToWalnut ? more.handleReturnToWalnut : undefined}
          onClose={more.menu.close}
          onAnchorLost={more.menu.onAnchorLost}
          focusNonce={more.menu.mode === 'keyboard' ? more.menu.focusNonce : 0}
          workspace={!walnut && where.readsWorkspace
            ? <DraftWorkspaceMenuItem draftId={draft.id} hasFolder={!!draft.cwd} onDone={() => more.menu.close('select')} />
            : undefined}
          taskSource={!walnut
            ? <SyncChoiceMenuRow project={draft.project} local={local} onChange={(l) => more.handleTaskFieldChange({ sync: l ? 'local' : 'project' })} />
            : undefined}
        />
      )}
    </div>
    {!walnut && !fresh && <DraftRecentList draft={draft} where={where} places={recent} byName={byName} onBrowse={onMoreRecent} />}
    </>
  );
}

function StartChip({ kind, label, current, onClick }: { kind: WhereKind; label: string; current: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-sm draft-v6-place" aria-pressed={current} title={current ? `${label}: in use now` : label}
      data-fit="chip" data-testid="draft-v6-start-chip" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {/* The place in use is the button family's pressed look (aria-pressed); it keeps its own icon, no check. */}
      <span className={`draft-v6-place-ic is-${kind}`} aria-hidden="true">
        <WhereIcon kind={kind} size={13} />
      </span>
      {label}
    </button>
  );
}

/** The agent's newest quick chats from the task store (a string key, so the store's other changes do not re-render). */
function useRecentAsks(agent: AskAgent, on: boolean, limit: number): RecentAsk[] {
  const key = useTaskListSelect(({ tasks }) => (on ? JSON.stringify(recentAsks(tasks, agent, limit)) : '')) ?? '';
  return useMemo(() => (key ? JSON.parse(key) as RecentAsk[] : []), [key]);
}

/**
 * Hides every `[data-fit]` part from the first one that does not fit whole in `ref` on, and a key
 * or separator left last without a chip after it (the spec: a chip that does not fit is not shown,
 * never cut). Measured again when the row changes width or `key` changes.
 */
function useFitWhole(ref: RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => {
      const parts = [...box.querySelectorAll<HTMLElement>('[data-fit]')];
      for (const p of parts) p.hidden = false;
      const right = box.getBoundingClientRect().right + 0.5;
      const cut = parts.findIndex((p) => p.getBoundingClientRect().right > right);
      if (cut >= 0) for (const p of parts.slice(cut)) p.hidden = true;
      for (let i = (cut >= 0 ? cut : parts.length) - 1; i >= 0 && parts[i].dataset.fit === 'key'; i--) parts[i].hidden = true;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [ref, key]);
}
