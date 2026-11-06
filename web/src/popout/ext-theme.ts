/**
 * Walnut's theme, told to the extension page that frames a side panel view (the Ask view, panel
 * and popup, and the Tasks view), so the parts it draws itself (the key popover, its full views,
 * the placeholder while the frame loads) wear the same one:
 *
 *   view → panel page   { walnut: 'ext-panel', type: 'theme', theme: 'dark' | 'light' | 'system' }
 *
 * Sent once the extension page has spoken (right after `ready`), and again whenever the theme
 * changes: in this frame, or in another Walnut window (General's theme is kept in localStorage, so
 * the frame follows it too).
 */
import { useEffect } from 'react';
import { onParentKnown, parentKnown, toParent } from './ext-frame';

export type FrameTheme = 'dark' | 'light' | 'system';

/** useTheme's key (web/src/hooks/useTheme.ts). */
export const THEME_KEY = 'open-walnut-theme';

/** The person's pick as the page wears it: `data-theme` on <html> is set for light or dark, absent for system. */
export function frameThemeOf(dataTheme: string | null | undefined): FrameTheme {
  return dataTheme === 'dark' || dataTheme === 'light' ? dataTheme : 'system';
}

export function useFrameTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    let told = '';
    const tell = () => {
      if (!parentKnown()) return;
      const theme = frameThemeOf(root.dataset.theme);
      if (theme === told) return;
      told = theme;
      toParent({ type: 'theme', theme });
    };
    const offKnown = onParentKnown(tell);
    const obs = new MutationObserver(tell);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    // Picked in another Walnut window: this frame wears it too (then the observer tells).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      const theme = frameThemeOf(e.newValue);
      if (theme === 'system') delete root.dataset.theme;
      else root.dataset.theme = theme;
    };
    window.addEventListener('storage', onStorage);
    tell();
    return () => { offKnown(); obs.disconnect(); window.removeEventListener('storage', onStorage); };
  }, []);
}
