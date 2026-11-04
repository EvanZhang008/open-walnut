/**
 * "#12 · 1 check failed": a task's linked pull request and where it stands, on the task row,
 * the pinned card and the session header. The watcher on the server keeps it current
 * (src/core/pull-requests/pr-watch.ts); the pill reads the snapshot on the task, so it changes
 * the moment a task:updated arrives.
 *
 *   pill   the pull request that needs a look first (a failed check before a running one),
 *          its number and state in one tone; "+1" when the task links more than one
 *   card   on a click: each pull request with its checks (the failed and running ones by name),
 *          review, merge state, the last time it woke the agent and what a merge did; two
 *          switches for this task (wake the agent, complete on merge); when it was last read,
 *          and Refresh
 *
 * Overlay rules (web/src/AGENTS.md): the card is portalled to <body>, placed by useMenuPlacement,
 * stops pointerdown (rows are dnd-kit draggables), and closes on an outside pointerdown or Escape.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import {
  leadPr, prChecksLine, prPillState, PR_ERROR_WORDS, PR_REVIEW_WORDS, watchablePrUrls,
  type PrCheck, type PrSnapshot, type PrTone,
} from '../../../../src/core/pull-requests/model';
import { apiGet, apiPatch, apiPost } from '@/api/client';
import { completeTask } from '@/api/tasks';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useKeyboardOpenFocus } from '@/hooks/useKeyboardOpenFocus';
import { useStoreTask } from '@/contexts/TasksContext';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import '@/styles/pr-pill.css';

/** A pull request as the card has it: when it was last read, and last read without an error. */
type CardPr = PrSnapshot & { lastReadAt?: string; lastGoodAt?: string };

interface PrView {
  watching: boolean;
  autoComplete: boolean;
  wake: boolean;
  prs: Array<CardPr>;
}

const CARD_CHECKS = 8;

/** The phone top bar's mark on its glyph, so a state never reads by colour alone. */
const PR_MARKS: Partial<Record<PrTone, string>> = { failed: '✕', conflict: '!', changes: '!', pending: '…', passed: '✓' };

/** A card open when its pill unmounted, by task, and when: the pill mounted next for that task
 *  within REOPEN_MS opens it again. */
const openAtUnmount = new Map<string, number>();
const REOPEN_MS = 1500;
function reopenFor(taskId: string): boolean {
  const at = openAtUnmount.get(taskId);
  openAtUnmount.delete(taskId);
  return at !== undefined && Date.now() - at < REOPEN_MS;
}

/** The last answer per task, so a card opened again draws whole at once. */
const lastViews = new Map<string, PrView>();
/** Before the first answer, a task the watcher has written for is watched with the defaults:
 *  the card draws its switches and Refresh at once instead of growing under the pointer. */
const ASSUMED_VIEW: PrView = { watching: true, autoComplete: true, wake: true, prs: [] };

/** The git-pull-request glyph, drawn as GitHub tells its states apart without colour: the merge
 *  once merged, a cross for closed, a dashed branch for a draft. */
function PrGlyph({ pr }: { pr?: Pick<PrSnapshot, 'state' | 'draft'> }) {
  const kind = pr?.state === 'merged' ? 'merged' : pr?.state === 'closed' ? 'closed' : pr?.draft ? 'draft' : 'open';
  return (
    <svg className="pr-pill-glyph" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" data-kind={kind}
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'merged'
        ? <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="9" r="1.6" /><path d="M4 5.1v5.8M4 5.1c0 2.4 2 3.9 6.4 3.9" /></>
        : kind === 'closed'
          ? <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V8" /><path d="M10 2.5l4 4M14 2.5l-4 4" /></>
          : kind === 'draft'
            ? <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8" /><path d="M12 10.9v-1M12 7.6v-1M12 4.3v-1" /></>
            : <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5" /><path d="M9 3l-1.5 1.5L9 6" /></>}
    </svg>
  );
}

/** A read that failed: what the pill says is what Walnut saw before. */
function StaleGlyph() {
  return (
    <svg className="pr-pill-glyph" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.2" /><path d="M8 4.6v4.2" /><path d="M8 11.4v.01" />
    </svg>
  );
}

/** Opening downward, the card may grow to the window's bottom edge: what a read adds after it was
 *  placed shows at once instead of under a cap measured before (the placement re-measures too). */
