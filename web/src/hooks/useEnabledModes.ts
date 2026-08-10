import { useState, useEffect } from 'react';
import { fetchConfig } from '@/api/config';
import { SESSION_MODE_IDS } from '@open-walnut/core';
import type { SessionMode } from '@open-walnut/core';

/**
 * Default cycle = EVERY mode the CLI supports, safest → loosest, straight from
 * the one registry (core/types.ts). It used to be a hardcoded ['bypass','plan'],
 * which is why the pill only ever toggled between those two even though Walnut
 * modelled four modes and the CLI accepts six — `session.enabled_modes` is
 * unset for almost everyone, so the narrow fallback WAS the shipped behavior.
 */
const DEFAULT_MODES: SessionMode[] = [...SESSION_MODE_IDS];

/**
 * Fetch session.enabled_modes from config once on mount.
 * Returns the mode cycle array (defaults to all modes).
 */
export function useEnabledModes(): SessionMode[] {
  const [modes, setModes] = useState<SessionMode[]>(DEFAULT_MODES);

  useEffect(() => {
    fetchConfig().then(c => {
      const m = c.session?.enabled_modes;
      // Ignore unknown ids from a hand-edited/older config so a stale entry
      // can't put an unsupported value into the cycle (the CLI would reject it).
      const valid = m?.filter((mode): mode is SessionMode => DEFAULT_MODES.includes(mode));
      if (valid?.length) setModes(valid);
    }).catch(() => {});
  }, []);

  return modes;
}
