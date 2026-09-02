/**
 * Conditional-GET support for GET /api/file-content: `If-None-Match` parsing
 * plus the small validator cache that lets a 304 be answered WITHOUT reading
 * the file.
 *
 * Why this exists: opening a file in the Files panel ships the whole file as a
 * JSON payload every single time, and for a remote host those bytes cross the
 * SSH tunnel. The payload already carries `contentHash` (the editor's
 * optimistic-lock token), so a validator already existed — it just wasn't
 * exposed as an HTTP one. With `If-None-Match` a re-open of an unchanged file
 * answers 304 and ships zero bytes.
 *
 * The whole point is that a 304 must not READ the file: reading it would still
 * pay the tunnel and save nothing but the browser hop. So the decision is made
 * from a stat alone (mtimeMs + size) plus this cache, which remembers the hash
 * last served for a (host, path) at a given (mtimeMs, size).
 *
 * WHY mtime+size is an acceptable weak validator here:
 *  - It is the standard HTTP approach. Every static file server validates on
 *    mtime+size, and the ETags they hand out are usually derived from exactly
 *    those two numbers; nobody re-hashes a file per request.
 *  - The worst case is bounded to "the viewer shows bytes one edit stale" — a
 *    write that keeps the byte count identical AND lands inside the same mtime
 *    tick. It can never cause silent data loss, because a SAVE is protected
 *    independently by the `expectedHash` optimistic lock: writeFileContentPayload
 *    re-reads and re-hashes the real file and answers 409 `conflict` when the
 *    editor's base hash is stale. A stale read cannot clobber anything.
 *  - Being certain would mean reading (and tunnelling) the bytes, which is the
 *    exact cost this cache exists to avoid.
 *
 * The cache is in-process and bounded (insertion-ordered LRU, MAX_VALIDATOR_ENTRIES).
 * Losing it (restart, eviction) costs one full read, never correctness.
 */

import fsp from 'node:fs/promises'
import { createFileReader } from '../../core/session-file-reader.js'
import type { DaemonFileReader } from '../../core/daemon-file-reader.js'

/** What we remember about the last complete text read of one file. */
export interface FileValidator {
  mtimeMs: number
  size: number
  hash: string
}

/** Hard ceiling on remembered files — one editor session touches dozens, not
 *  thousands, and each entry is three numbers plus a path. */
const MAX_VALIDATOR_ENTRIES = 2000

/** Insertion-ordered map == LRU: a re-read re-inserts, eviction takes the head. */
const validators = new Map<string, FileValidator>()

/** `host ?? ''` + NUL + absolute path. NUL can't occur in either half, so no
 *  two (host, path) pairs can collide. */
function keyFor(host: string | undefined, filePath: string): string {
  return (host ?? '') + '\0' + filePath
}

/** Remember the validator for a file whose complete text we just served. */
export function rememberFileValidator(
  host: string | undefined,
  filePath: string,
  entry: FileValidator,
): void {
  const key = keyFor(host, filePath)
  validators.delete(key) // re-insert so this key becomes the most recent
  validators.set(key, entry)
  while (validators.size > MAX_VALIDATOR_ENTRIES) {
    const oldest = validators.keys().next()
    if (oldest.done) break
    validators.delete(oldest.value)
  }
}

/** The remembered validator for a file, or undefined. Does not touch the disk. */
export function peekFileValidator(
  host: string | undefined,
  filePath: string,
): FileValidator | undefined {
  return validators.get(keyFor(host, filePath))
}

/** Drop everything — tests only. */
export function clearFileValidatorCache(): void {
  validators.clear()
}

/** Entry count — for the bound ratchet in tests. */
export function fileValidatorCacheSize(): number {
  return validators.size
}

/** A parsed `If-None-Match`. `wildcard` is the RFC 9110 `*` form. */
export interface IfNoneMatch {
  wildcard: boolean
  tags: string[]
}

