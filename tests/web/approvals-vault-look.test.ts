/**
 * A guarded approval card reads the live vault state (web/src/components/approvals/approvals-store.ts
 * lookForUnlock, review 2026-11-06: the card said "Unlock to approve" while Passwords was unlocked
 * on this computer, and a click just turned it into Approve with no password). When a guarded ask
 * arrives and this window holds no unlock, the store reads the vault at once (api/vault-live.ts
 * checkVault, which shares an unlock made on this computer): meanwhile the card is undecided (a
 * waiting Approve, never "Unlock to approve"), then Approve when it shared one, or "Unlock to
 * approve" when there was none to share. Nothing is read for an ask that needs no unlock, nor when
 * this window already holds one. Also: the live follower reads the status on `vault:changed` and
 * on a reconnect, and its reads coalesce.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../web/src/api/approvals';

const h = vi.hoisted(() => ({
  session: null as string | null,
  listeners: new Set<() => void>(),
  status: vi.fn(),
  events: new Map<string, (d: unknown) => void>(),
  answer: vi.fn(),
}));

vi.mock('@/api/approvals', () => ({ listApprovals: vi.fn(async () => ({ approvals: [], keys: [] })), answerApproval: h.answer, enrollApprovalKey: vi.fn() }));
vi.mock('@/api/test-run', () => ({ testRunLabel: () => null }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/notifications/quiet', () => ({ currentQuiet: () => ({ active: false }) }));
vi.mock('@/contexts/notifications/quiet-model', () => ({ quietAllowsToast: () => true }));
vi.mock('@/hooks/useHostStatus', () => ({ getHostStatus: () => undefined }));
vi.mock('@/api/vault', () => ({
  vaultSession: () => h.session,
  onVaultSessionChange: (fn: () => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn); },
  vaultApi: { status: h.status },
}));
vi.mock('../../web/src/api/vault', () => ({
  vaultSession: () => h.session,
  onVaultSessionChange: (fn: () => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn); },
  vaultApi: { status: h.status },
}));
vi.mock('../../web/src/api/ws', () => ({ wsClient: { onEvent: (n: string, cb: (d: unknown) => void) => { h.events.set(n, cb); } } }));

(globalThis as unknown as { window: unknown }).window = { addEventListener: () => undefined };

const store = await import('../../web/src/components/approvals/approvals-store');
const live = await import('../../web/src/api/vault-live');

function approval(over: Partial<Approval> = {}): Approval {
  const now = Date.now();
  return {
    id: `apr-${Math.random().toString(36).slice(2, 8)}`, what: 'Click Place order', digest: 'd', mode: 'tap',
    requester: { host: 'devbox' }, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    status: 'pending', guard: 'person', ...over,
  } as Approval;
}

/** The status read: resolves when `share` says so, and shares the unlock like vaultApi.status does. */
function statusAnswers(share: boolean) {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  h.status.mockImplementation(async () => {
    await gate;
    if (share) { h.session = 'shared-token'; for (const l of h.listeners) l(); }
    else if (h.session) { h.session = null; for (const l of h.listeners) l(); } // a dead token is dropped
    return { setUp: true, unlocked: share };
  });
  return resolve;
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Walnut gives this page a token now (an unlock, a share): vault.ts tells its listeners. */
function walnutGives(token: string) { h.session = token; for (const l of h.listeners) l(); }

beforeEach(() => {
  vi.useRealTimers();
  store.resetApprovalsForTest();
  live.resetVaultLiveForTest();
  h.session = null;
  h.status.mockReset();
  h.answer.mockReset();
});

describe('a guarded card reads the live vault state', () => {
  it('shares an unlock made on this computer: undecided, then Approve, never "Unlock to approve"', async () => {
    const go = statusAnswers(true);
    const a = approval();
    store.applyApprovalEvent(a);
    let s = store.approvalsSnapshot();
    expect(h.status).toHaveBeenCalledWith({ quiet: true });
    expect(store.unlockUndecided(s, a)).toBe(true);
    go();
    await flush();
    s = store.approvalsSnapshot();
    expect(s.vaultLooking).toBe(false);
    expect(store.approveKind(s, a)).toBe('tap');
    expect(store.unlockApproves(s, a)).toBe(false);
  });

  it('nothing to share: "Unlock to approve" once the read answers', async () => {
    const go = statusAnswers(false);
    const a = approval({ guard: 'vault' });
    store.applyApprovalEvent(a);
    expect(store.unlockUndecided(store.approvalsSnapshot(), a)).toBe(true);
    go();
    await flush();
    const s = store.approvalsSnapshot();
    expect(store.unlockUndecided(s, a)).toBe(false);
    expect(store.unlockApproves(s, a)).toBe(true);
  });

  it('reads nothing for an ask that needs no unlock, a biometric item, or a window that holds one', async () => {
    store.applyApprovalEvent(approval({ guard: undefined }));
    store.applyApprovalEvent(approval({ guard: 'vault-sensitive', mode: 'biometric' }));
    expect(h.status).not.toHaveBeenCalled();
    walnutGives('mine');
    store.applyApprovalEvent(approval());
    expect(h.status).not.toHaveBeenCalled();
    expect(store.approvalsSnapshot().vaultLooking).toBe(false);
  });
});

describe('the live follower (api/vault-live.ts)', () => {
  it('reads the status quietly on vault:changed and on a reconnect', async () => {
    h.status.mockResolvedValue({ setUp: true, unlocked: false });
    h.events.get('vault:changed')!({ at: 1 });
    await flush();
    h.events.get('_ws:reconnected')!({});
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.status).toHaveBeenNthCalledWith(1, { quiet: true });
  });

  it('coalesces: calls while a read runs make one more read after it, not one each', async () => {
    let resolve!: () => void;
    h.status.mockImplementationOnce(() => new Promise((r) => { resolve = () => r({ unlocked: false }); }));
    h.status.mockResolvedValue({ unlocked: true });
    const first = live.checkVault();
    const later = live.checkVault();
    void live.checkVault();
    resolve();
    expect(await first).toEqual({ unlocked: false });
    expect(await later).toEqual({ unlocked: true });
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('a failed read answers null and the next one runs', async () => {
    h.status.mockRejectedValueOnce(new Error('down'));
    expect(await live.checkVault()).toBeNull();
    h.status.mockResolvedValue({ unlocked: true });
    expect(await live.checkVault()).toEqual({ unlocked: true });
  });
});

describe('a token left in storage is no unlock until read live (review R1)', () => {
  it('an old token from before the page opened is checked first, and a dead one leaves "Unlock to approve", never a clickable Approve', async () => {
    h.session = 'left-from-yesterday'; // in storage at load: no listener heard Walnut give it
    const go = statusAnswers(false);
    const a = approval();
    store.applyApprovalEvent(a);
    let s = store.approvalsSnapshot();
    expect(h.status).toHaveBeenCalledWith({ quiet: true });
    expect(store.approveKind(s, a)).toBeNull();
    expect(store.unlockUndecided(s, a)).toBe(true);
    go();
    await flush();
    s = store.approvalsSnapshot();
    expect(h.session).toBeNull();
    expect(store.approveKind(s, a)).toBeNull();
    expect(store.unlockApproves(s, a)).toBe(true);
  });

  it('a live old token, once read, offers Approve', async () => {
    h.session = 'still-good';
    h.status.mockResolvedValue({ setUp: true, unlocked: true });
    const a = approval();
    store.applyApprovalEvent(a);
    await flush();
    expect(store.approveKind(store.approvalsSnapshot(), a)).toBe('tap');
  });

  it('Walnut refusing an Approve for want of proof drops the dead token and opens the unlock form', async () => {
    walnutGives('ended-meanwhile');
    const a = approval();
    store.applyApprovalEvent(a);
    expect(store.approveKind(store.approvalsSnapshot(), a)).toBe('tap');
    h.answer.mockRejectedValue(Object.assign(new Error('Unlock Passwords in this window to approve'), { status: 403, body: { code: 'proof_needed' } }));
    statusAnswers(false)();
    await store.decideApproval(a, 'approve', false);
    const s = store.approvalsSnapshot();
    expect(h.status).toHaveBeenCalled();
    expect(h.session).toBeNull();
    expect(store.approveKind(s, a)).toBeNull();
    expect(s.unlockId).toBe(a.id);
    expect(s.errors[a.id]).toContain('Unlock Passwords');
  });

  it('any other failure (the network) keeps the unlock and reads nothing', async () => {
    walnutGives('fine');
    const a = approval();
    store.applyApprovalEvent(a);
    h.answer.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    await store.decideApproval(a, 'approve', false);
    expect(h.status).not.toHaveBeenCalled();
    expect(store.approvalsSnapshot().unlockId).toBeNull();
    expect(store.approveKind(store.approvalsSnapshot(), a)).toBe('tap');
  });
});

describe('slow reads never keep a card undecided (review R2)', () => {
  it('reads of 4 s while a locked page polls every 3 s: the card is decided after at most two reads', async () => {
    vi.useFakeTimers();
    h.status.mockImplementation(() => new Promise((r) => setTimeout(() => r({ setUp: true, unlocked: false }), 4_000)));
    const poll = setInterval(() => { void live.checkVault(); }, 3_000); // PasswordsApp's locked poll
    const a = approval();
    store.applyApprovalEvent(a);
    expect(store.unlockUndecided(store.approvalsSnapshot(), a)).toBe(true);
    await vi.advanceTimersByTimeAsync(8_500);
    clearInterval(poll);
    const s = store.approvalsSnapshot();
    expect(s.vaultLooking).toBe(false);
    expect(store.unlockApproves(s, a)).toBe(true);
  });

  it('a read that never answers lets the card fall back to "Unlock to approve" after the timeout', async () => {
    vi.useFakeTimers();
    h.status.mockImplementation(() => new Promise(() => undefined));
    const a = approval();
    store.applyApprovalEvent(a);
    await vi.advanceTimersByTimeAsync(live.READ_TIMEOUT_MS + 50);
    const s = store.approvalsSnapshot();
    expect(s.vaultLooking).toBe(false);
    expect(store.unlockApproves(s, a)).toBe(true);
  });

  it('every caller is answered by a read that started after it asked, and calls made during one read share the next', async () => {
    vi.useFakeTimers();
    let n = 0;
    h.status.mockImplementation(() => { const k = ++n; return new Promise((r) => setTimeout(() => r({ unlocked: false, k }), 1_000)); });
    const a1 = live.checkVault();
    await vi.advanceTimersByTimeAsync(500);
    const b1 = live.checkVault();
    const b2 = live.checkVault();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await a1).toMatchObject({ k: 1 });
    expect(await b1).toMatchObject({ k: 2 });
    expect(await b2).toMatchObject({ k: 2 });
    expect(n).toBe(2);
  });
});
