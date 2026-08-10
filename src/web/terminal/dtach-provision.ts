/**
 * dtach provisioning — ensure a working `dtach` binary exists on the target
 * host (local or remote) and return its path.
 *
 * Why this exists: dtach is a tiny (~50KB) detach/reattach tool, but it is NOT
 * in the package repos of some managed dev hosts Walnut targets (verified: `yum
 * install dtach` → "No package dtach available"). Rather than make the user
 * hand-install it, we ship the dtach 0.9 source embedded (see dtach-sources.ts)
 * and compile it on the target on demand with a single `gcc *.c -lutil` — which
 * builds cleanly on both macOS and Linux (verified). The compiled binary is
 * cached so this cost is paid once per host.
 *
 *   - local:  cached at  <WALNUT_HOME>/tmp/bin/walnut-dtach
 *   - remote: cached at  ~/.local/bin/walnut-dtach   (on the remote host)
 *
 * The local cache lives under tmp/ because it is a platform-specific COMPILED
 * artifact: rebuildable in ~1s from the embedded source, and actively wrong for
 * any other architecture. It used to sit at <WALNUT_HOME>/bin/, inside the synced
 * data repo, so a Mac-built arm64 binary reached a Linux box as an exec-format
 * error. A missing cache just recompiles, so the move costs nothing.
 *
 * If compilation is impossible (no compiler), provisioning fails and the caller
 * surfaces a NO_DTACH install-hint card — never a silent state-losing shell.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { TMP_DIR } from '../../constants.js'
import { shellQuote } from '../../providers/session-io.js'
import { resolveSshTarget, sshControlMasterArgs } from './spawn.js'
import { DTACH_SOURCES, DTACH_VERSION } from './dtach-sources.js'
import { log } from '../../logging/index.js'

const PROVISION_TIMEOUT_MS = 30_000
/** Remote cache path (under the remote user's home). */
const REMOTE_BIN = '.local/bin/walnut-dtach'
/** Local cache path — under tmp/ (gitignored): a compiled, per-arch artifact. */
const LOCAL_BIN = path.join(TMP_DIR, 'bin', 'walnut-dtach')

/** dtach source filenames, in link order (headers excluded from the gcc line). */
const C_FILES = ['attach.c', 'main.c', 'master.c']
const ALL_FILES = [...C_FILES, 'dtach.h', 'config.h']

function run(cmd: string, args: string[], opts: { timeout?: number; input?: string; cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeout ?? PROVISION_TIMEOUT_MS, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, cwd: opts.cwd }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

/** Raw base64 of a vendored source file, with a missing-file guard. */
function rawSource(name: string): string {
  const b64 = DTACH_SOURCES[name]
  if (!b64) throw new DtachProvisionError(`Vendored dtach source missing: ${name}`)
  return b64
}

function decode(name: string): string {
  return Buffer.from(rawSource(name), 'base64').toString('utf-8')
}

export class DtachProvisionError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'DtachProvisionError'
  }
}

// ---- LOCAL ----------------------------------------------------------------

let localCache: Promise<string> | null = null

/**
 * Ensure dtach exists locally; return its path. Cached after first success.
 * Known limitation: if the cached binary is deleted out-of-band after the first
 * success, we keep returning the stale path until the process restarts. We
 * accept this — re-`access`ing on every open is cheap locally but adds little
 * value (provisioning re-runs on the next process start), and the remote cache
 * deliberately avoids a re-probe to preserve the warm-ControlMaster purpose.
 */
export function localDtachPath(): Promise<string> {
  if (!localCache) {
    localCache = provisionLocal().catch((err) => {
      localCache = null // allow retry on next call
      throw err
    })
  }
  return localCache
}

