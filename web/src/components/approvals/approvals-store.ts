/**
 * The approvals this window shows (`walnut approve`), in one store every surface reads: the
 * cards at the bottom right (ApprovalPrompts), the Needs you rows on Home and the Org page
 * (ApprovalRow), the dialog a row or a system notification opens (ApprovalDialog), and the
 * system notification itself (approval-notify.ts).
 *
 * ApprovalPrompts, mounted once in App, feeds it (the first read, `approval:changed`, a
 * reconnect); everything else only reads it and calls the actions here, so an answer given
 * in a row takes the card, the row and the notification off together.
 *
 * Every approval is answered with one tap here, as on every device the person is signed in on
 * (src/core/approvals/types.ts; 2026-11-21, the user: no signing key, a signed-in device approves).
 */
import { useSyncExternalStore } from 'react';
import { answerApproval, listApprovals, setApprovalsAskMe, type Approval } from '@/api/approvals';
import { vaultCall } from '@/api/vault';
import { withMasterPassword } from '@/components/passwords/with-passwords-unlock';
import { SHEET_BUSY_WORDS, unlockSheetBusy } from '@/components/passwords/unlock-sheet-busy';
import { clearApprovalNotice, keepApprovalNotices, setApprovalOpener, showApprovalNotice } from './approval-notify';
import { testRunLabel } from '@/api/test-run';
import { inMacApp } from '@/utils/mac-app';
import { log } from '@/utils/log';

export interface ApprovalsState {
  /** Pending, by id, as the server last said (expiry is judged at render time). */
  items: ReadonlyMap<string, Approval>;
  /** An answer on its way, by id: which decision. */
  busy: Readonly<Record<string, 'approve' | 'deny'>>;
  errors: Readonly<Record<string, string>>;
  /** Just settled, shown as a one-line card for a moment. */
  done: Readonly<Record<string, Approval>>;
  /** The approval the dialog shows (a row's click, a notification's click), or null. */
  openId: string | null;
  /**
   * The person just turned approvals off from a card ("Approve, and stop asking me"), on the
   * approval it was clicked on: the corner says so with Undo for a while. `undone` once Undo ran.
   */
  stoppedAsking: { id: string; at: number; undone?: boolean } | null;
  /** "Approve, and stop asking me" is on its way for this one: its own "Approved" receipt is not shown (the note says it). */
  stoppingId: string | null;
}

const EMPTY: ApprovalsState = { items: new Map(), busy: {}, errors: {}, done: {}, openId: null, stoppedAsking: null, stoppingId: null };
let state: ApprovalsState = EMPTY;
const subs = new Set<() => void>();
/** Approvals this page has raised a system notification for, so a re-read never repeats one. */
const noticed = new Set<string>();
/** Answered here or heard settled, with when: a list read that started before must not bring one back. */
const settledAt = new Map<string, number>();
const SETTLED_MEMORY_MS = 120_000;
/** Only the newest list read lands (several can be in flight: mount, reconnect, an answer). */
let readSeq = 0;

