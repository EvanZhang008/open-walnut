/**
 * tar.gz in-process, streaming: the reader every downloaded part of Walnut is
 * unpacked with (components, the speech runtime, uv) and the writer the
 * component build packs them with. A minimal Linux image has no `tar` (the
 * amazonlinux:2023 container does not), and the server brings what its own
 * features need.
 *
 * Reader: directories, regular files with their mode, symlinks to a sibling
 * (the versioned .so names), GNU and pax long names. Every entry must stay inside
 * the destination, and the output is bounded, so a crafted archive can neither
 * escape nor fill the disk. The archive streams through: memory stays at one
 * chunk however large it is.
 *
 * Writer: ustar, a pax record for a name past the header's fields, and every
 * header field fixed (mtime 0, uid and gid 0, no user names), so the same files
 * always give the same bytes (scripts/components/build.ts pins their hash).
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rm, symlink, type FileHandle } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const BLOCK = 512;
/** A pax or long-name record is a few hundred bytes; anything past this is not one. */
const MAX_META_BYTES = 1024 * 1024;

export interface ExtractOptions {
  /** Most bytes of file content the archive may unpack to (default 4 GB). */
  maxBytes?: number;
  /** Most bytes of the tar stream itself, padding and headers included (default unbounded). */
  maxTarBytes?: number;
  /** Most entries (default 200,000). */
  maxEntries?: number;
  /** fsync every file before closing it, so a rename that follows publishes durable content. */
  fsync?: boolean;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  /** SHA-256 and length of the tar stream as it was read: what a component pins. */
  tarSha256: string;
  tarBytes: number;
}

function field(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** A numeric header field: octal digits only, padded with spaces or NULs. NaN when it is anything else. */
function octal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len);
  // GNU base-256 (the high bit of the first byte): never written for what Walnut unpacks.
  if (raw[0] & 0x80) return Number.NaN;
  const s = raw.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) return Number.NaN;
  const n = parseInt(s, 8);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** An entry's size: a corrupt one would make the reader count bytes it can never reach. */
