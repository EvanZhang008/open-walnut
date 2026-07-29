import { describe, it, expect } from 'vitest';
import {
  panelCountOf,
  MIN_PANELS,
  MAX_PANELS,
  type SessionPanelMode,
} from '../../web/src/hooks/useSessionPanelMode';

/**
 * The session-panel setting is 'auto' OR an explicit column count as a string.
 * The Settings picker offers 1..MAX_PANELS plus Auto.
 *
 * Parsing is the load-bearing part, and it is NOT just about the picker: the value
 * also arrives from config.yaml and from other/older clients, so an out-of-range or
 * non-numeric value must degrade to the width-driven fallback rather than render a
 * broken strip (0 columns, or 99 unreadable slivers).
 */

describe('useSessionPanelMode: panelCountOf', () => {
  it('reads back every count the picker offers', () => {
    for (let n = MIN_PANELS; n <= MAX_PANELS; n++) {
      expect(panelCountOf(String(n) as SessionPanelMode)).toBe(n);
    }
  });

  it('returns null for auto so callers fall back to the width breakpoints', () => {
    expect(panelCountOf('auto')).toBeNull();
  });

  it('rejects out-of-range counts instead of honouring them', () => {
    // A hand-edited config asking for 0 or 99 columns must not be obeyed. Falling
    // back to auto is the safe read — never a zero-column or 99-column strip.
    expect(panelCountOf('0' as SessionPanelMode)).toBeNull();
    expect(panelCountOf(String(MAX_PANELS + 1) as SessionPanelMode)).toBeNull();
    expect(panelCountOf('99' as SessionPanelMode)).toBeNull();
    expect(panelCountOf('-2' as SessionPanelMode)).toBeNull();
  });

  it('rejects non-integer and non-numeric values', () => {
    // '' is the trap: Number('') is 0, not NaN, so a bare falsy check would let an
    // empty string through as a zero-column layout.
    expect(panelCountOf('2.5' as SessionPanelMode)).toBeNull();
    expect(panelCountOf('' as SessionPanelMode)).toBeNull();
    expect(panelCountOf('two' as SessionPanelMode)).toBeNull();
    expect(panelCountOf('3px' as SessionPanelMode)).toBeNull();
  });
});