/**
 * Parse `If-None-Match` per RFC 9110 §13.1.2, leniently but never dangerously.
 * Returns null for "absent or malformed" — every null means "serve the normal
 * 200", which is always the safe answer.
 *
 * Handled: a comma-separated list, the weak prefix `W/` (If-None-Match uses weak
 * comparison, so `W/"x"` and `"x"` are the same tag here), surrounding quotes,
 * and the `*` wildcard. A bare unquoted token is also accepted: it is sloppy
 * HTTP, but a tag only ever MATCHES by being byte-equal to the file's real
 * current hash, so leniency cannot manufacture a wrong 304 — it only decides
 * whether the optimization fires at all.
 *
 * Rejected outright (→ 200): an empty/blank header, a value with a stray quote
 * or internal whitespace (a half-quoted tag is a client bug, not a validator),
 * and `*` mixed with real tags (the RFC says `*` stands alone).
 */
export function parseIfNoneMatch(header: string | string[] | undefined): IfNoneMatch | null {
  if (typeof header !== 'string') return null
  const parts = header.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length === 0) return null

  const tags: string[] = []
  let wildcard = false
  for (const part of parts) {
    if (part === '*') { wildcard = true; continue }
    let tag = part
    if (tag.startsWith('W/')) tag = tag.slice(2).trim()
    if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) {
      tag = tag.slice(1, -1)
    } else if (/["\s]/.test(tag)) {
      return null // half-quoted / spaced: malformed, don't guess
    }
    if (tag.length === 0) continue // `""` matches nothing real; ignore it
    tags.push(tag)
  }
  if (wildcard && tags.length > 0) return null // `*` must stand alone
  if (!wildcard && tags.length === 0) return null
  return { wildcard, tags }
}

/** Does this `If-None-Match` cover a representation with the given hash? */
export function ifNoneMatchAccepts(cond: IfNoneMatch, hash: string): boolean {
  return cond.wildcard || cond.tags.includes(hash)
}

/**
 * Stat one file for validation purposes. Local: fsp.stat. Remote: the daemon's
 * `fs.stat` command (in REQUIRED_DAEMON_CAPABILITIES, so every daemon has it) —
 * one small RPC instead of a whole file.
 *
 * Returns null for "can't validate": missing, not a regular file, an old daemon
 * without fs.stat, or an unreachable one. Every null degrades to a full read, so
 * a stat failure can never turn into a wrong answer or a hang (the daemon's own
 * command timeout bounds the RPC).
 */
async function statForValidator(
  filePath: string,
  host: string | undefined,
): Promise<{ mtimeMs: number; size: number } | null> {
  if (host) {
    try {
      const reader = (await createFileReader(host)) as DaemonFileReader
      const st = await reader.stat(filePath)
      return st ? { mtimeMs: st.mtimeMs, size: st.size } : null
    } catch {
      return null
    }
  }
  try {
    const st = await fsp.stat(filePath)
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
  } catch {
    return null
  }
}

/**
 * Can this conditional request be answered "you already have it", without
 * reading a byte? Returns the hash to put in the ETag, or null → serve 200.
 *
 * `host` MUST be undefined for a local read; the caller derives it from
 * assertPathAllowed's `isRemote`, which also means the path sandbox has already
 * run — nothing here ever stats a path a plain read isn't allowed to touch.
 *
 * The cached-hash comparison happens BEFORE the stat, so a request whose tag
 * can't possibly match costs zero I/O.
 */
export async function conditionalFileHit(opts: {
  filePath: string
  host: string | undefined
  cond: IfNoneMatch
}): Promise<{ hash: string } | null> {
  const cached = peekFileValidator(opts.host, opts.filePath)
  if (!cached) return null // never served this file — nothing to validate against
  if (!ifNoneMatchAccepts(opts.cond, cached.hash)) return null
  const st = await statForValidator(opts.filePath, opts.host)
  if (!st) return null
  if (st.mtimeMs !== cached.mtimeMs || st.size !== cached.size) return null
  // Re-insert to keep an actively revalidated file at the young end of the LRU.
  rememberFileValidator(opts.host, opts.filePath, cached)
  return { hash: cached.hash }
}
