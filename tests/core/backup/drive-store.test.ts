import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DriveStore, driveAbout, driveEndpoints, findOrCreateFolder, type DriveEndpoints } from '../../../src/core/backup/stores/drive-store.js';
import { isNotFound } from '../../../src/core/backup/stores/types.js';
import { startFakeGoogleDrive, type FakeGoogleDrive } from '../../helpers/fake-google-drive.js';

let fake: FakeGoogleDrive;
let endpoints: DriveEndpoints;
let token: string;
let tokenCalls: boolean[];
let sleeps: number[];

const getAccessToken = async (force?: boolean) => {
  tokenCalls.push(Boolean(force));
  if (force) token = fake.mintAccessToken();
  return token;
};

const retry = { sleep: async (ms: number) => { sleeps.push(ms); } };

async function setup(opts: Parameters<typeof startFakeGoogleDrive>[0] = {}) {
  fake = await startFakeGoogleDrive(opts);
  endpoints = { api: fake.env.WALNUT_GDRIVE_API_URL, upload: fake.env.WALNUT_GDRIVE_UPLOAD_URL };
  token = fake.mintAccessToken();
}

async function makeStore(): Promise<DriveStore> {
  const folder = await findOrCreateFolder('Walnut Backup', getAccessToken, endpoints, undefined, retry);
  return new DriveStore({ folderId: folder.id, folderName: 'Walnut Backup', getAccessToken, endpoints, retry });
}

beforeEach(() => {
  tokenCalls = [];
  sleeps = [];
});

afterEach(async () => {
  await fake?.close();
});

describe('DriveStore', () => {
  it('round-trips put/get/list/delete, small and large bodies', async () => {
    await setup();
    const store = await makeStore();
    expect(store.kind).toBe('gdrive');
    expect(store.describe()).toBe('Google Drive: Walnut Backup');

    const small = Buffer.from('{"version":2}');
    const big = randomBytes(6 * 1024 * 1024);
    const packKey = `packs/ab/${'ab'.padEnd(64, 'c')}`;
    await store.put('walnut-backup.json', small);
    await store.put(packKey, big);

    expect(fake.requests.some((r) => r.startsWith('POST /upload/drive/v3/files?uploadType=multipart'))).toBe(true);
    expect(fake.requests.some((r) => r.startsWith('POST /upload/drive/v3/files?uploadType=resumable'))).toBe(true);
    expect(fake.requests.some((r) => r.startsWith('PUT /upload/drive/v3/files?uploadType=resumable&upload_id='))).toBe(true);

    expect((await store.get('walnut-backup.json')).equals(small)).toBe(true);
    expect((await store.get(packKey)).equals(big)).toBe(true);
    // A fresh store (another process) finds the files by name.
    const other = await makeStore();
    expect((await other.get(packKey)).equals(big)).toBe(true);

    const listed = await store.list('');
    expect(listed.map((o) => o.key)).toEqual(['packs/ab/' + 'ab'.padEnd(64, 'c'), 'walnut-backup.json'].sort());
    expect(listed.find((o) => o.key === packKey)?.size).toBe(big.length);
    expect(listed[0].modifiedAt).toBeGreaterThan(0);

    await store.delete(packKey);
    await store.delete(packKey); // already gone: fine
    await other.delete(packKey); // stale cache in the other store: fine
    await expect(store.get(packKey)).rejects.toSatisfy(isNotFound);
    expect(fake.files().filter((f) => f.name === packKey)).toHaveLength(0);
  });

  it('updates an existing name in place, also from a second store, never duplicating', async () => {
    await setup();
    const a = await makeStore();
    const b = await makeStore();
    await a.put('index/one', Buffer.from('v1'));
    await b.put('index/one', Buffer.from('v2'));
    await a.put('index/one', Buffer.from('v3'));
    await a.put('index/one', randomBytes(5 * 1024 * 1024 + 10)); // resumable update
    const big = randomBytes(5 * 1024 * 1024 + 20);
    await b.put('index/one', big);
    expect(fake.files().filter((f) => f.name === 'index/one')).toHaveLength(1);
    expect(fake.requests.some((r) => /^PATCH \/upload\/drive\/v3\/files\/[^?]+\?uploadType=multipart/.test(r))).toBe(true);
    expect(fake.requests.some((r) => /^PATCH \/upload\/drive\/v3\/files\/[^?]+\?uploadType=resumable/.test(r))).toBe(true);
    expect((await a.get('index/one')).equals(big)).toBe(true);
  });

  it('re-creates a file that was deleted elsewhere while cached', async () => {
    await setup();
    const a = await makeStore();
    const b = await makeStore();
    await a.put('snapshots/s1', Buffer.from('one'));
    await b.delete('snapshots/s1');
    await a.put('snapshots/s1', Buffer.from('two'));
    expect((await b.get('snapshots/s1')).toString()).toBe('two');
    expect(fake.files().filter((f) => f.name === 'snapshots/s1')).toHaveLength(1);
  });

  it('pages through a large folder and filters by prefix', async () => {
    await setup({ maxPageSize: 3 });
    const store = await makeStore();
    for (let i = 0; i < 7; i++) await store.put(`packs/0${i}/p${i}`, Buffer.from(`pack ${i}`));
    await store.put('index/i1', Buffer.from('idx'));
    await store.put('snapshots/s1', Buffer.from('snap'));

    const before = fake.requests.length;
    const packs = await store.list('packs/');
    expect(packs.map((o) => o.key)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `packs/0${i}/p${i}`));
    const listCalls = fake.requests.slice(before).filter((r) => r.startsWith('GET /drive/v3/files?'));
    expect(listCalls).toHaveLength(3); // 9 files, 3 per page
    expect(listCalls[1]).toContain('pageToken=');
    expect((await store.list('index/')).map((o) => o.key)).toEqual(['index/i1']);
    expect(await store.list('nothing/')).toEqual([]);
  });

  it('throws StoreNotFoundError for a missing key', async () => {
    await setup();
    const store = await makeStore();
    await expect(store.get('snapshots/missing')).rejects.toSatisfy(isNotFound);
  });

  it('keeps the newest file when two share a name', async () => {
    await setup();
    const store = await makeStore();
    const folderId = fake.files().find((f) => f.mimeType === 'application/vnd.google-apps.folder')!.id;
    fake.addFile('walnut-backup.json', folderId, Buffer.from('old'));
    fake.addFile('walnut-backup.json', folderId, Buffer.from('newest'));
    expect((await store.get('walnut-backup.json')).toString()).toBe('newest');
    const listed = await new DriveStore({ folderId, folderName: 'x', getAccessToken, endpoints }).list('');
    expect(listed).toHaveLength(1);
    expect(listed[0].size).toBe(6);
  });

  it('retries 429 and 5xx with growing backoff, then succeeds', async () => {
    await setup();
    const store = await makeStore();
    fake.failNext(2, 429);
    fake.failNext(1, 503);
    fake.failNext(1, 403, 'userRateLimitExceeded');
    await store.put('index/r', Buffer.from('retried'));
    expect(sleeps).toHaveLength(4);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[3]).toBeGreaterThanOrEqual(4000);
    expect((await store.get('index/r')).toString()).toBe('retried');
  });

  it('gives up after five tries with a plain message', async () => {
    await setup();
    const store = await makeStore();
    fake.failNext(5, 500);
    await expect(store.get('index/x')).rejects.toThrow(/Google Drive lookup of index\/x failed after 5 tries: 500 backendError: Backend Error/);
  });

  it('refreshes the token once on 401, then succeeds', async () => {
    await setup();
    const store = await makeStore();
    token = 'ya29.revoked';
    tokenCalls = [];
    await store.put('index/auth', Buffer.from('ok'));
    expect(tokenCalls.filter(Boolean)).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect((await store.get('index/auth')).toString()).toBe('ok');
  });

  it('surfaces a storage quota 403 in plain words without retrying', async () => {
    await setup();
    const store = await makeStore();
    const key = `packs/ab/${'a'.repeat(64)}`;
    fake.failNext(1, 403, 'storageQuotaExceeded', /^POST \/upload\//);
    await expect(store.put(key, Buffer.from('x'))).rejects.toThrow(
      `Google Drive upload of ${key} failed: 403 storageQuotaExceeded: The user's Drive storage quota has been exceeded.`,
    );
    expect(sleeps).toHaveLength(0);
    expect(fake.files().filter((f) => f.name === key)).toHaveLength(0);
  });
});

