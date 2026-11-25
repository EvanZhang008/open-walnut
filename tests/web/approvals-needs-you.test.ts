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
 *  - quiet mode holds the notice back, asks included, and the end of quiet raises ONE notice
 *    (the approval itself when it is the only one that waited: system-notice.ts);
 *  - a list read that started before an answer never brings the answered one back;
 *  - the notice names the host by its display name, never a raw alias.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '../../web/src/api/approvals';

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({ approvals: [] as Approval[] })),
  answer: vi.fn(),
  label: null as string | null,
  quiet: { active: false, allowPermissions: true, holds: [] } as Record<string, unknown>,
  allows: vi.fn(() => true),
  quietListener: null as null | ((q: Record<string, unknown>) => void),
  hostLabel: undefined as string | undefined,
}));

vi.mock('@/api/approvals', () => ({
  listApprovals: api.list,
  answerApproval: api.answer,
}));
vi.mock('@/api/test-run', () => ({ testRunLabel: () => api.label }));
vi.mock('@/utils/log', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/notifications/quiet', () => ({
  currentQuiet: () => api.quiet,
  onQuietState: (fn: (q: Record<string, unknown>) => void) => { api.quietListener = fn; return () => undefined; },
}));
// No focus block lets a task's notice through quiet here (quiet-model.ts quietLetsTaskThrough).
vi.mock('@/contexts/notifications/quiet-model', () => ({ quietAllowsToast: api.allows, effectiveQuiet: (q: unknown) => q, quietLetsTaskThrough: () => false }));
vi.mock('@/hooks/useHostStatus', () => ({ getHostStatus: () => (api.hostLabel ? { label: api.hostLabel } : undefined) }));

const posts: Array<Record<string, unknown>> = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => undefined,
  webkit: { messageHandlers: { walnutNotify: { postMessage: async (b: Record<string, unknown>) => { posts.push(b); return { posted: true }; } } } },
};

const store = await import('../../web/src/components/approvals/approvals-store');
const notify = await import('../../web/src/components/approvals/approval-notify');
const { approvalsForNode } = store;
const snapshot = () => store.approvalsSnapshot();

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
  api.list.mockResolvedValue({ approvals: [] });
  api.hostLabel = undefined;
});

