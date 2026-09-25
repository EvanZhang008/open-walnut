/**
 * The prebuilt dtach the npm package ships in dist/daemon-binaries, built by
 * scripts/build-dtach.sh on the maintainer's machine (which has a compiler), so
 * a Mac without the Xcode Command Line Tools still gets a persistent terminal.
 *
 * Names follow Node's platform/arch words: dtach-darwin-arm64, dtach-darwin-x64,
 * dtach-linux-x64, dtach-linux-arm64. A remote host reports `uname -s`/`uname -m`
 * instead, so both vocabularies map to the same name. Whatever is found here is
 * only a CANDIDATE: the caller copies it into place and runs `--help` before
 * trusting it (a Linux prebuilt linked against a newer glibc will not start on an
 * older host), and compiling from source stays the fallback.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_BINARIES_DIR } from '../../constants.js'

/** Refuse to ship anything larger over ssh: a static Linux dtach is under 1MB. */
const MAX_PREBUILT_BYTES = 2 * 1024 * 1024

function normalizePlatform(p: string | undefined): 'darwin' | 'linux' | null {
  if (!p) return null
  if (/^darwin$/i.test(p)) return 'darwin'
  if (/^linux$/i.test(p)) return 'linux'
  return null
}

function normalizeArch(a: string | undefined): 'arm64' | 'x64' | null {
  if (!a) return null
  if (/^(arm64|aarch64)$/i.test(a)) return 'arm64'
  if (/^(x64|x86_64|amd64)$/i.test(a)) return 'x64'
  return null
}

/**
 * Prebuilt file name for a platform + arch in either vocabulary (Node's
 * `process.platform`/`process.arch`, or `uname -s`/`uname -m`). Null when no
 * prebuilt could exist for it.
 */
export function prebuiltDtachName(platform: string | undefined, arch: string | undefined): string | null {
  const p = normalizePlatform(platform?.trim())
  const a = normalizeArch(arch?.trim())
  return p && a ? `dtach-${p}-${a}` : null
}

/** Absolute path of the shipped prebuilt for this platform/arch, or null. */
export async function findPrebuiltDtach(
  platform: string | undefined,
  arch: string | undefined,
  dir: string = DAEMON_BINARIES_DIR,
): Promise<string | null> {
  const name = prebuiltDtachName(platform, arch)
  if (!name) return null
  const p = path.join(dir, name)
  try {
    const st = await fs.stat(p)
    return st.isFile() && st.size > 0 && st.size <= MAX_PREBUILT_BYTES ? p : null
  } catch {
    return null
  }
}

/** The prebuilt's bytes, or null when there is none for this platform/arch. */
export async function readPrebuiltDtach(
  platform: string | undefined,
  arch: string | undefined,
  dir: string = DAEMON_BINARIES_DIR,
): Promise<{ path: string; bytes: Buffer } | null> {
  const p = await findPrebuiltDtach(platform, arch, dir)
  if (!p) return null
  try {
    return { path: p, bytes: await fs.readFile(p) }
  } catch {
    return null
  }
}
