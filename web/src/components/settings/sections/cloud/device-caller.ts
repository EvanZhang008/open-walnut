/**
 * Who is looking at Phones & Cloud (spec 4.7 Settings).
 *
 * - A browser that holds a device token signed in with a code: it is a device,
 *   not the person at the computer Walnut runs on. The server refuses it every
 *   code and QR (403 person_at_this_machine), so those buttons are not shown.
 * - Which row is this browser: GET /api/v1/me names the caller's device when
 *   the server knows it (`device.name`). Without that field (an older server)
 *   no row is marked and nothing is guessed: a wrong "This phone" would offer
 *   to sign out another device.
 *
 * Removal (src/core/device-actor.ts deviceChangeDecision): a device caller may
 * revoke only itself (`by: 'self'`), or any device when it holds owner rights,
 * which only a computer owning machine credentials has. A browser or a phone
 * never does, so Remove on another row is hidden for a device caller.
 */
import { useEffect, useState } from 'react';
import { getDeviceToken } from '@/api/device-token';
import { log } from '@/utils/log';

export interface DeviceCaller {
  /** This browser holds a device token (signed in with a code). */
  isDevice: boolean;
  /** The caller's own device name, once /api/v1/me says it. */
  name: string | null;
  /** A phone or tablet: the row says "This phone", else "This browser". */
  touch: boolean;
}

function matches(query: string): boolean {
  try { return window.matchMedia(query).matches; } catch { return false; }
}

export function isDeviceCaller(): boolean {
  try { return !!getDeviceToken(); } catch { return false; }
}

/** The own device name in a /api/v1/me answer, if it carries one. */
export function deviceNameFromMe(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { device?: { name?: unknown }; deviceName?: unknown };
  const name = typeof b.device?.name === 'string' ? b.device.name : typeof b.deviceName === 'string' ? b.deviceName : '';
  return name.trim() ? name.trim() : null;
}

export function useDeviceCaller(): DeviceCaller {
  const [isDevice] = useState(isDeviceCaller);
  const [touch] = useState(() => matches('(pointer: coarse)'));
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!isDevice) return undefined;
    let live = true;
    // Raw fetch: auth-fetch.ts adds the token to every same-origin /api call.
    fetch('/api/v1/me', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (live) setName(deviceNameFromMe(body)); })
      .catch((err) => log.warn('settings', 'who-am-i read failed', { error: String(err) }));
    return () => { live = false; };
  }, [isDevice]);
  return { isDevice, name, touch };
}

/** iOS Safari in a tab (not a Home Screen app), on a touch screen (spec C51). */
export function isIosSafariTab(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ua = nav.userAgent || '';
  const ios = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const standalone = matches('(display-mode: standalone)') || nav.standalone === true;
  return ios && safari && !standalone && matches('(pointer: coarse)');
}

/** The caller's own row first, the rest in their order. */
export function ownFirst<T extends { name: string }>(rows: T[], own: string | null): T[] {
  if (!own) return rows;
  const mine = rows.filter((r) => r.name === own);
  return mine.length ? [...mine, ...rows.filter((r) => r.name !== own)] : rows;
}