async function provisionLocal(): Promise<string> {
  // Already cached + runnable?
  if (await isRunnable(LOCAL_BIN)) return LOCAL_BIN

  const cc = await firstAvailable(['cc', 'gcc', 'clang'])
  if (!cc) throw new DtachProvisionError('No C compiler found locally (need cc/gcc/clang)')

  const srcDir = path.join(os.tmpdir(), `walnut-dtach-build-${process.pid}`)
  await fs.mkdir(srcDir, { recursive: true })
  try {
    for (const f of ALL_FILES) await fs.writeFile(path.join(srcDir, f), decode(f))
    await fs.mkdir(path.dirname(LOCAL_BIN), { recursive: true })
    // Compile from inside the temp dir so the relative `-I.` and *.c names
    // resolve (and config.h is found alongside them).
    const res = await run(cc, ['-O2', '-I.', '-o', LOCAL_BIN, ...C_FILES, '-lutil'], { timeout: PROVISION_TIMEOUT_MS, cwd: srcDir })
    if (res.code !== 0 || !(await isRunnable(LOCAL_BIN))) {
      throw new DtachProvisionError('Local dtach compile failed', res.stderr || res.stdout)
    }
    log.web.info('dtach provisioned (local)', { path: LOCAL_BIN, version: DTACH_VERSION })
    return LOCAL_BIN
  } finally {
    await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function firstAvailable(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    const w = await run('which', [c])
    if (w.code === 0 && w.stdout.trim()) return c
  }
  return null
}

async function isRunnable(p: string): Promise<boolean> {
  try {
    await fs.access(p, (await import('node:fs')).constants.X_OK)
  } catch {
    return false
  }
  const res = await run(p, ['--help'])
  // dtach --help exits non-zero but its usage always mentions "dtach"
  // (e.g. "dtach - version 0.9"). Require that string so a half-built or
  // foreign binary that merely prints "Usage:" can't pass.
  return /dtach/i.test(res.stdout + res.stderr)
}

// ---- REMOTE ---------------------------------------------------------------

/** host alias → resolved remote dtach path. Cached after first success. */
const remoteCache = new Map<string, Promise<string>>()

/** Ensure dtach exists on a remote host; return its (remote) path. */
export function remoteDtachPath(host: string): Promise<string> {
  let p = remoteCache.get(host)
  if (!p) {
    p = provisionRemote(host).catch((err) => {
      remoteCache.delete(host) // allow retry
      throw err
    })
    remoteCache.set(host, p)
  }
  return p
}

/** Build the ssh argv for a one-off remote command (shared ControlMaster). */
async function sshArgsFor(host: string, remoteCmd: string): Promise<string[]> {
  const target = await resolveSshTarget(host)
  const hostString = target.user ? `${target.user}@${target.hostname}` : target.hostname
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', ...sshControlMasterArgs(host)]
  if (target.port) args.push('-p', String(target.port))
  args.push(hostString, remoteCmd)
  return args
}

async function provisionRemote(host: string): Promise<string> {
  // 1. Already provisioned + runnable on the remote? (Cheap check; also warms
  //    the ControlMaster connection the spawn reuses.)
  const probe = `B="$HOME/${REMOTE_BIN}"; if [ -x "$B" ] && "$B" --help 2>&1 | grep -qi dtach; then echo "DTACH_OK:$B"; else echo NEED_BUILD; fi`
  const probeRes = await run('ssh', await sshArgsFor(host, probe))
  if (/DTACH_OK:/.test(probeRes.stdout)) {
    const p = probeRes.stdout.match(/DTACH_OK:(.*)/)?.[1]?.trim()
    if (p) {
      log.web.info('dtach already present (remote)', { host, path: p })
      return p
    }
  }

  // 2. Need to build. Ensure a compiler exists first so we can give a precise
  //    error instead of a confusing gcc-not-found.
  const ccProbe = 'for c in cc gcc clang; do command -v "$c" >/dev/null 2>&1 && { echo "CC:$c"; break; }; done; echo "END"'
  const ccRes = await run('ssh', await sshArgsFor(host, ccProbe))
  const cc = ccRes.stdout.match(/CC:(\w+)/)?.[1]
  if (!cc) {
    throw new DtachProvisionError(`No C compiler on ${host} (need cc/gcc/clang to build dtach)`)
  }

  // 3. Ship the source as a single base64 tar-free blob: write each file via a
  //    heredoc-free `base64 -d` pipe, then compile. We pack all sources into one
  //    shell script fed over stdin to a single ssh invocation (one round-trip).
  const buildDir = '/tmp/walnut-dtach-build'
  const lines: string[] = [
    'set -e',
    `rm -rf ${buildDir}`,
    `mkdir -p ${buildDir}`,
    `mkdir -p "$HOME/$(dirname ${REMOTE_BIN})"`,
    `cd ${buildDir}`,
  ]
  for (const f of ALL_FILES) {
    const b64 = rawSource(f) // guards missing files, same as the local decode() path
    // base64 payload has no shell metacharacters; echo it through base64 -d.
    lines.push(`printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(f)}`)
  }
  lines.push(`${cc} -O2 -I. -o "$HOME/${REMOTE_BIN}" ${C_FILES.join(' ')} -lutil`)
  lines.push(`"$HOME/${REMOTE_BIN}" --help 2>&1 | grep -qi dtach && echo "BUILT:$HOME/${REMOTE_BIN}"`)
  lines.push(`rm -rf ${buildDir}`)
  const script = lines.join('\n')

  const buildRes = await run('ssh', await sshArgsFor(host, 'bash -s'), { input: script, timeout: PROVISION_TIMEOUT_MS })
  const builtPath = buildRes.stdout.match(/BUILT:(.*)/)?.[1]?.trim()
  if (!builtPath) {
    log.web.warn('dtach remote provision failed', { host, cc, code: buildRes.code, stderr: buildRes.stderr.slice(-400) })
    throw new DtachProvisionError(`Failed to build dtach on ${host}`, buildRes.stderr || buildRes.stdout)
  }
  log.web.info('dtach provisioned (remote)', { host, path: builtPath, cc, version: DTACH_VERSION })
  return builtPath
}
