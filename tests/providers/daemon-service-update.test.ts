import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRemoteDaemonService, updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { RemoteCommandError, runRemoteSh } from '../../src/providers/remote-sh.js'
import { daemonBusyRefusal } from '../../src/providers/exec-runs-hold.js'
import { guardedPath } from '../setup/exec-guard.js'

let root: string
let binary: string
const version = 'walnut-daemon-1234abcd'
const remote = '/tmp/open-walnut-update.Abc123xyz9'
const staged = `${remote}/daemon`
const existing = '/home/walnut/.local/share/open-walnut/daemon/versions/walnut-daemon-1234abcd/open-walnut-daemon'
const RM = `rm -rf ${remote}`

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-update-test-'))
  binary = path.join(root, 'daemon')
  await fs.writeFile(binary, randomBytes(800_000))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

type UploadFault = 'chunk' | 'version' | 'checksum' | 'path'

/** The remote side of the upload: confirmed chunks, the reassembly check, and the staging dir's removal. */
function uploads(fault?: UploadFault) {
  const chunks = new Map<number, Buffer>()
  const slots: number[] = []
  let retried = false
  const chunk = vi.fn(async (data: Buffer, directory: string, index: number) => {
    expect(directory).toBe(remote)
    expect(data.length).toBeLessThanOrEqual(262_144)
    slots.push(index)
    if (fault === 'chunk' || !retried) { retried = true; return false }
    chunks.set(index, Buffer.from(data))
    return true
  })
  const answer = async (command: string): Promise<string | null> => {
    if (command.includes('mktemp -d')) return fault === 'path' ? `${remote}; unwanted` : remote
    if (command.includes('sha256sum')) {
      if (fault === 'checksum') throw new Error('checksum mismatch')
      const indices = [...command.matchAll(/chunk_(\d+)/g)].map((match) => Number(match[1]))
      expect(indices.every((index) => chunks.has(index))).toBe(true)
      const payload = Buffer.concat(indices.map((index) => chunks.get(index)!))
      expect(command).toContain(createHash('sha256').update(payload).digest('hex'))
      expect(gunzipSync(payload).equals(await fs.readFile(binary))).toBe(true)
      return fault === 'version' ? 'different-build' : version
    }
    if (command === RM) return ''
    return null
  }
  return { chunk, slots, answer }
}

function lab(fault?: UploadFault | 'service' | 'transport', scope: 'user' | 'cron' = 'user') {
  const upload = uploads(fault === 'service' || fault === 'transport' ? undefined : fault)
  const calls: string[] = []
  const run = vi.fn(async (command: string, _timeoutMs?: number) => {
    calls.push(command)
    const answered = await upload.answer(command)
    if (answered !== null) return answered
    expect(command).toBe(`${staged} walnut daemon update --yes --scope ${scope} --executable ${staged}`)
    if (fault === 'transport') throw new Error('connection lost')
    return fault === 'service' ? JSON.stringify({ ok: false, failure: { message: 'busy', rollback: 'unchanged' } }) : '{"ok":true}'
  })
  return { run, chunk: upload.chunk, calls, slots: upload.slots }
}

