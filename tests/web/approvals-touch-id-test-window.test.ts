/**
 * A test window never touches the Mac app's Touch ID bridge (approvals-store.ts startTouchId): it
 * makes no key and enrolls none. 2026-11-18 a test's copy of the Mac app, driven by automation,
 * enrolled a fresh key against the person's Walnut, which put "Let … (Mac app) sign your approvals"
 * on the person's screen. The person's own window still reads the bridge and enrolls its key.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

let label: string | null = null;
const status = vi.fn(async () => ({ available: true, keyId: 'ak-mac', publicKey: 'MFkw', name: 'Mac' }));
const enroll = vi.fn(async () => ({ status: 200, body: { key: { id: 'ak-mac', status: 'active' } } }));

vi.mock('@/api/test-run', () => ({ testRunLabel: () => label }));
vi.mock('../../web/src/components/approvals/touch-id-bridge', () => ({
  hasTouchIdBridge: () => true, touchIdStatus: status, touchIdEnroll: enroll, touchIdSign: vi.fn(),
}));
vi.mock('@/api/approvals', () => ({
  listApprovals: vi.fn(async () => ({ approvals: [], keys: [] })),
  enrollApprovalKey: vi.fn(), answerApproval: vi.fn(), setApprovalsAskMe: vi.fn(), turnApprovalsOff: vi.fn(),
}));

const store = await import('../../web/src/components/approvals/approvals-store');

beforeEach(() => { status.mockClear(); enroll.mockClear(); });

describe('the Mac app enrolls its Touch ID key only in a person\'s window', () => {
  it.each(['webdriver-a1b2c3', 'release-check'])('a test window (%s) never asks the bridge', async (l) => {
    label = l;
    await store.startTouchId();
    expect(status).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('the person\'s own window reads the bridge and sends its key from the app', async () => {
    label = null;
    await store.startTouchId();
    // Read before the enroll, and once more after it (the app may have made its key then).
    expect(status).toHaveBeenCalled();
    expect(enroll).toHaveBeenCalledTimes(1);
  });
});
