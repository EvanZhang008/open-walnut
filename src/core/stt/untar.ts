/**
 * Extract a .tar.gz in-process: a minimal Linux image has no `tar` (the
 * amazonlinux:2023 container does not), and the server brings what its own
 * features need. Handles what the speech runtime archive holds: directories,
 * regular files with their mode, symlinks to a sibling (the versioned .so
 * names), and GNU / pax long names. Every entry must stay inside the destination.
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve, sep, isAbsolute } from 'node:path';

function field(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = field(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function inside(dest: string, name: string): string {
  if (isAbsolute(name)) throw new Error(`Archive entry has an absolute path: ${name}`);
  const target = resolve(dest, name);
  if (target !== dest && !target.startsWith(dest + sep)) throw new Error(`Archive entry leaves the destination: ${name}`);
  return target;
}

/** Read the whole decompressed archive (the runtime is a few tens of MB). */
async function gunzipFile(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  // pipeline carries a read error to the caller, where .pipe() would leave it unhandled.
  await pipeline(createReadStream(path), createGunzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

export async function extractTarGz(archive: string, destDir: string): Promise<void> {
  const dest = resolve(destDir);
  const tar = await gunzipFile(archive);
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') { longName = field(body, 0, body.length); continue; }
    if (type === 'K') { longLink = field(body, 0, body.length); continue; }
    if (type === 'x') {
      // pax: "<len> path=<value>\n" records; only path and linkpath matter here.
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ (path|linkpath)=(.*)$/.exec(rec);
        if (m?.[1] === 'path') longName = m[2];
        if (m?.[1] === 'linkpath') longLink = m[2];
      }
      continue;
    }
    if (type === 'g') continue;

    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const link = longLink ?? field(header, 157, 100);
    longName = null;
    longLink = null;
    if (!name || name === './') continue;
    const target = inside(dest, name);
    const mode = octal(header, 100, 8) & 0o777;

    if (type === '5') {
      await mkdir(target, { recursive: true });
    } else if (type === '0' || type === '7') {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      await chmod(target, mode || 0o644);
    } else if (type === '2') {
      // Only a link to a sibling (libx.so.1 -> libx.so.1.2): any path in a link
      // could combine with another link to reach outside the destination.
      if (!link || link.includes('/') || link === '..' || link === '.') {
        throw new Error(`Archive link leaves the destination: ${name} -> ${link}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      await symlink(link, target);
    }
    // Hard links, devices and FIFOs never appear in the runtime archive.
  }
}