describe('approvals store: one list for the cards, the rows and the dialog', () => {
  it('a new approval is listed and raises one system notice, however often it is heard', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    store.applyApprovalEvent(a);
    api.list.mockResolvedValue({ approvals: [a] });
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
    api.list.mockResolvedValue({ approvals: [] });
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
    api.list.mockResolvedValue({ approvals: [a] });
    store.openApproval(a.id);
    await vi.waitFor(() => expect(snapshot().items.has(a.id)).toBe(true));
    expect(snapshot().openId).toBe(a.id);
  });

  it('a list read that started before an answer never brings the answered one back', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    let release!: (v: { approvals: Approval[] }) => void;
    api.list.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const read = store.refreshApprovals();
    store.applyApprovalEvent({ ...a, status: 'approved' });
    release({ approvals: [a] });
    await read;
    expect(snapshot().items.has(a.id)).toBe(false);
    // A late pending event for it is ignored too.
    store.applyApprovalEvent(a);
    expect(snapshot().items.has(a.id)).toBe(false);
  });

  it('only the newest of several reads lands', async () => {
    const a = approval();
    const b = approval();
    let releaseOld!: (v: { approvals: Approval[] }) => void;
    api.list.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
    const older = store.refreshApprovals();
    api.list.mockResolvedValueOnce({ approvals: [b] });
    await store.refreshApprovals();
    releaseOld({ approvals: [a] });
    await older;
    expect([...snapshot().items.keys()]).toEqual([b.id]);
  });

  it('quiet mode holds a notice back, and the end of quiet raises it once', async () => {
    api.quiet = { active: true, allowPermissions: true, holds: [{ source: 'plugin:walnut-rhythm', since: 1 }] };
    const a = approval();
    store.applyApprovalEvent(a);
    expect(postsOf('post')).toHaveLength(0);
    api.quiet = { active: false, allowPermissions: true, holds: [] };
    api.quietListener?.(api.quiet);
    api.quietListener?.(api.quiet);
    await new Promise((r) => setTimeout(r, 0));
    expect(postsOf('post').map((p) => p.id)).toEqual([a.id]);
  });

  it('the Mac app is told which notices are still current after every read', async () => {
    const a = approval();
    api.list.mockResolvedValue({ approvals: [a] });
    await store.refreshApprovals();
    // The reminder after quiet shares the app's approval notices and is kept with them.
    expect(postsOf('keep').at(-1)).toMatchObject({ ids: [a.id, 'quiet-catchup'] });
  });

  it('an expired one is not listed and raises no notice', () => {
    const a = approval({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    store.applyApprovalEvent(a);
    expect(store.pendingAt(snapshot(), Date.now())).toEqual([]);
    expect(postsOf('post')).toHaveLength(0);
  });

  it('Approve here is a tap bound to the digest this window showed, naming the window (an older Face ID ask pinned to the phone too)', async () => {
    const a = approval({ mode: 'biometric', singleUse: true, signingKeyIds: ['ak-f9ca'] } as Partial<Approval>);
    store.applyApprovalEvent(a);
    api.answer.mockResolvedValueOnce({ approval: { ...a, status: 'approved' } });
    await store.decideApproval(a, 'approve');
    expect(api.answer).toHaveBeenLastCalledWith(a.id, { decision: 'approve', digest: 'd', device: { name: 'Web console', kind: 'web' } });
    expect(snapshot().items.has(a.id)).toBe(false);
    expect(snapshot().done[a.id]?.status).toBe('approved');
    expect(snapshot().busy[a.id]).toBeUndefined();
  });

  it('a request that changed or was answered elsewhere meanwhile (409): the error shows and the list is read again', async () => {
    const a = approval();
    store.applyApprovalEvent(a);
    api.answer.mockRejectedValueOnce(Object.assign(new Error('This request changed since it was shown.'), { status: 409 }));
    api.list.mockClear();
    api.list.mockResolvedValue({ approvals: [] });
    await store.decideApproval(a, 'approve');
    expect(snapshot().errors[a.id]).toBe('This request changed since it was shown.');
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    await vi.waitFor(() => expect(snapshot().items.has(a.id)).toBe(false));
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
  it('quiet mode holds it back, even while quiet lets permission prompts toast in the window', () => {
    api.quiet = { active: true, allowPermissions: true, holds: [{ source: 'user', since: 1 }] };
    notify.showApprovalNotice(approval());
    expect(postsOf('post')).toHaveLength(0);
    api.quiet = { active: false, allowPermissions: true, holds: [] };
  });

  it('says what to do and names the host by its display name, never the alias', () => {
    api.hostLabel = 'Dev box';
    const text = notify.approvalNoticeText(approval({ requester: { host: 'devbox', taskTitle: 'Ship it' } }));
    expect(text.title).toBe('Approve? Deploy web');
    expect(text.body).toBe('Task "Ship it" on Dev box is waiting for you. Click to approve or deny.');
    api.hostLabel = undefined;
    expect(notify.approvalNoticeText(approval({ requester: { host: '__cloudbox__' } })).body).toContain('on Cloud ');
    // An older Face ID ask reads the same: a click here approves it.
    const older = notify.approvalNoticeText(approval({ mode: 'biometric' })).body;
    expect(older).toContain('Click to approve or deny.');
    expect(older).not.toMatch(/Face ID|Touch ID/);
  });

  it('an ask from this computer says "this computer", never its host name', () => {
    const a = approval({ requester: { host: '2d34e77b685c', local: true } });
    expect(notify.approvalNoticeText(a, '2d34e77b685c').body).toContain('A script on this computer is waiting');
    expect(notify.approvalNoticeText(a, '2d34e77b685c').body).not.toContain('2d34e77b685c');
  });
});
