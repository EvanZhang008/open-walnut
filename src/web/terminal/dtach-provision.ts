/**
 * dtach provisioning: find or build a working `dtach` on the target host
 * (local or remote) and report the outcome as a typed DtachResolution.
 *
 * Why this exists: dtach is a tiny (~50KB) detach/reattach tool, but it is NOT
 * in the package repos of some managed dev hosts Walnut targets (verified: `yum
 * install dtach` said "No package dtach available"). So Walnut ships the dtach
 * 0.9 source embedded (see dtach-sources.ts) and compiles it on the target with
 * a single `cc *.c -lutil`, which builds cleanly on macOS and Linux. A Mac
 * without the Command Line Tools has no compiler, so the package also ships
 * prebuilt binaries (see dtach-prebuilt.ts, built by scripts/build-dtach.sh).
 *
 * Search order, local and remote alike:
 *   1. Walnut's own copy    local <WALNUT_HOME>/tmp/bin/walnut-dtach,
 *                           remote ~/.local/bin/walnut-dtach
 *   2. a system dtach       yum/apt/brew install, found on PATH
 *   3. the shipped prebuilt for this platform/arch, installed into the path
 *      from step 1 once it passes `--help` there
 *   4. compile the vendored source into the path from step 1
 *   5. none: `no_compiler`, or `build_failed` with the compiler's stderr
 * Remote steps 1, 2 and the compiler check share ONE ssh round trip; steps 3
 * and 4 share the second. See dtach-probe-script.ts for the scripts and the
 * ssh-vs-compiler rule.
 *
 * The local cache lives under tmp/ because it is a platform-specific COMPILED
 * artifact: rebuildable in ~1s from the embedded source, and actively wrong for
 * any other architecture. It used to sit at <WALNUT_HOME>/bin/, inside the synced
 * data repo, so a Mac-built arm64 binary reached a Linux box as an exec-format
 * error. A missing cache just recompiles, so the move costs nothing.
 *
 * A failed provision no longer blocks the terminal: the caller opens a LOUD,
 * clearly labelled non-persistent shell instead (see dtach-check.ts).
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { TMP_DIR } from '../../constants.js'
import { resolveSshTarget, sshControlMasterArgs } from './spawn.js'
import { DTACH_SOURCES, DTACH_VERSION } from './dtach-sources.js'
import {
  ALL_FILES,
  C_FILES,
  DTACH_BANNER,
  buildInstallScript,
  buildProbeScript,
  classifyScriptRun,
  parseHostPlatform,
  toHostOs,
  type DtachResolution,
  type ScriptRun,
} from './dtach-probe-script.js'
import { readPrebuiltDtach } from './dtach-prebuilt.js'
import { log } from '../../logging/index.js'

export type { DtachResolution, DtachSource, HostOs } from './dtach-probe-script.js'

const PROVISION_TIMEOUT_MS = 30_000
/**
 * How long a FAILED resolution is reused. Long enough to absorb the prewarm
 * (panel mount) + open (click) pair so they share one ssh probe, short enough
 * that any later open re-probes. Retry skips it entirely (`fresh`).
 */
const FAILURE_TTL_MS = 10_000
/** Local cache path, under tmp/ (gitignored): a compiled, per-arch artifact. */
const LOCAL_BIN = path.join(TMP_DIR, 'bin', 'walnut-dtach')
/** This machine's OS, for the local fix command. */
const LOCAL_OS = toHostOs(process.platform)
/** Fixed dirs that back up `which dtach` when the server's PATH is minimal. */
const LOCAL_SYSTEM_CANDIDATES = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/usr/bin/dtach']

function run(cmd: string, args: string[], opts: { timeout?: number; input?: string; cwd?: string } = {}): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const execOpts = { timeout: opts.timeout ?? PROVISION_TIMEOUT_MS, encoding: 'utf-8' as const, maxBuffer: 8 * 1024 * 1024, cwd: opts.cwd }
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(cmd, args, execOpts, (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null
        const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: Boolean(e?.killed) })
      })
    } catch (err) {
      // execFile THROWS (instead of calling back) for a file the kernel can't
      // exec, e.g. `spawn ENOEXEC` on a corrupt prebuilt: an answer, not a crash.
      resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    if (opts.input !== undefined) {
      // ssh can exit before draining stdin (auth failure); an EPIPE on this
      // stream is then expected and must not become an uncaught error.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.input)
    }
  })
}

export class DtachProvisionError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'DtachProvisionError'
  }
}

// ---- cache ------------------------------------------------------------------

interface CacheEntry {
  promise: Promise<DtachResolution>
  /** Set once the promise settles; unset while in flight. */
  settledAt?: number
  ok?: boolean
}

/** key = host alias, or '' for local. Success is kept for the process life. */
const cache = new Map<string, CacheEntry>()