describe('managed daemon upload and update', () => {
  it('reassembles only confirmed chunks, verifies bytes and version, requests a user service update, then removes the staging dir', async () => {
    const l = lab()
    await updateRemoteDaemonService({ binary }, version, l)
    expect(l.chunk.mock.calls.length).toBeGreaterThan(3)
    expect(new Set(l.slots).size).toBe(l.slots.length)
    expect(l.calls).toHaveLength(4)
    expect(l.calls[2]).toContain('--scope user')
    expect(l.calls[3]).toBe(RM)
    expect(l.calls.join('\n')).not.toMatch(/sudo|nohup|kill|enable/)
    expect(l.run.mock.calls[2][1]).toBe(600_000)
  })

  it('requests a cron service update for the cron scope', async () => {
    const l = lab(undefined, 'cron')
    await updateRemoteDaemonService({ binary }, version, l, 'cron')
    expect(l.calls[2]).toBe(`${staged} walnut daemon update --yes --scope cron --executable ${staged}`)
    expect(l.calls.at(-1)).toBe(RM)
  })

  it('refuses a system service update before any remote operation', async () => {
    const l = lab()
    await expect(updateRemoteDaemonService({ binary }, version, l, 'system')).rejects.toThrow('does not update a system service')
    expect(l.run).not.toHaveBeenCalled()
    expect(l.chunk).not.toHaveBeenCalled()
  })

  it.each(['chunk', 'version', 'checksum', 'path'] as const)('does not touch the service after a %s failure', async (fault) => {
    const l = lab(fault)
    await expect(updateRemoteDaemonService({ binary }, version, l)).rejects.toThrow()
    expect(l.calls.some((command) => command.includes('daemon update'))).toBe(false)
    if (fault === 'chunk') expect(l.chunk).toHaveBeenCalledTimes(3)
    if (fault === 'path') {
      expect(l.chunk).not.toHaveBeenCalled()
      expect(l.calls.some((command) => command.startsWith('rm '))).toBe(false)
    } else {
      expect(l.calls.at(-1)).toBe(RM)
    }
  })

  it.each(['service', 'transport'] as const)('does not retry or start an unmanaged replacement after a %s failure, and removes the staging dir', async (fault) => {
    const l = lab(fault)
    await expect(updateRemoteDaemonService({ binary }, version, l)).rejects.toThrow()
    expect(l.calls.filter((command) => command.includes('daemon update'))).toHaveLength(1)
    expect(l.calls.join('\n')).not.toContain('--start')
    expect(l.calls.at(-1)).toBe(RM)
  })

  it('rejects an invalid build version before any remote operation', async () => {
    const l = lab()
    await expect(updateRemoteDaemonService({ binary }, 'build; invalid', l)).rejects.toThrow('Invalid daemon build version')
    expect(l.run).not.toHaveBeenCalled()
  })
  // 2026-11-03: a deploy's update met a relay in flight. The CLI's busy refusal exits 1 with
  // its answer on stdout, and over SSH that exit throws with the answer only beside the
  // message, so the server read "exited with code 1" as a failed update (a 10-minute
  // cooldown) instead of a busy daemon it asks again in a minute.
  describe('a refusal that exits 1 over ssh', () => {
    const BUSY = 'Error: service.handover: active ACP workers or relay requests must finish first'
    let bin: string
    let savedPath: string | undefined
    beforeEach(async () => {
      bin = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fake-ssh-'))
      // This machine stands in for the host: the fake ssh runs the wrapped script it is fed.
      // Its login shell prints a line with a brace before the script runs, as an rc file may.
      await fs.writeFile(path.join(bin, 'ssh'), "#!/bin/sh\necho 'motd: {welcome}'\nexec sh -s\n", { mode: 0o755 })
      savedPath = process.env.PATH
      process.env.PATH = guardedPath([bin])
    })
    afterEach(async () => {
      process.env.PATH = savedPath
      await fs.rm(bin, { recursive: true, force: true })
    })

    /** The upload answered as in `lab`; the update line runs through the real runRemoteSh. */
    function sshLab(update: string) {
      const upload = uploads()
      const calls: string[] = []
      const run = vi.fn(async (command: string) => {
        calls.push(command)
        const answered = await upload.answer(command)
        if (answered !== null) return answered
        return runRemoteSh(['devbox'], update, 10_000)
      })
      return { run, chunk: upload.chunk, calls }
    }
    const answers = (failure: Record<string, string>) =>
      `echo 'walnut daemon: a note first' >&2\nprintf '%s\\n' '${JSON.stringify({ ok: false, failure }, null, 2)}'\nexit 1`

    it('a busy refusal reads as busy, with its words, and the staging dir is removed', async () => {
      const l = sshLab(answers({ code: 'updateRefused', message: BUSY, rollback: 'the old service config was put back' }))
      const error = await updateRemoteDaemonService({ binary }, version, l).catch((reason: unknown) => reason)
      expect(error).not.toBeInstanceOf(RemoteCommandError)
      expect(String(error)).toContain('must finish first')
      expect(String(error)).toContain('the old service config was put back')
      expect(daemonBusyRefusal(error)).toBe(true)
      expect(l.calls.filter((command) => command.includes('daemon update'))).toHaveLength(1)
      expect(l.calls.at(-1)).toBe(RM)
    })

    it('any other refusal keeps its own words and is not busy', async () => {
      const l = sshLab(answers({ code: 'serviceInactive', message: 'The service was stopped or disabled during staging; nothing was changed' }))
      const error = await updateRemoteDaemonService({ binary }, version, l).catch((reason: unknown) => reason)
      expect(String(error)).toContain('The service was stopped or disabled during staging')
      expect(daemonBusyRefusal(error)).toBe(false)
    })

    it('an exit with no answer stays the ssh error it was', async () => {
      const l = sshLab("echo 'walnut: command not found' >&2\nexit 127")
      const error = await updateRemoteDaemonService({ binary }, version, l).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(RemoteCommandError)
      expect(String(error)).toContain('command not found')
      expect(daemonBusyRefusal(error)).toBe(false)
    })
  })
})

