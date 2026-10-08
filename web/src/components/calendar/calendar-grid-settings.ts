import { useSyncExternalStore } from 'react';
import { SLOT_MINUTES } from '@/utils/calendar-date';

export const GRID_SETTINGS_KEY = 'open-walnut-calendar-grid-settings';
export const GRID_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export interface CalendarGridSettings { zoom: number; fullDay: boolean }
const DEFAULT: CalendarGridSettings = { zoom: 1, fullDay: false };
let current: CalendarGridSettings | null = null;
const listeners = new Set<() => void>();

function read(): CalendarGridSettings {
  try {
    const value = JSON.parse(localStorage.getItem(GRID_SETTINGS_KEY) ?? 'null');
    if (value && GRID_ZOOM_LEVELS.includes(value.zoom) && typeof value.fullDay === 'boolean') return value;
  } catch { /* Keep the default when storage is unavailable. */ }
  return DEFAULT;
}

function getSettings(): CalendarGridSettings {
  return current ??= read();
}

function notify(): void {
  for (const fn of listeners) fn();
}

function onStorage(e: StorageEvent): void {
  if (e.key !== GRID_SETTINGS_KEY && e.key !== null) return;
  current = read();
  notify();
}

function subscribe(fn: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

export function setCalendarGridSettings(patch: Partial<CalendarGridSettings>): void {
  current = { ...getSettings(), ...patch };
  try { localStorage.setItem(GRID_SETTINGS_KEY, JSON.stringify(current)); } catch { /* Keep the view usable. */ }
  notify();
}

export function useCalendarGridSettings(): CalendarGridSettings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

export function gridY(minute: number, startMinute: number, slotPx: number): number {
  return (minute - startMinute) / SLOT_MINUTES * slotPx;
}

export function gridMinute(y: number, startMinute: number, slotPx: number): number {
  return startMinute + y / slotPx * SLOT_MINUTES;
}

export function gridLocalIso(day: string, minute: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + Math.floor(minute / 1440));
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const withinDay = minute % 1440;
  return `${datePart}T${pad(Math.floor(withinDay / 60))}:${pad(withinDay % 60)}:00`;
}
