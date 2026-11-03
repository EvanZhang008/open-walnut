/**
 * Send a new walnut file to a host as the blocks that differ from the file its
 * daemon slot already holds (the previous build), instead of the whole file.
 *
 * Two consecutive builds share most of their bytes at the same offsets: the
 * bun runtime at the front never moves, and only the bundle behind it changes.
 * Measured on clouddev 2026-11-03, two builds 74 minutes apart: 417 of 514
 * blocks of 256 KB identical, so 12 MB of gz to send instead of 65 MB (that
 * deploy's upload took 260 s through a relay that cuts every SSH connection
 * after about 5 MB, one 256 KB chunk per connection).
 *
 * The host hashes its file block by block (blockHashScript), this side reads
 * the new file's blocks from its gz, and the blocks that differ go up as ONE gz
 * of their bytes in order (DaemonConnection.uploadFile: resumable, lanes, sha
 * checked). The host then builds the new file from its old blocks and the sent
 * ones (slotDeltaInstallScript, daemon-file-slot.ts), checks it by sha256
 * against the whole file's, and moves it in. Anything that does not fit (no
 * file in the slot, no sha256 tool, most blocks changed) answers null here and
 * the whole file is sent as before.
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { shq } from './remote-sh.js'
import { sha256Hex } from './upload-resume.js'

/** One block, the unit compared and sent. */
export const DELTA_BLOCK_BYTES = 262_144
/** More than this share of blocks changed: the whole file is sent (a delta saves too little). */
export const DELTA_MAX_CHANGED_SHARE = 0.6

/**
 * The host's side, first step: the size of `base` and the sha256 of each of
 * its blocks, as `size=<n>` then `b <index> <hex>` lines, then `delta=hashed`.
 * `delta=nobase`, `delta=nosha` or `delta=nogzip` when it cannot help. POSIX
 * sh (busybox included); one dd and one hash per block.
 */
export function blockHashScript(base: string): string {
  const q = shq(base)
  return [
    `[ -f ${q} ] || { echo delta=nobase; exit 0; }`,
    'command -v gzip >/dev/null 2>&1 || { echo delta=nogzip; exit 0; }',
    'if command -v sha256sum >/dev/null 2>&1; then W_H="sha256sum"; elif command -v shasum >/dev/null 2>&1; then W_H="shasum -a 256"; else echo delta=nosha; exit 0; fi',
    `W_SIZE=$(wc -c < ${q} | tr -d ' ')`,
    'echo "size=$W_SIZE"',
    `W_N=$(( (W_SIZE + ${DELTA_BLOCK_BYTES} - 1) / ${DELTA_BLOCK_BYTES} ))`,
    'W_I=0',
    'while [ "$W_I" -lt "$W_N" ]; do',
    `  W_SUM=$(dd if=${q} bs=${DELTA_BLOCK_BYTES} skip=$W_I count=1 2>/dev/null | $W_H | awk '{print $1}')`,
    '  [ -n "$W_SUM" ] || { echo delta=nosha; exit 0; }',
    '  echo "b $W_I $W_SUM"',
    '  W_I=$((W_I + 1))',
    'done',
    'echo delta=hashed',
  ].join('\n')
}

/** blockHashScript's answer: the base's block hashes in order, or null when it cannot help. */
export function parseBlockHashes(out: string): { size: number; hashes: string[] } | null {
  if (!/^delta=hashed\s*$/m.test(out)) return null
  const size = /^size=(\d+)\s*$/m.exec(out)
  if (!size) return null
  const hashes: string[] = []
  for (const line of out.split('\n')) {
    const m = /^b (\d+) ([0-9a-f]{64})\s*$/.exec(line)
    if (!m) continue
    if (Number(m[1]) !== hashes.length) return null
    hashes.push(m[2])
  }
  const expected = Math.ceil(Number(size[1]) / DELTA_BLOCK_BYTES)
  return hashes.length === expected ? { size: Number(size[1]), hashes } : null
}

export interface WalnutFileDelta {
  /** Blocks of the new file. */
  blocks: number
  /** Indexes of the blocks that differ from the base, ascending (their bytes are `payload`, in this order). */
  changed: number[]
  /** gz of the changed blocks' bytes, one after another. */
  payload: Buffer
  payloadSha256: string
  /** The new file's raw size. */
  size: number
}

/**
 * The delta from a base with `baseHashes` to the file in `gz`: null when more
 * than DELTA_MAX_CHANGED_SHARE of its blocks changed (decided as soon as that
 * many differ, from the size the gz trailer records). Off the event loop where
 * it matters (gunzip and gzip on the thread pool, one block hashed per step),
 * and the changed blocks go straight into the payload's gzip, so only the
 * compressed payload is held.
 */
export async function planWalnutFileDelta(gz: Buffer, baseHashes: readonly string[]): Promise<WalnutFileDelta | null> {
  // ISIZE: the raw size mod 2^32 (a walnut file is far below 4 GB).
  const rawSize = gz.length >= 18 ? gz.readUInt32LE(gz.length - 4) : 0
  const limit = Math.ceil(rawSize / DELTA_BLOCK_BYTES) * DELTA_MAX_CHANGED_SHARE
  const changed: number[] = []
  const out: Buffer[] = []
  const zip = zlib.createGzip()
  zip.on('data', (c: Buffer) => out.push(c))
  const zipped = new Promise<void>((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject) })
  let blocks = 0
  let size = 0
  let pending: Buffer[] = []
  let pendingBytes = 0
  let tooMany = false
  const take = (block: Buffer): void => {
    const i = blocks++
    size += block.length
    const sum = crypto.createHash('sha256').update(block).digest('hex')
    if (baseHashes[i] === sum) return
    changed.push(i)
    if (changed.length > limit) tooMany = true
    else zip.write(block)
  }
  await new Promise<void>((resolve, reject) => {
    const gunzip = zlib.createGunzip()
    gunzip.on('data', (chunk: Buffer) => {
      if (tooMany) return
      pending.push(chunk)
      pendingBytes += chunk.length
      while (pendingBytes >= DELTA_BLOCK_BYTES && !tooMany) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending)
        take(Buffer.from(all.subarray(0, DELTA_BLOCK_BYTES)))
        const rest = all.subarray(DELTA_BLOCK_BYTES)
        pending = rest.length ? [rest] : []
        pendingBytes = rest.length
      }
      if (tooMany) { gunzip.destroy(); resolve() }
    })
    gunzip.on('end', () => {
      if (pendingBytes > 0 && !tooMany) take(Buffer.concat(pending))
      resolve()
    })
    gunzip.on('error', reject)
    gunzip.end(gz)
  })
  zip.end()
  await zipped
  if (tooMany || blocks === 0 || changed.length > blocks * DELTA_MAX_CHANGED_SHARE) return null
  const payload = Buffer.concat(out)
  const payloadSha256 = await sha256Hex(payload)
  return { blocks, changed, payload, payloadSha256, size }
}
