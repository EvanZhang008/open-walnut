/**
 * The host downloads the daemon's walnut file itself, instead of this computer
 * sending it (DaemonConnection.fetchWalnutFileOnHost). Some SSH relays end a
 * connection a few MB into an upload, so the ~67 MB gz of a Linux walnut file
 * went up as 256 KB chunks over hundreds of fresh logins: about three minutes of
 * a first connect. A host that reaches GitHub fetches the same bytes in seconds.
 *
 * Only for a file a release publishes byte for byte: `planHostFetch` takes the
 * release asset only when its SHA256SUMS names the very file this computer would
 * send (same sha256 of the unpacked file). A build of a checkout, a version with
 * no release, or a release of other bytes keeps the upload, as before.
 *
 * The script is POSIX sh (bash as sh, dash, busybox ash). It downloads with
 * curl, else wget (only with a `timeout` that works: wget alone has no limit on
 * the whole download), into `<gz>.fetch-<token>` beside the slot, a name of its
 * own per run, and checks the gz's sha256 against the release (a host with no
 * sha256 tool downloads nothing: nothing could check it). It never renames the
 * part to `<gz>`: an SSH link that drops sends the remote command no signal, so
 * a run cut off from this computer goes on to its end, and a rename then would
 * race the upload that took over. The caller installs from the checked part with
 * the slot's own install (daemon-file-slot.ts slotInstallScript), exactly as
 * after an upload; a part a cut run left is removed with the slot's leftovers.
 * Any failure prints `fetch=no reason=<word>` and removes the part.
 */
import crypto from 'node:crypto'
import { shq } from './remote-sh.js'
import { remoteSha256Command } from './upload-resume.js'

/** The longest the host's download may run; past it the upload is no slower. */
export const HOST_FETCH_MAX_SECONDS = 150
/** A download slower than this (bytes a second) for HOST_FETCH_SLOW_SECONDS stops: the upload takes over. */
export const HOST_FETCH_MIN_RATE = 256 * 1024
export const HOST_FETCH_SLOW_SECONDS = 20
/** How often the size of the part on the host is read for the progress bar. */
export const HOST_FETCH_POLL_MS = 1_000
/** A host whose download failed is not asked again for this long (it has no way out, no tools, a proxy). */
export const HOST_FETCH_RETRY_MS = 6 * 3_600_000

const SHA256 = /^[0-9a-f]{64}$/
const TOKEN = /^[0-9a-f]{8,32}$/

/** The release asset as host-file-download.ts PublishedAsset gives it, or why there is none. */
export type PublishedLookup = { url: string; gzSha256: string; sha256: string } | { none: string }

export interface HostFetchPlan {
  url: string
  gzSha256: string
  /** The gz's size, when this computer holds the same gz (for the progress bar); null when not known. */
  total: number | null
  /** The slowest the download may go: what still ends within HOST_FETCH_MAX_SECONDS, at least HOST_FETCH_MIN_RATE. */
  minRate: number
}

/**
 * Whether the host downloads the file this computer would send: only when the
 * release's file is that file (its sha256), from a web address. `skip` says why not.
 */
