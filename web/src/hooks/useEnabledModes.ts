import { useState, useEffect } from 'react';
import { fetchConfig } from '@/api/config';
import type { SessionMode } from '@open-walnut/core';

const DEFAULT_MODES: SessionMode[] = ['bypass', 'plan'];

/**
 * Fetch session.enabled_modes from config once on mount.
 * Returns the mode cycle array (defaults to all 4 modes).
 */
export function useEnabledModes(): SessionMode[] {
  const [modes, setModes] = useState<SessionMode[]>(DEFAULT_MODES);

  useEffect(() => {
    fetchConfig().then(c => {
      const m = c.session?.enabled_modes;
      if (m?.length) setModes(m);
    }).catch(() => {});
  }, []);

  return modes;
}
