import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import {
  fetchRemoteManifest,
  isBackupRunning,
  runBackup,
  testBackupConnection,
} from '../../../src/core/backup/s3-backup.js';
import type { S3Client } from '@aws-sdk/client-s3';
import type { BackupConfig, BackupManifest } from '../../../src/core/backup/types.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = path.join(os.tmpdir(), `walnut-backup-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const cfg: BackupConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-west-2',
  prefix: 'walnut',
  auth: { method: 'access_keys', aws_access_key_id: 'AKIATEST', aws_secret_access_key: 'secret' },
};

/**
 * Hand-rolled S3 mock (repo convention — no aws-sdk-client-mock dep).
 * Tracks objects in a Map; supports the command names the engine sends.
 */
function makeMockS3(initial: { manifest?: BackupManifest; versioning?: boolean; failPutKeys?: string[] } = {}) {
  const objects = new Map<string, string>();
  if (initial.manifest) objects.set('walnut/backup-manifest.json', JSON.stringify(initial.manifest));
  const calls: string[] = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      calls.push(name);
      switch (name) {
        case 'GetBucketVersioningCommand':
          return { Status: initial.versioning ? 'Enabled' : undefined };
        case 'HeadBucketCommand':
          return {};
        case 'GetObjectCommand': {
          const key = command.input.Key as string;
          const body = objects.get(key);
          if (body === undefined) {
            const err = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            throw err;
          }
          return { Body: { transformToString: async () => body } };
        }
        case 'DeleteObjectCommand':
          objects.delete(command.input.Key as string);
          return {};
        case 'PutObjectCommand': {
          // lib-storage's Upload issues PutObject for small bodies; capture it.
          const key = command.input.Key as string;
          if (initial.failPutKeys?.includes(key)) throw new Error(`mock put failure for ${key}`);
          const body = command.input.Body;
          objects.set(key, typeof body === 'string' ? body : '[stream]');
          return { ETag: '"mock"' };
        }
        default:
          return {};
      }
    }),
    config: {
      // lib-storage inspects the client config for region/endpoint resolution.
      requestChecksumCalculation: async () => 'WHEN_REQUIRED',
      responseChecksumValidation: async () => 'WHEN_REQUIRED',
    },
  };
  return { client: client as unknown as S3Client, objects, calls };
}

describe('fetchRemoteManifest', () => {
  it('returns null on a first backup (NoSuchKey)', async () => {
    const { client } = makeMockS3();
    expect(await fetchRemoteManifest(cfg, client)).toBeNull();
  });

  it('parses an existing manifest', async () => {
    const manifest: BackupManifest = {
      version: 1, createdAt: 'x', hostname: os.hostname(), walnutVersion: '1',
      fileCount: 0, totalBytes: 0, files: [],
    };
    const { client } = makeMockS3({ manifest });
    const got = await fetchRemoteManifest(cfg, client);
    expect(got?.hostname).toBe(os.hostname());
  });
});

describe('runBackup', () => {
  it('refuses a bucket prefix owned by another machine', async () => {
    const manifest: BackupManifest = {
      version: 1, createdAt: 'x', hostname: 'someone-elses-mac', walnutVersion: '1',
      fileCount: 0, totalBytes: 0, files: [],
    };
    const { client } = makeMockS3({ manifest });
    const result = await runBackup(cfg, { client, dataDir });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must not share a prefix/);
  });

  it('fails fast with no bucket', async () => {
    const result = await runBackup({ ...cfg, bucket: undefined }, { dataDir });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No bucket/);
  });

  it('single-flight: concurrent calls join the same run', async () => {
    const { client } = makeMockS3();
    await fsp.writeFile(path.join(dataDir, 'config.yaml'), 'version: 1');
    const p1 = runBackup(cfg, { client, dataDir });
    const p2 = runBackup(cfg, { client, dataDir });
    expect(isBackupRunning()).toBe(true);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(isBackupRunning()).toBe(false);
  });

  it('uploads files and writes the manifest last', async () => {
    const { client, objects, calls } = makeMockS3({ versioning: true });
    await fsp.writeFile(path.join(dataDir, 'config.yaml'), 'version: 1');
    await fsp.mkdir(path.join(dataDir, 'tasks'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tasks', 'tasks.json'), '[]');

    const result = await runBackup(cfg, { client, dataDir });
    expect(result.ok).toBe(true);
    expect(result.uploaded).toBe(2);
    expect(result.versioningEnabled).toBe(true);
    expect(objects.has('walnut/backup-manifest.json')).toBe(true);
    const manifest = JSON.parse(objects.get('walnut/backup-manifest.json')!) as BackupManifest;
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['config.yaml', 'tasks/tasks.json']);
    expect(manifest.hostname).toBe(os.hostname());
    // Manifest write must come after the data uploads.
    const manifestIdx = calls.lastIndexOf('PutObjectCommand');
    expect(calls.slice(0, manifestIdx).filter((c) => c === 'PutObjectCommand').length).toBe(2);
  });

  it('second run with unchanged files uploads nothing new', async () => {
    const { client, objects } = makeMockS3();
    await fsp.writeFile(path.join(dataDir, 'config.yaml'), 'version: 1');
    const first = await runBackup(cfg, { client, dataDir });
    expect(first.ok).toBe(true);
    expect(first.uploaded).toBe(1);

    // Re-init a second mock carrying the manifest forward (fresh call log).
    const manifest = JSON.parse(objects.get('walnut/backup-manifest.json')!) as BackupManifest;
    const second = makeMockS3({ manifest });
    const result = await runBackup(cfg, { client: second.client, dataDir });
    expect(result.ok).toBe(true);
    expect(result.uploaded).toBe(0);
    expect(result.unchanged).toBe(1);
  });
});

