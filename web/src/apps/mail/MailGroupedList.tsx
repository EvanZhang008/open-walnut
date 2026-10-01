/**
 * The grouped inbox: a one-line header, the status strip, one line per group that holds UNREAD mail
 * (newest first), then Important (unbounded, newest first, paged, read mail included: it is the
 * reading list).
 *
 * The groups are the model's (sort-ai.ts on the server): nothing here knows a group's name in advance.
 * A group with no unread mail is not drawn, except while it is open and the pointer is still over the
 * list, so the mail somebody just read does not vanish from under the pointer. While the pointer is
 * over the list the group ORDER is held too (a group whose mail just arrived must not jump under it);
 * both let go once the pointer leaves.
 *
 * `MailMessageList` renders this ONLY for an inbox-role folder or All Inboxes, with the switch on and
 * no search running; every other list is exactly what it was.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { mailFailure } from '@/api/mail';
import { getMailUnsubscribePlan, type MailGroupItem, type MailGroupsScope, type MailUnsubscribePlan } from '@/api/mail-groups';
import { MailGroupLine, type GroupNumbers } from './MailGroupLine';
import { MailGroupedHeader } from './MailGroupedHeader';
import { MailListStatus } from './MailListStatus';
import { isOpenRow, MailRow } from './MailMessageRow';
import { MailUnsubscribePlanDialog } from './MailUnsubscribePlanDialog';
import {
  ALL_CAUGHT_UP, ALL_CAUGHT_UP_DETAIL, ALL_CAUGHT_UP_EMPTY, IMPORTANT_EMPTY, IMPORTANT_EMPTY_UNREAD, STALE_COUNTS,
  groupsErrorText, rulesErrorText, sortProgressText, unreadWord,
} from './mail-groups-copy';
import { groupedNumbers, groupedScopeOf, wireGroupsBus } from './mail-groups-live';
import {
  IMPORTANT_ID, drawnGroups, holdGroupOrder, loadGroupPage, loadGroups, releaseSpentGroups, resetPage, useGroupPage,
  useGroupsView, viewState, type GroupsViewState,
} from './mail-groups-store';
import { useGroupedPref } from './mail-grouped-pref';
import { SMART_ACCOUNT, SMART_INBOX, type MailSnapshot } from './mail-store';
import { readUnreadOnly, subscribeUnreadOnly, writeUnreadOnly } from './mail-unread-filter';
import type { MailRowMenuHandle } from './MailRowContextMenu';
import './mail-groups.css';

export interface GroupedMode {
  scope: MailGroupsScope;
  /** The switch is on (the list is grouped unless `failed`). */
  on: boolean;
  /** `/groups` failed with nothing to show: the ordinary list is drawn, with the error line. */
  failed: boolean;
}

/** Whether (and how) the list on screen is a grouped one. Null: grouping does not apply here. */
export function useGroupedMode(snapshot: MailSnapshot): GroupedMode | null {
  const on = useGroupedPref();
  const scope = snapshot.search.active ? null : groupedScopeOf(snapshot.selected);
  const view = useGroupsView(scope ?? { role: 'inbox' });
  if (!scope) return null;
  return { scope, on, failed: on && !!view.error && !view.groups };
}

/** Grouping failed with nothing to show: the ordinary list is drawn under this line. */
export function MailGroupsFallback({ mode }: { mode: GroupedMode }) {
  const view = useGroupsView(mode.scope);
  if (!mode.failed || !view.error) return null;
  return (
    <p className="mail-list-note mail-groups-error" data-testid="mail-groups-error" role="status">
      <span>{groupsErrorText(view.error)}</span>
      <button
        type="button"
        className="mail-text-btn"
        data-testid="mail-groups-retry"
        onClick={() => { void loadGroups(mode.scope, true); }}
      >
        Try again
      </button>
    </p>
  );
}

function selectionOf(scope: MailGroupsScope): { accountId: string; mailboxId: string } {
  return 'role' in scope ? { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX } : scope;
}

function numbersOf(group: MailGroupItem, unread: number, rulesRev: string, recomputing: boolean): GroupNumbers {
  // The overlay moved `unread` since the answer; the markable share moves with it, never above it.
  const markable = Math.max(0, Math.min(unread, group.markableUnread + (unread - group.unread)));
  return { unread, markable, rulesRev, recomputing };
}

