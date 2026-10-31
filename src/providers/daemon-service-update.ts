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
}

const VERSION = /^walnut-daemon-[a-zA-Z0-9]+$/
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/

/**
 * Put this build's daemon binary on the host in a private temp dir, checked
 * byte for byte and by its own `--version`. The service command then copies it
 * into the install root's versions, so the dir is removed afterwards.
 */
async function stageRemoteDaemonBinary(binary: string, expectedVersion: string, io: RemoteDaemonUpdateIo): Promise<{ executable: string; directory: string }> {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-service-update-'))
  try {
    const compressed = path.join(temporary, 'daemon.gz')
    await pipeline(fs.createReadStream(binary), createGzip(), fs.createWriteStream(compressed, { mode: 0o600, flags: 'wx' }))
    const directory = (await io.run('umask 077; mktemp -d /tmp/open-walnut-update.XXXXXXXXXX')).trim()
    if (!STAGING.test(directory)) throw new Error('Invalid daemon update staging directory')
    try {
      const hash = createHash('sha256')
      const files: string[] = []
      let index = 0
      for await (const data of fs.createReadStream(compressed, { highWaterMark: 262_144 })) {
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
      const version = await io.run(
        `cat ${files.join(' ')} > ${payload} && printf '%s  %s\\n' '${checksum}' '${payload}' | sha256sum -c - >/dev/null && gzip -dc ${payload} > ${executable} && rm -f ${payload} ${directory}/chunk_* && chmod 700 ${executable} && ${executable} --version`,
        30_000,
      )
      if (version.trim() !== expectedVersion) throw new Error('Uploaded daemon version differs; the installed service was not changed')
      return { executable, directory }
    } catch (error) {
      await removeStaging(io, directory)
      throw error
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}

async function removeStaging(io: RemoteDaemonUpdateIo, directory: string): Promise<void> {
  if (STAGING.test(directory)) await io.run(`rm -rf ${directory}`, 15_000).catch(() => {})
}

export async function updateRemoteDaemonService(binary: string, expectedVersion: string, io: RemoteDaemonUpdateIo, scope: DaemonServiceScope = 'user'): Promise<void> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  if (scope !== 'user' && scope !== 'cron') throw new Error(`Walnut does not update a ${scope} service from the server`)
  const { executable, directory } = await stageRemoteDaemonBinary(binary, expectedVersion, io)
  try {
    const output = await io.run(`${executable} walnut daemon update --yes --scope ${scope} --executable ${executable}`, 600_000)
    const result = JSON.parse(output) as { ok?: boolean; failure?: { message?: string; rollback?: string } }
    if (result.ok !== true) throw new Error(`Managed daemon update failed: ${result.failure?.message ?? output}; ${result.failure?.rollback ?? ''}`)
  } finally {
    await removeStaging(io, directory)
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
 * no scope: the host picks a boot start it can have without root). The binary
 * already there is used when it is this build (a binary host); otherwise this
 * build's is uploaded. Never throws for a refusal the host answered: the result
 * says it, so the caller can record and show it.
 */
export async function installRemoteDaemonService(
  binary: string, expectedVersion: string, io: RemoteDaemonUpdateIo, opts: { existing?: string } = {},
): Promise<RemoteInstallResult> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  let executable: string | null = null
  let directory: string | null = null
  if (opts.existing && /^\/[A-Za-z0-9._/-]+$/.test(opts.existing)) {
    const said = await io.run(`${opts.existing} --version 2>/dev/null || true`, 30_000).catch(() => '')
    if (said.trim() === expectedVersion) executable = opts.existing
  }
  const uploaded = executable === null
  if (!executable) ({ executable, directory } = await stageRemoteDaemonBinary(binary, expectedVersion, io))
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
