import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, live: the component re-renders when the window crosses it.
 * One subscribe function per query (useSyncExternalStore re-subscribes when it changes), and false
 * where there is no window (a test, a server render). usePhoneLayout reads its query the same way.
 */
const subscribers = new Map<string, (onChange: () => void) => () => void>();

export function mediaQuerySubscribe(query: string): (onChange: () => void) => () => void {
  let fn = subscribers.get(query);
  if (!fn) {
    fn = (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    };
    subscribers.set(query, fn);
  }
  return fn;
}

export function mediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(mediaQuerySubscribe(query), () => mediaMatches(query), () => false);
}
