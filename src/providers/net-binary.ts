/**
 * walnut-net for this host, when its install has none (net-core.ts): the daemon
 * downloads its platform's build from this repo's `walnut-net-v<version>` prerelease
 * (.github/workflows/walnut-net.yml) into `<net state>/bin/walnut-net`.
 *
 * The file is checked before it is kept: against the SHA-256 pinned below when there
 * is one, else against the release's own SHA256SUMS (the trust install.sh gives a
 * Walnut release). It is written to a `.part` and renamed only once it matches, so a
 * file under the final name is always a checked one.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** native/walnut-net/Cargo.toml's version (tests/providers/net-binary.test.ts keeps them equal). */
export const NET_BIN_VERSION = '0.1.0'
export const NET_BIN_TAG = `walnut-net-v${NET_BIN_VERSION}`
const RELEASE_BASE = 'https://github.com/EvanZhang008/open-walnut/releases/download'
/** Pinned SHA-256 of each `.gz` asset of NET_BIN_TAG (its SHA256SUMS); a target not here is checked by SHA256SUMS. */
export const NET_BIN_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '04cfb61b38deaf0f6b7cc6d1962134c23443de67a1e10e2d0621639ade377418',
  'darwin-x64': '320ac396aa55614504196d94acbdc5508c3381b6bfb98ac49c35aed8a5c36012',
  'linux-arm64': '4b0d742a2b79bbe90e8eaca9d1d42ddc808709301500a290263291fdf7576512',
  'linux-x64': '12465b4beac2abff3bc0fbd8ae44a9c035bbd397843cd754b3885d297638b0ab',
}
const MAX_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 180_000

export function netBinTarget(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform !== 'darwin' && platform !== 'linux') return null
  if (arch !== 'arm64' && arch !== 'x64') return null
  return `${platform}-${arch}`
}

/** The downloaded connector's file name in `<net state>/bin`. */
export function netInstallName(): string {
  return `walnut-net-${NET_BIN_VERSION}`
}

export function netAssetName(target: string): string {
  return `walnut-net-${NET_BIN_VERSION}-${target}.gz`
}

/** The asset's line in a SHA256SUMS file, or null. */
export function sumFor(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (m && m[2] === asset) return m[1]
  }
  return null
}

async function get(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error(`${url}: ${len} bytes is too large`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error(`${url}: too large`)
  return buf
}

let inflight: Promise<string> | null = null

/** Download, check and install walnut-net into `dir`; one download at a time. Returns its path. */
export function fetchNetBinary(opts: {
  dir: string
  base?: string
  fetchImpl?: typeof fetch
  platform?: string
  arch?: string
  /** Tests: the pins to check against (default NET_BIN_SHA256). */
  pins?: Readonly<Record<string, string>>
  log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void
}): Promise<string> {
  inflight ??= (async () => {
    const target = netBinTarget(opts.platform, opts.arch)
    if (!target) throw new Error(`walnut-net has no build for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`)
    const fetchImpl = opts.fetchImpl ?? fetch
    const base = (opts.base ?? process.env.WALNUT_NET_RELEASE_BASE_URL ?? RELEASE_BASE).replace(/\/+$/, '')
    const asset = netAssetName(target)
    const url = `${base}/${NET_BIN_TAG}/${asset}`
    let want: string | null = (opts.pins ?? NET_BIN_SHA256)[target] ?? null
    if (!want) {
      want = sumFor((await get(`${base}/${NET_BIN_TAG}/SHA256SUMS`, fetchImpl)).toString('utf8'), asset)
      if (!want) throw new Error(`${NET_BIN_TAG}'s SHA256SUMS does not list ${asset}`)
    }
    opts.log?.('info', 'walnut-net: downloading', { url })
    const gz = await get(url, fetchImpl)
    const got = crypto.createHash('sha256').update(gz).digest('hex')
    if (got !== want) throw new Error(`${asset}: SHA-256 ${got} is not the expected ${want}; not installed`)
    const bin = zlib.gunzipSync(gz, { maxOutputLength: MAX_BYTES * 2 })
    fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    // Named by version: a daemon that needs a newer one never takes this one for it.
    const dest = path.join(opts.dir, netInstallName())
    const part = `${dest}.part-${process.pid}`
    fs.writeFileSync(part, bin, { mode: 0o755 })
    fs.chmodSync(part, 0o755)
    fs.renameSync(part, dest)
    opts.log?.('info', 'walnut-net: installed', { path: dest, sha256: got })
    return dest
  })().finally(() => { inflight = null })
  return inflight
}