function set(next: Partial<ApprovalsState>): void {
  state = { ...state, ...next };
  for (const fn of subs) fn();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** The state now, outside React. */
export function approvalsSnapshot(): ApprovalsState {
  return state;
}

export function useApprovals(): ApprovalsState {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

/** The approvals still waiting at `now`, oldest first. */
export function pendingAt(s: ApprovalsState, now: number): Approval[] {
  return [...s.items.values()].filter((a) => Date.parse(a.expiresAt) > now).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

/**
 * The approvals an Org node lists: Main (the CEO) every one, since it answers for the person; any
 * other node those a task in its own work asked for.
 */
export function approvalsForNode(list: readonly Approval[], kind: string, taskIds: ReadonlySet<string>): Approval[] {
  if (kind === 'main') return [...list];
  return list.filter((a) => !!a.requester.taskId && taskIds.has(a.requester.taskId));
}

function notice(a: Approval): void {
  if (noticed.has(a.id) || a.status !== 'pending' || Date.parse(a.expiresAt) <= Date.now()) return;
  // Quiet mode holds it in the system notice exit, whose one reminder after quiet covers it.
  showApprovalNotice(a);
  noticed.add(a.id);
}

function settle(a: Approval): void {
  const now = Date.now();
  settledAt.set(a.id, now);
  for (const [id, at] of settledAt) if (now - at > SETTLED_MEMORY_MS) settledAt.delete(id);
  const items = new Map(state.items);
  items.delete(a.id);
  const { [a.id]: _err, ...errors } = state.errors;
  set({ items, errors, done: { ...state.done, [a.id]: a } });
  clearApprovalNotice(a.id);
  setTimeout(() => {
    const { [a.id]: _gone, ...rest } = state.done;
    set({ done: rest, ...(state.openId === a.id ? { openId: null } : {}) });
  }, 2500);
}

export async function refreshApprovals(): Promise<void> {
  const seq = ++readSeq;
  try {
    const r = await listApprovals('pending');
    if (seq !== readSeq) return;
    const fresh = r.approvals.filter((a) => !settledAt.has(a.id));
    const items = new Map(fresh.map((a) => [a.id, a]));
    // One that left the list while this window was away was answered elsewhere: its notice goes too.
    for (const id of state.items.keys()) if (!items.has(id)) clearApprovalNotice(id);
    set({ items });
    // The Mac app also takes back notices from before it started whose approval is gone now.
    keepApprovalNotices([...items.keys()]);
    for (const a of fresh) notice(a);
  } catch {
    // 404/503: an older server or a replica whose Mac is away; nothing to show.
  }
}

/** One `approval:changed` event. */
export function applyApprovalEvent(a: Approval): void {
  // A test run's approvals show only in that test window, and a test window sees no real one.
  // The server's list is the judge (a throwaway server marks nothing, so an automated window
  // there sees every approval): a person's window drops a marked one, a test window re-reads.
  const label = testRunLabel();
  if ((a.testRun ?? null) !== label) {
    if (label) void refreshApprovals();
    return;
  }
  if (a.status === 'pending') {
    if (settledAt.has(a.id)) return;
    const items = new Map(state.items);
    items.set(a.id, a);
    set({ items });
    notice(a);
  } else if (state.items.has(a.id) || state.openId === a.id) {
    settle(a);
  } else {
    clearApprovalNotice(a.id);
  }
}

/**
 * The master password sheet's line for an agent's ask for a locked note: the card's own words (who
 * asks, which note, read or read and change: src/core/notes/locked-note-ask.ts writes "read and
 * change your locked note" for an edit ask, "read your locked note" for a read ask), for how long
 * (its READ_MS and EDIT_MS), and where the text goes.
 */
export function passwordsSubFor(a: Pick<Approval, 'what'>): string {
  const edit = /\bread and change your locked note\b/.test(a.what);
  return `${a.what.replace(/[.\s]+$/, '')}. A yes lets the agent ${edit ? 'read and change' : 'read'} it for ${edit ? 30 : 10} minutes, and its text goes into that agent's conversation. Type your master password to approve.`;
}

/** The sheet's title and button for that yes: it approves, it does not unlock. */
export const APPROVE_WORDS = { title: 'Approve with your master password', action: 'Approve' };

/** Which device this window is, for the record of who answered. */
function thisDevice(): { name: string; kind: 'mac-app' | 'web' } {
  return inMacApp() ? { name: 'Mac app', kind: 'mac-app' } : { name: 'Web console', kind: 'web' };
}

/**
 * Answer one with a tap. The answer names the digest of the request this window shows, so a
 * request that changed since is refused (409) and read again rather than approved unseen.
 */
export async function decideApproval(a: Approval, decision: 'approve' | 'deny'): Promise<void> {
  if (state.busy[a.id]) return;
  const { [a.id]: _old, ...errors } = state.errors;
  set({ busy: { ...state.busy, [a.id]: decision }, errors });
  try {
    const body = { decision, digest: a.digest, device: thisDevice() };
    // An agent's ask for a locked note: the yes goes with the master password typed for it, here and
    // now (docs/reference/locked-notes.md); a cancelled sheet answers nothing.
    const r = a.needsPasswords && decision === 'approve'
      ? await withMasterPassword(passwordsSubFor(a), () => vaultCall<{ approval: Approval }>('POST', `/approvals/${encodeURIComponent(a.id)}/answer`, body), APPROVE_WORDS)
      : await answerApproval(a.id, body);
    if (r) settle(r.approval);
    // No sheet came up: another step's sheet is open. Said on the card, never a silent no.
    else if (unlockSheetBusy()) set({ errors: { ...state.errors, [a.id]: SHEET_BUSY_WORDS } });
  } catch (err) {
    set({ errors: { ...state.errors, [a.id]: err instanceof Error ? err.message : String(err) } });
    // Changed, answered elsewhere or gone meanwhile: read the list so the card shows what is true now.
    if ((err as { status?: unknown })?.status === 409) void refreshApprovals();
  } finally {
    const { [a.id]: _done, ...busy } = state.busy;
    set({ busy });
  }
}

/**
 * "Approve, and stop asking me": the person turns the Approvals switch off from the card, and this
 * request is approved (2026-11-12, the user: "don't need my approval for anything"). Only for a
 * request the switch covers (not a single-use one, not an explicit `walnut approve`).
 */
export async function approveAndStopAsking(a: Approval): Promise<void> {
  if (a.singleUse || a.outsideSwitch || state.busy[a.id]) return;
  set({ stoppingId: a.id });
  await decideApproval(a, 'approve');
  if (state.done[a.id]?.status !== 'approved') { set({ stoppingId: null }); return; }
  try {
    await setApprovalsAskMe(false);
    log.info('approvals', 'the person turned approvals off from a card', { approvalId: a.id });
    showStopped({ id: a.id, at: Date.now() });
  } catch (err) {
    log.warn('approvals', 'turning approvals off from a card failed', { approvalId: a.id, error: err instanceof Error ? err.message : String(err) });
    set({ stoppingId: null, errors: { ...state.errors, [a.id]: 'Approved, but approvals could not be turned off. Try again in Settings › General.' } });
  }
}

/** How long the "won't ask you any more" note stays in the corner. */
const STOPPED_NOTE_MS = 12_000;
let stoppedTimer: ReturnType<typeof setTimeout> | null = null;
function showStopped(next: ApprovalsState['stoppedAsking']): void {
  if (stoppedTimer) clearTimeout(stoppedTimer);
  set({ stoppedAsking: next });
  if (next) stoppedTimer = setTimeout(() => { stoppedTimer = null; set({ stoppedAsking: null }); }, STOPPED_NOTE_MS);
}

export function dismissStoppedAsking(): void {
  if (state.stoppedAsking) showStopped(null);
}

/** Undo of "stop asking me": approvals on again (the one approved stays approved). */
export async function undoStopAsking(): Promise<void> {
  const st = state.stoppedAsking;
  if (!st || st.undone) return;
  try {
    await setApprovalsAskMe(true);
    log.info('approvals', 'the person undid stop asking', { approvalId: st.id });
    showStopped({ ...st, undone: true });
  } catch (err) {
    log.warn('approvals', 'undo of stop asking failed', { approvalId: st.id, error: err instanceof Error ? err.message : String(err) });
  }
}

export function openApproval(id: string): void {
  set({ openId: id });
  // A notification clicked for one this window has not read yet (it came in while the page slept).
  if (!state.items.has(id) && !state.done[id]) void refreshApprovals();
}

setApprovalOpener(openApproval);

export function closeApproval(): void {
  if (state.openId !== null) set({ openId: null });
}

/** Tests: start from nothing. */
export function resetApprovalsForTest(): void {
  state = EMPTY;
  noticed.clear();
  settledAt.clear();
  readSeq = 0;
  for (const fn of subs) fn();
}
