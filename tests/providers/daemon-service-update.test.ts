import fs from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

const TAILS = {
  serving: 'outcome=serving\na daemon answers\n',
  loaded: 'outcome=loaded\nthe service was not running after the update, so it was started again, and a daemon answers\n',
  restored: 'outcome=restored\nno daemon answered within 90 s, so the previous service config was put back, and its daemon answers\n',
  down: 'outcome=down\nno daemon answered within 90 s, nor after the previous service config was put back\n',
} as const
type TailOutcome = keyof typeof TAILS
/** Quick clocks for the detached runner (daemon-net-update-io.ts runDetachedUpdate). */
const FAST = { pollMs: 1, settleSeconds: 0 }

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

/**
 * The host side of the detached runner, as it behaves: the script the server writes with a
 * heredoc, the launch, and the record it reads back with cat. The launch "runs" the update
 * line the script holds (`answer` says what it printed) and leaves the tail's record.
 * `linkDown`: every read fails, as when the link stays down after the launch.
 */
function runnerHost(answer: (line: string) => { stdout: string; stderr?: string; code?: number }, tail: TailOutcome = 'serving', o: { linkDown?: boolean } = {}) {
  const files = new Map<string, string>()
  const updates: string[] = []
  const handle = (command: string): string | null => {
    const write = /^umask 077; cat > '([^']+)\.tmp' <<'(WALNUT_EOF_[0-9a-f]+)'\n([\s\S]*)\n\2\nmv -f /.exec(command)
    if (write) { files.set(write[1], write[3]); return '' }
    const read = /^if \[ -f '([^']+)' \]; then cat /.exec(command)
    if (read) {
      if (o.linkDown) throw new Error('connection lost')
      return files.get(read[1]) ?? '__walnut_no_file__'
    }
    if (command.includes('update.go')) {
      const d = /^d=([^;]+);/.exec(command)![1].replace(/'/g, '')
      const line = files.get(`${d}/update.sh`)!.split('\n').find((l) => l.includes(' walnut daemon update '))!
        .trim().replace(/ >"\$d\/update\.out" 2>"\$d\/update\.err"( &)?$/, '')
      updates.push(line)
      const said = answer(line)
      files.set(`${d}/update.out`, said.stdout)
      files.set(`${d}/update.err`, said.stderr ?? '')
      files.set(`${d}/update.tail`, TAILS[tail])
      files.set(`${d}/update.done`, `rc=${said.code ?? 0} tries=1 tail=${tail}\n`)
      return 'walnut-update-started pid=4242 group=4242 own=4100'
    }
    return null
  }
  return { handle, files, updates }
}

const isScriptWrite = (command: string) => command.startsWith('umask 077; cat > ')
const isRead = (command: string) => command.startsWith('if [ -f ')
const isLaunch = (command: string) => command.includes('update.go')

function lab(fault?: UploadFault | 'service' | 'stopped' | 'transport', scope: 'user' | 'cron' = 'user', tail: TailOutcome = 'serving', extra = '') {
  const upload = uploads(fault === 'service' || fault === 'stopped' || fault === 'transport' ? undefined : fault)
  const refusal = fault === 'service' ? { message: 'busy', rollback: 'unchanged' }
    : fault === 'stopped' ? { message: 'the new daemon did not answer', rollback: 'restored', stopped: true } : null
  const host = runnerHost((line) => {
    expect(line).toBe(`${staged} walnut daemon update --yes --scope ${scope} --executable ${staged}${extra}`)
    return { stdout: refusal ? JSON.stringify({ ok: false, failure: refusal }) : '{"ok":true}' }
  }, tail, { linkDown: fault === 'transport' })
  const calls: string[] = []
  const run = vi.fn(async (command: string, _timeoutMs?: number) => {
    calls.push(command)
    // The runner's own commands first: the script it writes holds a mktemp of its own (the tail's launchd spawn probe).
    const answered = host.handle(command) ?? (await upload.answer(command))
    if (answered === null) throw new Error(`unexpected command: ${command}`)
    return answered
  })
  return { run, chunk: upload.chunk, calls, slots: upload.slots, host, detached: { ...FAST, waitMs: 50 } }
}

