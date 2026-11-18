/**
 * Run one POSIX sh script on a terminal's host: the ONE way the terminal's steps
 * other than its pty reach a host (dtach's probe and install, the lifecycle's
 * master probes, stops and orphan sweep, the prewarm through them). Which way the
 * script goes is resolveTerminalRoute's decision (spawn.ts), the same one the
 * spawn follows:
 *
 *   this machine   `bash -c <script>`, as the lifecycle always ran it
 *   an SSH route   ssh over the terminal's shared ControlMaster, as before:
 *                  `sh -s` with the script on stdin (dtach's provisioning), or the
 *                  script as ssh's command, run by the login shell (`command`) or
 *                  by /bin/sh (`posix`, a dtach-master.ts script)
 *   any other host its daemon link: `exec.script` ('host-script-v1',
 *                  core/hosts/host-script.ts), which runs `sh -s` with the script on
 *                  stdin there and answers stdout and stderr apart. A script over
 *                  exec.script's 1 MB (an install script carrying a large prebuilt)
 *                  is written to the host first (fs.writePart) and run from there.
 *
 * A run never throws: its exit code, stdout, stderr and whether it timed out, as
 * execFile gives them. A link that cannot carry it answers 255 with the reason in
 * stderr, as ssh does for a connection it could not make. Only the route throws
 * (an unknown host, a host a test server may not touch).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { shellQuote, sshAliasOptions, sshDestination } from '../../providers/session-io.js'
import { resolveTerminalRoute, sshControlMasterArgs } from './terminal-route.js'

export interface HostShellRun {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface HostShellOptions {
  timeoutMs: number
  /** How ssh carries it: stdin to `sh -s`, the login shell's command, or a /bin/sh command. */
  ssh: 'stdin' | 'command' | 'posix'
}

/** ssh's own status for a connection it could not make (ssh(1)); a link's failure reads the same. */
export const TRANSPORT_FAILED = 255
const MAX_BUFFER = 8 * 1024 * 1024
/** exec.script's own cap (providers/host-script-core.ts SCRIPT_MAX_BYTES), less room for its frame. */
const LINK_SCRIPT_MAX_BYTES = 1024 * 1024 - 4096

/**
 * One program on this machine, bounded (ssh, bash, and dtach-provision.ts's which, cc and
 * `dtach --help`): its exit code and output, never a throw. execFile THROWS (instead of
 * calling back) for a file the kernel cannot exec, e.g. `spawn ENOEXEC` on a corrupt
 * prebuilt: an answer, not a crash.
 */
export function runProgram(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string; input?: string }): Promise<HostShellRun> {
  const { timeoutMs, cwd, input } = opts
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: MAX_BUFFER, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null
        const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: Boolean(e?.killed) })
      })
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false })
      return
    }
    if (input !== undefined) {
      // ssh can exit before draining stdin (auth failure): an EPIPE then is expected.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

/** Run `script` on `host` (undefined: this machine). */
export async function runOnTerminalHost(host: string | undefined, script: string, opts: HostShellOptions): Promise<HostShellRun> {
  if (!host) return runProgram('bash', ['-c', script], { timeoutMs: opts.timeoutMs })
  const route = await resolveTerminalRoute(host)
  if (route.via === 'link') return runOverLink(host, script, opts.timeoutMs)
  const target = route.target
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', ...sshAliasOptions(target), ...sshControlMasterArgs(host)]
  if (target.port) args.push('-p', String(target.port))
  if (opts.ssh === 'stdin') return runProgram('ssh', [...args, sshDestination(target), 'sh -s'], { timeoutMs: opts.timeoutMs, input: script })
  // zsh (a common login shell) does not split an unquoted `$owners` into words: a
  // dtach-master.ts script runs under /bin/sh instead.
  return runProgram('ssh', [...args, sshDestination(target), opts.ssh === 'posix' ? `/bin/sh -c ${shellQuote(script)}` : script], { timeoutMs: opts.timeoutMs })
}

async function runOverLink(host: string, script: string, timeoutMs: number): Promise<HostShellRun> {
  const { runScriptOnHost } = await import('../../core/hosts/host-script.js')
  let staged: string | null = null
  try {
    let input = { script, args: [] as string[], timeoutMs, maxOutputBytes: MAX_BUFFER }
    if (Buffer.byteLength(script) > LINK_SCRIPT_MAX_BYTES) {
      staged = `/tmp/walnut-term-script-${randomBytes(8).toString('hex')}.sh`
      const { writeFileInParts } = await import('../../core/transfer/daemon-transfer-client.js')
      await writeFileInParts(host, staged, Buffer.from(script))
      input = { ...input, script: 'f=$1; sh "$f"; rc=$?; rm -f "$f"; exit $rc', args: [staged] }
    }
    const r = await runScriptOnHost(host, input)
    // The script removed it, unless it was stopped first (timed out): then the finally does.
    if (!r.timedOut) staged = null
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
  } catch (err) {
    return { code: TRANSPORT_FAILED, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false }
  } finally {
    // A script written whose run did not finish (never sent, its answer lost, timed out):
    // removed with a short run of its own, best-effort.
    if (staged) void runScriptOnHost(host, { script: `rm -f ${shellQuote(staged)}`, args: [], timeoutMs: 10_000, maxOutputBytes: 1024 }).catch(() => {})
  }
}

/**
 * A host reached over its daemon link can run a terminal script now: connected, with a daemon
 * that runs scripts. Never dials (the orphan sweep asks it so it neither dials nor fails on
 * every start for a host whose link is down).
 */
export async function hostLinkRunsScripts(host: string): Promise<boolean> {
  try {
    const [{ getConnectedDaemonConnection }, { HOST_SCRIPT_CAPABILITY }] = await Promise.all([
      import('../../providers/daemon-connection.js'), import('../../core/hosts/host-script.js'),
    ])
    return getConnectedDaemonConnection(host)?.hasCapability(HOST_SCRIPT_CAPABILITY) === true
  } catch {
    return false
  }
}