/** The state lines under the header: a recompute in progress, a rules file error, stale counts. */
function GroupsStateLines({ view, onOpenRules }: { view: GroupsViewState; onOpenRules: () => void }) {
  const groups = view.groups;
  if (!groups) return null;
  const recomputing = groups.recomputing;
  const firstBackfill = !!recomputing && recomputing.total >= Math.max(1, groups.cachedTotal) * 0.9;
  if (!recomputing && !groups.rulesError && !groups.stale) return null;
  return (
    <div className="mail-grouped-state">
      {recomputing && (
        <p className="mail-list-note" data-testid="mail-sort-progress" aria-live="polite">
          {sortProgressText(recomputing.done, recomputing.total, firstBackfill)}
        </p>
      )}
      {groups.rulesError && (
        <p className="mail-list-note mail-rules-error" data-testid="mail-rules-error">
          <span>{rulesErrorText(groups.rulesError.line)}</span>
          <button type="button" className="mail-text-btn" data-testid="mail-rules-open" onClick={onOpenRules}>
            Open Mail rules
          </button>
        </p>
      )}
      {groups.stale && <p className="mail-list-note" data-testid="mail-groups-stale">{STALE_COUNTS}</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mail-group-skeletons" data-testid="mail-group-skeleton" aria-hidden="true">
      <span className="mail-group-skeleton" />
      <span className="mail-group-skeleton" />
      <span className="mail-group-skeleton" />
    </div>
  );
}

interface PlanState { groupId: string; busy: boolean; error: string | null; plan: MailUnsubscribePlan | null; anchor: HTMLElement | null }

export function MailGroupedList({ snapshot, scope: scopeProp, menu, name }: {
  snapshot: MailSnapshot;
  scope: MailGroupsScope;
  menu: MailRowMenuHandle;
  /** The header's name (`Inbox`, `All Inboxes`), from the ordinary section rules. */
  name: string;
}) {
  // One scope object per view, so effects keyed on it do not run on every render.
  const propKey = 'role' in scopeProp ? 'smart' : JSON.stringify([scopeProp.accountId, scopeProp.mailboxId]);
  const scope = useMemo(() => scopeProp, [propKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useGroupsView(scope);
  const viewKey = view.viewKey;
  const selection = selectionOf(scope);
  const unreadOnly = useSyncExternalStore(subscribeUnreadOnly, () => readUnreadOnly(selection.accountId, selection.mailboxId));
  const important = useGroupPage(scope, IMPORTANT_ID);
  const navigateTo = useNavigate();
  const [plan, setPlan] = useState<PlanState | null>(null);

  useEffect(() => { wireGroupsBus(); }, []);
  // Stale-while-revalidate: whatever this view last held draws at once, and both reads refresh it.
  useEffect(() => {
    // An open group left at zero last time is not drawn again.
    releaseSpentGroups(scope);
    void loadGroups(scope, true);
    void loadGroupPage(scope, IMPORTANT_ID, '', 'first', readUnreadOnly(selection.accountId, selection.mailboxId));
    for (const [id, open] of Object.entries(viewState(scope).expanded)) {
      if (open) void loadGroupPage(scope, id, '', 'first', true, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);
  // Leaving the view lets the order follow the server again.
  useEffect(() => () => { holdGroupOrder(scope, null); }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Grouped menu (or the folder menu) changed the filter: Important is read again under it.
  const shownFilter = useRef(unreadOnly);
  useEffect(() => {
    if (shownFilter.current === unreadOnly) return;
    shownFilter.current = unreadOnly;
    resetPage(scope, IMPORTANT_ID);
    void loadGroupPage(scope, IMPORTANT_ID, '', 'first', unreadOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadOnly]);

  const openPlan = async (groupId: string, anchor: HTMLElement) => {
    setPlan({ groupId, busy: true, error: null, plan: null, anchor });
    try {
      const answer = await getMailUnsubscribePlan(scope, groupId, false);
      setPlan({ groupId, busy: false, error: null, plan: answer, anchor });
    } catch (error) {
      setPlan({ groupId, busy: false, error: `Walnut couldn't list the unsubscribe options: ${mailFailure(error).message.replace(/[.\s]+$/, '')}.`, plan: null, anchor });
    }
  };
  const closePlan = () => {
    const anchor = plan?.anchor;
    setPlan(null);
    void loadGroups(scope, true);
    if (anchor?.isConnected) anchor.focus();
  };
  const accountAddress = (accountId: string) => snapshot.accounts.find((one) => one.accountId === accountId)?.address ?? '';

  const numbers = groupedNumbers(view);
  const groups = view.groups;
  const rulesRev = groups?.rulesRev ?? '';
  const recomputing = !!groups?.recomputing;
  const drawn = drawnGroups(view);
  const accountLabels = 'role' in scope && snapshot.accounts.length > 1 ? snapshot.accounts : null;
  const planGroup = plan ? drawn.find((one) => one.group.id === plan.groupId)?.group ?? null : null;
  const unreadTotal = (numbers?.importantUnread ?? 0) + (numbers?.groupedUnread ?? 0);
  const caughtUp = !!groups && drawn.length === 0 && (numbers?.importantUnread ?? 0) === 0;

  // Hold the order while the pointer is over the list; let it go when it leaves. Read from the
  // document, not React's enter/leave: a menu's full-page backdrop is a React child of the list, and
  // once it closes under a still pointer the browser's next move starts from a removed node, so React
  // never reports the leave and the list stayed held (0-unread groups kept, order frozen).
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const drawnIds = useRef<string[]>([]);
  drawnIds.current = drawn.map((one) => one.group.id);
  useEffect(() => {
    const hold = () => { if (!viewState(scope).heldOrder) holdGroupOrder(scope, drawnIds.current); };
    const release = () => { holdGroupOrder(scope, null); releaseSpentGroups(scope); };
    const onOver = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // A menu opened over the list changes nothing: the rows it acts on stay where they are.
      if (!target || target.closest('.wn-context-backdrop, .wn-context-menu')) return;
      if (rowsRef.current?.contains(target)) hold();
      else release();
    };
    // Out of the window (or into the reader's frame): nothing in this document reports the next spot.
    const onOut = (event: PointerEvent) => { if (!event.relatedTarget) release(); };
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    return () => {
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
    };
  }, [scope]);

  return (
    <div className="mail-grouped-pane" data-testid="mail-grouped" data-view-key={viewKey}>
      <MailGroupedHeader
        name={name}
        unread={unreadTotal}
        explain={numbers?.explain ?? ''}
        ai={groups?.ai ?? null}
        unreadOnly={unreadOnly}
        onUnreadOnly={(next) => { writeUnreadOnly(selection.accountId, selection.mailboxId, next); }}
      />
      <MailListStatus viewKey={viewKey} />
      <GroupsStateLines view={view} onOpenRules={() => navigateTo('/settings#mail-rules')} />
      {plan?.error && (
        <p className="mail-list-note" data-testid="mail-unsub-plan-error" role="status">
          <span>{plan.error}</span>
          <button type="button" className="mail-text-btn" onClick={() => setPlan(null)}>Dismiss</button>
        </p>
      )}
      <div className="mail-rows mail-grouped" ref={rowsRef}>
        {!groups ? (
          <>
            <Skeleton />
            <p className="mail-pane-empty" data-testid="mail-list-empty">Loading…</p>
          </>
        ) : (
          <>
            {drawn.length > 0 && (
              <div className="mail-group-list" data-testid="mail-group-rows">
                {drawn.map(({ group, unread }) => (
                  <MailGroupLine
                    key={group.id}
                    group={group}
                    numbers={numbersOf(group, unread, rulesRev, recomputing)}
                    open={!!view.expanded[group.id]}
                    scope={scope}
                    snapshot={snapshot}
                    menu={menu}
                    accounts={accountLabels}
                    onUnsubscribe={(id, anchor) => { void openPlan(id, anchor); }}
                    unsubBusy={plan?.groupId === group.id && plan.busy}
                  />
                ))}
              </div>
            )}
            {caughtUp && (
              <div className="mail-caught-up" data-testid="mail-caught-up">
                <strong>{ALL_CAUGHT_UP}</strong>
                <span>{important.rows.length > 0 ? ALL_CAUGHT_UP_DETAIL : ALL_CAUGHT_UP_EMPTY}</span>
              </div>
            )}
            <div className="mail-important">
              <p className="mail-list-section mail-important-head" data-testid="mail-important-head" title={numbers?.explain}>
                <span className="mail-list-section-name">Important</span>
                {(numbers?.importantUnread ?? 0) > 0 && (
                  <span className="mail-important-unread" data-testid="mail-important-unread">{unreadWord(numbers!.importantUnread)}</span>
                )}
              </p>
              {important.rows.length === 0 ? (
                important.loaded ? (
                  caughtUp ? null : (
                    <p className="mail-pane-empty mail-important-empty" data-testid="mail-important-empty">
                      {unreadOnly ? IMPORTANT_EMPTY_UNREAD : IMPORTANT_EMPTY}
                    </p>
                  )
                ) : <p className="mail-pane-empty" data-testid="mail-important-loading">Loading…</p>
              ) : important.rows.map((message) => (
                <MailRow
                  key={`${message.accountId} ${message.messageId}`}
                  message={message}
                  accounts={accountLabels}
                  selected={isOpenRow(snapshot, message)}
                  menu={menu}
                  flagFailed={snapshot.flagFailed}
                />
              ))}
              {important.error && <p className="mail-inline-error">{important.error}</p>}
              {important.nextBefore && important.rows.length > 0 && (
                <button
                  type="button"
                  className="mail-load-older"
                  data-testid="mail-load-older"
                  disabled={important.olderLoading}
                  onClick={() => { void loadGroupPage(scope, IMPORTANT_ID, '', 'older', unreadOnly); }}
                >
                  {important.olderLoading ? 'Loading…' : 'Load older'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {plan?.plan && planGroup && (
        <MailUnsubscribePlanDialog
          scope={scope}
          groupId={plan.groupId}
          groupLabel={planGroup.label}
          plan={plan.plan}
          accountAddress={accountAddress}
          onClose={closePlan}
        />
      )}
    </div>
  );
}
