/**
 * Unit tests for device-token authentication (src/core/device-auth.ts).
 *
 * auth.json lives in the mocked WALNUT_HOME (unique tmpdir per run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import {
  createDevice,
  verifyDeviceToken,
  revokeDevice,
  listDevices,
  isClaimed,
  getSetupTokenIfUnclaimed,
  claimInstance,
  _resetDeviceAuthForTesting,
} from '../../src/core/device-auth.js';

const authFile = () => path.join(WALNUT_HOME, 'auth.json');

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  _resetDeviceAuthForTesting();
});

describe('createDevice / verifyDeviceToken / revokeDevice round-trip', () => {
  it('creates a device and verifies its token', async () => {
    const { token } = await createDevice('phone');
    expect(token).toMatch(/^[0-9a-f]{32}$/); // 128-bit hex

    const result = await verifyDeviceToken(token);
    expect(result).toEqual({ name: 'phone' });
  });

  it('never stores the plaintext token on disk', async () => {
    const { token } = await createDevice('phone');
    const raw = await fs.readFile(authFile(), 'utf-8');
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a wrong token', async () => {
    await createDevice('phone');
    expect(await verifyDeviceToken('0'.repeat(32))).toBeNull();
    expect(await verifyDeviceToken('')).toBeNull();
    expect(await verifyDeviceToken('not-hex')).toBeNull();
  });

  it('revoked device token no longer verifies', async () => {
    const { token } = await createDevice('phone');
    expect(await revokeDevice('phone')).toBe(true);
    expect(await verifyDeviceToken(token)).toBeNull();
    expect(await revokeDevice('phone')).toBe(false); // already gone
  });

  it('rejects duplicate device names and invalid names', async () => {
    await createDevice('phone');
    await expect(createDevice('phone')).rejects.toThrow(/already exists/);
    await expect(createDevice('../evil')).rejects.toThrow(/Invalid device name/);
    await expect(createDevice('')).rejects.toThrow(/Invalid device name/);
  });

  it('listDevices exposes no token hashes', async () => {
    await createDevice('phone');
    await createDevice('laptop');
    const devices = await listDevices();
    expect(devices).toHaveLength(2);
    for (const d of devices) {
      expect(d.name).toBeTruthy();
      expect(JSON.stringify(d)).not.toContain('tokenHash');
    }
  });

  it('writes auth.json with mode 0600', async () => {
    await createDevice('phone');
    const stat = await fs.stat(authFile());
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('lastUsedAt throttle', () => {
  it('updates lastUsedAt on first verify, then throttles writes within a minute', async () => {
    const { token } = await createDevice('phone');

    await verifyDeviceToken(token);
    const first = JSON.parse(await fs.readFile(authFile(), 'utf-8')).devices[0].lastUsedAt;
    expect(first).toBeTruthy();

    // Second verify inside the throttle window must NOT rewrite the file.
    const mtimeBefore = (await fs.stat(authFile())).mtimeMs;
    await verifyDeviceToken(token);
    const mtimeAfter = (await fs.stat(authFile())).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('claim flow', () => {
  it('zero devices → setup token exists and claim works exactly once', async () => {
    expect(await isClaimed()).toBe(false);
    const setup = await getSetupTokenIfUnclaimed();
    expect(setup).not.toBeNull();
    expect(setup!.token).toMatch(/^[0-9a-f]{32}$/);

    const { name, token } = await claimInstance(setup!.token, 'first-phone');
    expect(name).toBe('first-phone');
    expect(await verifyDeviceToken(token)).toEqual({ name: 'first-phone' });
    expect(await isClaimed()).toBe(true);

    // Second claim must fail — path closed permanently.
    await expect(claimInstance(setup!.token, 'second-phone')).rejects.toThrow(/already claimed/);
  });

  it('rejects a wrong setup token', async () => {
    await getSetupTokenIfUnclaimed();
    await expect(claimInstance('f'.repeat(32), 'phone')).rejects.toThrow(/Invalid or expired/);
    expect(await isClaimed()).toBe(false);
  });

  it('setup token is unavailable once claimed', async () => {
    const setup = await getSetupTokenIfUnclaimed();
    await claimInstance(setup!.token, 'phone');
    expect(await getSetupTokenIfUnclaimed()).toBeNull();
  });

  it('claiming without ever generating a setup token fails', async () => {
    // No getSetupTokenIfUnclaimed() call — module state has no token.
    await expect(claimInstance('a'.repeat(32), 'phone')).rejects.toThrow(/Invalid or expired/);
  });
});

describe('corrupt / missing auth.json', () => {
  it('missing file → zero devices, verify fails cleanly', async () => {
    expect(await isClaimed()).toBe(false);
    expect(await verifyDeviceToken('a'.repeat(32))).toBeNull();
    expect(await listDevices()).toEqual([]);
  });

  it('corrupt file → treated as zero devices, claim flow reopens', async () => {
    await fs.writeFile(authFile(), '{{{not json', 'utf-8');
    expect(await isClaimed()).toBe(false);

    const setup = await getSetupTokenIfUnclaimed();
    const { token } = await claimInstance(setup!.token, 'recovered-phone');
    expect(await verifyDeviceToken(token)).toEqual({ name: 'recovered-phone' });
    expect(await isClaimed()).toBe(true);
  });

  it('valid JSON but wrong shape → zero devices', async () => {
    await fs.writeFile(authFile(), JSON.stringify({ devices: 'nope' }), 'utf-8');
    expect(await isClaimed()).toBe(false);
    expect(await listDevices()).toEqual([]);
  });
});

// ── 2026-07-26 incident: a merge carrying a remote deletion removed auth.json
// on both boxes. "Missing" is indistinguishable from a first boot here, so every
// token silently stopped validating and sync died on a bare 401 for six hours.
describe('auth.json sidecar backup (a lost device registry is recoverable)', () => {
  it('recovers every device from auth.json.bak when the primary is deleted', async () => {
    const { token } = await createDevice('phone');
    await createDevice('laptop');
    // The sidecar is written alongside the primary, not lazily on loss.
    expect(await fs.readFile(`${authFile()}.bak`, 'utf-8')).toContain('laptop');

    // Exactly what the merge did.
    await fs.rm(authFile());
    _resetDeviceAuthForTesting();

    // The token must still validate — this is what broke.
    expect(await verifyDeviceToken(token)).toEqual({ name: 'phone' });
    expect((await listDevices()).map((d) => d.name).sort()).toEqual(['laptop', 'phone']);
    // …and the primary is restored so the next read is a plain hit.
    expect(await fs.readFile(authFile(), 'utf-8')).toContain('phone');
  });

  it('a genuine first boot (no primary, no sidecar) still reports zero devices', async () => {
    // Must NOT mistake a fresh install for a loss — that would block claiming.
    expect(await isClaimed()).toBe(false);
    expect(await listDevices()).toEqual([]);
  });

  it('revocation is not resurrected by the sidecar', async () => {
    const { token } = await createDevice('phone');
    await revokeDevice('phone');
    await fs.rm(authFile());
    _resetDeviceAuthForTesting();

    // The sidecar mirrors the POST-revocation state, so the token stays dead.
    expect(await verifyDeviceToken(token)).toBeNull();
  });
});
