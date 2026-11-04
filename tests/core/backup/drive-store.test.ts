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

async function makeStore(extra: Partial<typeof retry> & { timeoutMs?: number } = {}): Promise<DriveStore> {
  const folder = await findOrCreateFolder('Walnut Backup', getAccessToken, endpoints, undefined, retry);
  return new DriveStore({ folderId: folder.id, folderName: 'Walnut Backup', getAccessToken, endpoints, retry: { ...retry, ...extra } });
}

const folderOf = () => fake.files().find((f) => f.mimeType === 'application/vnd.google-apps.folder')!.id;
const named = (name: string) => fake.files().filter((f) => f.name === name);
const creates = () => fake.requests.filter((r) => r.startsWith('POST /upload/drive/v3/files?'));

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
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000); // throttle 1
    expect(sleeps[1]).toBeGreaterThanOrEqual(2000); // throttle 2
    expect(sleeps[2]).toBeGreaterThanOrEqual(500); // failure 1: its own, shorter schedule
    expect(sleeps[2]).toBeLessThanOrEqual(1000);
    expect(sleeps[3]).toBeGreaterThanOrEqual(4000); // throttle 3
    expect((await store.get('index/r')).toString()).toBe('retried');
  });

  it('backs off throttling exponentially up to about 64 s, over up to 8 tries', async () => {
    await setup();
    const store = await makeStore();
    fake.failNext(7, 403, 'rateLimitExceeded');
    await store.put('index/slow', Buffer.from('finally'));
    expect(sleeps).toHaveLength(7);
    for (let i = 0; i < 6; i++) {
      expect(sleeps[i]).toBeGreaterThanOrEqual(1000 * 2 ** i);
      expect(sleeps[i]).toBeLessThanOrEqual(1000 * 2 ** i + 1000);
    }
    expect(sleeps[6]).toBe(64_000);
    expect((await store.get('index/slow')).toString()).toBe('finally');

    fake.failNext(8, 429);
    await expect(store.get('index/never')).rejects.toThrow(/lookup of index\/never failed after 8 tries: 429 rateLimitExceeded/);
  });

  it('honors Retry-After, in seconds or as a date', async () => {
    await setup();
    const store = await makeStore();
    fake.failNext(1, 429, undefined, undefined, '7');
    fake.failNext(1, 403, 'userRateLimitExceeded', undefined, new Date(Date.now() + 3000).toUTCString());
    fake.failNext(1, 503, undefined, undefined, '2');
    await store.put('index/ra', Buffer.from('x'));
    expect(sleeps[0]).toBe(7000);
    expect(sleeps[1]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeLessThanOrEqual(3000);
    expect(sleeps[2]).toBe(2000);
  });

  it('a create that landed but answered 5xx is not repeated', async () => {
    await setup();
    const store = await makeStore();
    fake.failAfterCreate(1, 500);
    await store.put('index/once', Buffer.from('one copy'));
    expect(creates()).toHaveLength(1);
    expect(named('index/once')).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
    expect((await store.get('index/once')).toString()).toBe('one copy');
    // The id of the file found by the lookup is cached: the next put updates it.
    await store.put('index/once', Buffer.from('v2'));
    expect(creates()).toHaveLength(1);
    expect(named('index/once')).toHaveLength(1);
  });

  it('a create that landed but timed out is not repeated', async () => {
    await setup();
    const store = await makeStore({ timeoutMs: 300 });
    fake.failAfterCreate(1, 'hang');
    await store.put('index/slow-create', Buffer.from('landed'));
    expect(creates()).toHaveLength(1);
    expect(named('index/slow-create')).toHaveLength(1);
    expect((await store.get('index/slow-create')).toString()).toBe('landed');
  });

  it('a create that landed but lost its connection is not repeated', async () => {
    await setup();
    const store = await makeStore();
    fake.failAfterCreate(1, 'reset');
    await store.put('index/reset', Buffer.from('kept'));
    expect(creates()).toHaveLength(1);
    expect(named('index/reset')).toHaveLength(1);
    expect((await store.get('index/reset')).toString()).toBe('kept');
  });

  it('a resumable create that landed but answered 5xx is not repeated', async () => {
    await setup();
    const store = await makeStore();
    const key = `packs/cd/${'cd'.repeat(32)}`;
    const big = randomBytes(5 * 1024 * 1024 + 30);
    fake.failAfterCreate(1, 502);
    await store.put(key, big);
    expect(fake.requests.filter((r) => r.startsWith('PUT /upload/drive/v3/files?uploadType=resumable&upload_id='))).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
    expect(named(key)).toHaveLength(1);
    expect((await store.get(key)).equals(big)).toBe(true);
  });

  it('a create that failed for real is retried, once', async () => {
    await setup();
    const store = await makeStore();
    fake.failNext(1, 503, undefined, /^POST \/upload\//);
    await store.put('index/retry-create', Buffer.from('made'));
    expect(creates()).toHaveLength(2);
    expect(named('index/retry-create')).toHaveLength(1);
    expect((await store.get('index/retry-create')).toString()).toBe('made');
  });

  it('a same-name file of another size does not count as landed; the retry leaves one file', async () => {
    await setup();
    const key = 'snapshots/race';
    const store = new DriveStore({
      folderId: (await findOrCreateFolder('Walnut Backup', getAccessToken, endpoints, undefined, retry)).id,
      folderName: 'Walnut Backup', getAccessToken, endpoints,
      // During the backoff another writer adds a file of the same name and a different size.
      retry: { sleep: async (ms) => { sleeps.push(ms); fake.addFile(key, folderOf(), Buffer.from('other writer')); } },
    });
    fake.failNext(1, 500, undefined, /^POST \/upload\//);
    await store.put(key, Buffer.from('mine'));
    expect(creates()).toHaveLength(2);
    expect(named(key)).toHaveLength(1);
    expect((await store.get(key)).toString()).toBe('mine');
    expect((await new DriveStore({ folderId: folderOf(), folderName: 'x', getAccessToken, endpoints }).get(key)).toString()).toBe('mine');
  });

  it('a put on a name with duplicates updates the newest and deletes the rest', async () => {
    await setup();
    const store = await makeStore();
    fake.addFile('walnut-backup.json', folderOf(), Buffer.from('old'));
    const newest = fake.addFile('walnut-backup.json', folderOf(), Buffer.from('newer'));
    await store.put('walnut-backup.json', Buffer.from('latest'));
    expect(named('walnut-backup.json').map((f) => f.id)).toEqual([newest.id]);
    expect((await store.get('walnut-backup.json')).toString()).toBe('latest');

    // Same through the cache filled by list().
    fake.addFile('index/dup', folderOf(), Buffer.from('a'));
    fake.addFile('index/dup', folderOf(), Buffer.from('b'));
    fake.addFile('index/dup', folderOf(), Buffer.from('c'));
    const lister = await makeStore();
    await lister.list('');
    await lister.put('index/dup', Buffer.from('d'));
    expect(named('index/dup')).toHaveLength(1);
    expect((await store.get('index/dup')).toString()).toBe('d');
  });

  it('delete removes every file with that name, and tolerates copies already gone', async () => {
    await setup();
    const store = await makeStore();
    for (const v of ['a', 'b', 'c']) fake.addFile('index/many', folderOf(), Buffer.from(v));
    fake.addFile('index/keep', folderOf(), Buffer.from('k'));
    expect((await store.get('index/many')).toString()).toBe('c'); // caches only the newest lookup result
    await store.delete('index/many');
    expect(named('index/many')).toHaveLength(0);
    expect(named('index/keep')).toHaveLength(1);
    await expect(store.get('index/many')).rejects.toSatisfy(isNotFound);

    // A cached copy deleted elsewhere answers 404; a new copy the lookup finds is deleted too.
    fake.addFile('index/many', folderOf(), Buffer.from('x'));
    fake.addFile('index/many', folderOf(), Buffer.from('y'));
    const stale = await makeStore();
    await stale.list('');
    await store.delete('index/many');
    fake.addFile('index/many', folderOf(), Buffer.from('z'));
    await stale.delete('index/many');
    expect(named('index/many')).toHaveLength(0);
    expect(fake.requests.filter((r) => r.startsWith('DELETE /drive/v3/files/')).length).toBeGreaterThanOrEqual(6);
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
