import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

export interface RemoteDaemonUpdateIo {
  run(command: string, timeoutMs?: number): Promise<string>
  chunk(data: Buffer, directory: string, index: number): Promise<boolean>
}

export async function updateRemoteDaemonService(binary: string, expectedVersion: string, io: RemoteDaemonUpdateIo): Promise<void> {
  if (!/^walnut-daemon-[a-zA-Z0-9]+$/.test(expectedVersion)) throw new Error('Invalid daemon build version')
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-service-update-'))
  try {
    const compressed = path.join(temporary, 'daemon.gz')
    await pipeline(fs.createReadStream(binary), createGzip(), fs.createWriteStream(compressed, { mode: 0o600, flags: 'wx' }))
    const directory = (await io.run('umask 077; mktemp -d /tmp/open-walnut-update.XXXXXXXXXX')).trim()
    if (!/^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/.test(directory)) throw new Error('Invalid daemon update staging directory')
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
      `cat ${files.join(' ')} > ${payload} && printf '%s  %s\\n' '${checksum}' '${payload}' | sha256sum -c - >/dev/null && gzip -dc ${payload} > ${executable} && chmod 700 ${executable} && ${executable} --version`,
      30_000,
    )
    if (version.trim() !== expectedVersion) throw new Error('Uploaded daemon version differs; the installed service was not changed')
    const output = await io.run(`${executable} walnut daemon update --yes --scope user --executable ${executable}`, 600_000)
    const result = JSON.parse(output) as { ok?: boolean; failure?: { message?: string; rollback?: string } }
    if (result.ok !== true) throw new Error(`Managed daemon update failed: ${result.failure?.message ?? output}; ${result.failure?.rollback ?? ''}`)
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}
