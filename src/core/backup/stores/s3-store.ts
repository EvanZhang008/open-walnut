/**
 * S3-protocol backup store: AWS S3, Cloudflare R2, and any S3-compatible
 * server (MinIO, Backblaze B2, ...) through a custom endpoint.
 *
 * R2 speaks S3 at https://<account id>.r2.cloudflarestorage.com with region
 * "auto". Non-AWS endpoints get path-style addressing (MinIO needs it, R2
 * takes it) and checksums only where the operation requires one: since SDK
 * 3.729 the client adds CRC32 checksums to every upload by default, which
 * several S3-compatible servers have refused.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { backupCredentials } from '../s3-backup.js';
import type { BackupAuthConfig } from '../types.js';
import { StoreNotFoundError, type BackupStore, type StoredObject } from './types.js';

const NETWORK_TIMEOUT_MS = 60_000;

export interface S3StoreOptions {
  kind: 's3' | 'r2';
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string;
  /** Static keys (R2, S3-compatible). AWS S3 may use `auth` instead. */
  accessKeyId?: string;
  secretAccessKey?: string;
  auth?: BackupAuthConfig;
}

export function r2Endpoint(accountId: string): string {
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}

export function makeStoreS3Client(o: S3StoreOptions): S3Client {
  const custom = Boolean(o.endpoint);
  const credentials = o.accessKeyId
    ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey ?? '' }
    : backupCredentials({ auth: o.auth });
  return new S3Client({
    region: o.region || (o.kind === 'r2' ? 'auto' : 'us-west-2'),
    ...(custom ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    // Amazon S3 without a region typed: the SDK follows the bucket's own region.
    ...(!custom && o.kind === 's3' ? { followRegionRedirects: true } : {}),
    ...(custom || o.kind === 'r2'
      ? { requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const }
      : {}),
    credentials,
    requestHandler: { requestTimeout: NETWORK_TIMEOUT_MS },
    maxAttempts: 4,
  });
}

export class S3Store implements BackupStore {
  readonly kind: 's3' | 'r2';
  private readonly root: string;

  constructor(private readonly o: S3StoreOptions, private readonly client: S3Client = makeStoreS3Client(o)) {
    this.kind = o.kind;
    this.root = o.prefix.replace(/^\/+|\/+$/g, '');
  }

  describe(): string {
    return `${this.kind}://${this.o.bucket}/${this.root}`;
  }

  private keyOf(key: string): string {
    return this.root ? `${this.root}/${key}` : key;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.o.bucket,
      Key: this.keyOf(key),
      Body: body,
      ContentLength: body.length,
      ContentType: 'application/octet-stream',
    }));
  }

  async get(key: string): Promise<Buffer> {
    try {
      const resp = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.keyOf(key) }));
      if (!resp.Body) throw new StoreNotFoundError(key);
      return Buffer.from(await resp.Body.transformToByteArray());
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') throw new StoreNotFoundError(key);
      throw err;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const strip = this.root ? this.root.length + 1 : 0;
    let token: string | undefined;
    do {
      const resp = await this.client.send(new ListObjectsV2Command({
        Bucket: this.o.bucket,
        Prefix: this.keyOf(prefix),
        ContinuationToken: token,
      }));
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({ key: obj.Key.slice(strip), size: obj.Size ?? 0, modifiedAt: obj.LastModified?.getTime() });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.keyOf(key) }));
  }
}
