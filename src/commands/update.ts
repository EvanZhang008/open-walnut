/**
 * `walnut update`: is a newer open-walnut published, and install it.
 *
 * Updates the install THIS command runs from (not whatever server happens to be
 * on :3456): the CLI and the server are the same package, and the install kind
 * is read off this process's own path (src/core/self-update/install-kind.ts).
 *
 *   - npm/pnpm/bun/yarn install: ask the registry, then run that manager's
 *     global install with inherited stdio, so its own progress and prompts show.
 *     A running server keeps the old code until it is restarted; say so.
 *   - source checkout: print the git steps and do nothing. The developer owns
 *     that tree (an unexpected pull over local work is worse than no update).
 *   - cloud replica / unpacked bundle: say where the update comes from.
 *
 * `--check` only reports. `--channel stable|nightly` follows that dist-tag
 * instead of the installed version's own channel (a nightly build follows
 * `nightly`, a release follows `latest`). Exit 0 when the question was answered
 * (newer or not), 1 when the registry could not be reached, the installer's
 * code when it failed.
 */

import { spawn } from 'node:child_process'
import type { GlobalOptions } from '../core/types.js'
import type { UpdateChannel, UpdateStatus } from '../core/self-update/update-check.js'
import { managerArgv } from '../core/self-update/install-kind.js'
import { apiBaseUrl } from '../utils/api-client.js'

export interface UpdateOptions {
  /** Report only; never install. */
  check?: boolean
  channel?: string
}

export function parseChannel(raw: string | undefined): UpdateChannel | undefined {
  if (raw === undefined) return undefined
  if (raw === 'stable' || raw === 'nightly') return raw
  throw new Error(`--channel must be stable or nightly, not "${raw}"`)
}

export interface UpdatePlan {
  /** What to print before (and instead of) installing. */
  lines: string[]
  /** The installer to run; absent when there is nothing to run. */
  install?: { file: string; args: string[] }
  exitCode: number
}

export function planUpdate(status: UpdateStatus, opts: { check: boolean }): UpdatePlan {
  const { install } = status
  if (install.kind === 'source') {
    const dir = install.sourceDir ?? 'the checkout'
    return {
      exitCode: 0,
      lines: [
        `Open Walnut ${status.current} here runs from a source checkout (${dir}), so it updates with git:`,
        `  cd ${dir} && git pull && npm run build`,
        'Then restart the server.',
      ],
    }
  }
  if (install.kind === 'replica') {
    return { exitCode: 0, lines: ['This is a cloud replica. Update the primary console, then redeploy the replica with the cloud scripts.'] }
  }
  if (!status.enabled) {
    return { exitCode: 0, lines: [`The update check is off here (${status.reason ?? 'disabled'}). Releases: ${status.packageUrl}`] }
  }
  if (!status.latest) {
    return { exitCode: 1, lines: [`Could not reach the npm registry: ${status.error ?? 'no answer'}. Releases: ${status.packageUrl}`] }
  }
  const onChannel = status.channel === 'nightly' ? ' on the nightly channel' : ''
  if (!status.available) {
    const other = status.channel === 'nightly' ? status.tags.latest : status.tags.nightly
    const otherName = status.channel === 'nightly' ? 'stable' : 'nightly'
    return {
      exitCode: 0,
      lines: [
        `Open Walnut ${status.current} is the newest${onChannel} (${status.latest}).`,
        ...(other ? [`The ${otherName} channel is at ${other}: walnut update --channel ${otherName}`] : []),
      ],
    }
  }
  const head = `A newer Open Walnut is available${onChannel}: ${status.current} → ${status.latest}.`
  if (install.kind !== 'npm' || !install.manager) {
    return { exitCode: 0, lines: [head, `This install has no package manager to update it with. Releases: ${status.packageUrl}`] }
  }
  const argv = managerArgv(install.manager, `open-walnut@${status.latest}`)
  if (opts.check) return { exitCode: 0, lines: [head, `Run: ${install.updateCommand}`] }
  return { exitCode: 0, lines: [head, `Running: ${argv.file} ${argv.args.join(' ')}`], install: argv }
}

export interface UpdateDeps {
  checkNow: (channel?: UpdateChannel) => Promise<UpdateStatus>
  run: (file: string, args: string[]) => Promise<number>
  /** Is a Walnut server answering at the default address? (It keeps the old code until restarted.) */
  serverRunning: () => Promise<boolean>
  out: (line: string) => void
  err: (line: string) => void
}

function runInherited(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/system/update`, { signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
  }
}

export async function defaultDeps(): Promise<UpdateDeps> {
  const { UpdateChecker } = await import('../core/self-update/update-check.js')
  return {
    // A fresh checker, not the server's: this process is the install being updated.
    checkNow: (channel) => new UpdateChecker(channel ? { channel } : {}).checkNow(),
    run: runInherited,
    serverRunning: probeServer,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
}

/** Returns the exit code; the caller sets process.exitCode so stdio flushes. */
export async function runUpdateWith(options: UpdateOptions, globals: GlobalOptions, deps: UpdateDeps): Promise<number> {
  let channel: UpdateChannel | undefined
  try {
    channel = parseChannel(options.channel)
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err))
    return 2
  }
  const status = await deps.checkNow(channel)
  const plan = planUpdate(status, { check: options.check === true })
  if (globals.json) {
    deps.out(JSON.stringify({ ...status, plan: { lines: plan.lines, install: plan.install ?? null } }, null, 2))
    if (!plan.install) return plan.exitCode
  } else {
    for (const line of plan.lines) (plan.exitCode === 0 ? deps.out : deps.err)(line)
    if (!plan.install) return plan.exitCode
  }
  let code: number
  try {
    code = await deps.run(plan.install.file, plan.install.args)
  } catch (err) {
    deps.err(`Could not run ${plan.install.file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (code !== 0) {
    deps.err(`${plan.install.file} exited with ${code}; Open Walnut ${status.current} is unchanged.`)
    return code
  }
  deps.out(`Installed Open Walnut ${status.latest}.`)
  if (await deps.serverRunning()) {
    deps.out(`The server at ${apiBaseUrl()} still runs ${status.current} until it is restarted (stop \`walnut web\`, then start it again).`)
  }
  return 0
}

export async function runUpdate(options: UpdateOptions, globals: GlobalOptions): Promise<void> {
  process.exitCode = await runUpdateWith(options, globals, await defaultDeps())
}
