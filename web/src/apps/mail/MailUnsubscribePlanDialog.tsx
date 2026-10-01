/**
 * The batch unsubscribe checklist (spec 10). Opens on the cache-only plan (`check=0`) at once, and
 * when some senders' headers were never read it asks for them (`check=1`) and APPENDS what it finds
 * below the rows already listed, so nothing moves under the pointer.
 *
 * Nothing leaves for a sender until the main button is pressed: opening, ticking and cancelling send
 * nothing. The batch then walks the existing ladder one list at a time on the server; each row shows
 * its own outcome. While it runs, Escape and the backdrop do nothing: `Stop after this one` is the
 * only way to interrupt, and it says exactly what it does.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { mailFailure } from '@/api/mail';
import {
  getMailUnsubscribeBatch, getMailUnsubscribePlan, startMailUnsubscribeBatch, stopMailUnsubscribeBatch,
  type MailGroupsScope, type MailUnsubscribePlan,
} from '@/api/mail-groups';
import { log } from '@/utils/log';
import { groupsViewKey, pushMailListStatus, updateMailListStatus } from './mail-groups-bus';
import { onUnsubBatch } from './mail-groups-live';
import { loadGroups } from './mail-groups-store';
import { MailUnsubscribePlanRow, type PlanRowRun } from './MailUnsubscribePlanRow';
import {
  PICK_SENTENCE, alreadyLine, appendChecked, batchStripText, checkingSentence,
  dialogTitle, headerUnknownSentence, listedItems, nothingToDo, partialSentence, runSummary,
  submitLabel, withoutOptionSentence, type PlanItem, type RunStatus,
} from './mail-unsub-plan-model';
import { openMailMessage } from './mail-actions';
import { openFinishUnsubscribeAsk, unsubscribeFromMessage } from './mail-unsubscribe-actions';

interface Batch {
  batchId: string;
  keys: string[];
  runs: PlanRowRun[];
  running: boolean;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Every list starts unticked; a list the person already ticked keeps its tick when more arrive. */
function ticksFor(items: PlanItem[], held: Record<string, boolean> = {}): Record<string, boolean> {
  const next = { ...held };
  for (const one of items) if (!(one.listKey in next)) next[one.listKey] = false;
  return next;
}

/**
 * The server's item status as a row status. It says `waiting` for a list that has not started; once
 * the batch is over (stopped) that list never will, which is `skipped`. `conflict` carries the
 * server's own sentence and reads as a failure with `Try again`.
 */
function statusOf(raw: string, batchOver = false): RunStatus {
  if (raw === 'waiting' || raw === 'queued') return batchOver ? 'skipped' : 'queued';
  if (raw === 'already' || raw === 'done' || raw === 'needs-human' || raw === 'failed' || raw === 'running' || raw === 'skipped') return raw;
  return raw === 'in-flight' ? 'running' : 'failed';
}