export function planHostFetch(published: PublishedLookup, file: { sha256: string; gzSha256: string; gz: { length: number } }): HostFetchPlan | { skip: string } {
  if ('none' in published) return { skip: published.none }
  if (!SHA256.test(published.sha256) || !SHA256.test(published.gzSha256)) return { skip: 'the release lists no usable sha256 for the file' }
  if (!/^https?:\/\//i.test(published.url)) return { skip: `the release asset (${published.url}) is not a web address` }
  if (published.sha256 !== file.sha256) {
    return { skip: `the release's file (sha256 ${published.sha256.slice(0, 12)}) is not the one this computer would send (${file.sha256.slice(0, 12)})` }
  }
  const total = published.gzSha256 === file.gzSha256 ? file.gz.length : null
  // A download slower than the size over the time it may take would only be cut at the end.
  const minRate = total ? Math.max(HOST_FETCH_MIN_RATE, Math.ceil(total / HOST_FETCH_MAX_SECONDS)) : HOST_FETCH_MIN_RATE
  return { url: published.url, gzSha256: published.gzSha256, total, minRate }
}

/** A name of its own for one run's part file. */
export function newFetchToken(): string {
  return crypto.randomBytes(8).toString('hex')
}

/** Where one run's download goes beside the gz; daemon-file-slot.ts leftoversOf removes `<gz>.fetch-*`. */
export function hostFetchPartPath(gz: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error('hostFetchPartPath: the token must be 8 to 32 hex characters')
  return `${gz}.fetch-${token}`
}

/** One marked line per answer (`fetch=ok`, or `fetch=no reason=<word>` and a `detail=` line). */
const no = (reason: string, detail?: string): string => (detail
  ? `{ echo "fetch=no reason=${reason}"; printf 'detail=%s\\n' "$(printf %s "${detail}" | tr -cd '[:print:]' | cut -c1-200)"; exit 0; }`
  : `{ echo "fetch=no reason=${reason}"; exit 0; }`)

export interface HostFetchScriptOpts {
  url: string
  /** The gz an upload would put beside the slot: the part goes beside it. */
  gz: string
  token: string
  gzSha256: string
  maxSeconds?: number
  minRate?: number
  /** The HOME curl and wget run with (a test server's own install home: nothing of theirs lands in the real one). */
  home?: string
}

/**
 * Download `url` beside `gz` on the host, checked by `gzSha256`; `fetch=ok`
 * leaves the checked part at hostFetchPartPath(gz, token). The download runs in
 * the foreground under its own time limit (curl's --max-time, `timeout` around
 * wget), shorter than the caller's. curl reads no ~/.curlrc (`-q`), and wget no
 * wgetrc and no HSTS or HPKP file where it has those options, so nothing is
 * written outside the slot's dir.
 */
export function hostFetchScript(opts: HostFetchScriptOpts): string {
  if (!SHA256.test(opts.gzSha256)) throw new Error('hostFetchScript: gzSha256 must be 64 hex characters')
  if (!/^(https?|file):\/\/\S+$/i.test(opts.url)) throw new Error('hostFetchScript: url must be a web address')
  const max = Math.max(5, Math.floor(opts.maxSeconds ?? HOST_FETCH_MAX_SECONDS))
  const rate = Math.max(1, Math.floor(opts.minRate ?? HOST_FETCH_MIN_RATE))
  const U = shq(opts.url)
  const env = opts.home ? `env HOME=${shq(opts.home)} ` : ''
  return [
    // The part's path in a variable: the traps quote it themselves.
    `W_P=${shq(hostFetchPartPath(opts.gz, opts.token))}`,
    'trap \'rm -f "$W_P"\' EXIT',
    'trap \'rm -f "$W_P"; exit 1\' HUP INT TERM PIPE',
    'rm -f "$W_P"',
    // A sha256 tool first: a download nothing can check is not one to keep.
    `[ -n "$( ${remoteSha256Command('/dev/null')} )" ] || ${no('no-sha256')}`,
    `mkdir -p ${shq(opts.gz.slice(0, opts.gz.lastIndexOf('/')) || '/')} || ${no('no-dir')}`,
    'if command -v curl >/dev/null 2>&1; then',
    `  W_E=$(${env}curl -q -fsSL --connect-timeout 10 --speed-limit ${rate} --speed-time ${HOST_FETCH_SLOW_SECONDS} --max-time ${max} -o "$W_P" ${U} 2>&1); W_R=$?`,
    'elif command -v wget >/dev/null 2>&1; then',
    // busybox before 1.30 spells it `timeout -t N`: such a host gets the upload.
    `  timeout 1 true >/dev/null 2>&1 || ${no('no-timeout')}`,
    '  W_H=$(wget --help 2>&1); W_O=',
    '  for W_F in --no-config --no-hsts --no-hpkp; do case "$W_H" in *"$W_F"*) W_O="$W_O $W_F";; esac; done',
    '  case "$W_H" in *--tries*) W_O="$W_O --tries=1";; esac',
    `  W_E=$(timeout ${max} ${env}wget -q $W_O -T ${HOST_FETCH_SLOW_SECONDS} -O "$W_P" ${U} 2>&1); W_R=$?`,
    'else',
    `  ${no('no-downloader')}`,
    'fi',
    `[ "$W_R" -eq 0 ] || ${no('download', 'exit $W_R: $W_E')}`,
    `W_S=$( ${remoteSha256Command(hostFetchPartPath(opts.gz, opts.token))} )`,
    `[ "$W_S" = ${shq(opts.gzSha256)} ] || ${no('sha', 'got $W_S')}`,
    // Checked: the part stays for the install, whatever happens to this command now.
    'trap - EXIT HUP INT TERM PIPE',
    'echo fetch=ok',
  ].join('\n')
}

/** The bytes downloaded so far (`fetched_bytes=<n>`, nothing before the file exists). */
export function hostFetchSizeScript(gz: string, token: string): string {
  const P = shq(hostFetchPartPath(gz, token))
  return `if [ -f ${P} ]; then printf 'fetched_bytes=%s\\n' "$(wc -c < ${P} | tr -d ' ')"; fi`
}

export function parseHostFetchSize(out: string): number | null {
  const m = /^fetched_bytes=(\d+)\s*$/m.exec(out)
  return m ? Number(m[1]) : null
}

export type HostFetchAnswer = { ok: true } | { ok: false; reason: string; detail?: string }

/** The script's answer, or null when it printed none (cut off). */
export function parseHostFetchAnswer(out: string): HostFetchAnswer | null {
  if (/^fetch=ok\s*$/m.test(out)) return { ok: true }
  const m = /^fetch=no reason=([a-z0-9-]+)\s*$/m.exec(out)
  if (!m) return null
  const detail = /^detail=(.*)$/m.exec(out)?.[1]?.trim()
  return { ok: false, reason: m[1], ...(detail ? { detail } : {}) }
}
