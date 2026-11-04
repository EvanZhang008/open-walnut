/**
 * Open, read and write the encrypted backup repository (format.ts) on any
 * BackupStore. The backup run, prune and restore are built on this.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { isNotFound, type BackupStore } from '../stores/types.js';
import type { WriterIdentity } from '../local-state.js';
import { AVG_CHUNK, MAX_CHUNK, MIN_CHUNK, chunkBuffer } from './chunker.js';
import { blobId, deriveKeys, keyCheck, open, seal, type RepoKeys } from './crypto.js';
import {
  PACK_TARGET_BYTES, REPO_CONFIG_KEY, REPO_FORMAT, REPO_VERSION,
  indexKey, packKey, snapshotKey,
  type BlobLocation, type IndexFile, type PackInfo, type PackType, type RepoConfig,
  type Snapshot, type SnapshotSummary, type TreeEntry,
} from './format.js';

const deflate = promisify(zlib.deflateRaw);
const inflate = promisify(zlib.inflateRaw);

/** Codecs of a blob's plaintext (its first byte). */
const RAW = 0;
const DEFLATE = 1;

/** Already-compressed formats: deflating them burns CPU for nothing. */
const STORED_EXT_RE = /\.(mp4|mov|m4a|m4v|mp3|aac|ogg|opus|webm|mkv|avi|jpe?g|png|gif|webp|heic|heif|avif|zip|gz|tgz|bz2|xz|zst|7z|rar|docx|xlsx|pptx|pdf|woff2?)$/i;

export function shouldCompress(relPath: string): boolean {
  return !STORED_EXT_RE.test(relPath);
}

export type RepoErrorCode = 'no_repo' | 'key_mismatch' | 'other_writer' | 'bad_format' | 'missing_blob';

export class RepoError extends Error {
  constructor(readonly code: RepoErrorCode, message: string) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface BlobRef {
  pack: string;
  type: PackType;
  offset: number;
  length: number;
  rawLength: number;
}

export interface LoadedIndex {
  blobs: Map<string, BlobRef>;
  packs: Map<string, PackInfo>;
  /** The index objects this was read from (prune replaces them with one). */
  indexKeys: string[];
}

const randomId = (): string => randomBytes(16).toString('hex');

/** The store already holds snapshots or packs. */
export async function holdsBackupData(store: BackupStore): Promise<boolean> {
  return (await store.list('snapshots/')).length > 0 || (await store.list('packs/')).length > 0;
}

function sealWriter(keys: RepoKeys, me: WriterIdentity): RepoConfig['writer'] {
  return {
    id: me.id,
    name: seal(keys, Buffer.from(me.name, 'utf8'), 'writer-name').toString('base64'),
    since: new Date().toISOString(),
  };
}

export class Repository {
  private constructor(
    readonly store: BackupStore,
    readonly keys: RepoKeys,
    public config: RepoConfig,
  ) {}

