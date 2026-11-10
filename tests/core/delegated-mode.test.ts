import { describe, expect, it } from 'vitest';
import { delegatedMode } from '../../src/core/sessions/delegated-mode.js';
import { SESSION_MODE_IDS } from '../../src/core/types.js';
describe('preapproved task creation preserves caller permissions', () => {
  it.each(SESSION_MODE_IDS)('an implicit child inherits %s', mode => {
    expect(delegatedMode(mode)).toBe(mode === 'bypass' ? undefined : mode);
  });
  it.each(['plan', 'default', 'dontAsk', 'accept', 'auto'] as const)('%s cannot create a bypass child', mode => {
    expect(() => delegatedMode(mode, 'bypass')).toThrow('cannot start a task');
  });
  it('a legacy caller with no recorded mode cannot grant bypass', () => {
    expect(() => delegatedMode(undefined as never, 'bypass')).toThrow('cannot start a task');
  });
  it('Auto can delegate Auto and stricter work; Bypass retains current behavior', () => {
    expect(delegatedMode('auto', 'auto')).toBe('auto');
    expect(delegatedMode('auto', 'plan')).toBe('plan');
    expect(delegatedMode('bypass', 'auto')).toBe('auto');
  });
});