function cardStyle(placement: ReturnType<typeof useMenuPlacement>, trigger: HTMLElement | null): CSSProperties {
  const style = menuPlacementStyle(placement);
  if (!placement || !trigger || typeof window === 'undefined') return style;
  if (placement.top < trigger.getBoundingClientRect().bottom - 1) return style;
  return { ...style, maxHeight: Math.max(placement.maxHeight, window.innerHeight - placement.top - 8) };
}

function CheckMark({ status }: { status: PrCheck['status'] }) {
  return (
    <span className="pr-card-check-mark" data-status={status} aria-hidden="true">
      {status === 'failed' ? '✕' : status === 'pending' ? '◌' : '✓'}
    </span>
  );
}

const STATE_WORDS: Record<PrSnapshot['state'], string> = { open: 'Open', merged: 'Merged', closed: 'Closed' };

/** The pill's words for the task's pull requests (also its accessible name). */
/** The folded pill's parts, drawn as generated text (pr-pill.css) so the words are read once. */
export interface PrPillShort {
  n: string; who?: string;
  /** The state as a tight column says it ("1 failed", "Changes requested"), and as a narrower
   *  one does ("Failed", "Changes"). */
  word: string; narrowWord: string;
  more?: string; stale?: string;
}

export function prPillText(prs: readonly PrSnapshot[], urls: readonly string[]): {
  tone: PrTone; text: string; short: string; parts: PrPillShort; stale: boolean; lead?: PrSnapshot;
} {
  const lead = leadPr(prs);
  const others = urls.length - 1;
  const more = others > 0 ? ` (+${others} ${others === 1 ? 'PR' : 'PRs'})` : '';
  const plus = others > 0 ? `+${others}` : undefined;
  if (!lead) {
    const n = `#${urls[0]?.split('/').pop() ?? ''}`;
    return { tone: 'unknown', text: `${n}${more}`, short: [n, 'PR', plus].filter(Boolean).join(' '), parts: { n, word: 'PR', narrowWord: 'PR', more: plus }, stale: false };
  }
  const { tone, label, short: narrowWord } = prPillState(lead);
  // With room, the word says what failed and what a review asked, in the session header's words
  // ("1 check failed, conflict").
  const word = tone === 'failed' ? label : tone === 'changes' ? 'Changes requested' : narrowWord;
  const n = `#${lead.number}`;
  // Another person's pull request says whose it is: it never wakes or completes this task.
  const who = lead.checkedAt && lead.author && !lead.mine ? lead.author : undefined;
  // An open pull request whose last read failed shows what Walnut saw before, marked as such.
  const stale = lead.state === 'open' && !!lead.checkedAt && !!lead.error;
  const text = `${n} · ${label}${stale ? ' · not current' : ''}${who ? ` · by ${who}` : ''}${more}`;
  // Folded in a tight column: the number, whose, the state's word, how many more.
  const old = stale ? 'not current' : undefined;
  return { tone, text, short: [n, who, word, old, plus].filter(Boolean).join(' '), parts: { n, who, word, narrowWord, more: plus, stale: old }, stale, lead };
}

function mergeLine(pr: PrSnapshot): string | null {
  if (pr.state !== 'open') return null;
  if (pr.mergeable === 'conflicting') return `Conflicts with ${pr.base || 'its base branch'}`;
  if (pr.mergeable === 'clean') return `No conflicts with ${pr.base || 'its base branch'}`;
  return 'GitHub is still checking';
}

function PrError({ error, seen }: { error: NonNullable<PrSnapshot['error']>; seen?: string }) {
  return (
    <div className="pr-card-error" data-testid="pr-card-error" role="status">
      {PR_ERROR_WORDS[error.code]}
      {(error.code === 'signed-out' || error.code === 'cli-missing') && (
        <> Run <code>{error.code === 'cli-missing' ? 'brew install gh' : 'gh auth login'}</code> there, then Refresh.</>
      )}
      {seen && <> Below is what it showed {timeAgo(seen, { long: true })}.</>}
    </div>
  );
}

