/**
 * The Backup settings pane's rules (web/src/components/settings/sections/backup/backup-model.ts):
 * what is still missing, when two destinations are the same, why backing up
 * cannot happen yet, what a save writes, and the words after a connection test.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_INTERVAL_HOURS, blockedReason, buildBackupConfig, missingFields, sameDestination, testHelp,
} from '../../web/src/components/settings/sections/backup/backup-model';

const r2 = { type: 'r2' as const, bucket: 'b', account_id: 'a', access_key_id: 'k', secret_access_key: 's' };

describe('missingFields', () => {
  it('names each empty field of a bucket destination', () => {
    expect(missingFields({ type: 'r2' })).toEqual(['bucket', 'account ID', 'access key ID', 'secret access key']);
    expect(missingFields(r2)).toEqual([]);
    expect(missingFields({ type: 'r2', bucket: 'b', endpoint: 'http://x', access_key_id: 'k', secret_access_key: 's' })).toEqual([]);
    expect(missingFields({ type: 's3', bucket: 'b', auth: { method: 'access_keys', aws_access_key_id: 'k' } })).toEqual(['access keys']);
    expect(missingFields({ type: 's3', bucket: 'b', auth: { method: 'profile' } })).toEqual(['profile']);
    expect(missingFields({ type: 's3', bucket: 'b', endpoint: 'http://x', auth: { method: 'access_keys', aws_access_key_id: 'k', aws_secret_access_key: 's' } })).toEqual([]);
    expect(missingFields({ type: 'gdrive' })).toEqual([]);
  });
});

describe('sameDestination', () => {
  it('ignores blanks and key order, not a changed field', () => {
    expect(sameDestination({ ...r2, prefix: '' }, { secret_access_key: 's', access_key_id: 'k', account_id: 'a', bucket: 'b', type: 'r2' })).toBe(true);
    expect(sameDestination({ ...r2, bucket: ' b ' }, r2)).toBe(true);
    expect(sameDestination({ ...r2, bucket: 'other' }, r2)).toBe(false);
    expect(sameDestination({ type: 'gdrive' }, r2)).toBe(false);
  });
});

describe('blockedReason', () => {
  const base = { legacyMode: false, driveConnected: false, needsKey: false, hasKey: true };
  it('says the first thing to fix, in order', () => {
    expect(blockedReason({ ...base })).toMatch(/Where backups go/);
    expect(blockedReason({ ...base, saved: { type: 'r2', bucket: 'b' } })).toMatch(/Fill in account ID/);
    expect(blockedReason({ ...base, saved: { type: 'gdrive' } })).toMatch(/Connect Google Drive/);
    expect(blockedReason({ ...base, saved: r2, needsKey: true })).toMatch(/recovery key/);
    expect(blockedReason({ ...base, saved: r2, hasKey: false })).toMatch(/Waiting for the recovery key/);
    expect(blockedReason({ ...base, saved: r2 })).toBeNull();
    expect(blockedReason({ ...base, saved: { type: 'gdrive' }, driveConnected: true })).toBeNull();
    expect(blockedReason({ ...base, legacyMode: true })).toMatch(/bucket/);
    expect(blockedReason({ ...base, legacyMode: true, legacyBucket: 'old' })).toBeNull();
  });
});

describe('buildBackupConfig', () => {
  it('keeps the interval between 1 hour and a week', () => {
    const at = (h: number | undefined) => buildBackupConfig({}, { enabled: true, intervalHours: h, destination: r2 }).interval_hours;
    expect(at(0)).toBe(24);
    expect(at(-5)).toBe(1);
    expect(at(0.4)).toBe(1);
    expect(at(9999)).toBe(MAX_INTERVAL_HOURS);
    expect(at(undefined)).toBe(24);
  });
  it('never writes the legacy bucket beside a destination', () => {
    const c = buildBackupConfig({ bucket: 'old', recovery_key_saved_at: 't' }, { enabled: true, intervalHours: 6, destination: r2 });
    expect(c.bucket).toBeUndefined();
    expect(c.recovery_key_saved_at).toBe('t');
  });
});

describe('testHelp', () => {
  it('says what was found and whether it was saved', () => {
    expect(testHelp({ ok: true, hasBackups: false, savedNow: true }, false)).toBe('Connected. Walnut can write here; no backups yet. Saved: backups go here now.');
    expect(testHelp({ ok: true, hasBackups: true, keyMatches: false }, false)).toMatch(/another recovery key/);
    expect(testHelp({ ok: true, hasBackups: true, keyMatches: true, thisWriter: false, writer: 'Old-Mac' }, false)).toMatch(/computer "Old-Mac"/);
    expect(testHelp({ ok: false, error: 'No bucket named "x".' }, false)).toBe('Couldn\'t connect. No bucket named "x".');
  });
});
