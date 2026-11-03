import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import type { DaemonServiceScope } from './daemon-service-manager.js'

export interface RemoteDaemonUpdateIo {
  run(command: string, timeoutMs?: number): Promise<string>
  chunk(data: Buffer, directory: string, index: number): Promise<boolean>
  /**
   * Run the final `walnut daemon update` line and answer what it printed (its JSON).
   * Absent: `run` in the foreground, as over SSH. A link that runs commands through the
   * very daemon the update replaces (the host network, daemon-net-update-io.ts) starts it
   * detached from that daemon, which exits during the handover.
   */
  serviceUpdate?(update: { command: string; directory: string | null; executable: string }): Promise<string>
}

const VERSION = /^walnut-daemon-[a-zA-Z0-9]+$/
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/
const REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/

/**
 * How a host executable names the daemon build it carries. The daemon binary
 * ignores the `__daemon` word; the compiled walnut file routes it to the
 * daemon (its plain `--version` is the CLI's), so one command reads both.
 */
export const DAEMON_VERSION_ARGS = '__daemon --version'

/**
 * What a service install or update runs on the host: an executable already
 * there (the daemon slot) when it is this build, else this build's daemon
 * binary, uploaded. A compiled Mac has no separate daemon binary: its source is
 * the host's walnut file, which the daemon deploy put in the slot.
 */
export interface ServiceDaemonSource {
  binary: string | null
  existing?: string
  /**
   * This build's daemon already gzipped, sent as it is (no copy here, no unpacking on
   * this side): a compiled Mac's walnut file for the host's target (host-file.ts), for a
   * host it has no SSH to (daemon-net-update.ts). The host checks it like an upload of
   * `binary`: its sha256, then its `__daemon --version`.
   */
  gz?: Buffer
}

const CHUNK_BYTES = 262_144

function* slices(gz: Buffer): Generator<Buffer> {
  for (let at = 0; at < gz.length; at += CHUNK_BYTES) yield gz.subarray(at, at + CHUNK_BYTES)
}

/**
 * Put this build's daemon binary (or its gz) on the host in a private temp dir,
 * checked byte for byte and by its own `--version`. The service command then copies
 * it into the install root's versions, so the dir is removed afterwards.
 */
async function stageRemoteDaemonBinary(payload: { binary: string } | { gz: Buffer }, expectedVersion: string, io: RemoteDaemonUpdateIo): Promise<{ executable: string; directory: string }> {
  const temporary = 'binary' in payload ? await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-service-update-')) : null
  try {
    let chunks: AsyncIterable<unknown> | Iterable<Buffer>
    if ('binary' in payload) {
      const compressed = path.join(temporary!, 'daemon.gz')
      await pipeline(fs.createReadStream(payload.binary), createGzip(), fs.createWriteStream(compressed, { mode: 0o600, flags: 'wx' }))
      chunks = fs.createReadStream(compressed, { highWaterMark: CHUNK_BYTES })
    } else {
      chunks = slices(payload.gz)
    }
    const directory = (await io.run('umask 077; mktemp -d /tmp/open-walnut-update.XXXXXXXXXX')).trim()
    if (!STAGING.test(directory)) throw new Error('Invalid daemon update staging directory')
    try {
      const hash = createHash('sha256')
      const files: string[] = []
      let index = 0
      for await (const data of chunks) {
        const chunk = data as Buffer
        hash.update(chunk)
        let sent = false
        for (let attempt = 0; attempt < 3; attempt++) {
          const slot = index++
          if (await io.chunk(chunk, directory, slot)) {
            files.push(`${directory}/chunk_${String(slot).padStart(4, '0')}`)
            sent = true
            break
          }
        }
        if (!sent) throw new Error('Daemon update upload failed; the installed service was not changed')
      }
      const payload = `${directory}/daemon.gz`
      const executable = `${directory}/daemon`
      const checksum = hash.digest('hex')
      // A Mac has no sha256sum (a host that joined over the host network may be one): shasum then.
      const line = `printf '%s  %s\\n' '${checksum}' '${payload}'`
      const verify = `{ if command -v sha256sum >/dev/null 2>&1; then ${line} | sha256sum -c - >/dev/null; else ${line} | shasum -a 256 -c - >/dev/null; fi; }`
      const version = await io.run(
        `cat ${files.join(' ')} > ${payload} && ${verify} && gzip -dc ${payload} > ${executable} && rm -f ${payload} ${directory}/chunk_* && chmod 700 ${executable} && ${executable} ${DAEMON_VERSION_ARGS}`,
        30_000,
      )
      if (version.trim().split('\n').pop()?.trim() !== expectedVersion) throw new Error('Uploaded daemon version differs; the installed service was not changed')
      return { executable, directory }
    } catch (error) {
      await removeStaging(io, directory)
      throw error
    }
  } finally {
    if (temporary) await fsp.rm(temporary, { recursive: true, force: true })
  }
}

async function removeStaging(io: RemoteDaemonUpdateIo, directory: string): Promise<void> {
  if (STAGING.test(directory)) await io.run(`rm -rf ${directory}`, 15_000).catch(() => {})
}