export function MailUnsubscribePlanDialog({ scope, groupId, groupLabel, plan, accountAddress, onClose }: {
  scope: MailGroupsScope;
  groupId: string;
  groupLabel: string;
  plan: MailUnsubscribePlan;
  /** accountId → the address a mailto would send from. */
  accountAddress: (accountId: string) => string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<PlanItem[]>(plan.items as PlanItem[]);
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => ticksFor(plan.items as PlanItem[]));
  const [checking, setChecking] = useState((plan.unchecked ?? 0) > 0);
  const [partial, setPartial] = useState<string | null>(null);
  const [counts, setCounts] = useState({ withoutOption: plan.withoutOption, headerUnknown: plan.headerUnknown });
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const batchRef = useRef<Batch | null>(null);
  batchRef.current = batch;
  const viewKey = groupsViewKey(scope);

  // The headers Walnut never read: fetched with PEEK on the server, appended below (spec 6.3).
  useEffect(() => {
    if ((plan.unchecked ?? 0) <= 0) return;
    let live = true;
    getMailUnsubscribePlan(scope, groupId, true).then((checked) => {
      if (!live) return;
      setItems((current) => appendChecked(current, checked.items as PlanItem[]));
      setTicked((held) => ticksFor(checked.items as PlanItem[], held));
      setCounts({ withoutOption: checked.withoutOption, headerUnknown: checked.headerUnknown });
      if (checked.partial) {
        const of = plan.unchecked ?? 0;
        setPartial(partialSentence(Math.max(0, of - (checked.unchecked ?? 0)), of));
      }
    }).catch((failure: unknown) => {
      log.warn('mail', 'unsubscribe header check failed', { error: mailFailure(failure).message });
    }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the first tickable row on open.
  useEffect(() => {
    const first = dialog.current?.querySelector<HTMLElement>('input[type="checkbox"]:not([disabled])')
      ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  // Each list's outcome, from the batch events; a poll is the floor for a lost socket.
  useEffect(() => {
    if (!batch?.running) return;
    const off = onUnsubBatch((event) => {
      if (event.batchId !== batchRef.current?.batchId) return;
      setBatch((held) => {
        if (!held) return held;
        const runs = [...held.runs];
        runs[event.index] = { status: statusOf(event.status), ...(event.message ? { message: event.message } : {}), ...(event.url ? { url: event.url } : {}) };
        if (event.index + 1 < runs.length && runs[event.index + 1]?.status === 'queued') runs[event.index + 1] = { status: 'running' };
        return { ...held, runs };
      });
    });
    const timer = setInterval(() => {
      const held = batchRef.current;
      if (!held) return;
      void getMailUnsubscribeBatch(held.batchId).then((state) => {
        setBatch((now) => now && now.batchId === state.batchId ? {
          ...now,
          running: state.state === 'running',
          runs: state.items.map((one, index) => {
            const status = statusOf(one.status, state.state === 'done');
            // A Stop already pressed here: a list the server still calls waiting stays skipped.
            const held = now.runs[index];
            if (status === 'queued' && held?.status === 'skipped') return held;
            return { status, ...(one.message ? { message: one.message } : {}), ...(one.url ? { url: one.url } : {}) };
          }),
        } : now);
      }).catch(() => undefined);
    }, 2_000);
    return () => { off(); clearInterval(timer); };
  }, [batch?.running, batch?.batchId]);

  // The batch finished: counts change (fewer lists to leave).
  const over = !!batch && batch.runs.every((one) => !['queued', 'running'].includes(one.status));
  useEffect(() => {
    if (!batch || !over) return;
    if (batch.running) setBatch({ ...batch, running: false });
    void loadGroups(scope, true);
    updateMailListStatus(`unsub:${batch.batchId}`, { text: batchStripText(batch.runs.map((one) => one.status), false), ttlMs: 12_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);

  const listed = listedItems(items);
  const tickedItems = listed.filter((one) => ticked[one.listKey] && (planIsTickable(one)));
  const ran = (index: number): PlanRowRun | null => (batch ? batch.runs[index] ?? null : null);
  const runIndex = (listKey: string): number => (batch ? batch.keys.indexOf(listKey) : -1);

  const start = async () => {
    if (tickedItems.length === 0 || batch) return;
    setError(null);
    try {
      const answer = await startMailUnsubscribeBatch(tickedItems.map((one) => ({ accountId: one.accountId, messageId: one.messageId, method: one.method })));
      const runs: PlanRowRun[] = tickedItems.map((_, index) => ({ status: index === 0 ? 'running' : 'queued' }));
      setBatch({ batchId: answer.batchId, keys: tickedItems.map((one) => one.listKey), runs, running: true });
      pushMailListStatus({
        id: `unsub:${answer.batchId}`, viewKey, sticky: true,
        text: batchStripText(runs.map((one) => one.status), true),
      });
    } catch (failure) {
      setError(mailFailure(failure).message);
    }
  };

  const stop = () => {
    const held = batchRef.current;
    if (!held) return;
    void stopMailUnsubscribeBatch(held.batchId).catch(() => undefined);
    // What has not started stays `Waiting` and never starts; the one running finishes.
    setBatch({ ...held, runs: held.runs.map((one) => (one.status === 'queued' ? { status: 'skipped' } : one)) });
  };

  const retry = async (listKey: string) => {
    const index = runIndex(listKey);
    const item = items.find((one) => one.listKey === listKey);
    if (!item || index < 0) return;
    const set = (run: PlanRowRun) => setBatch((held) => {
      if (!held) return held;
      const runs = [...held.runs];
      runs[index] = run;
      return { ...held, runs };
    });
    set({ status: 'running' });
    const answer = await unsubscribeFromMessage(item.accountId, item.messageId);
    if (!answer) return;
    // `reason` is a key to switch on, never words to print; the server's sentence goes to the row strip.
    set({ status: statusOf(answer.status), ...(answer.url ? { url: answer.url } : {}) });
  };

  const finishWithWalnut = (item: PlanItem) => {
    void openMailMessage(item.accountId, item.messageId).then(() => {
      openFinishUnsubscribeAsk(item.accountId, item.messageId);
    });
  };

  const running = !!batch && !over;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!running) onClose();
      return;
    }
    // Enter never submits from a checkbox (it would be a slip, not a decision).
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON' && (event.target as HTMLElement).tagName !== 'A') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const empty = nothingToDo({ items: listed });
  const already = alreadyLine(items);
  const without = withoutOptionSentence(counts.withoutOption);
  const unknown = headerUnknownSentence(counts.headerUnknown);
  const titleId = `mail-unsub-plan-title-${groupId}`;
  return createPortal(
    <div
      className="mail-unsub-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <div
        ref={dialog}
        className="mail-unsub-plan"
        data-testid="mail-unsub-plan"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 className="mail-unsub-title" id={titleId}>{dialogTitle(groupLabel)}</h2>
        {batch && <p className="mail-unsub-summary" data-testid="mail-unsub-summary">{runSummary(batch.runs.map((one) => one.status))}</p>}
        {listed.length > 0 && !batch && (
          <p className="mail-unsub-note" data-testid="mail-unsub-pick">{PICK_SENTENCE}</p>
        )}
        {checking && (
          <p className="mail-unsub-note" data-testid="mail-unsub-checking" aria-live="polite">{checkingSentence(plan.unchecked ?? 0)}</p>
        )}
        {partial && <p className="mail-unsub-note" data-testid="mail-unsub-partial">{partial}</p>}
        <ul className="mail-unsub-list">
          {listed.map((item) => {
            const index = runIndex(item.listKey);
            return (
              <MailUnsubscribePlanRow
                key={item.listKey}
                item={item}
                ticked={!!ticked[item.listKey]}
                onTick={(next) => setTicked((held) => ({ ...held, [item.listKey]: next }))}
                disabled={!!batch}
                run={index >= 0 ? ran(index) : null}
                fromAddress={accountAddress(item.accountId)}
                onRetry={() => { void retry(item.listKey); }}
                onFinishWithWalnut={() => finishWithWalnut(item)}
              />
            );
          })}
        </ul>
        {already && <p className="mail-unsub-note" data-testid="mail-unsub-already">{already}</p>}
        {without && <p className="mail-unsub-note" data-testid="mail-unsub-without">{without}</p>}
        {unknown && <p className="mail-unsub-note" data-testid="mail-unsub-header-unknown">{unknown}</p>}
        {error && <p className="mail-inline-error" role="alert">{error}</p>}
        <div className="mail-unsub-buttons">
          {empty || over ? (
            <button type="button" className="mail-group-btn primary" data-testid="mail-unsub-close" onClick={onClose}>Close</button>
          ) : running ? (
            <button type="button" className="mail-group-btn" data-testid="mail-unsub-stop" onClick={stop}>Stop after this one</button>
          ) : (
            <>
              <button type="button" className="mail-group-btn" data-testid="mail-unsub-cancel" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="mail-group-btn primary"
                data-testid="mail-unsub-submit"
                disabled={tickedItems.length === 0}
                onClick={() => { void start(); }}
              >
                {submitLabel(tickedItems.length)}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function planIsTickable(item: PlanItem): boolean {
  return !item.done && item.attempt?.status !== 'in-flight' && !(item.method === 'mailto' && !item.canSend);
}
