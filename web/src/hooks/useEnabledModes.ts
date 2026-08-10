import { useState, useEffect } from 'react';
import { fetchConfig } from '@/api/config';
import { VALID_SESSION_MODE_IDS } from '@open-walnut/core';
import type { SessionMode } from '@open-walnut/core';

/**
 * The DEFAULT pill cycle: three modes that cover the three real intents, so one
 * tap always lands somewhere useful instead of walking a six-item ring.
 *
 *   Plan   — look, don't touch
 *   Auto   — run it, classifier vets each call (measured working on Bedrock:
 *            auto-allowed a Write that `default` refused)
 *   Bypass — run it, full trust
 *
 * Default/Accept/Don't Ask are still fully supported everywhere — spawn, live
 * switch, REST, iOS. They're just off the default cycle; tick them in
 * Settings → Tasks & Sessions → Enabled Session Modes to add them back.
 *
 * This is a UI-cycle default ONLY. Do not narrow any validator to match it, or
 * a session already running in an unlisted mode becomes unrepresentable — that
 * class of coercion is exactly what froze the pill on "Default" before.
 */
const DEFAULT_MODES: SessionMode[] = ['plan', 'auto', 'bypass'];

/**
 * Fetch session.enabled_modes from config once on mount.
 * Returns the mode cycle array (defaults to DEFAULT_MODES).
 */
export function useEnabledModes(): SessionMode[] {
  const [modes, setModes] = useState<SessionMode[]>(DEFAULT_MODES);

  useEffect(() => {
    fetchConfig().then(c => {
      const m = c.session?.enabled_modes;
      // Validate against the FULL registry, never against DEFAULT_MODES — a
      // user who ticked Accept must get Accept, not have it filtered out for
      // being absent from the default trio.
      const valid = m?.filter((mode): mode is SessionMode => VALID_SESSION_MODE_IDS.has(mode));
      if (valid?.length) setModes(valid);
    }).catch(() => {});
  }, []);

  return modes;
}
