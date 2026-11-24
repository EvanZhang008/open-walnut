/**
 * host.preflight's claude block, asked the way each daemon twin spawns:
 * shell_setup runs under the user's $SHELL, a slow shell is "unknown" (never
 * "not installed"), and the binary twin (it spawns through `$SHELL -c`) asks
 * that shell before it calls claude missing or nodeless.
 */
import { describe, it, expect } from 'vitest'
import { createHostRuntime } from '../../src/providers/host-runtime-core.js'
import { claudeMissingMessage } from '../../src/core/hosts/host-readiness-problems.js'
import { ELF, HOME, fakeHost, glibcFail, npmHostFiles } from '../helpers/fake-host-runtime.js'

const MISSING = claudeMissingMessage({ hostLabel: 'this host' })

describe('preflight: shell_setup', () => {
  // The daemon's spawnPreamble puts the shell_setup FILE into the preamble a session starts with
  // (session-shell.ts); shellSetupFile writes preflight's setup to a private scratch file.
  const withSetup = (file?: string) => (file ? '. ' + file : ':')
  const scratch = () => {
    const removed: string[] = []
    let n = 0
    const shellSetupFile = (setup: string) => { const file = `/state/scratch-${++n}/setup`; void setup; return { file, remove: () => { removed.push(file) } } }
    return { shellSetupFile, removed }
  }

  it('shell_setup runs through the spawn preamble, in the session shell ($SHELL, else /bin/sh)', async () => {
    const files = { '/bin/bash': { content: ELF, exec: true } }
    const ok = fakeHost(files, () => ({ code: 0, stdout: '__WALNUT_LOGIN_PATH__=/usr/bin\n' }), { HOME, PATH: '/usr/bin', SHELL: '/bin/bash' })
    const held = scratch()
    await createHostRuntime({ ...ok.deps, spawnPreamble: withSetup, shellSetupFile: held.shellSetupFile }).preflight({ shellSetup: 'source ~/.bashrc' })
    expect(ok.calls[0].file).toBe('/bin/bash')
    // The shell's argv names the scratch file, never the setup text, and the file is removed after.
    expect(ok.calls[0].args[1]).toMatch(/^\. \/state\/scratch-1\/setup; printf /)
    for (const c of ok.calls) expect(c.args.join(' ')).not.toContain('source ~/.bashrc')
    expect(held.removed).toEqual(['/state/scratch-1/setup'])
    const gone = fakeHost(files, () => ({ code: 0, stdout: '__WALNUT_LOGIN_PATH__=/usr/bin\n' }), { HOME, PATH: '/usr/bin', SHELL: '/usr/local/bin/zsh' })
    await createHostRuntime({ ...gone.deps, spawnPreamble: withSetup, shellSetupFile: scratch().shellSetupFile }).preflight({ shellSetup: 'source ~/.bashrc' })
    expect(gone.calls[0].file).toBe('/bin/sh')
    // The daemon names the shell its sessions start in: that one runs it.
    const named = fakeHost(files, () => ({ code: 0, stdout: '__WALNUT_LOGIN_PATH__=/usr/bin\n' }), { HOME, PATH: '/usr/bin', SHELL: '/bin/sh' })
    await createHostRuntime({ ...named.deps, spawnPreamble: withSetup, shellSetupFile: scratch().shellSetupFile, sessionShell: () => '/bin/bash' }).preflight({ shellSetup: 'source ~/.bashrc' })
    expect(named.calls[0].file).toBe('/bin/bash')
  })

  it('a slow shell_setup is unknown, never "not installed", and the spawn shell is not asked again', async () => {
    const { deps, calls } = fakeHost({}, () => ({ code: 1, killed: true }), { HOME, PATH: '/usr/bin' })
    const held = scratch()
    expect((await createHostRuntime({ ...deps, spawnPreamble: withSetup, shellSetupFile: held.shellSetupFile }).preflight({ shellSetup: 'source /slow/env.sh' })).claude).toEqual({ found: false, unknown: 'shell_setup did not finish in time' })
    expect(calls).toHaveLength(1)
    expect(held.removed).toHaveLength(1)
  })

  it('a setup file that could not be written runs no shell_setup', async () => {
    const { deps, calls } = fakeHost({}, () => ({ code: 1 }), { HOME, PATH: '/usr/bin' })
    await createHostRuntime({ ...deps, spawnPreamble: withSetup, shellSetupFile: () => null }).preflight({ shellSetup: 'export X=1' })
    for (const c of calls) expect(c.args.join(' ')).not.toContain('export X=1')
    expect(calls.some((c) => c.file === '/bin/sh' && /printf "\\n__WALNUT_LOGIN_PATH__/.test(c.args[1] || ''))).toBe(false)
  })

  it('a runtime with no spawn preamble (an in-process check) runs no shell_setup', async () => {
    const { deps, calls } = fakeHost({}, () => ({ code: 0 }), { HOME, PATH: '/usr/bin' })
    await createHostRuntime(deps).preflight({ shellSetup: 'export X=1' })
    expect(calls).toEqual([])
  })
})

// ── The spawn shell's second opinion (binary twin: it spawns through $SHELL) ─

describe('preflight asks the spawn shell before calling claude missing or nodeless', () => {
  const ZSH = { '/bin/zsh': { content: ELF, exec: true } }
  const env = { HOME, PATH: '/usr/bin', SHELL: '/bin/zsh' }
  const preamble = () => 'export PATH=/opt/rc/bin:$PATH'
  const isSecondOpinion = (file: string, args: string[]) => file === '/bin/zsh' && String(args[1]).includes('__WALNUT_HAS_CMD__')
  const isShellVersion = (file: string, args: string[]) => file === '/bin/zsh' && String(args[1]).endsWith(' --version')

  it('a claude only the spawn shell reaches is found there, and its version is asked through that shell', async () => {
    const files = { ...ZSH, '/opt/rc/bin/claude': { content: ELF, exec: true } }
    const { deps, calls } = fakeHost(files, (file, args) => {
      if (isSecondOpinion(file, args)) return { code: 0, stdout: '\n__WALNUT_HAS_CMD__=/opt/rc/bin/claude\n' }
      if (isShellVersion(file, args)) return { code: 0, stdout: '2.1.281 (Claude Code)\n' }
      return { code: 1 }
    }, env)
    const out = await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()
    expect(out.claude).toEqual({ found: true, path: '/opt/rc/bin/claude', kind: 'native', needsNode: false, version: '2.1.281' })
    const version = calls.find((c) => isShellVersion(c.file, c.args))!
    expect(version.args[1]).toBe("export PATH=/opt/rc/bin:$PATH; exec '/opt/rc/bin/claude' --version")
  })

  it('an npm claude whose node only the spawn shell reaches is not reported as needing Node.js', async () => {
    const { deps } = fakeHost({ ...ZSH, ...npmHostFiles() }, (file, args) => {
      if (isSecondOpinion(file, args)) return { code: 0, stdout: `\n__WALNUT_HAS_CMD__=${HOME}/.local/bin/claude\n__WALNUT_HAS_NODE__\n` }
      if (isShellVersion(file, args)) return { code: 0, stdout: '2.1.280 (Claude Code)\n' }
      return glibcFail
    }, { ...env, PATH: `${HOME}/.local/bin:/usr/bin` })
    const out = await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()
    expect(out.claude).toMatchObject({ found: true, kind: 'npm', needsNode: true, nodeFound: true, version: '2.1.280' })
    expect(out.claude.error).toBeUndefined()
  })

  it('a spawn shell that does not answer in time is unknown, never "not installed"', async () => {
    const { deps } = fakeHost(ZSH, (file, args) => (isSecondOpinion(file, args) ? { code: 1, killed: true } : { code: 1 }), env)
    expect((await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()).claude).toEqual({ found: false, unknown: 'the login shell did not answer in time' })
  })

  it('a claude that is a shell function or alias is unknown (the shell may run it, there is nothing to inspect)', async () => {
    const { deps } = fakeHost(ZSH, (file, args) => (isSecondOpinion(file, args) ? { code: 0, stdout: '\n__WALNUT_HAS_CMD__=claude\n' } : { code: 1 }), env)
    expect((await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()).claude).toEqual({ found: false, unknown: 'claude is a shell function or alias' })
  })

  it('a shell that does not know claude either: the not-installed sentence', async () => {
    const { deps } = fakeHost(ZSH, () => ({ code: 0, stdout: '' }), env)
    expect((await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()).claude).toEqual({ found: false, error: MISSING })
  })

  it('a claude the daemon PATH already runs never asks the shell', async () => {
    const { deps, calls } = fakeHost({ ...ZSH, '/usr/bin/claude': { content: ELF, exec: true } }, (file, args) => (args[0] === '--version' ? { code: 0, stdout: '2.1.281\n' } : { code: 1 }), env)
    await createHostRuntime({ ...deps, spawnPreamble: preamble }).preflight()
    expect(calls.map((c) => c.file)).toEqual(['/usr/bin/claude'])
  })
})
