/**
 * Terminal keys (src/core/terminal-key.ts): slot 1 of a session is the session id, so the
 * terminal a session had before it could hold several reattaches its running shell; slot n
 * is `<id>__term<n>`. The key names the dtach socket and goes unquoted into a remote command.
 */
import { describe, it, expect } from 'vitest';
import { terminalKeyFor, parseTerminalKey, isSafeTerminalKey, isTerminalSlot, MAX_TERMINAL_SLOTS } from '../../src/core/terminal-key.js';
import { buildRemoteDtachCommand, dtachSocketPath } from '../../src/web/terminal/spawn.js';

const SID = '0f8e2c1a-5b3d-4e6f-9a7b-1c2d3e4f5a6b';

describe('terminal keys', () => {
  it('slot 1 is the session id; the others carry their slot', () => {
    expect(terminalKeyFor(SID)).toBe(SID);
    expect(terminalKeyFor(SID, 1)).toBe(SID);
    expect(terminalKeyFor(SID, 3)).toBe(`${SID}__term3`);
  });

  it('every slot round-trips and stays a safe socket name', () => {
    for (let slot = 1; slot <= MAX_TERMINAL_SLOTS; slot++) {
      const key = terminalKeyFor(SID, slot);
      expect(parseTerminalKey(key)).toEqual({ sessionId: SID, slot });
      expect(isSafeTerminalKey(key)).toBe(true);
      expect(() => dtachSocketPath(key)).not.toThrow();
    }
  });

  it('refuses a slot out of range', () => {
    for (const bad of [0, -1, MAX_TERMINAL_SLOTS + 1, 1.5, Number.NaN]) {
      expect(isTerminalSlot(bad)).toBe(false);
      expect(() => terminalKeyFor(SID, bad)).toThrow();
    }
  });

  it('a key without a valid slot suffix is slot 1 of that id', () => {
    expect(parseTerminalKey('plain-id')).toEqual({ sessionId: 'plain-id', slot: 1 });
    expect(parseTerminalKey(`${SID}__term1`)).toEqual({ sessionId: `${SID}__term1`, slot: 1 });
    expect(parseTerminalKey(`${SID}__term99`)).toEqual({ sessionId: `${SID}__term99`, slot: 1 });
  });

  it("a remote host's command names the slot's own socket and pid record", () => {
    const key = terminalKeyFor(SID, 4);
    const cmd = buildRemoteDtachCommand('/opt/w/dtach', key, '/bin/zsh', '/home/u/proj');
    expect(cmd).toContain(`walnut-${key}.dsock`);
    expect(cmd).toContain(`walnut-${key}.dpid`);
    expect(cmd).not.toContain(`walnut-${SID}.dsock`);
  });
});
