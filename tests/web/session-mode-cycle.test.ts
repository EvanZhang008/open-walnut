/**
 * The permission-mode pill's cycle rule (web/src/components/sessions/session-mode-cycle.ts),
 * shared by the live session column, the chat lane and the draft composer.
 */
import { describe, it, expect } from 'vitest';
import { nextSessionMode } from '../../web/src/components/sessions/session-mode-cycle';
import { DEFAULT_SESSION_MODE, SESSION_MODE_IDS, VALID_SESSION_MODE_IDS } from '../../src/core/types';

describe('nextSessionMode', () => {
  it('walks the enabled cycle and wraps', () => {
    const cycle = ['plan', 'auto', 'bypass'] as const;
    expect(nextSessionMode('plan', cycle)).toBe('auto');
    expect(nextSessionMode('auto', cycle)).toBe('bypass');
    expect(nextSessionMode('bypass', cycle)).toBe('plan');
  });

  it('a mode outside the cycle steps onto its first entry instead of sticking', () => {
    expect(nextSessionMode('accept', ['plan', 'bypass'])).toBe('plan');
    expect(nextSessionMode('dontAsk', ['bypass'])).toBe('bypass');
  });

  it('an empty cycle changes nothing', () => {
    expect(nextSessionMode('plan', [])).toBe('plan');
  });

  it('the launch default the draft pill shows is a registered mode', () => {
    expect(VALID_SESSION_MODE_IDS.has(DEFAULT_SESSION_MODE)).toBe(true);
    expect(SESSION_MODE_IDS).toContain(DEFAULT_SESSION_MODE);
  });
});
