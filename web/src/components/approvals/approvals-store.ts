/**
 * The approvals this window shows (`walnut approve`), in one store every surface reads: the
 * cards at the bottom right (ApprovalPrompts), the Needs you rows on Home and the Org page
 * (ApprovalRow), the dialog a row or a system notification opens (ApprovalDialog), and the
 * system notification itself (approval-notify.ts).
 *
 * ApprovalPrompts, mounted once in App, feeds it (the first read, `approval:changed`, a
 * reconnect); everything else only reads it and calls the actions here, so an answer given
 * in a row takes the card, the row and the notification off together.
 */
import { useSyncExternalStore } from 'react';
import { answerApproval, enrollApprovalKey, listApprovals, type Approval, type ApprovalKey } from '@/api/approvals';
import { onVaultSessionChange, vaultSession } from '@/api/vault';
import { howToApprove, signerKinds } from '../../../../src/core/approvals/signer-words';
import { hasTouchIdBridge, touchIdSign, touchIdStatus, type TouchIdStatus } from './touch-id-bridge';
import { clearApprovalNotice, keepApprovalNotices, setApprovalOpener, showApprovalNotice } from './approval-notify';
import { testRunLabel } from '@/api/test-run';
import { log } from '@/utils/log';

export interface ApprovalsState {
  /** Pending, by id, as the server last said (expiry is judged at render time). */
  items: ReadonlyMap<string, Approval>;
  keys: readonly ApprovalKey[];
  /** The Mac app's Touch ID signer, once asked; null in a browser or before the answer. */
  touchId: TouchIdStatus | null;
  /** An answer on its way, by id: which decision. */
  busy: Readonly<Record<string, 'approve' | 'deny'>>;
  errors: Readonly<Record<string, string>>;
  /** Just settled, shown as a one-line card for a moment. */
  done: Readonly<Record<string, Approval>>;
  /** The approval the dialog shows (a row's click, a notification's click), or null. */
  openId: string | null;
  /** The approval whose card shows its "Unlock to approve" form (ApprovalUnlock.tsx), or null. */
  unlockId: string | null;
}

const EMPTY: ApprovalsState = { items: new Map(), keys: [], touchId: null, busy: {}, errors: {}, done: {}, openId: null, unlockId: null };
let state: ApprovalsState = EMPTY;
const subs = new Set<() => void>();
/** Approvals this page has raised a system notification for, so a re-read never repeats one. */
const noticed = new Set<string>();
/** Answered here or heard settled, with when: a list read that started before must not bring one back. */
const settledAt = new Map<string, number>();
const SETTLED_MEMORY_MS = 120_000;
/** Only the newest list read lands (several can be in flight: mount, reconnect, a key change). */
let readSeq = 0;

function set(next: Partial<ApprovalsState>): void {
  state = { ...state, ...next };
  for (const fn of subs) fn();
}

// This window unlocked or locked Passwords: what each card offers changes (Approve, or Unlock to approve).
if (typeof window !== 'undefined') onVaultSessionChange(() => set(state.unlockId && vaultSession() ? { unlockId: null } : {}));

