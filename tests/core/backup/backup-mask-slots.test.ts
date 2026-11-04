/**
 * Switching backup services moves a destination between `backup.destination` and
 * `backup.other_destinations`; a client that read masked secrets sends them back in
 * the new slot. storedBackupLike (src/core/backup/destination.ts) lays the stored
 * section out like the write, so restoreMaskedSecrets pairs each mask with the
 * same service's stored value, and never with another service's.
 */
import { describe, it, expect } from 'vitest';
import { storedBackupLike } from '../../../src/core/backup/destination.js';
import { MaskedValueError, maskSecretShapes, restoreMaskedSecrets } from '../../../src/core/config-secret-shape.js';
import type { BackupConfig } from '../../../src/core/backup/types.js';
import { maskForMacClients } from '../../../src/core/config-redact.js';

const r2 = { type: 'r2' as const, bucket: 'mine', account_id: 'acct', access_key_id: 'AKR2', secret_access_key: 'r2-secret-access-key-value-7777QQQQ' };
const drive = { type: 'gdrive' as const, client_id: 'c.apps.googleusercontent.com', client_secret: 'drive-client-secret-value-8888RRRR' };

const roundTrip = (sent: BackupConfig, stored: BackupConfig) =>
  restoreMaskedSecrets({ backup: sent }, { backup: storedBackupLike(sent, stored) }).backup;

describe('storedBackupLike', () => {
  it('a masked R2 secret follows R2 into other_destinations and back', () => {
    const stored: BackupConfig = { enabled: true, destination: r2 };
    const read = maskSecretShapes(stored);
    expect(JSON.stringify(read)).not.toContain('7777QQQQ-');
    expect(read.destination!.secret_access_key).not.toBe(r2.secret_access_key);

    const toDrive = roundTrip({ enabled: true, destination: { type: 'gdrive' }, other_destinations: [read.destination!] }, stored);
    expect(toDrive.other_destinations).toEqual([r2]);

    const stored2: BackupConfig = { enabled: true, destination: drive, other_destinations: [r2] };
    const read2 = maskSecretShapes(stored2);
    const back = roundTrip({ enabled: true, destination: read2.other_destinations![0], other_destinations: [read2.destination!] }, stored2);
    expect(back.destination).toEqual(r2);
    expect(back.other_destinations).toEqual([drive]);
  });

  it('a mask in another service slot is refused, never filled from a different service', () => {
    const stored: BackupConfig = { enabled: true, destination: r2 };
    const read = maskSecretShapes(stored);
    expect(() => roundTrip({ enabled: true, destination: { ...read.destination!, type: 's3' } }, stored)).toThrow(MaskedValueError);
  });

  it('a write with no backup section, or nothing stored, changes nothing', () => {
    expect(storedBackupLike(undefined, { destination: r2 })).toEqual({ destination: r2 });
    expect(storedBackupLike({ destination: r2 }, undefined)).toBeUndefined();
  });

  it('the Mac clients view masks the backup keys (never the key ids) and a save round-trips them', () => {
    const s3 = { type: 's3' as const, bucket: 'b', region: 'us-west-2', auth: { method: 'access_keys' as const, aws_access_key_id: 'AKS3', aws_secret_access_key: 's3-secret-value-9999ZZZZ' } };
    const stored: BackupConfig = { enabled: true, destination: r2, other_destinations: [drive, s3] };
    const view = (maskForMacClients({ backup: stored }) as { backup: BackupConfig }).backup;
    const text = JSON.stringify(view);
    for (const secret of [r2.secret_access_key, drive.client_secret, s3.auth.aws_secret_access_key]) expect(text).not.toContain(secret);
    expect(view.destination!.access_key_id).toBe('AKR2');
    expect(view.other_destinations![1].auth!.aws_access_key_id).toBe('AKS3');
    // Sent back as read: every key is the stored one again.
    expect(roundTrip(view, stored)).toEqual(stored);
  });
});