/** The executable to hand the service command: the one on the host when it is this build, else an upload. */
async function serviceExecutable(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo,
): Promise<{ executable: string; directory: string | null }> {
  if (source.existing && REMOTE_PATH.test(source.existing)) {
    const said = await io.run(`${source.existing} ${DAEMON_VERSION_ARGS} 2>/dev/null || true`, 30_000).catch(() => '')
    if (said.trim().split('\n').pop()?.trim() === expectedVersion) return { executable: source.existing, directory: null }
  }
  if (source.binary) return stageRemoteDaemonBinary({ binary: source.binary }, expectedVersion, io)
  if (source.gz?.length) return stageRemoteDaemonBinary({ gz: source.gz }, expectedVersion, io)
  throw new Error(`the daemon file on the host is not this build (${expectedVersion}), and this Walnut has no other copy to send`)
}

/** The new daemon did not get onto the host: the installed service and the running daemon are untouched. */
export class DaemonUpdateStageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUpdateStageError'
  }
}

/**
 * Update the host's daemon service to `expectedVersion`: the executable onto
 * the host first (an upload while the old daemon still serves), then the
 * service swap. `onStaged` is asked between the two: false keeps the old daemon
 * (work started during the upload) and answers 'held'.
 */
export async function updateRemoteDaemonService(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo, scope: DaemonServiceScope = 'user',
  opts: { onStaged?: () => boolean | Promise<boolean> } = {},
): Promise<'applied' | 'held'> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  if (scope !== 'user' && scope !== 'cron') throw new Error(`Walnut does not update a ${scope} service from the server`)
  const { executable, directory } = await serviceExecutable(source, expectedVersion, io).catch((error: unknown) => {
    throw new DaemonUpdateStageError(error instanceof Error ? error.message : String(error))
  })
  try {
    if (opts.onStaged && !(await opts.onStaged())) return 'held'
    const command = `${executable} walnut daemon update --yes --scope ${scope} --executable ${executable}`
    const output = io.serviceUpdate ? await io.serviceUpdate({ command, directory, executable }) : await io.run(command, 600_000)
    const result = JSON.parse(output) as { ok?: boolean; failure?: { message?: string; rollback?: string } }
    if (result.ok !== true) throw new Error(`Managed daemon update failed: ${result.failure?.message ?? output}; ${result.failure?.rollback ?? ''}`)
    return 'applied'
  } finally {
    if (directory) await removeStaging(io, directory)
  }
}

interface ServiceReply { ok?: boolean; status?: { scope?: string; startup?: string }; failure?: { code?: string; message?: string; rollback?: string } }
interface DaemonStatusReply { installed?: boolean; scope?: string }

export interface RemoteInstallResult {
  ok: boolean
  /** The failure's own words, then its rollback, for the log and Settings. */
  message?: string
  code?: string
  scope?: string
  startup?: string
  uploaded: boolean
}

/**
 * Install the daemon as a service on the host (`walnut daemon install --yes`,
 * no scope: the host picks a boot start it can have without root). The
 * executable already there is used when it is this build (a binary host, or
 * the walnut file a compiled Mac put in the daemon slot); otherwise this build's
 * daemon binary is uploaded. Never throws for a refusal the host answered: the
 * result says it, so the caller can record and show it.
 */
export async function installRemoteDaemonService(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo,
): Promise<RemoteInstallResult> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  const { executable, directory } = await serviceExecutable(source, expectedVersion, io)
  const uploaded = directory !== null
  // `|| true`: a refusal exits 1 with its JSON on stdout, which is the answer to keep.
  const cli = async (args: string, timeoutMs: number): Promise<ServiceReply | null> => {
    const output = (await io.run(`${executable} walnut daemon ${args} 2>/dev/null || true`, timeoutMs)).trim()
    try { return JSON.parse(output.slice(output.indexOf('{'))) as ServiceReply } catch { return null }
  }
  try {
    let reply = await cli(`install --yes --executable ${executable}`, 600_000)
    // The old daemon may have exited after handing over: a second install finishes that handover.
    if (reply && reply.ok !== true && (reply.failure?.code === 'handoverPending' || /retry install/i.test(reply.failure?.rollback ?? ''))) {
      reply = await cli(`install --yes --executable ${executable}`, 600_000)
    }
    if (reply?.ok === true) return { ok: true, scope: reply.status?.scope, startup: reply.status?.startup, uploaded }
    // Never leave a config with no daemon behind it: the server will not start one beside a service.
    const left = await cli('status', 60_000).catch(() => null)
    let removed = ''
    if (left && (left as DaemonStatusReply).installed === true) {
      const scope = (left as DaemonStatusReply).scope
      const gone = await cli(`uninstall --yes${scope === 'user' || scope === 'cron' ? ` --scope ${scope}` : ''}`, 120_000).catch(() => null)
      removed = gone?.ok === true ? 'the half-made service was removed, so Walnut runs the daemon the usual way' : 'the half-made service could not be removed'
    }
    if (!reply) return { ok: false, message: ['the install gave no answer Walnut could read', removed].filter(Boolean).join('; '), uploaded }
    const f = reply.failure ?? {}
    return { ok: false, code: f.code, message: [f.message, f.rollback, removed].filter(Boolean).join('; ') || 'the install failed', uploaded }
  } finally {
    if (directory) await removeStaging(io, directory)
  }
}