describe('managed daemon upload and update', () => {
  it('reassembles only confirmed chunks, verifies bytes and version, runs the user service update detached with its tail, then removes the staging dir', async () => {
    const l = lab()
    await updateRemoteDaemonService({ binary }, version, l)
    expect(l.chunk.mock.calls.length).toBeGreaterThan(3)
    expect(new Set(l.slots).size).toBe(l.slots.length)
    // mktemp, the reassembly check, the runner script, the launch, the record's reads, the removal.
    expect(l.calls.slice(0, 4).map((c, i) => [c.includes('mktemp'), c.includes('sha256sum'), isScriptWrite(c), isLaunch(c)][i])).toEqual([true, true, true, true])
    expect(l.calls.slice(4, -1).every(isRead)).toBe(true)
    expect(l.calls.at(-1)).toBe(RM)
    expect(l.host.updates).toEqual([`${staged} walnut daemon update --yes --scope user --executable ${staged}`])
    // The script on the host copies the config aside, tries once (a busy daemon is asked again from the server), and runs the tail.
    const script = l.host.files.get(`${remote}/update.sh`)!
    expect(script).toContain('before.cfg')
    expect(script).toContain('[ "$n" -ge 1 ] && break')
    expect(script).toContain('update.tail')
    expect(l.calls.filter((c) => !isScriptWrite(c) && !isLaunch(c)).join('\n')).not.toMatch(/sudo|nohup|kill|enable/)
  })

  it('an overdue update asks the daemon to go over its own work (daemon-update-behind.ts)', async () => {
    const l = lab(undefined, 'user', 'serving', ' --over-busy')
    await updateRemoteDaemonService({ binary }, version, l, 'user', { overBusy: true })
    expect(l.host.updates).toEqual([`${staged} walnut daemon update --yes --scope user --executable ${staged} --over-busy`])
  })

  it('requests a cron service update for the cron scope, and its tail checks the boot script', async () => {
    const l = lab(undefined, 'cron')
    await updateRemoteDaemonService({ binary }, version, l, 'cron')
    expect(l.host.updates).toEqual([`${staged} walnut daemon update --yes --scope cron --executable ${staged}`])
    expect(l.host.files.get(`${remote}/update.sh`)).toContain('tk=cron')
    expect(l.calls.at(-1)).toBe(RM)
  })

  // 2026-11-04: an update that answered and left no daemon serving. The tail runs on the
  // host after the answer, whatever it said, and its record decides.
  it('reads a tail that had to start the service again as applied', async () => {
    const l = lab(undefined, 'user', 'loaded')
    await expect(updateRemoteDaemonService({ binary }, version, l)).resolves.toBe('applied')
  })

  it.each(['restored', 'down'] as const)('fails an update that answered ok when its tail says %s, with the tail\'s words', async (tail) => {
    const l = lab(undefined, 'user', tail)
    const error = await updateRemoteDaemonService({ binary }, version, l).catch((reason: unknown) => reason)
    expect(String(error)).toContain('the update answered ok, but afterwards on the host: no daemon answered within 90 s')
    expect(l.calls.at(-1)).toBe(RM)
  })

  it('a link that stays down after the launch keeps the staging dir for the runner, and says the update may still finish', async () => {
    const l = lab('transport')
    const error = await updateRemoteDaemonService({ binary }, version, l).catch((reason: unknown) => reason)
    expect(String(error)).toContain('did not report back')
    expect(String(error)).toContain('it may still finish there')
    // The runner was started once, on the host, and nothing removed its dir under it.
    expect(l.host.updates).toHaveLength(1)
    expect(l.calls).not.toContain(RM)
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
    expect(l.host.updates).toEqual([])
    expect(l.calls.some(isLaunch)).toBe(false)
    if (fault === 'chunk') expect(l.chunk).toHaveBeenCalledTimes(3)
    if (fault === 'path') {
      expect(l.chunk).not.toHaveBeenCalled()
      expect(l.calls.some((command) => command.startsWith('rm '))).toBe(false)
    } else {
      expect(l.calls.at(-1)).toBe(RM)
    }
  })

  it('does not retry or start an unmanaged replacement after a refusal, and removes the staging dir', async () => {
    const l = lab('service')
    await expect(updateRemoteDaemonService({ binary }, version, l)).rejects.toThrow('Managed daemon update failed: busy; unchanged')
    expect(l.host.updates).toHaveLength(1)
    expect(l.calls.join('\n')).not.toContain('--start')
    expect(l.calls.at(-1)).toBe(RM)
  })

  // 2026-11-04 review 5: the build's hold is written before its record (the staging dir) goes,
  // so a server killed in between keeps one of them, never neither.
  it('a build that stopped the daemon and did not stay is held before the staging dir is removed', async () => {
    const l = lab('stopped')
    const order: string[] = []
    const run = l.run.getMockImplementation()!
    l.run.mockImplementation(async (command: string, timeoutMs?: number) => {
      if (command === RM) order.push('rm')
      return run(command, timeoutMs)
    })
    const held = vi.fn(() => { order.push('hold') })
    const error = await updateRemoteDaemonService({ binary }, version, l, 'user', { onBuildFailed: held }).catch((reason: unknown) => reason)
    expect((error as { buildFailed?: unknown }).buildFailed).toBe(true)
    expect(held).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['hold', 'rm'])
  })

  it('a refusal that never stopped the daemon holds nothing', async () => {
    const l = lab('service')
    const held = vi.fn()
    await expect(updateRemoteDaemonService({ binary }, version, l, 'user', { onBuildFailed: held })).rejects.toThrow('busy')
    expect(held).not.toHaveBeenCalled()
  })

  it('rejects an invalid build version before any remote operation', async () => {
    const l = lab()
    await expect(updateRemoteDaemonService({ binary }, 'build; invalid', l)).rejects.toThrow('Invalid daemon build version')
    expect(l.run).not.toHaveBeenCalled()
  })

  // Over SSH for real (a fake ssh that runs the script it is fed with this machine's sh):
  // the runner starts detached, its update line runs, and its record is read back through
  // what the login shell prints. 2026-11-03: a busy refusal exits 1 with its answer on
  // stdout, and the server took the exit for a failed update (a 10-minute cooldown)
  // instead of a busy daemon it asks again in a minute; the record keeps the answer.
  describe('over a real (stand-in) ssh', () => {
    const BUSY = 'Error: service.handover: active ACP workers or relay requests must finish first'
    let bin: string
    let savedPath: string | undefined
    beforeEach(async () => {
      bin = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fake-ssh-'))
      await fs.mkdir(path.join(bin, 'home'))
      // This machine stands in for the host: the fake ssh runs the wrapped script it is fed, in a
      // home of its own (no service config there, so the tail touches nothing). Its login shell
      // prints a line with a brace first, as an rc file may.
      await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/sh\necho 'motd: {welcome}'\nHOME='${bin}/home' exec sh -s\n`, { mode: 0o755 })
      savedPath = process.env.PATH
      process.env.PATH = guardedPath([bin])
    })
    afterEach(async () => {
      process.env.PATH = savedPath
      await fs.rm(bin, { recursive: true, force: true })
    })

    /** This build's daemon file on the "host": its version, and an update that does what `body` says. */
    function sshLab(body: string) {
      const existing = path.join(bin, 'daemon')
      writeFileSync(existing, `#!/bin/sh\nif [ "$1 $2" = "__daemon --version" ]; then echo ${version}; exit 0; fi\necho "$*" >> '${bin}/updates'\n${body}\n`, { mode: 0o755 })
      const calls: string[] = []
      const run = vi.fn(async (command: string, timeoutMs?: number) => {
        calls.push(command)
        return runRemoteSh(['devbox'], command, timeoutMs ?? 10_000)
      })
      const updates = () => readFileSync(path.join(bin, 'updates'), 'utf8').trim().split('\n')
      return { existing, io: { run, chunk: vi.fn(async () => true), detached: { pollMs: 50, settleSeconds: 0, waitMs: 30_000, latestMarker: path.join(bin, 'latest') } }, calls, updates }
    }
    const answers = (failure: Record<string, string>) =>
      `echo 'walnut daemon: a note first' >&2\nprintf '%s\\n' '${JSON.stringify({ ok: false, failure }, null, 2)}'\nexit 1`

    it('runs the update detached on the host and reads an ok answer past the login noise, then removes its dir', async () => {
      const l = sshLab(`printf '%s\\n' '{"ok":true}'`)
      await expect(updateRemoteDaemonService({ binary: null, existing: l.existing }, version, l.io, 'user')).resolves.toBe('applied')
      expect(l.updates()).toEqual([`walnut daemon update --yes --scope user --executable ${l.existing}`])
      const dir = /\/tmp\/open-walnut-update\.\w+/.exec(l.calls.find((c) => c.includes('update.go'))!)![0]
      expect(existsSync(dir)).toBe(false)
    }, 60_000)

    it('a busy refusal reads as busy, with its words, and is asked once', async () => {
      const l = sshLab(answers({ code: 'updateRefused', message: BUSY, rollback: 'the old service config was put back' }))
      const error = await updateRemoteDaemonService({ binary: null, existing: l.existing }, version, l.io, 'user').catch((reason: unknown) => reason)
      expect(error).not.toBeInstanceOf(RemoteCommandError)
      expect(String(error)).toContain('must finish first')
      expect(String(error)).toContain('the old service config was put back')
      expect(daemonBusyRefusal(error)).toBe(true)
      expect(l.updates()).toHaveLength(1)
    }, 60_000)

    it('any other refusal keeps its own words and is not busy', async () => {
      const l = sshLab(answers({ code: 'serviceInactive', message: 'The service was stopped or disabled during staging; nothing was changed' }))
      const error = await updateRemoteDaemonService({ binary: null, existing: l.existing }, version, l.io, 'user').catch((reason: unknown) => reason)
      expect(String(error)).toContain('The service was stopped or disabled during staging')
      expect(daemonBusyRefusal(error)).toBe(false)
    }, 60_000)

    it('an exit with no answer says so, with what it printed', async () => {
      const l = sshLab("echo 'walnut: command not found' >&2\nexit 127")
      const error = await updateRemoteDaemonService({ binary: null, existing: l.existing }, version, l.io, 'user').catch((reason: unknown) => reason)
      expect(String(error)).toContain('the update gave no answer Walnut could read (rc=127 tries=1 tail=no-service)')
      expect(String(error)).toContain('command not found')
      expect(daemonBusyRefusal(error)).toBe(false)
    }, 60_000)
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
    const host = runnerHost(() => ({ stdout: '{"ok":true}' }))
    const update = vi.fn(async (command: string) => host.handle(command) ?? l.run(command))
    await updateRemoteDaemonService({ binary: null, existing }, version, { run: update, chunk: l.chunk, detached: { ...FAST, waitMs: 50 } }, 'cron')
    expect(host.updates).toEqual([`${existing} walnut daemon update --yes --scope cron --executable ${existing}`])
    expect(l.chunk).not.toHaveBeenCalled()
    // Nothing was uploaded, so the runner got a dir of its own, removed afterwards.
    expect(l.calls.at(-1)).toBe(RM)
  })})