describe('runBackup — review-fix regressions', () => {
  it('a failed sqlite snapshot preserves the previous backup entry instead of deleting it', async () => {
    // Previous backup holds a snapshot of an unreadable DB; this run cannot
    // re-snapshot it (the file is not valid sqlite → snapshot fails).
    const snapPath = '.sqlite-snapshots/tasks/tasks.sqlite';
    const manifest: BackupManifest = {
      version: 1, createdAt: '2026-08-13T00:00:00Z', hostname: os.hostname(), walnutVersion: '1',
      fileCount: 1, totalBytes: 500, files: [{ path: snapPath, size: 500, mtimeMs: 42 }],
    };
    const { client, objects } = makeMockS3({ manifest });
    objects.set(`walnut/data/${snapPath}`, 'old-db-bytes');
    await fsp.mkdir(path.join(dataDir, 'tasks'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tasks', 'tasks.sqlite'), 'not a real sqlite db');

    const result = await runBackup(cfg, { client, dataDir });
    expect(result.ok).toBe(true);
    // The bucket object must survive and the new manifest must still list it.
    expect(objects.has(`walnut/data/${snapPath}`)).toBe(true);
    const newManifest = JSON.parse(objects.get('walnut/backup-manifest.json')!) as BackupManifest;
    expect(newManifest.files.map((f) => f.path)).toContain(snapPath);
  });

  it('one failed file upload does not abort the run; the manifest keeps the previous entry', async () => {
    const manifest: BackupManifest = {
      version: 1, createdAt: '2026-08-13T00:00:00Z', hostname: os.hostname(), walnutVersion: '1',
      fileCount: 1, totalBytes: 3, files: [{ path: 'flaky.txt', size: 3, mtimeMs: 1 }],
    };
    const { client, objects } = makeMockS3({ manifest, failPutKeys: ['walnut/data/flaky.txt'] });
    objects.set('walnut/data/flaky.txt', 'old-bytes');
    // flaky.txt changed since the last backup → diff wants to re-upload it,
    // but S3 rejects that specific put. ok.txt must still upload and the
    // manifest must keep flaky.txt's PREVIOUS entry (the bucket still holds it).
    await fsp.writeFile(path.join(dataDir, 'flaky.txt'), 'newer');
    await fsp.writeFile(path.join(dataDir, 'ok.txt'), 'fine');

    const result = await runBackup(cfg, { client, dataDir });
    expect(result.ok).toBe(true);
    expect(result.error).toMatch(/skipped/);
    const newManifest = JSON.parse(objects.get('walnut/backup-manifest.json')!) as BackupManifest;
    const paths = newManifest.files.map((f) => f.path);
    expect(paths).toContain('ok.txt');
    expect(paths).toContain('flaky.txt');
    const flaky = newManifest.files.find((f) => f.path === 'flaky.txt');
    expect(flaky?.size).toBe(3); // previous entry preserved, not the failed new stat
    expect(objects.get('walnut/data/flaky.txt')).toBe('old-bytes');
  });

  it('re-stats files at upload time so the manifest records the uploaded size', async () => {
    const { client, objects } = makeMockS3();
    const file = path.join(dataDir, 'grow.txt');
    await fsp.writeFile(file, 'grew-after-scan-simulated');
    const result = await runBackup(cfg, { client, dataDir });
    expect(result.ok).toBe(true);
    const newManifest = JSON.parse(objects.get('walnut/backup-manifest.json')!) as BackupManifest;
    const entry = newManifest.files.find((f) => f.path === 'grow.txt');
    const st = await fsp.stat(file);
    expect(entry?.size).toBe(st.size);
  });
});

describe('testBackupConnection', () => {
  it('reports missing bucket without any network call', async () => {
    const result = await testBackupConnection({ ...cfg, bucket: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No bucket/);
  });
});
