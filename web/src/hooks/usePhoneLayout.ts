import { useSyncExternalStore } from 'react';

/**
 * The phone layout: one surface at a time. The task panel is the home screen,
 * and the chat, a session or a draft opens over it full screen; navigation is a
 * drawer behind the top bar's menu button. A phone held sideways (844 to 932 px
 * wide, under 500 px tall, touch) is still a phone. The CSS twin of this query
 * is every `@media (max-width: 768px), (pointer: coarse) and (max-height: 500px)`
 * block (globals.css "Responsive", phone-layout.css); the ratchet
 * tests/web/phone-media-query-ratchet.test.ts keeps them the same.
 */
export const PHONE_LAYOUT_QUERY = '(max-width: 768px), (pointer: coarse) and (max-height: 500px)';

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

/** The Home strip this window keeps (layout-record.ts): a phone has its own, so a phone showing one
 *  column never overwrites the Mac's strip of three. Decided by the device (a touch screen in the
 *  phone layout), not the width alone: a Mac window opened narrow is still the Mac's strip. */
export function homeColumnsField(): 'homeColumns' | 'phoneColumns' {
  return isPhoneLayout() && typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches ? 'phoneColumns' : 'homeColumns';
}
