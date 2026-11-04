/**
 * Store errors in words the user can act on, per cause, for R2 and S3.
 */
import { describe, it, expect } from 'vitest';
import { friendlyStoreError } from '../../../src/core/backup/errors.js';
import { selectKept } from '../../../src/core/backup/repo/prune.js';

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
