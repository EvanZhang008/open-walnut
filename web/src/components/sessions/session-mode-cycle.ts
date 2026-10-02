/**
 * The permission-mode pill's one rule, shared by the composers that draw it (the
 * chat lane, the draft composer; SessionPanel spells out the same two lines): a
 * click or Shift+Tab moves to the next mode of the enabled cycle (Settings ›
 * Sessions › Enabled Session Modes, default Plan → Auto → Bypass). A current mode
 * that is not in the cycle (a session started in Accept, say) steps onto its
 * first entry rather than staying stuck.
 */
import type { SessionMode } from '@open-walnut/core';

export function nextSessionMode(current: SessionMode, enabled: readonly SessionMode[]): SessionMode {
  if (enabled.length === 0) return current;
  const idx = enabled.indexOf(current);
  return enabled[(idx + 1) % enabled.length]!;
}
