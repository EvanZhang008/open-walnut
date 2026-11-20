/**
 * How a pushed toast reads on its NoticeCard (web/src/contexts/notifications/notice-face.ts), how
 * long it stays, and which ones stay in sight when the stack is full (2026-11-20: an error is never
 * folded away or gone before it is read; a click on a notice opens what it is about).
 */
import { describe, expect, it } from 'vitest';
import { KIND_SOURCE, keepInSight, noticeSource, noticeStatus } from '../../web/src/contexts/notifications/notice-face';
import { linkTargetOf } from '../../web/src/contexts/notifications/notification-model';
import { ERROR_TOAST_MIN_MS, TOAST_DURATION_MS, toastLifetimeMs, type NotificationKind } from '../../web/src/contexts/notifications/types';

describe('a toast\'s face', () => {
  it('every kind has who it is from, and a session or task names it first', () => {
    for (const kind of Object.keys(TOAST_DURATION_MS) as NotificationKind[]) {
      expect(KIND_SOURCE[kind], kind).toBeTruthy();
      expect(noticeSource({ kind })).toBe(KIND_SOURCE[kind]);
    }
    expect(noticeSource({ kind: 'permission', sessionTitle: 'Fix the login' })).toBe('Fix the login');
    expect(noticeSource({ kind: 'operation-error', category: 'Data & Sync' })).toBe('Data & Sync');
    expect(noticeSource({ kind: 'host', host: 'clouddev' })).toBe('clouddev');
  });

  it('its status is a tone and a word: an ask waits on you, an answered one says how it went', () => {
    expect(noticeStatus({ kind: 'permission', severity: 'warning' })).toEqual({ tone: 'ask', text: 'Needs you' });
    expect(noticeStatus({ kind: 'permission', severity: 'warning', resolved: 'allowed' })).toEqual({ tone: 'ok', text: 'Allowed' });
    expect(noticeStatus({ kind: 'permission', severity: 'warning', resolved: 'denied' }).text).toBe('Denied');
    expect(noticeStatus({ kind: 'operation-error', severity: 'error' })).toEqual({ tone: 'error', text: 'Error' });
    expect(noticeStatus({ kind: 'operation-error', severity: 'error', resolved: 'recovered' })).toEqual({ tone: 'ok', text: 'Recovered' });
    // Plain news has a dot of no colour and no word.
    expect(noticeStatus({ kind: 'reminder', severity: 'info' })).toEqual({ tone: 'muted' });
  });

  it('a click on any notice goes where linkTargetOf says: the session first, then the task', () => {
    const n = (extra: object) => ({ id: 'x', kind: 'permission', severity: 'warning', title: 't', timestamp: 0, read: false, ...extra }) as Parameters<typeof linkTargetOf>[0];
    expect(linkTargetOf(n({ taskId: 't-1', sessionId: 's-1' }))).toBe('/sessions?id=s-1');
    expect(linkTargetOf(n({ taskId: 't-1' }))).toMatch(/t-1/);
    expect(linkTargetOf(n({}))).toBeNull();
  });
});

describe('an error is never folded away or gone too soon', () => {
  it('stays at least ERROR_TOAST_MIN_MS whatever its kind says', () => {
    expect(TOAST_DURATION_MS['operation-error']).toBeLessThan(ERROR_TOAST_MIN_MS);
    expect(toastLifetimeMs({ kind: 'operation-error', severity: 'error' })).toBe(ERROR_TOAST_MIN_MS);
    expect(toastLifetimeMs({ kind: 'hook', severity: 'error', durationMs: 2_000 })).toBe(ERROR_TOAST_MIN_MS);
    expect(toastLifetimeMs({ kind: 'reminder', severity: 'info' })).toBe(TOAST_DURATION_MS.reminder);
    expect(toastLifetimeMs({ kind: 'sort', severity: 'info' })).toBe(TOAST_DURATION_MS.sort);
  });

  it('keeps the errors in sight first, then the newest of the rest', () => {
    const err = { id: 'err', severity: 'error' };
    const a = { id: 'a', severity: 'info' };
    const b = { id: 'b', severity: 'info' };
    expect([...keepInSight([err, a, b], 2)].map((t) => t.id).sort()).toEqual(['b', 'err']);
    expect([...keepInSight([a, b], 1)].map((t) => t.id)).toEqual(['b']);
    expect([...keepInSight([err, a], 1)].map((t) => t.id)).toEqual(['err']);
    expect(keepInSight([err, a], 0).size).toBe(0);
  });
});