interface InstallLab {
  install?: string[]
  status?: string
  uninstall?: string
  existingVersion?: string
}

function installLab(options: InstallLab = {}) {
  const upload = uploads()
  const calls: string[] = []
  const installs = [...(options.install ?? ['{"ok":true,"status":{"scope":"cron","startup":"boot"}}'])]
  const run = vi.fn(async (command: string) => {
    calls.push(command)
    const answered = await upload.answer(command)
    if (answered !== null) return answered
    if (command === `${existing} __daemon --version 2>/dev/null || true`) return `${options.existingVersion ?? version}\n`
    const cli = /^(\S+) walnut daemon (.+) 2>\/dev\/null \|\| true$/.exec(command)
    if (!cli) throw new Error(`unexpected command: ${command}`)
    const args = cli[2]
    if (args === `install --yes --executable ${cli[1]}`) return installs.length > 1 ? installs.shift()! : installs[0]
    if (args === 'status') return options.status ?? '{"installed":false}'
    if (args.startsWith('uninstall --yes')) return options.uninstall ?? '{"ok":true,"status":{"installed":false}}'
    throw new Error(`unexpected walnut daemon ${args}`)
  })
  const installCalls = () => calls.filter((command) => command.includes('walnut daemon install'))
  return { run, chunk: upload.chunk, calls, installCalls }
}

const refusal = (code: string, message: string, rollback?: string) =>
  JSON.stringify({ ok: false, failure: { code, message, ...(rollback ? { rollback } : {}) } })

