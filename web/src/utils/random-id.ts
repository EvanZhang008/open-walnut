/**
 * A random v4 UUID that works in every context the app runs in.
 *
 * `crypto.randomUUID` exists only in a secure context (https, or localhost): on a
 * plain-http address the app is opened at from another machine (a LAN address, a
 * proxy) it is undefined, and a bare call threw "crypto.randomUUID is not a
 * function" into the page's error boundary, so opening a third column took the
 * whole page down (2026-11-05). `crypto.getRandomValues` exists in every context.
 */
export function randomId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
