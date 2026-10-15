/**
 * Keeps the browser bar colour (`<meta name="theme-color">`) on the theme in
 * use (spec 5.2), so the bar above the phone top bar never shows the other
 * theme's colour after a switch in Settings.
 *
 *   system        two metas with `media`, the browser picks (index.html's pair)
 *   light / dark  one meta, no `media`, the chosen colour
 *
 * The values are the phone top bar's --bg (globals.css): #FFFFFF and #000000.
 * index.html's inline script makes the same call before the first frame.
 */
import { useEffect } from 'react';
import type { ThemePreference } from './useTheme';

export const THEME_COLOR_LIGHT = '#FFFFFF';
export const THEME_COLOR_DARK = '#000000';

function meta(content: string, media?: string): HTMLMetaElement {
  const el = document.createElement('meta');
  el.name = 'theme-color';
  el.content = content;
  if (media) el.media = media;
  return el;
}

export function applyThemeColorMeta(pref: ThemePreference, doc: Document = document): void {
  const head = doc.head;
  if (!head) return;
  const existing = [...head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const wanted = pref === 'system'
    ? [meta(THEME_COLOR_LIGHT, '(prefers-color-scheme: light)'), meta(THEME_COLOR_DARK, '(prefers-color-scheme: dark)')]
    : [meta(pref === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT)];
  const same = existing.length === wanted.length && existing.every((el, i) =>
    el.content.toUpperCase() === wanted[i]!.content && (el.getAttribute('media') ?? '') === (wanted[i]!.getAttribute('media') ?? ''));
  if (same) return;
  const anchor = existing[0] ?? null;
  for (const el of wanted) head.insertBefore(el, anchor);
  for (const el of existing) el.remove();
}

export function useThemeColorMeta(pref: ThemePreference): void {
  useEffect(() => { applyThemeColorMeta(pref); }, [pref]);
}
