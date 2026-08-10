/**
 * Unit tests for device-token authentication (src/core/device-auth.ts).
 *
 * auth.json lives in the mocked WALNUT_HOME (unique tmpdir per run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';
import {
  createDevice,
  verifyDeviceToken,
  revokeDevice,
  listDevices,
  isClaimed,
  getSetupTokenIfUnclaimed,
  claimInstance,
  setDeviceInfo,
  _resetDeviceAuthForTesting,
} from '../../src/core/device-auth.js';

const authFile = () => path.join(WALNUT_HOME, 'auth.json');

// The provisioned-token path reads two env vars. Snapshot/restore them around
// EVERY case (not just the provisioning block) so an ambient value on the box
// can't turn the random-token assertions into false failures, and so the
// provisioning cases can't leak into the ones after them.
const SETUP_ENV_VARS = ['WALNUT_SETUP_TOKEN', 'WALNUT_SETUP_TOKEN_FILE'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(SETUP_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of SETUP_ENV_VARS) delete process.env[k];
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();
});

afterEach(async () => {
  for (const k of SETUP_ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

describe('self-reported device info (model/OS backfill)', () => {
  it('stores a report, stamps reportedAt server-side, and surfaces it in listDevices', async () => {
    await createDevice('phone');
    expect(await setDeviceInfo('phone', {
      model: 'iPhone17,1', os: 'iOS 26.1', deviceName: 'iPhone', appVersion: '1.0 (26)',
    })).toBe(true);

    const [device] = (await listDevices()).filter((d) => d.name === 'phone');
    expect(device.info?.model).toBe('iPhone17,1');
    expect(device.info?.os).toBe('iOS 26.1');
    expect(device.info?.appVersion).toBe('1.0 (26)');
    // reportedAt is stamped by the server, never taken from the client.
    expect(Date.parse(device.info!.reportedAt!)).not.toBeNaN();
  });

  it('ignores a client-supplied reportedAt', async () => {
    await createDevice('phone');
    await setDeviceInfo('phone', {
      model: 'iPhone17,1', reportedAt: '1999-01-01T00:00:00.000Z',
    } as Parameters<typeof setDeviceInfo>[1]);
    const [device] = (await listDevices()).filter((d) => d.name === 'phone');
    expect(device.info?.reportedAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('clamps overlong values and drops blank ones', async () => {
    await createDevice('phone');
    await setDeviceInfo('phone', { model: 'x'.repeat(500), os: '   ' });
    const [device] = (await listDevices()).filter((d) => d.name === 'phone');
    expect(device.info!.model!.length).toBeLessThanOrEqual(120);
    expect(device.info?.os).toBeUndefined();
  });

  it('reports for an unknown device are rejected, not silently created', async () => {
    await createDevice('phone');
    expect(await setDeviceInfo('not-a-device', { model: 'iPhone17,1' })).toBe(false);
    expect((await listDevices()).map((d) => d.name)).not.toContain('not-a-device');
  });

  it('a repeat report with identical values does not rewrite auth.json', async () => {
    await createDevice('phone');
    await setDeviceInfo('phone', { model: 'iPhone17,1', os: 'iOS 26.1' });
    const firstStamp = (await listDevices())[0].info!.reportedAt;

    await setDeviceInfo('phone', { model: 'iPhone17,1', os: 'iOS 26.1' });
    // Unchanged payload → early return, so the original stamp survives.
    expect((await listDevices())[0].info!.reportedAt).toBe(firstStamp);
  });

  it('a changed value (app upgrade) does update the record', async () => {
    await createDevice('phone');
    await setDeviceInfo('phone', { model: 'iPhone17,1', appVersion: '1.0 (26)' });
    await setDeviceInfo('phone', { model: 'iPhone17,1', appVersion: '1.1 (30)' });
    expect((await listDevices())[0].info?.appVersion).toBe('1.1 (30)');
  });
});

// ── Reversed pairing: the operator's Walnut generates the code and burns it into
// the new box's cloud-init, so nothing has to read it back out of the journal.
describe('provisioned setup token (pairing code)', () => {
  const PAIRING_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  let tokenDir: string;

  const tokenFile = () => path.join(tokenDir, 'setup-token');

  beforeEach(async () => {
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-setup-token-'));
  });

  afterEach(async () => {
    await fs.rm(tokenDir, { recursive: true, force: true });
  });

  it('adopts WALNUT_SETUP_TOKEN and claims with it', async () => {
    process.env.WALNUT_SETUP_TOKEN = PAIRING_CODE;

    const setup = await getSetupTokenIfUnclaimed();
    expect(setup!.token).toBe(PAIRING_CODE);
    expect(setup!.provisioned).toBe(true);

    const { token } = await claimInstance(PAIRING_CODE, 'provisioned-phone');
    expect(await verifyDeviceToken(token)).toEqual({ name: 'provisioned-phone' });
  });

  it('adopts a token from WALNUT_SETUP_TOKEN_FILE', async () => {
    await fs.writeFile(tokenFile(), PAIRING_CODE, 'utf-8');
    process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();

    const setup = await getSetupTokenIfUnclaimed();
    expect(setup!.token).toBe(PAIRING_CODE);
    expect(setup!.provisioned).toBe(true);
  });

  it('trims whitespace/newline from the token file (cloud-init writes a trailing \\n)', async () => {
    await fs.writeFile(tokenFile(), `  ${PAIRING_CODE}\n`, 'utf-8');
    process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();

    const setup = await getSetupTokenIfUnclaimed();
    expect(setup!.token).toBe(PAIRING_CODE);
    // …and the trimmed value is what actually claims.
    await claimInstance(PAIRING_CODE, 'phone');
    expect(await isClaimed()).toBe(true);
  });

  it('env wins over the file when both are set', async () => {
    await fs.writeFile(tokenFile(), 'f'.repeat(32), 'utf-8');
    process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();
    process.env.WALNUT_SETUP_TOKEN = PAIRING_CODE;

    expect((await getSetupTokenIfUnclaimed())!.token).toBe(PAIRING_CODE);
  });

  it('gives a provisioned token a 24h window, not 15 min', async () => {
    process.env.WALNUT_SETUP_TOKEN = PAIRING_CODE;
    const before = Date.now();
    const setup = await getSetupTokenIfUnclaimed();
    const after = Date.now();
    // expiresAt was computed between the two stamps, so bound it by both.
    expect(setup!.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(setup!.expiresAt).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
  });

  it('claiming with a provisioned token closes the path forever', async () => {
    process.env.WALNUT_SETUP_TOKEN = PAIRING_CODE;
    await getSetupTokenIfUnclaimed();

    const { name } = await claimInstance(PAIRING_CODE, 'first-phone');
    expect(name).toBe('first-phone');
    expect(await isClaimed()).toBe(true);
    // The env var is still set — it must NOT reopen the claim path.
    expect(await getSetupTokenIfUnclaimed()).toBeNull();
    await expect(claimInstance(PAIRING_CODE, 'second-phone')).rejects.toThrow(/already claimed/);
  });

  it('deletes the token file after a successful claim (secret must not linger)', async () => {
    await fs.writeFile(tokenFile(), PAIRING_CODE, 'utf-8');
    process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();
    await getSetupTokenIfUnclaimed();

    await claimInstance(PAIRING_CODE, 'phone');
    await expect(fs.readFile(tokenFile(), 'utf-8')).rejects.toThrow();
  });

  it('a claim that FAILS leaves the token file in place (retryable)', async () => {
    await fs.writeFile(tokenFile(), PAIRING_CODE, 'utf-8');
    process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();
    await getSetupTokenIfUnclaimed();

    await expect(claimInstance('f'.repeat(32), 'phone')).rejects.toThrow(/Invalid or expired/);
    expect((await fs.readFile(tokenFile(), 'utf-8')).trim()).toBe(PAIRING_CODE);
  });

  describe('malformed provisioned tokens fall back to a random one', () => {
    // The operator's pairing code is dead in these cases — the point of the
    // assertion is that the box stays claimable rather than adopting garbage.
    const cases: Array<[string, string]> = [
      ['too short', 'abc123'],
      ['too long', 'a'.repeat(40)],
      ['non-hex', 'z'.repeat(32)],
      ['uppercase hex', 'A1B2C3D4E5F60718293A4B5C6D7E8F90'],
      ['empty', ''],
    ];

    for (const [label, bad] of cases) {
      it(`${label} → random 32-hex token with the 15-min window`, async () => {
        process.env.WALNUT_SETUP_TOKEN = bad;
        const setup = await getSetupTokenIfUnclaimed();
        const after = Date.now();

        expect(setup!.provisioned).toBe(false);
        expect(setup!.token).toMatch(/^[0-9a-f]{32}$/);
        expect(setup!.token).not.toBe(bad);
        // Anchor on a stamp taken AFTER the call: expiresAt was computed at some
        // point in between, so this cannot be off by the elapsed millisecond.
        expect(setup!.expiresAt).toBeLessThanOrEqual(after + 15 * 60 * 1000);
        // The malformed value must not claim anything.
        await expect(claimInstance(bad, 'phone')).rejects.toThrow(/Invalid or expired/);
      });
    }

    it('an unreadable/absent token file → random token', async () => {
      process.env.WALNUT_SETUP_TOKEN_FILE = path.join(tokenDir, 'does-not-exist');
      const setup = await getSetupTokenIfUnclaimed();
      expect(setup!.provisioned).toBe(false);
      expect(setup!.token).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  // An absent file means "not provisioned"; an existing-but-unreadable file means
  // the operator holds a pairing code that will never work. Collapsing the two
  // into a bare `catch { return null }` hid a real EACCES for a whole release
  // (/etc/walnut was root 0700, so the service user could not traverse it).
  describe('unreadable vs absent token file', () => {
    let errors: Array<{ message: string; meta?: Record<string, unknown> }>;
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errors = [];
      spy = vi.spyOn(log.web, 'error').mockImplementation((message, meta) => {
        errors.push({ message, meta });
      });
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it('ENOENT stays silent — that is the normal non-provisioned box', async () => {
      process.env.WALNUT_SETUP_TOKEN_FILE = path.join(tokenDir, 'does-not-exist');
      const setup = await getSetupTokenIfUnclaimed();
      expect(setup!.provisioned).toBe(false);
      expect(errors).toEqual([]);
    });

    it('a path that is a directory (EISDIR) logs an error naming the path and errno', async () => {
      const dirPath = path.join(tokenDir, 'setup-token-dir');
      await fs.mkdir(dirPath);
      process.env.WALNUT_SETUP_TOKEN_FILE = dirPath;

      const setup = await getSetupTokenIfUnclaimed();
      // Still falls back, so the box stays claimable out of band.
      expect(setup!.provisioned).toBe(false);
      expect(setup!.token).toMatch(/^[0-9a-f]{32}$/);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/could not be read/);
      expect(errors[0].message).toMatch(/pairing code will NOT claim/);
      expect(errors[0].meta!.file).toBe(dirPath);
      expect(errors[0].meta!.code).toBe('EISDIR');
    });

    it('a mode-000 file (EACCES) logs an error — the shape the /etc/walnut bug produced', async () => {
      if (process.getuid?.() === 0) return; // root ignores the mode
      await fs.writeFile(tokenFile(), PAIRING_CODE, 'utf-8');
      await fs.chmod(tokenFile(), 0o000);
      process.env.WALNUT_SETUP_TOKEN_FILE = tokenFile();

      const setup = await getSetupTokenIfUnclaimed();
      expect(setup!.provisioned).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0].meta!.code).toBe('EACCES');
      // The error must not echo the secret it failed to read.
      expect(JSON.stringify(errors[0])).not.toContain(PAIRING_CODE);
    });
  });

  it('no env, no file → unchanged legacy behavior (random token, 15-min window)', async () => {
    const before = Date.now();
    const setup = await getSetupTokenIfUnclaimed();
    const after = Date.now();
    expect(setup!.provisioned).toBe(false);
    expect(setup!.token).toMatch(/^[0-9a-f]{32}$/);
    expect(setup!.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(setup!.expiresAt).toBeLessThanOrEqual(after + 15 * 60 * 1000);
  });
});