  /**
   * Open the repository at `store`. With `create`, a store with no repository
   * gets a new one written by `writer`. A repository made with another key is
   * refused, never replaced: it is somebody's backups.
   */
  static async open(
    store: BackupStore,
    rawKey: Buffer,
    opts: { create?: boolean; writer?: WriterIdentity } = {},
  ): Promise<Repository> {
    const keys = deriveKeys(rawKey);
    let config: RepoConfig | null = null;
    try {
      config = JSON.parse((await store.get(REPO_CONFIG_KEY)).toString('utf8')) as RepoConfig;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (!config) {
      if (!opts.create || !opts.writer) throw new RepoError('no_repo', `No Walnut backups at ${store.describe()} yet.`);
      // Backups there without a readable config (a listing that lagged): never start a new
      // repository over them, or their key check and writer would be replaced.
      if (await holdsBackupData(store)) {
        throw new RepoError('bad_format', `${store.describe()} holds Walnut backup data but its walnut-backup.json could not be read. Try again in a minute.`);
      }
      const repoId = randomId();
      config = {
        format: REPO_FORMAT,
        version: REPO_VERSION,
        repoId,
        createdAt: new Date().toISOString(),
        keyCheck: keyCheck(keys, repoId),
        chunker: { min: MIN_CHUNK, avg: AVG_CHUNK, max: MAX_CHUNK },
        writer: sealWriter(keys, opts.writer),
      };
      await store.put(REPO_CONFIG_KEY, Buffer.from(JSON.stringify(config, null, 2)));
      return new Repository(store, keys, config);
    }
    if (config.format !== REPO_FORMAT) {
      throw new RepoError('bad_format', `${store.describe()} holds something that is not a Walnut backup.`);
    }
    if (config.version > REPO_VERSION) {
      throw new RepoError('bad_format', `These backups were written by a newer Walnut (format ${config.version}). Update Walnut to read them.`);
    }
    if (config.keyCheck !== keyCheck(keys, config.repoId)) {
      throw new RepoError('key_mismatch', `The backups at ${store.describe()} were made with a different recovery key.`);
    }
    return new Repository(store, keys, config);
  }

  /** Re-read walnut-backup.json (another machine may have taken the writer role). */
  async refreshConfig(): Promise<RepoConfig> {
    this.config = JSON.parse((await this.store.get(REPO_CONFIG_KEY)).toString('utf8')) as RepoConfig;
    return this.config;
  }

  isWriter(me: WriterIdentity): boolean {
    return this.config.writer?.id === me.id;
  }

  /** The writer machine's name, for the user ("another computer" when it cannot be read). */
  writerName(): string {
    try {
      return open(this.keys, Buffer.from(this.config.writer.name, 'base64'), 'writer-name').toString('utf8');
    } catch {
      return 'another computer';
    }
  }

  async setWriter(me: WriterIdentity): Promise<void> {
    const next: RepoConfig = { ...this.config, writer: sealWriter(this.keys, me) };
    await this.store.put(REPO_CONFIG_KEY, Buffer.from(JSON.stringify(next, null, 2)));
    this.config = next;
  }

  blobId(plaintext: Buffer): string {
    return blobId(this.keys, plaintext);
  }

  /** Encode one chunk as a sealed blob (compressed first when that helps). */
  async sealBlob(id: string, chunk: Buffer, compress: boolean): Promise<Buffer> {
    let body = Buffer.concat([Buffer.from([RAW]), chunk]);
    if (compress && chunk.length > 64) {
      const packed = await deflate(chunk);
      if (packed.length < chunk.length * 0.95) body = Buffer.concat([Buffer.from([DEFLATE]), packed]);
    }
    return seal(this.keys, body, `blob:${id}`);
  }

  async openBlob(id: string, sealed: Buffer): Promise<Buffer> {
    const body = open(this.keys, sealed, `blob:${id}`);
    const chunk = body[0] === DEFLATE ? await inflate(body.subarray(1)) : body.subarray(1);
    if (this.blobId(chunk) !== id) throw new RepoError('missing_blob', `blob ${id.slice(0, 12)} does not match its id`);
    return chunk;
  }

  // ── Index ────────────────────────────────────────────────────────────────

  /**
   * Every index file, merged. With `stored`, packs not in it are left out
   * BEFORE blobs are mapped, so a blob that a stale index places in a deleted
   * pack is found in the live pack that also holds it.
   */
  async loadIndex(stored?: { has(packId: string): boolean }): Promise<LoadedIndex> {
    const objs = (await this.store.list('index/')).sort((a, b) => a.key.localeCompare(b.key));
    const blobs = new Map<string, BlobRef>();
    const packs = new Map<string, PackInfo>();
    for (const obj of objs) {
      const file = await this.readSealedJson<IndexFile>(obj.key);
      for (const pack of file.packs) {
        if (stored && !stored.has(pack.id)) continue;
        packs.set(pack.id, pack);
        for (const [id, offset, length, rawLength] of pack.blobs) {
          if (!blobs.has(id)) blobs.set(id, { pack: pack.id, type: pack.type, offset, length, rawLength });
        }
      }
    }
    return { blobs, packs, indexKeys: objs.map((o) => o.key) };
  }

  async writeIndex(packs: PackInfo[]): Promise<string> {
    const key = indexKey(`${Date.now().toString(36)}-${randomId()}`);
    const file: IndexFile = { version: 1, packs };
    await this.writeSealedJson(key, file);
    return key;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  async listSnapshotKeys(): Promise<string[]> {
    return (await this.store.list('snapshots/')).map((o) => o.key).sort();
  }

  async readSnapshot(key: string): Promise<Snapshot> {
    return this.readSealedJson<Snapshot>(key);
  }

  /** Every snapshot, newest first. One that cannot be read is reported, not hidden. */
  async listSnapshots(): Promise<{ snapshots: Snapshot[]; unreadable: string[] }> {
    const snapshots: Snapshot[] = [];
    const unreadable: string[] = [];
    for (const key of await this.listSnapshotKeys()) {
      try {
        snapshots.push(await this.readSnapshot(key));
      } catch {
        unreadable.push(key);
      }
    }
    snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { snapshots, unreadable };
  }

  async writeSnapshot(snap: Snapshot): Promise<void> {
    await this.writeSealedJson(snapshotKey(snap.id), snap);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.store.delete(snapshotKey(id));
  }

  newSnapshotId(createdAt: Date): string {
    // Sorts by time; the random tail keeps two in one second apart.
    return `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomBytes(4).toString('hex')}`;
  }

  // ── Blobs ────────────────────────────────────────────────────────────────

  async readBlob(id: string, index: LoadedIndex, cache: PackCache): Promise<Buffer> {
    const ref = index.blobs.get(id);
    if (!ref) throw new RepoError('missing_blob', `blob ${id.slice(0, 12)} is in no index`);
    const pack = await cache.get(ref.pack);
    return this.openBlob(id, pack.subarray(ref.offset, ref.offset + ref.length));
  }

  async readTree(snap: Snapshot, index: LoadedIndex, cache: PackCache): Promise<TreeEntry[]> {
    const parts: Buffer[] = [];
    for (const id of snap.tree) parts.push(await this.readBlob(id, index, cache));
    const text = Buffer.concat(parts).toString('utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as TreeEntry);
  }

  // ── Sealed JSON objects ──────────────────────────────────────────────────

  private async readSealedJson<T>(key: string): Promise<T> {
    const sealed = await this.store.get(key);
    const body = open(this.keys, sealed, key);
    return JSON.parse((await inflate(body)).toString('utf8')) as T;
  }

  private async writeSealedJson(key: string, value: unknown): Promise<void> {
    const body = await deflate(Buffer.from(JSON.stringify(value)));
    await this.store.put(key, seal(this.keys, body, key));
  }
}

/**
 * Collects sealed blobs into ~16 MB packs and uploads each when full. Data
 * blobs and tree blobs go to separate writers (format.ts says why).
 */
export class PackWriter {
  private parts: Buffer[] = [];
  private locations: BlobLocation[] = [];
  private bytes = 0;
  /** One pack uploads while the next fills: at most two packs in memory. */
  private inflight: Promise<void> | null = null;
  readonly written: PackInfo[] = [];
  uploadedBytes = 0;

  constructor(
    private readonly repo: Repository,
    readonly type: PackType,
    private readonly onUploaded?: (info: PackInfo) => void,
  ) {}

  async add(id: string, sealed: Buffer, rawLength: number): Promise<void> {
    this.locations.push([id, this.bytes, sealed.length, rawLength]);
    this.parts.push(sealed);
    this.bytes += sealed.length;
    if (this.bytes >= PACK_TARGET_BYTES) await this.flush();
  }

  /** Close the buffered blobs into a pack and start its upload. */
  async flush(): Promise<void> {
    if (this.locations.length === 0) return;
    const header = seal(this.repo.keys, Buffer.from(JSON.stringify(this.locations)), 'pack-header');
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32LE(header.length);
    const body = Buffer.concat([...this.parts, header, trailer]);
    const id = createHash('sha256').update(body).digest('hex');
    const info: PackInfo = { id, type: this.type, size: body.length, blobs: this.locations };
    this.parts = [];
    this.locations = [];
    this.bytes = 0;
    const previous = this.inflight;
    const upload = (async () => {
      await previous;
      await this.repo.store.put(packKey(id), body);
      this.written.push(info);
      this.uploadedBytes += body.length;
      this.onUploaded?.(info);
    })();
    // Marked handled here; the next flush() or finish() awaits it and throws.
    upload.catch(() => {});
    this.inflight = upload;
    if (previous) await previous;
  }

  /** Upload what is left and wait for every upload. */
  async finish(): Promise<PackInfo[]> {
    await this.flush();
    await this.inflight;
    return this.written;
  }
}

/** A few downloaded packs kept in memory: reads are mostly in pack order. */
export class PackCache {
  private readonly packs = new Map<string, Buffer>();
  downloads = 0;
  downloadedBytes = 0;

  constructor(private readonly store: BackupStore, private readonly capacity = 6) {}

  async get(packId: string): Promise<Buffer> {
    const hit = this.packs.get(packId);
    if (hit) {
      this.packs.delete(packId);
      this.packs.set(packId, hit);
      return hit;
    }
    let body: Buffer;
    try {
      body = await this.store.get(packKey(packId));
    } catch (err) {
      if (isNotFound(err)) throw new RepoError('missing_blob', `pack ${packId.slice(0, 12)} is missing from ${this.store.describe()}`);
      throw err;
    }
    if (createHash('sha256').update(body).digest('hex') !== packId) {
      throw new RepoError('missing_blob', `pack ${packId.slice(0, 12)} is damaged (its contents do not match its name)`);
    }
    this.downloads++;
    this.downloadedBytes += body.length;
    this.packs.set(packId, body);
    while (this.packs.size > this.capacity) {
      const oldest = this.packs.keys().next().value as string;
      this.packs.delete(oldest);
    }
    return body;
  }
}

/** Serialize a tree as JSON lines and cut it into blobs (dedupes across snapshots). */
export function treeChunks(entries: TreeEntry[]): Buffer[] {
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return chunkBuffer(Buffer.from(text, 'utf8'));
}

export type { SnapshotSummary };
