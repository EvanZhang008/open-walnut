/**
 * The host side of DaemonConnection.uploadFile, as POSIX sh (busybox included):
 * the sha256 of a file there, the check for a file the host already has, and
 * the list of chunks a cut upload left, so a retry sends only what is missing.
 *
 * A 60 MB file is 240 chunks of 256 KB, each over its own SSH connection. Before
 * this, every attempt removed the chunks of the last one and started at chunk 0,
 * and a reconnect sent the whole file again even when the host had it.
 */
import crypto from 'node:crypto'
import { shq } from './remote-sh.js'

/**
 * A pipeline that prints the sha256 of `remotePath` in hex, or an empty line when
 * the host can compute none: `sha256sum`, else `shasum -a 256` (macOS has only
 * that one). One line without `!` or backslashes, so it also fits shDataCommand.
 * Inside `$(...)` it needs a space after the `$(`: `$((` starts arithmetic.
 */
export function remoteSha256Command(remotePath: string): string {
  const q = shq(remotePath)
  return `(sha256sum ${q} || shasum -a 256 ${q}) 2>/dev/null | awk '{print $1}'`
}

/** The sha256 of `data` in hex, off the event loop (WebCrypto hashes on another thread). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // A Buffer is never backed by a SharedArrayBuffer; the web lib's BufferSource type wants that said.
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return Buffer.from(digest).toString('hex')
}

/** The directory of a remote path, `.` for a bare name. */
export function remoteDirOf(remotePath: string): string {
  return remotePath.slice(0, remotePath.lastIndexOf('/')) || '.'
}

/**
 * One round trip before an upload: make the directory and, when `remotePath` is
 * there, print `sha=<hex or nothing>` and `size=<bytes>`. A file that already has
 * the expected sha needs none of the chunks a cut upload of it left.
 */
export function uploadPrecheckScript(remotePath: string, expectedSha256: string): string {
  const q = shq(remotePath)
  return [
    `mkdir -p ${shq(remoteDirOf(remotePath))} || exit 1`,
    `if [ -f ${q} ]; then`,
    `  walnut_sha=$( ${remoteSha256Command(remotePath)} )`,
    `  walnut_size=$(wc -c < ${q})`,
    '  echo "sha=$walnut_sha"',
    '  echo "size=$walnut_size"',
    `  if [ "$walnut_sha" = ${shq(expectedSha256)} ]; then rm -rf ${q}.chunks-*; fi`,
    'fi',
  ].join('\n')
}

/** What the precheck found: null when there is no file (or the answer is not one). `sha` is '' when the host cannot compute it. */
export function parseUploadPrecheck(output: string): { sha: string; size: number } | null {
  const sha = /^sha=([0-9a-f]*)\s*$/m.exec(output)
  const size = /^size=\s*(\d+)\s*$/m.exec(output)
  if (!sha || !size) return null
  return { sha: sha[1], size: Number(size[1]) }
}

/**
 * One round trip before a resumed chunked upload: remove the chunk dirs of this
 * path that belong to another sha (and the unkeyed `.chunks` dir older versions
 * used), make `chunkDir`, and list its chunks as `<bytes> chunk_<n>` lines (one
 * `wc -c`; an empty dir prints nothing).
 */
export function chunkListScript(remotePath: string, chunkDir: string): string {
  const cd = shq(chunkDir)
  return [
    `rm -rf ${shq(`${remotePath}.chunks`)}`,
    `for d in ${shq(remotePath)}.chunks-*; do`,
    '  [ -d "$d" ] || continue',
    `  [ "$d" = ${cd} ] || rm -rf "$d"`,
    'done',
    `mkdir -p ${cd} || exit 1`,
    `cd ${cd} || exit 1`,
    'wc -c chunk_* 2>/dev/null || true',
  ].join('\n')
}

/** Chunk index -> size in bytes, from chunkListScript's answer (wc's `total` line and any noise skipped). */
export function parseChunkList(output: string): Map<number, number> {
  const have = new Map<number, number>()
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+chunk_(\d+)\s*$/.exec(line)
    if (m) have.set(Number(m[2]), Number(m[1]))
  }
  return have
}

/** A resumed upload's failure cap: 30 for a small file, one in four chunks for a big one. */
export function resumeFailureCap(totalChunks: number): number {
  return Math.max(30, Math.ceil(totalChunks / 4))
}