describe('managed daemon install from the server', () => {
  it('uploads the binary, reads the answer past leading noise, and removes the staging dir', async () => {
    const l = installLab({ install: ['Last login: today\nwelcome\n{"ok":true,"status":{"scope":"cron","startup":"boot"}}\n'] })
    const result = await installRemoteDaemonService({ binary }, version, l)
    expect(result).toEqual({ ok: true, scope: 'cron', startup: 'boot', uploaded: true })
    expect(l.installCalls()).toEqual([`${staged} walnut daemon install --yes --executable ${staged} 2>/dev/null || true`])
    expect(l.calls.at(-1)).toBe(RM)
    expect(l.calls.join('\n')).not.toMatch(/sudo|enable-linger/)
  })

  it('returns a refusal with its message and rollback instead of throwing', async () => {
    const l = installLab({ install: [refusal('cronUnavailable', 'cron cannot start the daemon at boot here', 'nothing was changed')] })
    const result = await installRemoteDaemonService({ binary }, version, l)
    expect(result).toEqual({
      ok: false, code: 'cronUnavailable', message: 'cron cannot start the daemon at boot here; nothing was changed', uploaded: true,
    })
    expect(l.calls.some((command) => command.includes('walnut daemon uninstall'))).toBe(false)
    expect(l.calls.at(-1)).toBe(RM)
  })

  it('retries a pending handover once', async () => {
    const l = installLab({ install: [refusal('handoverPending', 'the reply was lost'), '{"ok":true,"status":{"scope":"user","startup":"boot"}}'] })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result).toMatchObject({ ok: true, scope: 'user' })
    expect(l.installCalls()).toHaveLength(2)
  })

  it('retries only once when the handover stays pending', async () => {
    const l = installLab({ install: [refusal('handoverPending', 'still pending')] })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result).toMatchObject({ ok: false, code: 'handoverPending' })
    expect(l.installCalls()).toHaveLength(2)
  })

  it.each(['cron', 'user'] as const)('removes a half-made %s service after a failure', async (scope) => {
    const l = installLab({
      install: [refusal('notReady', 'the daemon never answered as ready')],
      status: `{"installed":true,"scope":"${scope}"}`,
    })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(l.calls).toContain(`${existing} walnut daemon uninstall --yes --scope ${scope} 2>/dev/null || true`)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('the daemon never answered as ready; the half-made service was removed, so Walnut runs the daemon the usual way')
  })

  it('says so when the half-made service could not be removed', async () => {
    const l = installLab({
      install: [refusal('notReady', 'not ready')],
      status: '{"installed":true,"scope":"cron"}',
      uninstall: refusal('verifyFailed', 'the daemon did not exit'),
    })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result.message).toBe('not ready; the half-made service could not be removed')
  })

  it('reads an unparseable answer as a failure', async () => {
    const l = installLab({ install: ['Segmentation fault'] })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result).toEqual({ ok: false, message: 'the install gave no answer Walnut could read', uploaded: false })
  })

  it('uses the binary already on the host when it is this build', async () => {
    const l = installLab()
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result).toMatchObject({ ok: true, uploaded: false })
    expect(l.chunk).not.toHaveBeenCalled()
    expect(l.calls).toEqual([
      `${existing} __daemon --version 2>/dev/null || true`,
      `${existing} walnut daemon install --yes --executable ${existing} 2>/dev/null || true`,
    ])
  })

  it('uploads when the binary on the host is another build', async () => {
    const l = installLab({ existingVersion: 'walnut-daemon-older' })
    const result = await installRemoteDaemonService({ binary, existing }, version, l)
    expect(result).toMatchObject({ ok: true, uploaded: true })
    expect(l.installCalls()).toEqual([`${staged} walnut daemon install --yes --executable ${staged} 2>/dev/null || true`])
    expect(l.calls.at(-1)).toBe(RM)
  })

  it('never runs an existing path it cannot quote safely', async () => {
    const l = installLab()
    await installRemoteDaemonService({ binary, existing: '/tmp/x; rm -rf ~' }, version, l)
    expect(l.calls.some((command) => command.includes('; rm -rf ~'))).toBe(false)
    expect(l.chunk).toHaveBeenCalled()
  })

  it('rejects an invalid build version before any remote operation', async () => {
    const l = installLab()
    await expect(installRemoteDaemonService({ binary, existing }, 'walnut-daemon-1; id', l)).rejects.toThrow('Invalid daemon build version')
    expect(l.run).not.toHaveBeenCalled()
  })
})

describe('a compiled Mac\'s source: the walnut file in the daemon slot, no daemon binary', () => {
  it('installs from the slot when it names this build, and uploads nothing', async () => {
    const l = installLab()
    const result = await installRemoteDaemonService({ binary: null, existing }, version, l)
    expect(result).toMatchObject({ ok: true, uploaded: false })
    expect(l.chunk).not.toHaveBeenCalled()
  })

  it('reads the build from the last line, past what the file prints first', async () => {
    const l = installLab({ existingVersion: `unpacking the runtime\n${version}` })
    expect(await installRemoteDaemonService({ binary: null, existing }, version, l)).toMatchObject({ ok: true, uploaded: false })
  })

  it('refuses, without touching the host service, when the slot holds another build and there is nothing to send', async () => {
    const l = installLab({ existingVersion: 'walnut-daemon-older' })
    await expect(installRemoteDaemonService({ binary: null, existing }, version, l)).rejects.toThrow('not this build')
    expect(l.installCalls()).toEqual([])
  })

  it('updates a service from the slot too', async () => {
    const l = installLab()
    const update = vi.fn(async (command: string) => {
      if (command.startsWith(`${existing} walnut daemon update`)) return '{"ok":true}'
      return l.run(command)
    })
    await updateRemoteDaemonService({ binary: null, existing }, version, { run: update, chunk: l.chunk }, 'cron')
    expect(update).toHaveBeenCalledWith(`${existing} walnut daemon update --yes --scope cron --executable ${existing}`, 600_000)
    expect(l.chunk).not.toHaveBeenCalled()
  })
})
