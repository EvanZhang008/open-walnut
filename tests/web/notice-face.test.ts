/**
 * How a pushed toast reads on its NoticeCard (web/src/contexts/notifications/notice-face.ts), how
 * long it stays, and which ones stay in sight when the stack is full (2026-11-20: an error is never
 * folded away or gone before it is read; a click on a notice opens what it is about).
 */
import { describe, expect, it } from 'vitest';
import { KIND_SOURCE, avatarName, feedRowSource, feedRowStatus, keepInSight, noticeSource, noticeStatus } from '../../web/src/contexts/notifications/notice-face';
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

// The notification center's rows are the same card (NotificationFeedCards.tsx): 2026-11-21 audit.
describe('a row in the notification center', () => {
  it('unread is the status dot and a word, never a tint: "New", or "New error" / "New warning"', () => {
    expect(feedRowStatus({ kind: 'letter', severity: 'info', read: false })).toEqual({ tone: 'ask', text: 'New' });
    expect(feedRowStatus({ kind: 'letter', severity: 'info', read: true })).toEqual({ tone: 'muted' });
    expect(feedRowStatus({ kind: 'operation-error', severity: 'error', read: false })).toEqual({ tone: 'error', text: 'New error' });
    expect(feedRowStatus({ kind: 'operation-error', severity: 'error', read: true })).toEqual({ tone: 'error', text: 'Error' });
    expect(feedRowStatus({ kind: 'cron', severity: 'warning', read: false })).toEqual({ tone: 'warn', text: 'New warning' });
    expect(feedRowStatus({ kind: 'reminder', severity: 'success', read: false })).toEqual({ tone: 'ok', text: 'New' });
    // Settled states say how they settled, read or not; an ask keeps its own words.
    expect(feedRowStatus({ kind: 'operation-error', severity: 'info', resolved: 'recovered', read: false })).toEqual({ tone: 'ok', text: 'Recovered' });
    expect(feedRowStatus({ kind: 'operation-error', severity: 'error', resolved: 'expired', read: true })).toEqual({ tone: 'muted', text: 'Stale' });
    expect(feedRowStatus({ kind: 'permission', severity: 'warning', read: false })).toEqual({ tone: 'ask', text: 'Needs you' });
  });

  it('its last line says who sent it, once; the full session id and a fork\'s name are only its title', () => {
    // Another computer is part of the decision (an ask to delete a folder on a dev box is not one
    // on this Mac), and a phone has no hover: its host stays on the line (2026-11-22 review).
    expect(feedRowSource({ sessionTitle: 'Fix the login', project: 'Walnut', host: 'clouddev', sessionId: 'abc12345-0000' }))
      .toEqual({ text: 'Fix the login \u00b7 Walnut \u00b7 on clouddev', detail: 'Session id: abc12345-0000\nHost: clouddev' });
    expect(feedRowSource({ sessionTitle: 'Fix the login', host: 'devbox' }, 'Dev box').text).toBe('Fix the login \u00b7 on Dev box');
    // This computer is no news, by its alias, whatever its display name.
    for (const host of ['local', '__local__', 'localhost']) {
      expect(feedRowSource({ sessionTitle: 'Fix the login', host }, 'Local').text, host).toBe('Fix the login');
    }
    // A session nobody titled reads by its short id, as the toast names it.
    expect(feedRowSource({ sessionId: 'abc12345-6789-0000' }).text).toBe('Session abc12345\u2026');
    const fork = feedRowSource({ sessionTitle: 'Fork of Session: walnut \u2014 Claude finished the response', host: 'local', sessionId: 'cffc7f02-1111' });
    // A fork reads by its own name, as its avatar does, never by the machine prefix (2026-11-22 review).
    expect(fork.text).toBe('walnut \u2014 Claude finished the response');
    expect(fork.detail).toContain('Session: Fork of Session');
    expect(fork.detail).toContain('Host: This Mac');
    expect(feedRowSource({ sessionTitle: 'cffc7f02-aaaa-bbbb' }).text).toBeNull();
    expect(feedRowSource({ project: 'Walnut' })).toEqual({ text: 'Walnut', detail: null });
    expect(feedRowSource({ sessionTitle: 'Walnut', project: 'Walnut' }).text).toBe('Walnut');
    expect(feedRowSource({})).toEqual({ text: null, detail: null });
  });

  it('its avatar\'s letters come from the name a person gave it, never a fork\'s prefix or an id', () => {
    expect(avatarName('Fork of Session: garden \u2014 the chart draft')).toBe('garden \u2014 the chart draft');
    expect(avatarName('Fork of Session: Fork of Session: garden')).toBe('garden');
    expect(avatarName('Fix the login')).toBe('Fix the login');
    expect(avatarName('cffc7f02-1111-2222')).toBe('');
    expect(avatarName('cffc7f02\u2026')).toBe('');
    expect(avatarName('Fork of Session: cffc7f02')).toBe('');
    expect(avatarName(undefined)).toBe('');
  });
});
