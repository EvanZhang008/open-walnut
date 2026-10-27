/**
 * Two small parsers for `config.triage`: an interval ("30m", "1h", "2h30m")
 * and an active-hours window ("08:00-22:00", overnight "22:00-06:00").
 *
 * They came from the heartbeat runner, which was removed; triage still spells
 * its interval and window the same way.
 */

import { log } from '../../logging/index.js';

/** Parse a duration string like "30m", "1h", "2h30m" into milliseconds. */
export function parseDuration(s: string): number {
  if (!s || s === '0' || s === '0m' || s === '0s') return 0;

  let totalMs = 0;
  const hourMatch = s.match(/(\d+)\s*h/i);
  const minMatch = s.match(/(\d+)\s*m/i);
  const secMatch = s.match(/(\d+)\s*s/i);

  if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3_600_000;
  if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60_000;
  if (secMatch) totalMs += parseInt(secMatch[1], 10) * 1_000;

  // If none matched, try as plain number (assume minutes)
  if (!hourMatch && !minMatch && !secMatch) {
    const n = parseInt(s, 10);
    if (!isNaN(n)) totalMs = n * 60_000;
  }

  return totalMs;
}

/**
 * Check whether the current time is within the active hours window.
 * Format: "HH:MM-HH:MM" (24-hour local time).
 * Returns true if no activeHours is configured (always active).
 */
export function isWithinActiveHours(activeHours?: string): boolean {
  if (!activeHours) return true;

  const match = activeHours.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    log.cron.warn('invalid activeHours format, ignoring', { activeHours });
    return true;
  }

  const [, startH, startM, endH, endM] = match;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseInt(startH, 10) * 60 + parseInt(startM, 10);
  const endMinutes = parseInt(endH, 10) * 60 + parseInt(endM, 10);

  if (startMinutes <= endMinutes) {
    // Normal range: e.g. 08:00-22:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range: e.g. 22:00-06:00
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
