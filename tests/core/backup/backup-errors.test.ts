/**
 * Store errors in words the user can act on, per cause, for R2 and S3.
 */
import { describe, it, expect } from 'vitest';
import { friendlyStoreError } from '../../../src/core/backup/errors.js';
import { DEFAULT_RETENTION, selectKept } from '../../../src/core/backup/repo/prune.js';

const r2 = { type: 'r2' as const, bucket: 'walnut-backup', account_id: 'abc' };
const named = (name: string, status?: number): Error => Object.assign(new Error(`raw ${name}`), { name, $metadata: { httpStatusCode: status } });

describe('friendlyStoreError', () => {
  it('names what to check for each common cause', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' });
    expect(friendlyStoreError(refused, { ...r2, endpoint: 'http://127.0.0.1:9999' })).toMatch(/Can't reach the custom endpoint http:\/\/127\.0\.0\.1:9999.*\(ECONNREFUSED\)/);
    expect(friendlyStoreError(new TypeError('fetch failed', { cause: refused }), r2)).toMatch(/Can't reach Cloudflare with this Account ID/);
    expect(friendlyStoreError(named('NoSuchBucket', 404), r2)).toMatch(/No bucket named "walnut-backup" in this Cloudflare account.*Create bucket/);
    expect(friendlyStoreError(named('SignatureDoesNotMatch', 403), r2)).toMatch(/Cloudflare refused these keys/);
    expect(friendlyStoreError(named('InvalidAccessKeyId', 403), { ...r2, type: 's3' })).toMatch(/AWS refused these credentials/);
    expect(friendlyStoreError(named('AccessDenied', 403), r2)).toMatch(/Object Read & Write/);
  });

  it('keeps any other message as it is', () => {
    expect(friendlyStoreError(new Error('something odd'), r2)).toBe('something odd');
  });
});

describe('retention keeps the newest few of today', () => {
  it('three backups made today all stay with recent: 3', () => {
    const today = new Date();
    const snaps = [9, 11, 13, 15].map((h) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h);
      return { id: `s${h}`, createdAt: d.toISOString() };
    });
    expect([...selectKept(snaps, { daily: 7, weekly: 4, recent: 3 })].sort()).toEqual(['s11', 's13', 's15']);
    expect([...selectKept(snaps, { daily: 7, weekly: 4 })]).toEqual(['s15']);
  });
});

describe('retention keeps every backup of the last day', () => {
  it('"Back up now" pressed five times never pushes out the morning backup', () => {
    const now = Date.parse('2026-11-04T09:30:00Z');
    const at = (iso: string, id: string) => ({ id, createdAt: iso });
    const snaps = [
      at('2026-11-04T09:17:00Z', 'morning'), at('2026-11-04T09:21:00Z', 'later'),
      ...[1, 2, 3, 4, 5].map((n) => at(`2026-11-04T09:23:0${n}Z`, `click${n}`)),
      at('2026-11-03T05:00:00Z', 'day-before'), at('2026-11-02T05:00:00Z', 'two-days'),
    ];
    const kept = selectKept(snaps, DEFAULT_RETENTION, now);
    for (const id of ['morning', 'later', 'click1', 'click5', 'day-before', 'two-days']) expect(kept.has(id), id).toBe(true);
    // A day later the clicks of that day fold into one, the day's newest.
    const nextDay = selectKept(snaps, DEFAULT_RETENTION, now + 36 * 3_600_000);
    expect(nextDay.has('click5')).toBe(true);
    expect(nextDay.has('morning')).toBe(false);
  });

  it('keeps at most 48 for being recent', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const snaps = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, createdAt: new Date(now - i * 60_000).toISOString() }));
    expect(selectKept(snaps, DEFAULT_RETENTION, now).size).toBe(48);
  });
});

