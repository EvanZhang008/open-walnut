/**
 * Approve and Deny always come together (2026-11-15, the user, on an approval sheet that showed Deny
 * alone: "你那个到底在哪里？... 就显示了一个 small box of deny"). For every way a window can stand to a
 * request (a tap or a Face ID / Touch ID one, guarded by Passwords or not, this window signing or not,
 * Passwords unlocked here or not, still checking, bound to another device): the buttons hold Deny and an
 * Approve beside it, enabled only where this window may approve, never Deny alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { Approval, ApprovalKey } from '../../web/src/api/approvals';

let live = false;
vi.mock('@/api/vault-live', () => ({ vaultLive: () => live, checkVault: vi.fn() }));

const { ApprovalButtons } = await import('../../web/src/components/approvals/ApprovalPrompts');
const store = await import('../../web/src/components/approvals/approvals-store');
type State = Parameters<typeof store.approveKind>[0];

const MAC_KEY: ApprovalKey = { id: 'ak-mac', name: 'Mac', kind: 'mac-app', status: 'active' } as ApprovalKey;
const PHONE_KEY: ApprovalKey = { id: 'ak-phone', name: 'iPhone', kind: 'iphone', status: 'active' } as ApprovalKey;

function approval(over: Partial<Approval>): Approval {
  return {
    id: 'apr-pair', what: 'Publish a leak gate change', mode: 'tap', status: 'pending',
    createdAt: '2026-11-15T23:08:34.773Z', expiresAt: '2999-01-01T00:00:00.000Z', digest: 'd',
    requester: { host: '842f578d365e', local: true, taskTitle: 'Code repo secret protection' },
    ...over,
  } as Approval;
}

function state(over: Partial<State>): State {
  return { items: new Map(), keys: [MAC_KEY, PHONE_KEY], touchId: null, busy: {}, errors: {}, done: {}, openId: null, unlockId: null, vaultLooking: false, stoppedAsking: null, stoppingId: null, ...over } as State;
}

function buttons(a: Approval, s: State): { deny: number; approve: number; enabledApprove: number } {
  const html = renderToStaticMarkup(createElement(ApprovalButtons, { a, s }));
  const tags = html.match(/<button[^>]*>/g) ?? [];
  const approves = tags.filter((t) => t.includes('approval-btn-approve'));
  return {
    deny: tags.filter((t) => t.includes('approval-btn-deny')).length,
    approve: approves.length,
    enabledApprove: approves.filter((t) => !/\sdisabled=""/.test(t)).length,
  };
}

describe('approval buttons: Approve always beside Deny', () => {
  const modes = ['tap', 'biometric'] as const;
  const guards = [undefined, 'vault', 'person', 'vault-sensitive'] as const;
  const signers = {
    browser: null,
    'mac signs': { available: true, keyId: 'ak-mac' },
    'mac without Touch ID': { available: false, keyId: 'ak-mac', reason: 'Touch ID is not set up on this Mac.' },
  } as const;
  const bindings = { any: undefined, 'phone only': ['ak-phone'], 'mac and phone': ['ak-mac', 'ak-phone'] } as const;

  for (const mode of modes) for (const guard of guards) for (const [signer, touchId] of Object.entries(signers))
    for (const [bound, signingKeyIds] of Object.entries(bindings)) for (const unlocked of [false, true]) for (const looking of [false, true]) {
      it(`${mode} guard=${guard ?? 'none'} ${signer} bound=${bound} unlocked=${unlocked} checking=${looking}`, () => {
        live = unlocked;
        const a = approval({ mode, guard, signingKeyIds: signingKeyIds ? [...signingKeyIds] : undefined } as Partial<Approval>);
        const s = state({ touchId: touchId as State['touchId'], vaultLooking: looking });
        const b = buttons(a, s);
        expect(b.deny, 'one Deny').toBe(1);
        expect(b.approve, 'an Approve beside Deny').toBe(1);
        // Enabled exactly where this window may approve (or unlock Passwords here to approve).
        const may = !!store.approveKind(s, a) || (store.unlockApproves(s, a) && !store.unlockUndecided(s, a));
        expect(b.enabledApprove).toBe(may ? 1 : 0);
      });
    }

  it('the Face ID request in a browser: Approve dimmed, titled with where to approve it', () => {
    live = false;
    const a = approval({ mode: 'biometric' });
    const html = renderToStaticMarkup(createElement(ApprovalButtons, { a, s: state({}) }));
    expect(html).toContain('data-testid="approval-approve-elsewhere"');
    expect(html).toMatch(/title="[^"]*Face ID[^"]*"/);
  });
});