/** Show the unlock form on an approval's card or row (null: close it). */
export function openUnlock(id: string | null): void {
  set({ unlockId: id });
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

/** The Mac app's own key, when it has one on the server. */
export function myKeyOf(s: ApprovalsState): ApprovalKey | undefined {
  return s.keys.find((k) => k.id === s.touchId?.keyId);
}

/** This window signs a biometric approval itself (the Mac app with an active Touch ID key). */
export function canSignHere(s: ApprovalsState): boolean {
  return !!s.touchId?.available && myKeyOf(s)?.status === 'active';
}

/** The Approve this window offers: a tap, Touch ID, or none (approve it on the phone). */
export function approveKind(s: ApprovalsState, a: Approval): 'tap' | 'touch-id' | null {
  if (a.guard) {
    // A vault ask: signed here when this Mac signs, else a tap only with Passwords unlocked here.
    if (canSignHere(s)) return 'touch-id';
    const sensitiveSigned = a.guard === 'vault-sensitive' && a.mode === 'biometric';
    return !sensitiveSigned && vaultSession() ? 'tap' : null;
  }
  if (a.mode !== 'biometric') return 'tap';
  const ownEnrollment = !!a.enrollsKey && a.enrollsKey === s.touchId?.keyId;
  return canSignHere(s) && !ownEnrollment ? 'touch-id' : null;
}

/** Why a biometric approval has no Approve here, in the words the person reads. */
export function noApproveReason(s: ApprovalsState, a: Approval): string {
  // Only the devices the person really has (their signing keys), and this window's unlock.
  const kinds = signerKinds(s.keys);
  if (a.guard === 'vault' || a.guard === 'person') return howToApprove(kinds, { unlock: true });
  if (a.guard === 'vault-sensitive' && a.mode !== 'biometric') return 'Unlock Passwords in this window to approve.';
  if (a.enrollsKey && a.enrollsKey === s.touchId?.keyId) {
    return 'This is the request to let this Mac sign approvals: approve it on a device that already signs (your iPhone, with Face ID).';
  }
  if (s.touchId && !s.touchId.available && s.touchId.reason) return `${s.touchId.reason} Approve it on your iPhone with Face ID.`;
  if (myKeyOf(s)?.status === 'pending') return 'This Mac is waiting to be allowed to sign approvals. Approve it on your iPhone with Face ID.';
  return kinds.length ? howToApprove(kinds, { unlock: false }) : 'Approve it on your iPhone with Face ID (or in the Walnut Mac app with Touch ID).';
}

/**
 * A guarded ask (`vault`, `person`) this window cannot approve yet but could after Passwords is
 * unlocked here: the card offers "Unlock to approve" (ApprovalUnlock.tsx). Not an item that needs
 * Face ID or Touch ID itself (vault-sensitive, biometric).
 */
export function unlockApproves(s: ApprovalsState, a: Approval): boolean {
  if (!a.guard || approveKind(s, a)) return false;
  return !(a.guard === 'vault-sensitive' && a.mode === 'biometric');
}

function notice(a: Approval): void {
  if (noticed.has(a.id) || a.status !== 'pending' || Date.parse(a.expiresAt) <= Date.now()) return;
  // Held back by quiet mode: not noticed yet, so the end of quiet raises it (noticePending).
  if (showApprovalNotice(a)) noticed.add(a.id);
}

/** Raise the notices quiet mode held back, for the approvals still waiting (quiet just ended). */
export function noticePending(): void {
  for (const a of state.items.values()) notice(a);
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
    set({ items, keys: r.keys });
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

let enrolling = false;
/** The Mac app: learn whether Touch ID signs here, and enroll its key once. */
export async function startTouchId(): Promise<void> {
  if (!hasTouchIdBridge()) return;
  const touchId = await touchIdStatus();
  set({ touchId });
  if (!touchId.available || !touchId.publicKey || enrolling) return;
  await refreshApprovals();
  if (state.keys.some((k) => k.id === touchId.keyId)) return;
  enrolling = true;
  try {
    const r = await enrollApprovalKey({ publicKey: touchId.publicKey, name: touchId.name ?? 'Mac', kind: 'mac-app' });
    log.info('approvals', 'Mac app key enrolled', { keyId: r.key.id, status: r.key.status });
    await refreshApprovals();
  } catch (err) {
    log.warn('approvals', 'Mac app key enroll failed', { error: String(err) });
  }
}

/** Answer one: a tap, or Touch ID first when `signed`. */
export async function decideApproval(a: Approval, decision: 'approve' | 'deny', signed: boolean): Promise<void> {
  if (state.busy[a.id]) return;
  const { [a.id]: _old, ...errors } = state.errors;
  set({ busy: { ...state.busy, [a.id]: decision }, errors });
  try {
    const sig = signed ? await touchIdSign(a, decision) : undefined;
    const mac = hasTouchIdBridge();
    const r = await answerApproval(a.id, {
      decision,
      ...(sig ? { keyId: sig.keyId, signature: sig.signature } : {}),
      device: { name: mac ? (state.touchId?.name ?? 'Mac app') : 'Web console', kind: mac ? 'mac-app' : 'web' },
      ...(a.guard && decision === 'approve' && !sig && vaultSession() ? { vaultSession: vaultSession()! } : {}),
    });
    settle(r.approval);
  } catch (err) {
    set({ errors: { ...state.errors, [a.id]: err instanceof Error ? err.message : String(err) } });
  } finally {
    const { [a.id]: _done, ...busy } = state.busy;
    set({ busy });
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
  enrolling = false;
  for (const fn of subs) fn();
}
