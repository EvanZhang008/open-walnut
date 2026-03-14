import { useState, useEffect, useCallback, useMemo } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'open-walnut-theme';
const MQ = '(prefers-color-scheme: dark)';

function getStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* private browsing */ }
  return 'system';
}

function applyToDOM(pref: ThemePreference) {
  const el = document.documentElement;
  if (pref === 'light' || pref === 'dark') {
    el.dataset.theme = pref;
  } else {
    delete el.dataset.theme;
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(getStored);
  const [osDark, setOsDark] = useState(() => window.matchMedia(MQ).matches);

  // Listen for OS theme changes
  useEffect(() => {
    const mql = window.matchMedia(MQ);
    const handler = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Apply theme to DOM + persist
  const setTheme = useCallback((pref: ThemePreference) => {
    setThemeState(pref);
    applyToDOM(pref);
    try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* private browsing */ }
  }, []);

  // Sync DOM on mount (in case React hydrates after the inline script)
  useEffect(() => { applyToDOM(theme); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedTheme: ResolvedTheme = useMemo(() => {
    if (theme === 'system') return osDark ? 'dark' : 'light';
    return theme;
  }, [theme, osDark]);

  return { theme, resolvedTheme, setTheme } as const;
}
