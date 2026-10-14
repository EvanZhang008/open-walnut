import { useSyncExternalStore } from 'react';

/**
 * The phone layout: one surface at a time. The task panel is the home screen,
 * and the chat, a session or a draft opens over it full screen; navigation is a
 * drawer behind the top bar's menu button. The CSS twin of this query is every
 * `@media (max-width: 768px)` block (globals.css "Responsive", phone-layout.css).
 */
export const PHONE_LAYOUT_QUERY = '(max-width: 768px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia(PHONE_LAYOUT_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function isPhoneLayout(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

/** True while the window is phone width; re-renders when it crosses the line. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false);
}
