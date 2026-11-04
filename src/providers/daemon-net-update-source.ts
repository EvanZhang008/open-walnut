/**
 * Where a host network machine's daemon update comes from (daemon-net-update.ts): this build's
 * prebuilt daemon binary for the host's target, else (a compiled server, which ships none) the
 * host's walnut file of this build.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { singleFile } from '../lib/single-file.js'
import type { HostFileTarget } from '../core/host-server/host-target.js'

export type NetUpdateSource = { file: string } | { gz: Buffer; id: string }

/** This build's prebuilt daemon binary for the target (scripts/build-daemon.sh; none for musl), checked against the build it must be. */
export async function localDaemonBinary(t: HostFileTarget, expected: string, dir = DAEMON_BINARIES_DIR): Promise<{ file: string } | { missing: string }> {
  if (t.endsWith('-musl')) return { missing: `no daemon binary is built for ${t}` }
  const file = path.join(dir, `daemon-${t}`)
  const st = await fsp.stat(file).catch(() => null)
  if (!st?.isFile()) return { missing: `this build has no daemon binary for ${t}` }
  const built = await fsp.readFile(`${file}.version`, 'utf8').then((v) => v.trim(), () => null)
  if (built && built !== expected) return { missing: `this build's daemon-${t} is ${built}, not ${expected}; rebuild the daemon` }
  return { file }
}

export interface NetSourceDeps {
  dir?: string
  /** This server is the compiled walnut file (singleFile()): it ships no daemon binaries. */
  compiled?: () => boolean
  /** This build's walnut file for the target (host-file.ts sharedHostFileSource). */
  hostFile?: (t: HostFileTarget, say: (message: string) => void) => Promise<{ gz: Buffer; id: string }>
}

/**
 * Where the daemon for the target comes from: the prebuilt binary, else (a compiled
 * server) the host's walnut file of this build, the same one the SSH path deploys.
 * Getting that file may download or build it once per build (host-file.ts caches it).
 */
export async function netDaemonSource(t: HostFileTarget, expected: string, say: (message: string) => void = () => {}, deps: NetSourceDeps = {}): Promise<NetUpdateSource | { missing: string }> {
  const prebuilt = await localDaemonBinary(t, expected, deps.dir)
  if ('file' in prebuilt) return prebuilt
  if (!(deps.compiled ?? (() => singleFile() !== null))()) return prebuilt
  try {
    const f = await (deps.hostFile ?? defaultHostFile)(t, say)
    if (!f.gz.length) return { missing: `this build's walnut file for ${t} is empty` }
    return { gz: f.gz, id: f.id }
  } catch (err) {
    return { missing: `this build's walnut file for ${t} is not to be had: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function defaultHostFile(t: HostFileTarget, say: (message: string) => void): Promise<{ gz: Buffer; id: string }> {
  const { sharedHostFileSource } = await import('../core/host-server/index.js')
  return sharedHostFileSource().file(t, say)
}
