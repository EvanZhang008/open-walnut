/**
 * The Backup settings pane's rules (web/src/components/settings/sections/backup/backup-model.ts):
 * what is still missing, when two destinations are the same, why backing up
 * cannot happen yet, what a save writes, and the words after a connection test.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_INTERVAL_HOURS, blockedReason, buildBackupConfig, cleanDestination, destinationSummary, fieldProblem, missingFields, othersAfterSwitch,
  sameDestination, secretNeedsRetyping, testHelp,
} from '../../web/src/components/settings/sections/backup/backup-model';
import { swapCommands } from '../../web/src/components/settings/sections/backup/RestorePanel';

const r2 = { type: 'r2' as const, bucket: 'b', account_id: 'a', access_key_id: 'k', secret_access_key: 's' };

describe('missingFields', () => {
  it('names each empty field of a bucket destination', () => {
    expect(missingFields({ type: 'r2' })).toEqual(['account ID (or a custom endpoint under Advanced)', 'bucket', 'access key ID', 'secret access key']);
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
    expect(blockedReason({ ...base, saved: r2, keySaved: false })).toBe('Save the recovery key above first.');
    expect(blockedReason({ ...base, saved: r2, keySaved: true })).toBeNull();
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
    expect(testHelp({ ok: true, hasBackups: false, savedNow: true }, false)).toBe('Connected and saved: backups go here now.');
    expect(testHelp({ ok: true, hasBackups: false }, false)).toBe('Connected. Walnut can write here; no backups yet.');
    expect(testHelp({ ok: true, hasBackups: true, keyMatches: true, thisWriter: true, savedNow: true }, false))
      .toBe("Connected and saved: backups go here now. It holds this computer's Walnut backups.");
    expect(testHelp({ ok: true, hasBackups: true, keyMatches: false }, false)).toMatch(/another recovery key/);
    expect(testHelp({ ok: true, hasBackups: true, keyMatches: true, thisWriter: false, writer: 'Old-Mac' }, false)).toMatch(/computer "Old-Mac"/);
    expect(testHelp({ ok: false, error: 'No bucket named "x".' }, false)).toBe('Couldn\'t connect. No bucket named "x".');
  });
});

describe('other destinations', () => {
  const drive = { type: 'gdrive' as const, folder_name: 'Walnut Backup' };
  it('switching keeps the service left behind, one per type, never the one now in use', () => {
    expect(othersAfterSwitch({ destination: r2 }, drive)).toEqual([r2]);
    expect(othersAfterSwitch({ destination: drive, other_destinations: [r2] }, r2)).toEqual([drive]);
    expect(othersAfterSwitch({ destination: r2, other_destinations: [{ ...r2, bucket: 'old' }] }, drive)).toEqual([r2]);
    expect(othersAfterSwitch({ destination: r2, other_destinations: [drive] }, { ...r2, bucket: 'b2' })).toEqual([drive]);
    expect(othersAfterSwitch({}, r2)).toEqual([]);
  });
  it('a save keeps them', () => {
    const cfg = buildBackupConfig({ other_destinations: [drive] }, { enabled: true, intervalHours: 24, destination: r2 });
    expect(cfg.other_destinations).toEqual([drive]);
  });
});

describe('swapCommands', () => {
  it('keeps the current data aside and moves the restored folder in, each step only after the last one worked', () => {
    expect(swapCommands('/Users/me/.open-walnut', '/Users/me/open-walnut-restored-2026-11-04T08-00-00', '2026-11-04T08:00:00.000Z'))
      .toBe('[ ! -e /Users/me/.open-walnut-before-restore-2026-11-04T08-00-00 ] && mv /Users/me/.open-walnut /Users/me/.open-walnut-before-restore-2026-11-04T08-00-00 && mv /Users/me/open-walnut-restored-2026-11-04T08-00-00 /Users/me/.open-walnut');
  });
  it('two restores on one day keep apart', () => {
    expect(swapCommands('/h/.w', '/h/r', '2026-11-04T08:00:00Z')).not.toBe(swapCommands('/h/.w', '/h/r', '2026-11-04T15:30:00Z'));
  });
  it('quotes paths a shell would split, and keeps ~ expandable', () => {
    expect(swapCommands('~/.open-walnut/', "/tmp/my restore's", '2026-11-04T08:00:00Z'))
      .toBe("[ ! -e ~/.open-walnut-before-restore-2026-11-04T08-00-00 ] && mv ~/.open-walnut ~/.open-walnut-before-restore-2026-11-04T08-00-00 && mv '/tmp/my restore'\\''s' ~/.open-walnut");
  });
});

describe('fieldProblem', () => {
  it('asks for the scheme of an endpoint and a 32-character account ID, before any test', () => {
    expect(fieldProblem({ type: 'r2', endpoint: 'storage.example.com' })).toBe('Start the endpoint with https://');
    expect(fieldProblem({ type: 's3', endpoint: 'https://' })).toMatch(/not a web address/);
    expect(fieldProblem({ type: 's3', endpoint: 'http://127.0.0.1:9000' })).toBeNull();
    expect(fieldProblem({ type: 'r2', account_id: 'abc' })).toMatch(/32 letters and digits/);
    expect(fieldProblem({ type: 'r2', account_id: '0123456789abcdef0123456789ABCDEF' })).toBeNull();
    // With an endpoint the account ID is not used, so its shape does not matter.
    expect(fieldProblem({ type: 'r2', account_id: 'abc', endpoint: 'https://x.example' })).toBeNull();
    expect(fieldProblem({ type: 'gdrive' })).toBeNull();
  });
});

describe('secretNeedsRetyping', () => {
  const mask = '\u2022\u2022\u2022\u2022NEVG';
  const saved = { ...r2, secret_access_key: mask };
  it('a masked key on the place it was saved for is fine; pointed elsewhere it must be typed again', () => {
    expect(secretNeedsRetyping(saved, [saved])).toBe(false);
    expect(secretNeedsRetyping({ ...saved, prefix: 'other-folder' }, [saved])).toBe(false);
    expect(secretNeedsRetyping({ ...saved, bucket: 'other' }, [saved])).toBe(true);
    expect(secretNeedsRetyping({ ...saved, bucket: 'other', secret_access_key: 'typed' }, [saved])).toBe(false);
    // A service kept for later owns its own masked key.
    const kept = { type: 's3' as const, bucket: 'k', endpoint: 'https://m', access_key_id: 'a', secret_access_key: mask };
    expect(secretNeedsRetyping(kept, [saved, kept])).toBe(false);
    expect(secretNeedsRetyping({ ...kept, endpoint: 'https://n' }, [saved, kept])).toBe(true);
  });
});

describe('destinationSummary', () => {
  it('says whether the saved bucket is the one in use', () => {
    expect(destinationSummary({ ...r2, account_id: '0123456789abcdef0123456789abcdef' })).toMatch(/account \.\.\.cdef, key ID k\. Tested and in use\.$/);
    expect(destinationSummary(r2, false)).toMatch(/Tested before\.$/);
  });
});

describe('S3 with an endpoint keeps its keys', () => {
  it('keys typed as AWS keys before the endpoint are saved as the endpoint keys', () => {
    const form = {
      type: 's3' as const, bucket: 'b', endpoint: 'https://minio.example',
      auth: { method: 'access_keys' as const, aws_access_key_id: 'AK', aws_secret_access_key: 'SK' },
    };
    const saved = cleanDestination(form);
    expect(saved).toEqual({ type: 's3', bucket: 'b', endpoint: 'https://minio.example', access_key_id: 'AK', secret_access_key: 'SK' });
    expect(missingFields(saved)).toEqual([]);
    // The endpoint's own pair wins when both are there.
    expect(cleanDestination({ ...form, access_key_id: 'EK', secret_access_key: 'ES' })).toMatchObject({ access_key_id: 'EK', secret_access_key: 'ES' });
  });
  it('a hidden AWS key left masked never asks for the endpoint secret again', () => {
    const mask = '\u2022\u2022\u2022\u2022abcd';
    const saved = { type: 's3' as const, bucket: 'b', endpoint: 'https://minio.example', access_key_id: 'AK', secret_access_key: mask };
    const form = { ...saved, secret_access_key: 'typed-new', auth: { method: 'access_keys' as const, aws_secret_access_key: mask } };
    expect(secretNeedsRetyping({ ...form, bucket: 'other' }, [saved])).toBe(false);
  });
});
