/**
 * Approve and Deny always come together, and Approve always works (2026-11-15, the user, on an
 * approval sheet that showed Deny alone: "你那个到底在哪里？... 就显示了一个 small box of deny";
 * 2026-11-21, on a grey Approve on the phone: "只要我这个手机连到了这里面，或者其他的 device ... 就可以签呢").
 * Any window the person is signed in on approves with a tap: for every record shape a server writes
 * or once wrote (a tap or an older Face ID ask, guarded by Passwords or not, pinned to device keys or
 * not, single-use or not, from this machine or another), the buttons hold one Deny and one enabled
 * Approve beside it; both wait only while an answer is on its way.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { Approval } from '../../web/src/api/approvals';

const { ApprovalButtons } = await import('../../web/src/components/approvals/ApprovalPrompts');
const store = await import('../../web/src/components/approvals/approvals-store');
type State = ReturnType<typeof store.approvalsSnapshot>;

function approval(over: Record<string, unknown>): Approval {
  return {
    id: 'apr-pair', what: 'Publish a leak gate change', mode: 'tap', status: 'pending',
    createdAt: '2026-11-15T23:08:34.773Z', expiresAt: '2999-01-01T00:00:00.000Z', digest: 'd',
    requester: { host: '842f578d365e', local: true, taskTitle: 'Code repo secret protection' },
    ...over,
  } as Approval;
}

function state(over: Partial<State> = {}): State {
  return { ...store.approvalsSnapshot(), ...over };
}

function buttons(a: Approval, s: State): { deny: number; approve: number; enabledApprove: number; enabledDeny: number } {
  const html = renderToStaticMarkup(createElement(ApprovalButtons, { a, s }));
  const tags = html.match(/<button[^>]*>/g) ?? [];
  const approves = tags.filter((t) => t.includes('approval-btn-approve'));
  const denies = tags.filter((t) => t.includes('approval-btn-deny'));
  const enabled = (xs: string[]) => xs.filter((t) => !/\sdisabled=""/.test(t)).length;
  return { deny: denies.length, approve: approves.length, enabledApprove: enabled(approves), enabledDeny: enabled(denies) };
}

describe('approval buttons: an enabled Approve always beside Deny', () => {
  // `biometric`, `guard` and `signingKeyIds` are only in records an older server wrote.
  const modes = ['tap', 'biometric'] as const;
  const guards = [undefined, 'vault', 'person', 'vault-sensitive'] as const;
  const pins = { none: undefined, 'one phone key': ['ak-f9ca'], 'two old keys': ['ak-dcb776df2641b2ff', 'ak-e71d5e306b094f97'] } as const;
  const shapes = { plain: {}, 'single-use': { singleUse: true }, 'outside the switch': { outsideSwitch: true }, 'from another host': { requester: { host: 'clouddev', local: false } } } as const;

  for (const mode of modes) for (const guard of guards) for (const [pin, signingKeyIds] of Object.entries(pins)) for (const [shape, extra] of Object.entries(shapes)) {
    it(`${mode} guard=${guard ?? 'none'} pinned=${pin} ${shape}`, () => {
      const a = approval({ mode, guard, signingKeyIds: signingKeyIds ? [...signingKeyIds] : undefined, ...extra });
      const b = buttons(a, state());
      expect(b).toEqual({ deny: 1, approve: 1, enabledApprove: 1, enabledDeny: 1 });
    });
  }

  it('an answer on its way: both wait, and the one sent says so', () => {
    const a = approval({});
    for (const decision of ['approve', 'deny'] as const) {
      const b = buttons(a, state({ busy: { [a.id]: decision } }));
      expect(b).toMatchObject({ deny: 1, approve: 1, enabledApprove: 0, enabledDeny: 0 });
      const html = renderToStaticMarkup(createElement(ApprovalButtons, { a, s: state({ busy: { [a.id]: decision } }) }));
      expect(html).toContain(decision === 'approve' ? 'Approving…' : 'Denying…');
    }
  });

  it('never sends the person elsewhere: no "approve on another device", Face ID or unlock wording', () => {
    const a = approval({ mode: 'biometric', guard: 'vault', signingKeyIds: ['ak-f9ca'] });
    const html = renderToStaticMarkup(createElement(ApprovalButtons, { a, s: state() }));
    expect(html).not.toMatch(/approval-approve-elsewhere|Face ID|Touch ID|Unlock|another device/);
    expect(html).toContain('data-testid="approval-approve"');
  });
});
