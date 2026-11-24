/**
 * The ssh options Walnut passes work with the oldest OpenSSH client it runs beside
 * (src/providers/ssh-client-options.ts): an option that client does not know ends ssh before it dials.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetSshClientOptionsForTesting, learnSshClient, OLDEST_OPENSSH, refusesRemoteCommand, remoteCommandNone,
} from '../../src/providers/ssh-client-options.js'

/** Every `-o` name Walnut passes, with the OpenSSH release that added it (from OpenSSH's release notes). */
const ADDED_IN: Record<string, string> = {
  BatchMode: '1.2',
  CanonicalizeHostname: '6.5',
  ClearAllForwardings: '4.0',
  ConnectTimeout: '3.7',
  ControlMaster: '3.9',
  ControlPath: '3.9',
  ControlPersist: '5.6',
  ExitOnForwardFailure: '4.4',
  ForwardAgent: '1.2',
  HostName: '1.2',
  ProxyCommand: '1.2',
  RemoteCommand: '7.6',
  RequestTTY: '5.9',
  ServerAliveCountMax: '3.8',
  ServerAliveInterval: '3.8',
  StrictHostKeyChecking: '1.2',
  UpdateHostKeys: '6.8',
}
/** The one file that may spell an option newer than OLDEST_OPENSSH: it asks the client first. */
const GATE = path.join('src', 'providers', 'ssh-client-options.ts')

const newer = (v: string, than: string) => {
  const [a, b] = [v, than].map((x) => x.split('.').map(Number))
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** `'-o', 'Name=...'` / `'-o', \`Name=...\`` in source (ssh's options are CamelCase; `ps -o pid=` is not). */
function optionsUsed(): Array<{ name: string; file: string }> {
  const found: Array<{ name: string; file: string }> = []
  for (const file of sourceFiles('src')) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/'-o',\s*['`"]([A-Z][A-Za-z]+)=/g)) found.push({ name: m[1], file })
  }
  return found
}

afterEach(() => _resetSshClientOptionsForTesting())

describe('ssh client options', () => {
  it('every -o name in the source is known, and none newer than the oldest client is spelled outside the gate', () => {
    const used = optionsUsed()
    expect(used.length).toBeGreaterThan(10)
    const unknown = [...new Set(used.filter((u) => !(u.name in ADDED_IN)).map((u) => `${u.name} (${u.file})`))]
    expect(unknown, 'add the option to ADDED_IN with the OpenSSH release that added it').toEqual([])
    const tooNew = used.filter((u) => newer(ADDED_IN[u.name], OLDEST_OPENSSH) && u.file !== GATE)
    expect(tooNew.map((u) => `${u.name} (${u.file})`), `older clients (${OLDEST_OPENSSH}) refuse these: pass them through ssh-client-options.ts`).toEqual([])
  })

  it('reads an OpenSSH 7.4 refusal and drops the option', async () => {
    const refusal = { stdout: '', stderr: 'command-line: line 0: Bad configuration option: remotecommand\n', code: 255, timedOut: false }
    expect(refusesRemoteCommand(refusal)).toBe(true)
    let calls = 0
    await learnSshClient(async (args) => { calls++; expect(args.slice(0, 3)).toEqual(['-G', '-o', 'RemoteCommand=none']); return refusal })
    await learnSshClient(async () => { calls++; return refusal })
    expect(calls).toBe(1)
    expect(remoteCommandNone()).toEqual([])
  })

  it('keeps the option for a client that takes it, and while nothing is known', async () => {
    expect(remoteCommandNone()).toEqual(['-o', 'RemoteCommand=none'])
    await learnSshClient(async () => ({ stdout: 'user evan\nremotecommand none\n', stderr: '', code: 0, timedOut: false }))
    expect(remoteCommandNone()).toEqual(['-o', 'RemoteCommand=none'])
  })

  it('a probe that cannot run changes nothing', async () => {
    await learnSshClient(async () => ({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: new Error('spawn ssh ENOENT') }))
    expect(remoteCommandNone()).toEqual(['-o', 'RemoteCommand=none'])
    _resetSshClientOptionsForTesting()
    await learnSshClient(async () => ({ stdout: '', stderr: '', code: null, timedOut: true }))
    expect(remoteCommandNone()).toEqual(['-o', 'RemoteCommand=none'])
  })
})