describe('findOrCreateFolder / driveAbout / driveEndpoints', () => {
  it('creates the folder once, then finds the oldest', async () => {
    await setup();
    const first = await findOrCreateFolder("Walnut's Backup", getAccessToken, endpoints);
    expect(first.created).toBe(true);
    const again = await findOrCreateFolder("Walnut's Backup", getAccessToken, endpoints);
    expect(again).toEqual({ id: first.id, created: false });
    expect(fake.files().filter((f) => f.mimeType === 'application/vnd.google-apps.folder')).toHaveLength(1);
    expect(fake.files()[0].parents).toEqual(['root']);
  });

  it('reads the account and quota', async () => {
    await setup();
    const about = await driveAbout(getAccessToken, endpoints);
    expect(about).toEqual({ email: 'tester@example.com', displayName: 'Test User', limitBytes: 15 * 1024 ** 3, usageBytes: 0 });
  });

  it('reads env overrides at call time', () => {
    const saved = { ...process.env };
    try {
      delete process.env.WALNUT_GDRIVE_API_URL;
      delete process.env.WALNUT_GDRIVE_UPLOAD_URL;
      expect(driveEndpoints()).toEqual({ api: 'https://www.googleapis.com/drive/v3', upload: 'https://www.googleapis.com/upload/drive/v3' });
      process.env.WALNUT_GDRIVE_API_URL = 'http://127.0.0.1:1/drive/v3/';
      expect(driveEndpoints().api).toBe('http://127.0.0.1:1/drive/v3');
    } finally {
      process.env = saved;
    }
  });
});
