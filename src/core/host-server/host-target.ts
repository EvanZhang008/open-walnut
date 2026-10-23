/**
 * Which compiled walnut file a host runs (scripts/build-binary.mjs targets):
 * one sh probe over the Mac's SSH master, read the way scripts/install.sh reads
 * the machine it runs on. Pure: the probe is text, its answer is parsed here.
 *
 *   Linux x86_64 / amd64   linux-x64        (bun's baseline build: no AVX2 needed)
 *   Linux aarch64 / arm64  linux-arm64
 *   ... on musl (Alpine)   linux-x64-musl, linux-arm64-musl
 *   Darwin arm64           darwin-arm64     (also an x86_64 shell under Rosetta)
 *   Darwin x86_64          darwin-x64
 */

export const HOST_FILE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl'] as const
export type HostFileTarget = typeof HOST_FILE_TARGETS[number]

export function isHostFileTarget(t: unknown): t is HostFileTarget {
  return typeof t === 'string' && (HOST_FILE_TARGETS as readonly string[]).includes(t)
}

export interface HostTarget {
  target: HostFileTarget
  /** In words for a message: `Linux x86_64, glibc 2.26`. */
  describe: string
}

/**
 * Prints `os=`, `arch=`, `libc=`, `translated=` and `glibc=` lines. ldd names its
 * own C library; a glibc system may also carry musl's loader, so the loader
 * decides only when ldd gives no answer (as install.sh does).
 */
export function targetProbeScript(): string {
  return [
    's=$(uname -s 2>/dev/null); m=$(uname -m 2>/dev/null); libc=; tr=0; gv=',
    'if [ "$s" = Linux ]; then',
    '  out=$(ldd --version 2>&1 || true)',
    '  case "$out" in *musl*) libc=musl ;; *GNU*|*GLIBC*|*glibc*) libc=glibc ;; esac',
    '  if [ -z "$libc" ]; then for l in /lib/ld-musl-*; do if [ -e "$l" ]; then libc=musl; fi; done; fi',
    '  if [ -z "$libc" ]; then libc=glibc; fi',
    '  if [ "$libc" = glibc ]; then gv=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n "s/^glibc //p"); fi',
    'fi',
    'if [ "$s" = Darwin ]; then tr=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0); fi',
    'printf "os=%s\\narch=%s\\nlibc=%s\\ntranslated=%s\\nglibc=%s\\n" "$s" "$m" "$libc" "$tr" "$gv"',
  ].join('\n')
}

/** The probe's answer as a target, or an error a person can read. */
export function parseHostTarget(out: string): HostTarget {
  const kv: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(os|arch|libc|translated|glibc)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]!] = m[2]!.trim()
  }
  const os = kv.os ?? ''
  const rawArch = kv.arch ?? ''
  if (!os && !rawArch) throw new Error(`could not tell which system the host runs (it answered "${out.trim().slice(0, 120)}")`)
  let arch: 'x64' | 'arm64' | null = /^(x86_64|amd64)$/.test(rawArch) ? 'x64' : /^(aarch64|arm64)$/.test(rawArch) ? 'arm64' : null
  if (os === 'Darwin' && arch === 'x64' && kv.translated === '1') arch = 'arm64'
  if ((os !== 'Linux' && os !== 'Darwin') || !arch) {
    throw new Error(`the host runs ${os || 'an unknown system'} on ${rawArch || 'an unknown CPU'}; the walnut file is built for Linux and macOS on x64 and arm64`)
  }
  if (os === 'Darwin') return { target: `darwin-${arch}`, describe: `macOS ${rawArch}` }
  const musl = kv.libc === 'musl'
  const glibc = !musl && /^\d+\.\d+/.test(kv.glibc ?? '') ? ` ${kv.glibc}` : ''
  return { target: musl ? `linux-${arch}-musl` : `linux-${arch}`, describe: `Linux ${rawArch}, ${musl ? 'musl' : `glibc${glibc}`}` }
}