function entrySize(header: Buffer): number {
  const size = octal(header, 124, 12);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Archive entry has an invalid size field: corrupt, or a tar extension Walnut does not read');
  return size;
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  if (Number.isNaN(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

function inside(dest: string, name: string): string {
  if (isAbsolute(name)) throw new Error(`Archive entry has an absolute path: ${name}`);
  const target = resolve(dest, name);
  if (target !== dest && !target.startsWith(dest + sep)) throw new Error(`Archive entry leaves the destination: ${name}`);
  return target;
}

type State =
  | { kind: 'header' }
  | { kind: 'meta'; type: string; size: number; pad: number }
  | { kind: 'body'; fh: FileHandle; target: string; mode: number; left: number; pad: number }
  | { kind: 'skip'; left: number }
  | { kind: 'end' };

/** Feed it the decompressed tar in chunks; it writes the entries under `dest`. */
class TarExtractor {
  private pending: Buffer = Buffer.alloc(0);
  private state: State = { kind: 'header' };
  private longName: string | null = null;
  private longLink: string | null = null;
  private files = 0;
  private bytes = 0;
  private entries = 0;
  private tarBytes = 0;
  private readonly hash = createHash('sha256');
  private readonly maxBytes: number;
  private readonly maxTarBytes: number;
  private readonly maxEntries: number;
  private readonly fsync: boolean;

  constructor(private readonly dest: string, opts: ExtractOptions) {
    this.maxBytes = opts.maxBytes ?? 4 * 1024 ** 3;
    this.maxTarBytes = opts.maxTarBytes ?? Number.POSITIVE_INFINITY;
    this.maxEntries = opts.maxEntries ?? 200_000;
    this.fsync = opts.fsync ?? false;
  }

  async push(chunk: Buffer): Promise<void> {
    // Every byte read counts toward the hash, the trailing padding after the end blocks included.
    this.tarBytes += chunk.length;
    if (this.tarBytes > this.maxTarBytes) throw new Error(`Archive is longer than the ${this.maxTarBytes} bytes expected`);
    this.hash.update(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      const s = this.state;
      if (s.kind === 'end') { this.pending = Buffer.alloc(0); return; }
      if (s.kind === 'header') {
        if (this.pending.length < BLOCK) return;
        const header = this.pending.subarray(0, BLOCK);
        this.pending = this.pending.subarray(BLOCK);
        await this.onHeader(header);
        continue;
      }
      if (s.kind === 'meta') {
        const need = s.size + s.pad;
        if (this.pending.length < need) return;
        this.onMeta(s.type, this.pending.subarray(0, s.size));
        this.pending = this.pending.subarray(need);
        this.state = { kind: 'header' };
        continue;
      }
      if (this.pending.length === 0) return;
      if (s.kind === 'body') {
        const n = Math.min(s.left, this.pending.length);
        if (n > 0) {
          await writeAll(s.fh, this.pending.subarray(0, n));
          this.pending = this.pending.subarray(n);
          s.left -= n;
        }
        if (s.left === 0) {
          if (this.fsync) await s.fh.sync();
          await s.fh.close();
          await chmod(s.target, s.mode);
          this.state = { kind: 'skip', left: s.pad };
        }
        continue;
      }
      // skip
      const n = Math.min(s.left, this.pending.length);
      this.pending = this.pending.subarray(n);
      s.left -= n;
      if (s.left === 0) this.state = { kind: 'header' };
    }
  }

  /** The stream ended: only an archive that reached its end block is complete. */
  async end(): Promise<ExtractResult> {
    const s = this.state;
    if (s.kind === 'body') {
      await s.fh.close().catch(() => {});
      throw new Error('Archive ends inside a file: truncated');
    }
    // Cut at an entry boundary or inside a header, the stream still parses: the end block says it is whole.
    if (s.kind !== 'end') throw new Error('Archive ends before its end block: truncated');
    return { files: this.files, bytes: this.bytes, tarSha256: this.hash.digest('hex'), tarBytes: this.tarBytes };
  }

  /** On an error mid-file: close what is open so the caller can remove the tree. */
  async abort(): Promise<void> {
    const s = this.state;
    if (s.kind === 'body') await s.fh.close().catch(() => {});
    this.state = { kind: 'end' };
  }

  private async onHeader(header: Buffer): Promise<void> {
    if (header.every((b) => b === 0)) { this.state = { kind: 'end' }; return; }
    if (!checksumOk(header)) throw new Error('Archive header checksum does not match: not a tar, or corrupt');
    if (++this.entries > this.maxEntries) throw new Error(`Archive has more than ${this.maxEntries} entries`);
    const size = entrySize(header);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    const type = String.fromCharCode(header[156] || 48);

    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (size > MAX_META_BYTES) throw new Error(`Archive metadata record of ${size} bytes`);
      this.state = { kind: 'meta', type, size, pad };
      return;
    }

    const prefix = field(header, 345, 155);
    const plain = field(header, 0, 100);
    const name = this.longName ?? (prefix ? `${prefix}/${plain}` : plain);
    const link = this.longLink ?? field(header, 157, 100);
    this.longName = null;
    this.longLink = null;
    const skip = () => { this.state = size + pad > 0 ? { kind: 'skip', left: size + pad } : { kind: 'header' }; };
    if (!name || name === './' || name === '.') { skip(); return; }
    const target = inside(this.dest, name);
    const mode = ((octal(header, 100, 8) || 0) & 0o777) || 0o644;

    if (type === '5') {
      await mkdir(target, { recursive: true });
      skip();
    } else if (type === '0' || type === '7' || type === '\0') {
      this.bytes += size;
      if (this.bytes > this.maxBytes) throw new Error(`Archive unpacks to more than ${this.maxBytes} bytes`);
      this.files++;
      await mkdir(dirname(target), { recursive: true });
      // A name already there (an earlier entry, a link) is replaced, never written through.
      await rm(target, { force: true });
      const fh = await open(target, 'wx', 0o600);
      if (size === 0) {
        if (this.fsync) await fh.sync();
        await fh.close();
        await chmod(target, mode);
        this.state = pad > 0 ? { kind: 'skip', left: pad } : { kind: 'header' };
      } else {
        this.state = { kind: 'body', fh, target, mode, left: size, pad };
      }
    } else if (type === '2') {
      // Only a link to a sibling (libx.so.1 -> libx.so.1.2): any path in a link
      // could combine with another link to reach outside the destination.
      if (!link || link.includes('/') || link === '..' || link === '.') {
        throw new Error(`Archive link leaves the destination: ${name} -> ${link}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      await symlink(link, target);
      skip();
    } else if (type === '1' || type === '3' || type === '4' || type === '6') {
      // Hard links, devices and FIFOs never appear in what Walnut unpacks; skipping
      // a hard link would leave its file missing without a word.
      throw new Error(`Archive has an entry Walnut does not unpack (type ${type}): ${name}`);
    } else {
      // Vendor extensions (a Solaris ACL, a GNU sparse map name): nothing to write.
      skip();
    }
  }

  private onMeta(type: string, body: Buffer): void {
    if (type === 'L') { this.longName = field(body, 0, body.length); return; }
    if (type === 'K') { this.longLink = field(body, 0, body.length); return; }
    if (type !== 'x') return; // 'g': global records carry nothing Walnut reads
    // pax: "<len> <key>=<value>\n" records; only path and linkpath matter here.
    let off = 0;
    while (off < body.length) {
      const space = body.indexOf(0x20, off);
      if (space === -1) break;
      const len = parseInt(body.subarray(off, space).toString('utf8'), 10);
      if (!(len > 0) || off + len > body.length) break;
      const rec = body.subarray(space + 1, off + len - 1).toString('utf8');
      const eq = rec.indexOf('=');
      const key = rec.slice(0, eq);
      if (key === 'path') this.longName = rec.slice(eq + 1);
      if (key === 'linkpath') this.longLink = rec.slice(eq + 1);
      off += len;
    }
  }
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

/** Unpack a .tar.gz under `destDir` (created if missing). */
export async function extractTarGz(archive: string, destDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const dest = resolve(destDir);
  await mkdir(dest, { recursive: true });
  const tar = new TarExtractor(dest, opts);
  const stage = ownError();
  try {
    // pipeline carries a read or gunzip error to the caller, where .pipe() would leave it unhandled.
    await pipeline(createReadStream(archive), createGunzip(), stage.wrap(async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) await tar.push(chunk);
    }));
    return await tar.end();
  } catch (err) {
    await tar.abort();
    throw stage.error ?? err;
  }
}

/**
 * The error the last pipeline stage threw itself. Node 22's pipeline rejects
 * with the AbortError of the streams it tears down ("The operation was
 * aborted") when that stage throws; Node 24 and bun reject with the stage's own
 * error, the one that says what is wrong with the archive.
 */
function ownError() {
  const kept: { error: unknown; wrap: <T>(fn: (source: AsyncIterable<Buffer>) => Promise<T>) => (source: AsyncIterable<Buffer>) => Promise<T> } = {
    error: undefined,
    wrap: (fn) => async (source) => {
      try {
        return await fn(source);
      } catch (err) {
        kept.error = err;
        throw err;
      }
    },
  };
  return kept;
}

/**
 * SHA-256 and length of the tar inside a .tar.gz, streamed: what a component's
 * manifest pins (the compressed bytes depend on the compressor; these do not).
 * Stops past `maxBytes` so a hostile archive cannot keep it busy.
 */
export async function tarGzDigest(archive: string, maxBytes = Number.POSITIVE_INFINITY): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stage = ownError();
  try {
    await pipeline(createReadStream(archive), createGunzip(), stage.wrap(async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`Archive unpacks to more than the ${maxBytes} bytes pinned for it`);
        hash.update(chunk);
      }
    }));
  } catch (err) {
    throw stage.error ?? err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

// ── Writer ──

export interface TarEntry {
  /** Relative path, '/' separated, no leading './'. */
  path: string;
  type: 'file' | 'dir' | 'symlink';
  /** Permission bits (default 0o644 for files, 0o755 for directories). */
  mode?: number;
  data?: Uint8Array;
  /** A symlink's target: a sibling name. */
  link?: string;
}

function putString(h: Buffer, value: string, start: number, len: number): void {
  const b = Buffer.from(value, 'utf8');
  if (b.length > len) throw new Error(`tar field too long: ${value}`);
  b.copy(h, start);
}

function putOctal(h: Buffer, value: number, start: number, len: number): void {
  putString(h, `${value.toString(8).padStart(len - 1, '0')}\0`, start, len);
}

function header(name: string, prefix: string, type: string, size: number, mode: number, link = ''): Buffer {
  const h = Buffer.alloc(BLOCK);
  putString(h, name, 0, 100);
  putOctal(h, mode, 100, 8);
  putOctal(h, 0, 108, 8); // uid
  putOctal(h, 0, 116, 8); // gid
  putOctal(h, size, 124, 12);
  putOctal(h, 0, 136, 12); // mtime: fixed, so the bytes do not depend on when
  h.write(type, 156, 'latin1');
  putString(h, link, 157, 100);
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  putString(h, prefix, 345, 155);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function padded(data: Uint8Array): Buffer[] {
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return pad ? [Buffer.from(data), Buffer.alloc(pad)] : [Buffer.from(data)];
}

/** ustar's name split: a prefix of up to 155 bytes and a name of up to 100, at a '/'. */
function splitName(full: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' };
  for (let i = full.indexOf('/'); i !== -1; i = full.indexOf('/', i + 1)) {
    const prefix = full.slice(0, i);
    const name = full.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  // The length counts itself: grow it until it is stable.
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  for (;;) {
    const next = Buffer.byteLength(body) + String(len).length;
    if (next === len) return `${len}${body}`;
    len = next;
  }
}

/** A tar of `entries` in the order given (sort them for reproducible bytes). */
export function packTar(entries: TarEntry[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error(`tar entry escapes: ${e.path}`);
    const full = e.type === 'dir' ? `${e.path.replace(/\/+$/, '')}/` : e.path;
    const type = e.type === 'dir' ? '5' : e.type === 'symlink' ? '2' : '0';
    const mode = e.mode ?? (e.type === 'dir' ? 0o755 : 0o644);
    const data = e.type === 'file' ? (e.data ?? new Uint8Array()) : new Uint8Array();
    const link = e.link ?? '';
    let split = splitName(full);
    if (!split || Buffer.byteLength(link) > 100) {
      const pax = Buffer.from(
        (split ? '' : paxRecord('path', full)) + (Buffer.byteLength(link) > 100 ? paxRecord('linkpath', link) : ''),
        'utf8',
      );
      out.push(header('pax', '', 'x', pax.length, 0o644), ...padded(pax));
      // The plain name field only matters to a reader without pax: give it the tail, in ASCII.
      split = split ?? { name: full.replace(/[^\x20-\x7e]/g, '_').slice(-100), prefix: '' };
    }
    out.push(header(split.name, split.prefix, type, data.length, mode, Buffer.byteLength(link) > 100 ? '' : link));
    if (data.length) out.push(...padded(data));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}

/** Read a whole (decompressed) tar held in memory: the build reads npm tarballs with it. */
export function* readTar(tar: Buffer): Generator<{ path: string; type: 'file' | 'dir' | 'symlink' | 'other'; mode: number; data: Buffer; link: string }> {
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) return;
    if (!checksumOk(h)) throw new Error('tar header checksum does not match');
    const size = entrySize(h);
    if (offset + BLOCK + size > tar.length) throw new Error('tar ends inside an entry: truncated');
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = field(body, 0, body.length); continue; }
    if (type === 'K') { longLink = field(body, 0, body.length); continue; }
    if (type === 'x') {
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ (path|linkpath)=(.*)$/.exec(rec);
        if (m?.[1] === 'path') longName = m[2];
        if (m?.[1] === 'linkpath') longLink = m[2];
      }
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    const link = longLink ?? field(h, 157, 100);
    longName = null;
    longLink = null;
    const kind = type === '5' ? 'dir' : type === '2' ? 'symlink' : (type === '0' || type === '7' || type === '\0') ? 'file' : 'other';
    yield { path: name, type: kind, mode: (octal(h, 100, 8) || 0) & 0o777, data: body, link };
  }
}