function PrSection({ pr, alone, onComplete, completing, done, errorAbove, waitingOn, completeOn }: {
  pr: CardPr; alone: boolean; onComplete?: () => void; completing?: boolean;
  /** The task is complete. */
  done: boolean;
  /** The card says the read error once, above every pull request. */
  errorAbove: boolean;
  /** The task's other pull requests still open. */
  waitingOn: number[];
  completeOn: boolean;
}) {
  const { tone } = prPillState(pr);
  const items = pr.checks.items;
  const hidden = pr.checks.failed + pr.checks.pending - Math.min(items.length, CARD_CHECKS);
  const merge = mergeLine(pr);
  const w = pr.watch;
  if (!pr.checkedAt) {
    // Never read: nothing to show but which pull request it is and why it is not read.
    return (
      <section className="pr-card-pr" data-testid="pr-card-pr" data-pr-url={pr.url} data-tone="unknown">
        <div className="pr-card-head">
          <a className="pr-card-title" href={pr.url} target="_blank" rel="noreferrer" title={`Open #${pr.number} on GitHub`}>
            <span className="pr-card-number">#{pr.number}</span> {pr.repo}
          </a>
        </div>
        {pr.error ? (errorAbove ? null : <PrError error={pr.error} />) : <div className="pr-card-muted pr-card-empty">Not read yet.</div>}
      </section>
    );
  }
  return (
    <section className="pr-card-pr" data-testid="pr-card-pr" data-pr-url={pr.url} data-tone={tone}>
      <div className="pr-card-head">
        <span className="pr-card-state" data-tone={pr.state === 'open' && pr.draft ? 'draft' : pr.state}>
          <PrGlyph pr={pr} />
          {pr.state === 'open' && pr.draft ? 'Draft' : STATE_WORDS[pr.state]}
        </span>
        <a className="pr-card-title" href={pr.url} target="_blank" rel="noreferrer" title={`Open #${pr.number} on GitHub`}>
          <span className="pr-card-number">#{pr.number}</span> {pr.title || pr.repo}
        </a>
      </div>
      <div className="pr-card-sub">
        {pr.repo}{pr.head ? <> &middot; <code>{pr.head}</code> &rarr; <code>{pr.base || 'base'}</code></> : null}
      </div>
      {/* A read that failed says so first: what follows is from the read before it. */}
      {pr.error && !errorAbove && <PrError error={pr.error} seen={pr.lastGoodAt ?? pr.checkedAt} />}
      <dl className="pr-card-facts" data-stale={pr.error ? 'true' : undefined}>
        {/* A merged or closed pull request's checks, review and merge are history: the card says
            what it became. */}
        {pr.state === 'open' && (
          <>
            <dt>Checks</dt>
            <dd data-testid="pr-card-checks">
              <span className="pr-card-checks-line" data-tone={pr.checks.failed ? 'failed' : pr.checks.pending ? 'pending' : pr.checks.total ? 'passed' : 'open'}>
                {prChecksLine(pr.checks)}
              </span>
              {items.length > 0 && (
                <ul className="pr-card-checks">
                  {items.slice(0, CARD_CHECKS).map((c) => (
                    <li key={`${c.status}:${c.name}`} className="pr-card-check" data-status={c.status}>
                      <CheckMark status={c.status} />
                      {c.url
                        ? <a href={c.url} target="_blank" rel="noreferrer" title={`Open the log of "${c.name}"`}>{c.name}</a>
                        : <span>{c.name}</span>}
                      {c.required && <span className="pr-card-required">Required</span>}
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li className="pr-card-check pr-card-check-more">
                      <a href={`${pr.url}/checks`} target="_blank" rel="noreferrer">{hidden} more on GitHub</a>
                    </li>
                  )}
                </ul>
              )}
            </dd>
            <dt>Review</dt>
            <dd data-tone={pr.review === 'changes_requested' ? 'changes' : pr.review === 'approved' ? 'passed' : undefined}>
              {pr.review ? PR_REVIEW_WORDS[pr.review] : 'No review needed yet'}
              {pr.reviewBy && (pr.review === 'changes_requested' || pr.review === 'approved') && (
                <> by {pr.reviewBy.url
                  ? <a className="pr-card-review-by" href={pr.reviewBy.url} target="_blank" rel="noreferrer" title={`Open ${pr.reviewBy.author}'s review`}>{pr.reviewBy.author}</a>
                  : pr.reviewBy.author}</>
              )}
              {pr.remarks ? (
                <span className="pr-card-muted"> &middot; <a className="pr-card-comments" href={pr.url} target="_blank" rel="noreferrer" title="Read them on GitHub">
                  {pr.remarks === 1 ? '1 comment' : `${pr.remarks} comments`}
                </a></span>
              ) : null}
              {pr.outsideRemarks ? (
                <span className="pr-card-muted" title="People outside the repository never wake the agent, and their words never reach it">
                  {' '}&middot; {pr.outsideRemarks} from outside the repository
                </span>
              ) : null}
              {pr.reviewBy?.body && (pr.review === 'changes_requested' || pr.review === 'approved') && (
                <q className="pr-card-review-quote" data-testid="pr-card-review-quote">{pr.reviewBy.body}</q>
              )}
            </dd>
            {merge && (
              <>
                <dt>Merge</dt>
                <dd data-tone={pr.mergeable === 'conflicting' ? 'conflict' : undefined}>{merge}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {pr.checkedAt && pr.author && !pr.mine && (
        <div className="pr-card-note pr-card-muted" data-testid="pr-card-not-mine">
          Opened by {pr.author}, not by the GitHub account Walnut reads with, so it never wakes the agent or completes this task.
        </div>
      )}
      {pr.state === 'merged' && pr.mine && !w?.mergeSeen && !w?.completedAt && (
        <div className="pr-card-note pr-card-muted" data-testid="pr-card-note">
          {done
            ? 'It was already merged when it was linked. The task is complete.'
            : alone
              ? 'It was already merged when it was linked, so Walnut leaves this task as it is.'
              // Another pull request of the task can still complete it: only this merge does not.
              : 'It was already merged when it was linked, so this merge does not complete the task.'}
          {alone && !done && onComplete && (
            <button type="button" className="pr-card-complete" data-testid="pr-card-complete-now" disabled={completing} onClick={onComplete}>
              {completing ? 'Completing…' : 'Complete the task'}
            </button>
          )}
        </div>
      )}
      {pr.state === 'closed' && pr.mine && (
        <div className="pr-card-note pr-card-muted" data-testid="pr-card-note">
          Closed without merging. Walnut completes a task only when one of its pull requests merges.
        </div>
      )}
      {w?.completedAt && <div className="pr-card-note" data-testid="pr-card-note">Merged {timeAgo(pr.mergedAt || w.completedAt, { long: true })}: Walnut completed this task.</div>}
      {w?.heldOpen && <div className="pr-card-note" data-testid="pr-card-note">Merged. This task stays open: {w.heldOpen}</div>}
      {pr.state === 'merged' && pr.mine && w?.mergeSeen && !w.completedAt && !w.heldOpen && !done && completeOn && waitingOn.length > 0 && (
        <div className="pr-card-note pr-card-muted" data-testid="pr-card-note">
          Merged. The task completes once {waitingOn.map((n) => `#${n}`).join(' and ')} {waitingOn.length === 1 ? 'is' : 'are'} merged or closed too.
        </div>
      )}
      {w?.lastWakeAt && !w.completedAt && (
        <div className="pr-card-note pr-card-muted" data-testid="pr-card-woke">Told the agent {timeAgo(w.lastWakeAt, { long: true })}: {w.lastWake}.</div>
      )}
    </section>
  );
}

function Switch({ label, hint, checked, onChange, testId }: {
  label: string; hint: string; checked: boolean; onChange(next: boolean): void; testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="pr-card-switch"
      data-testid={testId}
      title={hint}
      onClick={() => onChange(!checked)}
    >
      <span className="pr-card-switch-text">
        <span className="pr-card-switch-label">{label}</span>
        <span className="pr-card-switch-hint">{hint}</span>
      </span>
      <span className="pr-card-switch-track" aria-hidden="true" />
    </button>
  );
}

export function PrPill({ task: given, className, compact = false }: { task: Task; className?: string; compact?: boolean }) {
  const live = useStoreTask(given.id);
  const task = live ?? given;
  const urls = watchablePrUrls(task.tags);
  // A row that is drawn anew (it moves to another section when its session starts a turn)
  // mounts its pill anew: a card open on it a moment ago opens again on the new one rather than
  // vanish under the pointer. The new pill renders before the old one's cleanup runs, and the
  // old trigger can leave the page before that: both record, and the mount effect reads it.
  const [open, setOpen] = useState(false);
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => {
    if (reopenFor(given.id)) setOpen(true);
    return () => { if (openNow.current) openAtUnmount.set(given.id, Date.now()); };
  }, [given.id]);
  const [view, setView] = useState<PrView | null>(null);
  const [busy, setBusy] = useState<'refresh' | 'complete' | null>(null);
  // The newest write of each switch: an older one's failure must not undo a newer press.
  const switchSeq = useRef<{ pr_wake: number; pr_auto_complete: number }>({ pr_wake: 0, pr_auto_complete: 0 });
  // Writes go one after another, so the server stores the last press, never an earlier one.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const [failure, setFailure] = useState<string | null>(null);
  // A switch just set here, until the card closes (the task event confirming it may come later).
  const [setHere, setSetHere] = useState<{ pr_wake?: boolean; pr_auto_complete?: boolean }>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The card opens beside the whole task row, so it never hides the row's title: in a window too
  // short for it on either side, it scrolls under its foot instead.
  const rowRef = useRef<HTMLElement | null>(null);
  rowRef.current = compact ? null : triggerRef.current?.closest<HTMLElement>('.todo-panel-item, .todo-pinned-card') ?? null;
  const cardRef = useRef<HTMLDivElement>(null);
  // A phone's row pill is a label (phone-fixes-r3.css): out of the Tab order too.
  const phone = usePhoneLayout();
  const markOpen = useKeyboardOpenFocus(open, cardRef);
  /** Opened from the keyboard: Escape gives the focus back to the pill (from the pointer, only
   *  when the focus went into the card). */
  const openedByKeys = useRef(false);
  const placement = useMenuPlacement(open, triggerRef, cardRef, {
    align: 'start', preferSide: 'down', minHeight: 160, verticalAnchorRef: rowRef, onAnchorLost: () => { if (openNow.current) openAtUnmount.set(given.id, Date.now()); setOpen(false); },
  });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await apiGet<PrView>(`/api/tasks/${encodeURIComponent(given.id)}/pull-requests`);
      lastViews.set(given.id, next);
      setView(next);
    } catch (err) {
      log.warn('tasks', 'pull request card load failed', { taskId: given.id, error: String(err) });
    }
  }, [given.id]);

  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setSetHere({});
    void load();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || cardRef.current?.contains(target))) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && cardRef.current?.contains(document.activeElement)) {
        // A dialog keeps Tab inside it: from the last control back to the first, and the reverse.
        const items = Array.from(cardRef.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(openedByKeys.current || !!cardRef.current?.contains(document.activeElement));
    };
    // Capture phase: every pill on a row stops its own pointerdown (LeaderPill.tsx).
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, load]);

  if (urls.length === 0) return null;

  // The task's own snapshots (live through task:updated) win over the card's copy.
  const snapshots = urls.map((url) => task.pr_status?.[url] ?? view?.prs.find((p) => p.url === url)).filter((p): p is PrSnapshot => !!p);
  const { tone, text, short, parts, stale, lead } = prPillText(snapshots, urls);
  // Before the card's first answer, the last good read the task holds stands in.
  const lastRead = (view ?? lastViews.get(given.id))?.prs.map((p) => p.lastReadAt).filter((x): x is string => !!x).sort().at(-1)
    ?? snapshots.map((p) => p.checkedAt).filter((x): x is string => !!x).sort().at(-1);

  const refresh = async () => {
    setBusy('refresh');
    setFailure(null);
    try {
      const next = await apiPost<PrView>(`/api/tasks/${encodeURIComponent(given.id)}/pull-requests/refresh`, {}, { timeoutMs: 90_000 });
      lastViews.set(given.id, next);
      setView(next);
    } catch (err) {
      setFailure('Could not read GitHub just now. Try again in a moment.');
      log.warn('tasks', 'pull request refresh failed', { taskId: given.id, error: String(err) });
    } finally {
      setBusy(null);
    }
  };

  /** The user's own close, for a pull request merged before it was linked (Walnut never does it). */
  const completeNow = async () => {
    setBusy('complete');
    setFailure(null);
    try {
      await completeTask(given.id);
    } catch (err) {
      setFailure('Could not complete the task just now. Try again in a moment.');
      log.warn('tasks', 'pull request card complete failed', { taskId: given.id, error: String(err) });
    } finally {
      setBusy(null);
    }
  };

  // The task's own setting (live), else the default the server answered with.
  const wakeOn = setHere.pr_wake ?? task.pr_wake ?? view?.wake ?? true;
  const completeOn = setHere.pr_auto_complete ?? task.pr_auto_complete ?? view?.autoComplete ?? true;

  // A switch never waits for its save: every press shows at once and is written in order; a
  // failed write goes back to what the task holds, unless a newer press came after it.
  const setSwitch = async (field: 'pr_wake' | 'pr_auto_complete', next: boolean) => {
    const seq = ++switchSeq.current[field];
    setSetHere((v) => ({ ...v, [field]: next }));
    setFailure(null);
    const write = writes.current.then(() => apiPatch(`/api/tasks/${encodeURIComponent(given.id)}`, { [field]: next }));
    writes.current = write.catch(() => undefined);
    try {
      await write;
      log.info('tasks', 'pull request switch set', { taskId: given.id, field, value: next });
    } catch (err) {
      if (seq !== switchSeq.current[field]) return;
      setSetHere((v) => { const { [field]: _gone, ...rest } = v; return rest; });
      setFailure('That switch did not save. Try again.');
      log.warn('tasks', 'pull request switch failed', { taskId: given.id, field, error: String(err) });
    }
  };

  // The pull request the pill speaks for comes first.
  const cardPrs: Array<CardPr> = urls.map((url) => {
    const fromTask = task.pr_status?.[url];
    const fromView = view?.prs.find((p) => p.url === url);
    return fromTask ? { ...fromTask, ...(fromView?.lastReadAt ? { lastReadAt: fromView.lastReadAt } : {}), ...(fromView?.lastGoodAt ? { lastGoodAt: fromView.lastGoodAt } : {}) } : fromView;
  }).filter((p): p is CardPr => !!p)
    .sort((a, b) => Number(b.url === lead?.url) - Number(a.url === lead?.url));
  // A switch shows only where it can still act: waking on an open pull request of the user's own,
  // completing while one of theirs has not completed the task yet.
  const mine = cardPrs.filter((p) => p.mine);
  const showWake = mine.some((p) => p.state === 'open');
  const showComplete = !mine.some((p) => p.watch?.completedAt)
    && mine.some((p) => p.state === 'open' || (p.state === 'merged' && p.watch?.mergeSeen === true));
  const theirs = !!lead?.checkedAt && !!lead.author && !lead.mine;
  const allFailed = cardPrs.length > 0 && cardPrs.every((p) => p.error);
  const finished = cardPrs.length > 0 && cardPrs.every((p) => p.checkedAt && p.state !== 'open');
  const sharedError = cardPrs.length > 1 && cardPrs.every((p) => p.error?.code === cardPrs[0]!.error?.code) ? cardPrs[0]!.error : undefined;
  const shown = view ?? lastViews.get(given.id) ?? (task.pr_status && Object.keys(task.pr_status).length ? ASSUMED_VIEW : null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`task-row-pill pr-pill${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
        data-testid="pr-pill"
        data-tone={tone}
        data-short={short}
        data-theirs={theirs ? 'true' : undefined}
        data-stale={stale ? 'true' : undefined}
        tabIndex={phone && !compact ? -1 : undefined}
        title={lead ? `${text}. ${lead.repo} #${lead.number}${lead.title ? `: ${lead.title}` : ''}` : 'Linked pull request'}
        // A phone's row pill only reads out the state: the row's tap opens the session.
        aria-label={phone && !compact ? `Pull request ${text}` : `Pull request ${text}. Show its status`}
        aria-haspopup={phone && !compact ? undefined : 'dialog'}
        aria-expanded={phone && !compact ? undefined : open}
        onPointerDown={(e) => e.stopPropagation()}
        // The row acts on Enter too (it opens the task): this key is the pill's alone, or the row
        // takes the focus the card was given.
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        // WebKit never focuses a button on click: without this the row around the pill takes
        // focus, scrolls itself into view, and the click lands on whatever moved under it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // A press with the pointer leaves no focus ring behind: WebKit never moves the focus on a
          // click, so the pill focused before (one an Escape gave it back to) would keep its ring.
          openedByKeys.current = e.detail === 0;
          const was = document.activeElement;
          if (!openedByKeys.current && was instanceof HTMLElement && was !== e.currentTarget && was !== document.body) was.blur();
          markOpen(e);
          setOpen((v) => !v);
        }}
      >
        {compact
          // The phone's top bar: the glyph in its tone (its words are the label and the card).
          ? (
            <span className="pr-pill-icon" aria-hidden="true">
              {stale ? <StaleGlyph /> : <PrGlyph pr={lead} />}
              {/* Not by colour alone: a mark says which kind of state it is. */}
              {PR_MARKS[tone] && <span className="pr-pill-mark" data-t={PR_MARKS[tone]} />}
            </span>
          )
          : <>
              {stale ? <StaleGlyph /> : <PrGlyph pr={lead} />}
              <span className="task-pill-long">{text}</span>
              {/* Last part first: pr-pill.css lays these out right to left and wraps the number
                  away, whole, when it does not fit. The state's word, with whose it is, "not
                  current" and how many more, always stays: when it is wider than the pill, the
                  word is cut short, never the rest. */}
              <span className="pr-pill-short" aria-hidden="true">
                <span className="pr-pill-word">
                  {parts.who && <span className="pr-pill-who" data-t={parts.who} />}
                  <span className="pr-pill-text" data-t={parts.word} data-tn={parts.narrowWord} />
                  {parts.stale && <span className="pr-pill-stale" data-t={parts.stale} />}
                  {parts.more && <span className="pr-pill-more" data-t={parts.more} />}
                </span>
                <span className="pr-pill-n" data-t={parts.n} />
              </span>
            </>}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="pr-card"
              role="dialog"
              aria-label="Pull request status"
              data-testid="pr-card"
              style={cardStyle(placement, triggerRef.current)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              // A portal still bubbles React events up to the row, whose Enter and Space act on the
              // task and would swallow a press meant for a switch here.
              onKeyDown={(e) => e.stopPropagation()}
            >
              {cardPrs.length === 0 && <div className="pr-card-muted pr-card-empty">Not read yet.</div>}
              {/* One read error for all of them (signed out, gh gone) is said once. */}
              {sharedError && <PrError error={sharedError} seen={cardPrs.map((p) => p.lastGoodAt ?? p.checkedAt).filter((x): x is string => !!x).sort().at(-1)} />}
              {cardPrs.map((pr) => (
                <PrSection key={pr.url} pr={pr} alone={cardPrs.length === 1} done={task.phase === 'COMPLETE'} errorAbove={!!sharedError}
                  waitingOn={cardPrs.filter((p) => p.url !== pr.url && p.state === 'open').map((p) => p.number)} completeOn={completeOn}
                  onComplete={() => void completeNow()} completing={busy === 'complete'} />
              ))}
              {shown && !shown.watching && (
                <div className="pr-card-note pr-card-muted" data-testid="pr-card-off">This Walnut does not watch pull requests, so this is the last status it saw.</div>
              )}
              {shown && (showWake || showComplete) && (
                <div className="pr-card-switches">
                  {showWake && <Switch
                    testId="pr-switch-wake"
                    label="Wake the agent"
                    hint="When a check fails, someone comments or reviews, or the branch conflicts"
                    checked={wakeOn}
                    onChange={(next) => void setSwitch('pr_wake', next)}
                  />}
                  {showComplete && <Switch
                    testId="pr-switch-complete"
                    label="Complete the task on merge"
                    hint="When it merges, once every other linked pull request is merged or closed too"
                    checked={completeOn}
                    onChange={(next) => void setSwitch('pr_auto_complete', next)}
                  />}
                </div>
              )}
              {failure && <div className="pr-card-error" role="alert">{failure}</div>}
              <div className="pr-card-foot">
                <span className="pr-card-muted" data-testid="pr-card-read">
                  {busy === 'refresh' ? 'Reading GitHub…' : lastRead ? `${allFailed ? 'Tried' : 'Checked'} ${timeAgo(lastRead, { long: true })}` : shown ? 'Not read yet' : ' '}
                  {/* Merged or closed is final: the watcher stops reading it. */}
                  {busy !== 'refresh' && lastRead && finished && (cardPrs.length === 1 ? '. Finished, so not read again' : '. All finished, so not read again')}
                </span>
                {shown?.watching && (
                  <button type="button" className="pr-card-refresh" data-testid="pr-card-refresh" disabled={busy !== null} onClick={() => void refresh()}>
                    Refresh
                  </button>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
