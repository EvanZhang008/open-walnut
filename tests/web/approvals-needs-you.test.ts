/**
 * Approvals as Needs you on the Mac (web/src/components/approvals/): one store every surface
 * reads (the bottom-left cards, the Home and Org Needs you rows, the dialog), and the system
 * notification a new approval raises, whose click opens that request.
 *
 *  - a new pending approval raises ONE notice (a re-read or a repeated event never another);
 *  - an answer anywhere takes the row and the notice off, and the dialog shows how it settled;
 *  - a test run's approval never reaches a person's window, nor its notice;
 *  - a notice clicked for one this window has not read yet re-reads the list;
 *  - an Org node lists every approval on Main, only its own work's elsewhere;
 *  - quiet mode holds the notice back unless quiet lets permission prompts through, and the
 *    end of quiet raises it;
 *  - a list read that started before an answer never brings the answered one back;
 *  - the notice names the host by its display name, never a raw alias.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../web/src/api/approvals';

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({ approvals: [] as Approval[], keys: [] })),
  answer: vi.fn(),
  label: null as string | null,
  quiet: { active: false, allowPermissions: true } as Record<string, unknown>,
  allows: vi.fn(() => true),
  hostLabel: undefined as string | undefined,
}));

vi.mock('@/api/approvals', () => ({
  listApprovals: api.list,
  answerApproval: api.answer,
  enrollApprovalKey: vi.fn(),
}));
vi.mock('@/api/test-run', () => ({ testRunLabel: () => api.label }));
// The live vault follower (its event socket) is covered by tests/web/approvals-vault-look.test.ts.
vi.mock('@/api/vault-live', () => ({ checkVault: vi.fn(async () => null), vaultLive: () => false }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/notifications/quiet', () => ({ currentQuiet: () => api.quiet }));
vi.mock('@/contexts/notifications/quiet-model', () => ({ quietAllowsToast: api.allows }));
vi.mock('@/hooks/useHostStatus', () => ({ getHostStatus: () => (api.hostLabel ? { label: api.hostLabel } : undefined) }));

const posts: Array<Record<string, unknown>> = [];
(globalThis as unknown as { window: unknown }).window = {
  // The vault client follows other tabs' unlocks through `storage` events (web/src/api/vault.ts).
  addEventListener: () => undefined,
  webkit: { messageHandlers: { walnutNotify: { postMessage: async (b: Record<string, unknown>) => { posts.push(b); return { posted: true }; } } } },
};

const store = await import('../../web/src/components/approvals/approvals-store');
const notify = await import('../../web/src/components/approvals/approval-notify');
const { approvalsForNode } = store;

function approval(over: Partial<Approval> = {}): Approval {
  const now = Date.now();
  return {
    id: `apr-${Math.random().toString(36).slice(2, 8)}`,
    what: 'Deploy web',
    digest: 'd',
    mode: 'tap',
    requester: { host: 'devbox', command: 'release.sh' },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    status: 'pending',
    ...over,
  };
}

const postsOf = (op: string) => posts.filter((p) => p.op === op);

beforeEach(() => {
  store.resetApprovalsForTest();
  posts.length = 0;
  api.label = null;
  api.allows.mockReturnValue(true);
  api.list.mockResolvedValue({ approvals: [], keys: [] });
  api.hostLabel = undefined;
});

describe('approvals store: one list for the cards, the rows and the dialog', () => {
  it('a new approval is listed and raises one system notice, however often it is heard', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    store.applyApprovalEvent(a);
    api.list.mockResolvedValue({ approvals: [a], keys: [] });
    await store.refreshApprovals();
    await Promise.resolve();
    expect([...snapshot().items.keys()]).toEqual([a.id]);
    expect(postsOf('post')).toHaveLength(1);
    expect(postsOf('post')[0]).toMatchObject({ id: a.id, title: 'Approve? Deploy web' });
  });

  it('an answer settles it everywhere: off the list, notice taken back, the dialog says how', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    store.openApproval(a.id);
    store.applyApprovalEvent({ ...a, status: 'approved' });
    await Promise.resolve();
    const snap = snapshot();
    expect(snap.items.has(a.id)).toBe(false);
    expect(snap.done[a.id]?.status).toBe('approved');
    expect(snap.openId).toBe(a.id);
    expect(postsOf('clear').map((p) => p.id)).toEqual([a.id]);
  });

  it('answered elsewhere while away: a re-read without it takes its notice back', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    api.list.mockResolvedValue({ approvals: [], keys: [] });
    await store.refreshApprovals();
    expect(snapshot().items.size).toBe(0);
    expect(postsOf('clear').map((p) => p.id)).toEqual([a.id]);
  });

  it("a test run's approval never reaches a person's window, nor its notice", () => {
    store.applyApprovalEvent(approval({ testRun: 'webdriver-1' }));
    expect(snapshot().items.size).toBe(0);
    expect(postsOf('post')).toHaveLength(0);
  });

  it('a test window re-reads instead of trusting an event of another label', () => {
    api.label = 'webdriver-1';
    store.applyApprovalEvent(approval());
    expect(api.list).toHaveBeenCalled();
    expect(snapshot().items.size).toBe(0);
  });

  it('a notice clicked for an approval this window has not read re-reads the list', async () => {
    const a = approval();
    api.list.mockResolvedValue({ approvals: [a], keys: [] });
    store.openApproval(a.id);
    await vi.waitFor(() => expect(snapshot().items.has(a.id)).toBe(true));
    expect(snapshot().openId).toBe(a.id);
  });

  it('a list read that started before an answer never brings the answered one back', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    let release!: (v: { approvals: Approval[]; keys: [] }) => void;
    api.list.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const read = store.refreshApprovals();
    store.applyApprovalEvent({ ...a, status: 'approved' });
    release({ approvals: [a], keys: [] });
    await read;
    expect(snapshot().items.has(a.id)).toBe(false);
    // A late pending event for it is ignored too.
    store.applyApprovalEvent(a);
    expect(snapshot().items.has(a.id)).toBe(false);
  });

  it('only the newest of several reads lands', async () => {
    const a = approval();
    const b = approval();
    let releaseOld!: (v: { approvals: Approval[]; keys: [] }) => void;
    api.list.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
    const older = store.refreshApprovals();
    api.list.mockResolvedValueOnce({ approvals: [b], keys: [] });
    await store.refreshApprovals();
    releaseOld({ approvals: [a], keys: [] });
    await older;
    expect([...snapshot().items.keys()]).toEqual([b.id]);
  });

  it('quiet mode holds a notice back, and the end of quiet raises it', () => {
    api.allows.mockReturnValue(false);
    const a = approval();
    store.applyApprovalEvent(a);
    expect(postsOf('post')).toHaveLength(0);
    api.allows.mockReturnValue(true);
    store.noticePending();
    store.noticePending();
    expect(postsOf('post').map((p) => p.id)).toEqual([a.id]);
  });

  it('the Mac app is told which notices are still current after every read', async () => {
    const a = approval();
    api.list.mockResolvedValue({ approvals: [a], keys: [] });
    await store.refreshApprovals();
    expect(postsOf('keep').at(-1)).toMatchObject({ ids: [a.id] });
  });

  it('an expired one is not listed and raises no notice', () => {
    const a = approval({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    store.applyApprovalEvent(a);
    expect(store.pendingAt(snapshot(), Date.now())).toEqual([]);
    expect(postsOf('post')).toHaveLength(0);
  });

  it('a tap approval offers Approve, a biometric one without a signer offers none and says why', () => {
    const s = snapshot();
    expect(store.approveKind(s, approval())).toBe('tap');
    expect(store.approveKind(s, approval({ mode: 'biometric' }))).toBeNull();
    expect(store.noApproveReason(s, approval({ mode: 'biometric' }))).toContain('iPhone with Face ID');
  });
});

describe('Org: which node lists an approval', () => {
  const asked = approval({ requester: { host: 'devbox', taskId: 't-1' } });
  const plain = approval();
  it('Main lists every one, a lead only those its own work asked for', () => {
    expect(approvalsForNode([asked, plain], 'main', new Set())).toEqual([asked, plain]);
    expect(approvalsForNode([asked, plain], 'project', new Set(['t-1']))).toEqual([asked]);
    expect(approvalsForNode([asked, plain], 'project', new Set(['t-2']))).toEqual([]);
  });
});

describe('the system notice', () => {
  it('quiet mode holds it back unless quiet lets permission prompts through', () => {
    api.allows.mockReturnValue(false);
    notify.showApprovalNotice(approval());
    expect(postsOf('post')).toHaveLength(0);
    expect(api.allows).toHaveBeenCalledWith(api.quiet, 'permission');
  });

  it('says what to do and names the host by its display name, never the alias', () => {
    api.hostLabel = 'Dev box';
    const text = notify.approvalNoticeText(approval({ requester: { host: 'devbox', taskTitle: 'Ship it' } }));
    expect(text.title).toBe('Approve? Deploy web');
    expect(text.body).toBe('Task "Ship it" on Dev box is waiting for you. Click to approve or deny.');
    api.hostLabel = undefined;
    expect(notify.approvalNoticeText(approval({ requester: { host: '__cloudbox__' } })).body).toContain('on Cloud ');
    expect(notify.approvalNoticeText(approval({ mode: 'biometric' })).body).toContain('Touch ID or Face ID');
  });
});

const snapshot = () => store.approvalsSnapshot();

describe('a guarded approval while Passwords is locked here: Unlock to approve, words for the devices the person has', () => {
  const guarded = (over: Partial<Approval> = {}) => approval({ guard: 'person', what: 'Let a Walnut agent click button "Place order" on shop.example.test?', ...over } as Partial<Approval>);
  it('no Approve, but an unlock in place; the reason names no device the person lacks', () => {
    const s = snapshot();
    const a = guarded();
    expect(store.approveKind(s, a)).toBeNull();
    expect(store.unlockApproves(s, a)).toBe(true);
    expect(store.noApproveReason(s, a)).toBe('Unlock Passwords in this window to approve.');
    store.openUnlock(a.id);
    expect(snapshot().unlockId).toBe(a.id);
    store.openUnlock(null);
    expect(snapshot().unlockId).toBeNull();
  });

  it('with an iPhone that signs, the reason names it too', () => {
    const s = { ...snapshot(), keys: [{ id: 'k1', name: 'iPhone', kind: 'iphone', status: 'active' }] } as unknown as ReturnType<typeof snapshot>;
    expect(store.noApproveReason(s, guarded({ mode: 'biometric' }))).toBe('Approve it on your iPhone with Face ID, or unlock Passwords in this window.');
  });

  it('an item that needs Face ID itself offers no unlock; a plain tap approval needs none', () => {
    const s = snapshot();
    expect(store.unlockApproves(s, approval({ guard: 'vault-sensitive', mode: 'biometric' } as Partial<Approval>))).toBe(false);
    expect(store.unlockApproves(s, approval())).toBe(false);
  });

  it('an ask from this computer says "this computer", never its host name', () => {
    const a = approval({ requester: { host: '2d34e77b685c', local: true } });
    expect(notify.approvalNoticeText(a, '2d34e77b685c').body).toContain('A script on this computer is waiting');
    expect(notify.approvalNoticeText(a, '2d34e77b685c').body).not.toContain('2d34e77b685c');
  });
});