function cached(key: string, fresh: boolean, compute: () => Promise<DtachResolution>): Promise<DtachResolution> {
  const hit = cache.get(key)
  if (hit) {
    const inFlight = hit.settledAt === undefined
    const failureStillWarm = !hit.ok && !fresh && Date.now() - (hit.settledAt ?? 0) < FAILURE_TTL_MS
    // In flight: coalesce even a `fresh` caller, the probe is already new.
    if (inFlight || hit.ok || failureStillWarm) return hit.promise
  }
  const entry = {} as CacheEntry
  entry.promise = compute().then((r) => {
    entry.settledAt = Date.now()
    entry.ok = r.kind === 'ok'
    return r
  })
  cache.set(key, entry)
  return entry.promise
}

/** Test seam: forget every cached resolution. */
export function resetDtachCacheForTests(): void {
  cache.clear()
}

/**
 * Forget one host's cached resolution ('' = local), so the next terminal open
 * probes again. Called when host.fix built dtach or installed a compiler there:
 * a cached `no_compiler` would otherwise answer the open that follows. An
 * in-flight probe keeps running for its callers; the next caller starts fresh.
 */
export function invalidateDtachCache(host: string): void {
  cache.delete(host)
}

/** Human one-liner for a non-ok resolution (errors and logs). */
export function describeResolution(r: DtachResolution, host?: string): string {
  const where = host ?? 'this machine'
  switch (r.kind) {
    case 'ok': return `dtach at ${r.path} (${r.source})`
    case 'ssh_failed': return `ssh to ${where} failed (exit ${r.exitCode})`
    case 'no_compiler': return `No C compiler on ${where} (need cc/gcc/clang to build dtach)`
    case 'build_failed': return `Failed to build dtach on ${where}`
  }
}

function unwrap(r: DtachResolution, host?: string): string {
  if (r.kind === 'ok') return r.path
  throw new DtachProvisionError(describeResolution(r, host), 'stderr' in r ? r.stderr : undefined)
}

// ---- LOCAL ------------------------------------------------------------------

/** Resolve dtach locally. `fresh` skips a still-warm cached failure. */
export function resolveLocalDtach(opts: { fresh?: boolean } = {}): Promise<DtachResolution> {
  return cached('', Boolean(opts.fresh), async () => {
    try {
      return await provisionLocal()
    } catch (err) {
      return { kind: 'build_failed', stderr: err instanceof Error ? err.message : String(err), os: LOCAL_OS }
    }
  })
}

/** Local dtach path, or a DtachProvisionError when none can be had. */
export async function localDtachPath(): Promise<string> {
  return unwrap(await resolveLocalDtach())
}

async function provisionLocal(): Promise<DtachResolution> {
  if (await isRunnable(LOCAL_BIN)) return { kind: 'ok', path: LOCAL_BIN, source: 'walnut' }

  const which = await run('which', ['dtach'])
  const onPath = which.code === 0 ? which.stdout.trim().split('\n')[0] : ''
  for (const cand of [onPath, ...LOCAL_SYSTEM_CANDIDATES]) {
    if (cand && (await isRunnable(cand, { requireWinch: true }))) {
      log.web.info('dtach found (local, system)', { path: cand })
      return { kind: 'ok', path: cand, source: 'system' }
    }
  }

  const prebuilt = await installLocalPrebuilt()
  if (prebuilt) return prebuilt

  const cc = await firstAvailable(['cc', 'gcc', 'clang'])
  if (!cc) return { kind: 'no_compiler', os: LOCAL_OS }

  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-dtach-build-'))
  try {
    for (const f of ALL_FILES) {
      const b64 = DTACH_SOURCES[f]
      if (!b64) throw new Error(`Vendored dtach source missing: ${f}`)
      await fs.writeFile(path.join(srcDir, f), Buffer.from(b64, 'base64'))
    }
    await fs.mkdir(path.dirname(LOCAL_BIN), { recursive: true })
    // Compile from inside the temp dir so `-I.` and the bare *.c names resolve.
    const res = await run(cc, ['-O2', '-I.', '-o', LOCAL_BIN, ...C_FILES, '-lutil'], { cwd: srcDir })
    if (res.code !== 0 || !(await isRunnable(LOCAL_BIN))) {
      log.web.warn('dtach local build failed', { cc, code: res.code, stderr: res.stderr.slice(-400) })
      return { kind: 'build_failed', stderr: (res.stderr || res.stdout).trim().slice(-2000), os: LOCAL_OS }
    }
    log.web.info('dtach provisioned (local)', { path: LOCAL_BIN, version: DTACH_VERSION })
    return { kind: 'ok', path: LOCAL_BIN, source: 'built' }
  } finally {
    await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Step 3: the shipped prebuilt for this machine, copied to a temp name, checked,
 * then renamed into LOCAL_BIN. Null (fall through to compiling) when there is
 * none or it fails `--help` here. The bytes are written fresh instead of
 * copyFile'd so the copy carries no extended attributes from the package dir.
 */
async function installLocalPrebuilt(): Promise<DtachResolution | null> {
  const found = await readPrebuiltDtach(process.platform, process.arch)
  if (!found) return null
  const tmp = `${LOCAL_BIN}.prebuilt-${process.pid}`
  try {
    await fs.mkdir(path.dirname(LOCAL_BIN), { recursive: true })
    await fs.writeFile(tmp, found.bytes)
    await fs.chmod(tmp, 0o755)
    if (await isRunnable(tmp)) {
      await fs.rename(tmp, LOCAL_BIN)
      log.web.info('dtach provisioned (local, prebuilt)', { path: LOCAL_BIN, from: found.path, version: DTACH_VERSION })
      return { kind: 'ok', path: LOCAL_BIN, source: 'prebuilt' }
    }
    log.web.warn('dtach prebuilt failed its --help check, compiling instead', { from: found.path })
  } catch (err) {
    log.web.warn('dtach prebuilt install failed, compiling instead', { from: found.path, error: err instanceof Error ? err.message : String(err) })
  }
  await fs.rm(tmp, { force: true }).catch(() => {})
  return null
}

async function firstAvailable(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    const w = await run('which', [c])
    if (w.code === 0 && w.stdout.trim()) return c
  }
  return null
}

/** Same predicate as the remote `is_dtach` / `is_modern_dtach` shell helpers. */
async function isRunnable(p: string, opts: { requireWinch?: boolean } = {}): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK)
  } catch {
    return false
  }
  const res = await run(p, ['--help'])
  const help = (res.stdout + res.stderr).toLowerCase()
  // Require the "dtach - version" banner so a foreign binary that merely prints
  // "Usage:" can't pass, nor an error that just names the walnut-dtach file; a
  // system build must also know `-r winch`, which spawn always passes.
  return help.includes(DTACH_BANNER) && (!opts.requireWinch || help.includes('winch'))
}

