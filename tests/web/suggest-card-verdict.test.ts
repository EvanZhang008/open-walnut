/**
 * Which failed invoke SETTLES a `<suggest>` action button for good.
 *
 * This is the persistence decision, so it is also a sync decision: the receipt
 * map lives under an `open-walnut-*` localStorage key that ui-prefs mirrors to
 * WALNUT_HOME/config/share/ui-prefs.json, which then reaches the user's other
 * devices. A verdict written here is therefore not local and not undoable by a
 * reload, which is why only codes that are true of the CARD may produce one.
 */
import { describe, it, expect } from 'vitest';
import type { InvokeErrorCode } from '@/api/actions';
import { terminalVerdict } from '@/utils/suggest-card-state';

describe('terminalVerdict', () => {
  it('settles a button whose tool can never be invoked', () => {
    expect(terminalVerdict('unknown_tool')).toBe('unknown_tool');
    expect(terminalVerdict('not_invocable')).toBe('unknown_tool');
  });

  it('settles a button whose args the op could never accept', () => {
    expect(terminalVerdict('invalid_arguments')).toBe('error');
  });

  it('does NOT settle a cloud replica 501 — the same button works on the primary', () => {
    // Persisting it synced a permanently dead receipt onto the Mac, where the op
    // is available: the code describes WHERE the click happened, not the card.
    expect(terminalVerdict('not_supported_cloud')).toBeNull();
  });

  it('does NOT settle anything about a single attempt', () => {
    const transient: InvokeErrorCode[] = ['network', 'timeout', 'op_failed', 'bad_request'];
    for (const code of transient) expect(terminalVerdict(code)).toBeNull();
  });

  it('leaves the confirmation escalation to the card, never a verdict', () => {
    expect(terminalVerdict('confirmation_required')).toBeNull();
  });
});
