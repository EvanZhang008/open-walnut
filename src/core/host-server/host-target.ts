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

/** The loader a target's file starts through (its ELF interpreter). */
const LOADERS: Record<string, string> = {
  'linux-x64': '/lib64/ld-linux-x86-64.so.2',
  'linux-arm64': '/lib/ld-linux-aarch64.so.1',
  'linux-x64-musl': '/lib/ld-musl-x86_64.so.1',
  'linux-arm64-musl': '/lib/ld-musl-aarch64.so.1',
}

/**
 * Prints `os=`, `arch=`, `libc=`, `translated=`, `glibc=`, `bits=` and `loader=`
 * lines. ldd names its own C library; a glibc system may also carry musl's
 * loader, so the loader decides only when ldd gives no answer (as install.sh
 * does). `bits` (getconf LONG_BIT) and the loaders tell a 32-bit system on a
 * 64-bit kernel (Raspberry Pi OS reads aarch64 in uname). WALNUT_PROBE_ROOT
 * (tests) puts the loaders under another root.
 */
export function targetProbeScript(): string {
  const loaders = Object.values(LOADERS).map((l) => `"$R${l}"`).join(' ')
  return [
    's=$(uname -s 2>/dev/null); m=$(uname -m 2>/dev/null); libc=; tr=0; gv=; bits=; ld=',
    'R=${WALNUT_PROBE_ROOT:-}',
    'if [ "$s" = Linux ]; then',
    '  out=$(ldd --version 2>&1 || true)',
    '  case "$out" in *musl*) libc=musl ;; *GNU*|*GLIBC*|*glibc*) libc=glibc ;; esac',
    '  if [ -z "$libc" ]; then for l in "$R"/lib/ld-musl-*; do if [ -e "$l" ]; then libc=musl; fi; done; fi',
    '  if [ -z "$libc" ]; then libc=glibc; fi',
    '  if [ "$libc" = glibc ]; then gv=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n "s/^glibc //p"); fi',
    '  bits=$(getconf LONG_BIT 2>/dev/null)',
    `  for l in ${loaders}; do if [ -e "$l" ]; then ld="$ld \${l#"$R"}"; fi; done`,
    'fi',
    'if [ "$s" = Darwin ]; then tr=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0); fi',
    'printf "os=%s\\narch=%s\\nlibc=%s\\ntranslated=%s\\nglibc=%s\\nbits=%s\\nloader=%s\\n" "$s" "$m" "$libc" "$tr" "$gv" "$bits" "$ld"',
  ].join('\n')
}

/** The probe's answer as a target, or an error a person can read. */
export function parseHostTarget(out: string): HostTarget {
  const kv: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(os|arch|libc|translated|glibc|bits|loader)=(.*)$/.exec(line.trim())
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
  const target: HostFileTarget = musl ? `linux-${arch}-musl` : `linux-${arch}`
  if (kv.bits === '32') {
    throw new Error(`the host runs a 32-bit Linux (getconf LONG_BIT is 32) on a ${rawArch} kernel; the walnut file is built for 64-bit Linux only`)
  }
  // An older probe (or a test) has no loader line: only a line that is there can refuse.
  if (kv.loader !== undefined && !kv.loader.split(/\s+/).includes(LOADERS[target]!)) {
    throw new Error(`the host has no ${LOADERS[target]}, which the ${target} walnut file starts through: a 32-bit system, or one that keeps its loader elsewhere (as NixOS does), is not supported`)
  }
  return { target, describe: `Linux ${rawArch}, ${musl ? 'musl' : `glibc${glibc}`}` }
}