// ---- REMOTE -----------------------------------------------------------------

/** Resolve dtach on a remote host. `fresh` skips a still-warm cached failure. */
export function resolveRemoteDtach(host: string, opts: { fresh?: boolean } = {}): Promise<DtachResolution> {
  return cached(host, Boolean(opts.fresh), async () => {
    try {
      return await provisionRemote(host)
    } catch (err) {
      // resolveSshTarget throws for an unknown alias: that is an ssh problem
      // (nothing ran on the host), so it must not read as a compiler problem.
      return { kind: 'ssh_failed', exitCode: -1, stderr: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Remote dtach path, or a DtachProvisionError when none can be had. */
export async function remoteDtachPath(host: string): Promise<string> {
  return unwrap(await resolveRemoteDtach(host), host)
}

/** ssh argv for `sh -s` on a host, over the shared ControlMaster. */
async function sshArgsFor(host: string): Promise<string[]> {
  const target = await resolveSshTarget(host)
  const hostString = target.user ? `${target.user}@${target.hostname}` : target.hostname
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', ...sshControlMasterArgs(host)]
  if (target.port) args.push('-p', String(target.port))
  args.push(hostString, 'sh -s')
  return args
}

async function provisionRemote(host: string): Promise<DtachResolution> {
  const args = await sshArgsFor(host)
  // Round trip 1 (also warms the ControlMaster the spawn reuses).
  const probeRun = await run('ssh', args, { input: buildProbeScript() })
  const probe = classifyScriptRun(probeRun)
  if (probe.kind !== 'need_build' && probe.kind !== 'no_compiler') {
    logRemote(host, probe)
    return probe
  }
  // A shipped prebuilt for the host's uname beats compiling, and is the only
  // way in for a host with no compiler (a Mac without the Command Line Tools).
  const platform = parseHostPlatform(probeRun.stdout)
  const prebuilt = await readPrebuiltDtach(platform.os, platform.arch)
  if (!prebuilt && probe.kind === 'no_compiler') {
    logRemote(host, probe, { arch: platform.arch })
    return probe
  }
  const cc = probe.kind === 'need_build' ? probe.cc : undefined
  // Round trip 2, once per host: ship the prebuilt and/or the source.
  const script = buildInstallScript({ prebuilt: prebuilt?.bytes, cc, sources: DTACH_SOURCES })
  const installRun = await run('ssh', args, { input: script })
  const installed = classifyScriptRun(installRun)
  const result: DtachResolution = installed.kind === 'need_build'
    ? { kind: 'build_failed', stderr: 'install script asked for another build', os: 'unknown' }
    : installed
  const prebuiltFailed = prebuilt && /^PREBUILT_FAILED$/m.test(installRun.stdout)
  logRemote(host, result, {
    cc,
    arch: platform.arch,
    prebuilt: prebuilt ? (prebuiltFailed ? 'failed' : 'offered') : undefined,
    prebuiltError: prebuiltFailed ? installRun.stderr.match(/^prebuilt dtach does not run.*$/m)?.[0]?.slice(0, 400) : undefined,
  })
  return result
}

function logRemote(host: string, r: DtachResolution, extra: Record<string, string | undefined> = {}): void {
  if (r.kind === 'ok') {
    log.web.info('dtach resolved (remote)', { host, path: r.path, source: r.source, ...extra, version: DTACH_VERSION })
  } else {
    log.web.warn('dtach remote provision failed', { host, kind: r.kind, ...extra, detail: 'stderr' in r ? r.stderr.slice(-400) : undefined })
  }
}
