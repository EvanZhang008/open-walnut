import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { cliCronRestoreConfig } from './daemon-cron-schedule.js'
import type { CronRestoreConfig } from './daemon-cron-transcript.js'
import type { CronProcessIdentity } from './daemon-cron-supervision.js'
import type { CronProcessProbe } from './daemon-cron-observer.js'

export function cliEnvTrue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

/**
 * Absolute wall-clock start of a live process, or null when the OS cannot say.
 *
 * Two sources, both already trusted elsewhere in the daemon. Linux publishes the
 * start as the /proc/<pid> directory's own mtime, stamped once when the process
 * is created (measured equal, to the second, to /proc/<pid>/stat field 22 plus
 * /proc/stat btime on a live CLI). macOS has no /proc, but the `ps -o lstart=`
 * string `defaultReadStartTime` records for pid identity IS an absolute date;
 * a Linux field-22 value is a bare tick count, so a digits-only string is
 * rejected rather than parsed into a nonsense year.
 *
 * `ps` reports whole seconds, so on macOS this floors the real start. Flooring is
 * the direction that keeps a job the process really created (a cron written in
 * the process's own first second still counts); the cost is that output written
 * by a PREVIOUS process inside that same second would be attributed here too.
 *
 * Sync on purpose: adoption builds its session record synchronously, and this is
 * one stat per adopted session at daemon startup.
 */
export function processStartedAtMs(pid: number | null | undefined, startTime: string | null | undefined): number | null {
  if (!pid || pid <= 1) return null
  const sane = (ms: number) => Number.isFinite(ms) && ms > 0 && ms <= Date.now() ? ms : null
  try {
    const ms = sane(statSync(`/proc/${pid}`).mtimeMs)
    if (ms !== null) return ms
  } catch { /* not Linux, or the process is gone */ }
  return startTime && !/^\d+$/.test(startTime.trim()) ? sane(Date.parse(startTime)) : null
}

function run(program: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, signal, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout.trim()))
  })
}

export async function readCronBootId(platform: string, signal: AbortSignal): Promise<string> {
  if (platform === 'linux') return (await fs.readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal })).trim()
  if (platform === 'darwin') return run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], signal)
  throw new Error('Cron supervision requires Linux or macOS')
}

export async function probeCronProcess(
  expected: CronProcessIdentity | null,
  bootId: string,
  platform: string,
  signal: AbortSignal,
): Promise<CronProcessProbe> {
  if (!expected || !bootId || !Number.isSafeInteger(expected.pid) || expected.pid <= 1) return { status: 'unknown' }
  if (expected.bootId !== bootId) return { status: 'dead' }
  const pid = expected.pid
  try {
    let startTime: string
    if (platform === 'linux') {
      const raw = await fs.readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal })
      const end = raw.lastIndexOf(')')
      const fields = raw.slice(end + 2).split(' ')
      if (end < 0 || fields.length < 20) return { status: 'unknown' }
      if (fields[0] === 'Z' || fields[0] === 'X') return { status: 'dead' }
      startTime = fields[19]
    } else if (platform === 'darwin') {
      startTime = await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], signal)
      if (!startTime) return { status: 'dead' }
    } else return { status: 'unknown' }
    // When the PID was reused, do not claim it is dead; the new process may be the same SID just adopted by another entry point.
    if (startTime !== expected.startTime) return { status: 'unknown' }
    return { status: 'alive', identity: { bootId, pid, startTime } }
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    if (e.code === 'ENOENT' && platform === 'linux') return { status: 'dead' }
    if (platform === 'darwin' && (e.code as unknown) === 1 && !signal.aborted
      && e.stdout === '' && e.stderr === '') return { status: 'dead' }
    return { status: 'unknown' }
  }
}

export async function readCronCliVersion(executable: string, signal: AbortSignal): Promise<string> {
  const output = await run(executable, ['--version'], signal)
  const match = output.match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/)
  if (!match) throw new Error('Unrecognized Claude Code version')
  return match[1]
}

export async function readCronCliConfig(
  home: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<CronRestoreConfig> {
  if (env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    throw new Error('Non-default CLI configuration is not verified for cron recovery')
  }
  if (cliEnvTrue(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN)) {
    return cliCronRestoreConfig({}, true)
  }
  const configDir = (env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')).normalize('NFC')
  if (!path.isAbsolute(configDir)) throw new Error('CLI configuration directory must be absolute')
  const candidates = [path.join(configDir, '.config.json'), path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')]
  let data: Record<string, unknown> = {}
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(candidate, { encoding: 'utf8', signal }))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid CLI configuration')
      data = parsed as Record<string, unknown>
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const features = data.cachedGrowthBookFeatures
  if (features !== undefined && (!features || typeof features !== 'object' || Array.isArray(features))) {
    throw new Error('Invalid cached CLI feature configuration')
  }
  return cliCronRestoreConfig((features ?? {}) as Record<string, unknown>, cliEnvTrue(env.CLAUDE_CODE_DISABLE_CRON))
}

export async function findCronTranscript(sid: string, cwd: string, claudeHome: string, signal: AbortSignal): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) throw new Error('Invalid session id')
  const projects = path.join(claudeHome, 'projects')
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const exists = async (candidate: string) => {
    signal.throwIfAborted()
    try { return (await fs.stat(candidate)).isFile() } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const direct = path.join(projects, encoded, `${sid}.jsonl`)
  if (encoded.length <= 200 && await exists(direct)) return direct
  let found: string | null = null
  for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(projects, entry.name, `${sid}.jsonl`)
    if (!await exists(candidate)) continue
    if (found) throw new Error('Multiple canonical transcripts match this session')
    found = candidate
  }
  if (!found) throw Object.assign(new Error('Canonical transcript is missing'), { code: 'ENOENT' })
  return found
}
