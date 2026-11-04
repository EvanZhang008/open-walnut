/**
 * A Mac without the Command Line Tools: /usr/bin/git, cc, xcodebuild... show "Install Command
 * Line Developer Tools" on its owner's screen (src/providers/host-exec-clt.ts). 2026-11-04:
 * host_exec ran `xcodebuild -version` on such a Mac and the dialog came up.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CLT_STUBS, cltInstalled, cltMessage, cltStubRun, loginPath, pathHelperOrder, type CltFs } from '../../src/providers/host-exec-clt.js'

function fsWith(files: string[], link: string | null = null): CltFs {
  const set = new Set(files)
  return { exists: (p) => set.has(p), readlink: () => link }
}
const BARE_MAC = fsWith(['/usr/bin/git', '/usr/bin/python3', '/usr/bin/make', '/usr/bin/xcodebuild', '/usr/bin/ls'])
const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

/** A login shell that prints its profile's noise, then the PATH line, after `ms`; or never. */
function fakeShell(answer: string | null, ms = 0) {
  const spawned: Array<{ cmd: string; args: string[] }> = []
  const killed: number[] = []
  let pid = 4_000
  const spawn = (cmd: string, args: string[]) => {
    spawned.push({ cmd, args })
    const child = new EventEmitter() as ChildProcess
    const out = new PassThrough()
    Object.assign(child, { stdout: out, pid: ++pid })
    if (answer !== null) {
      setTimeout(() => { out.write('Welcome back\n'); out.write(`\n__WALNUT_LOGIN_PATH__=${answer}\n`); child.emit('close', 0) }, ms)
    }
    return child
  }
  return { spawn, spawned, killed, killGroup: (p: number) => { killed.push(p) } }
}
const plan = (line: string) => ({ cmd: '/bin/zsh', args: ['-l', '-c', line] })

describe('the Command Line Tools are read from the filesystem', () => {
  it('there when the selected developer dir, or a default one, holds its tools', () => {
    expect(cltInstalled(fsWith([]))).toBe(false)
    expect(cltInstalled(fsWith(['/Library/Developer/CommandLineTools/usr/bin/git']))).toBe(true)
    expect(cltInstalled(fsWith(['/Applications/Xcode.app/Contents/Developer/usr/bin/xcrun']))).toBe(true)
    expect(cltInstalled(fsWith(['/opt/Xcode-beta.app/Contents/Developer/usr/bin/xcrun'], '/opt/Xcode-beta.app/Contents/Developer'))).toBe(true)
    // A link left pointing at a removed Xcode is no tools.
    expect(cltInstalled(fsWith([], '/Applications/Xcode.app/Contents/Developer'))).toBe(false)
  })
})

describe('a line that runs a stub is refused on a Mac without them', () => {
  it.each([
    ['xcodebuild -version', 'xcodebuild'],
    ['git status', 'git'],
    ['/usr/bin/python3 -c "print(1)"', 'python3'],
    ['cd /tmp && make', 'make'],
    ['FOO=1 env git log', 'git'],
    ["bash -lc 'git --version'", 'git'],
    ['echo hi; xcrun --find clang', 'xcrun'],
    ['ls $(git rev-parse --show-toplevel)', 'git'],
    ['xcode-select --install', 'xcode-select --install'],
    // The ways a line hands a script to a shell (2026-11-04 review: each of these ran the stub).
    ['bash <<EOF\ngit status\nEOF', 'git'],
    ['echo "git status" | sh', 'git'],
    ['bash -s <<< "git status"', 'git'],
    ['find . -name x -exec git add {} \\;', 'git'],
    ['bash -o pipefail -c "git status"', 'git'],
    ['env -S "git status"', 'git'],
    ["env --split-string='make all'", 'make'],
    ['cd /usr/bin && ./git', 'git'],
    ['/usr/bin//git status', 'git'],
    ['/usr/./bin/git status', 'git'],
    ['/usr/local/../bin/git status', 'git'],
    ['zsh -c "eval xcrun --show-sdk-path"', 'xcrun'],
  ])('%s -> %s', (line, stub) => {
    expect(cltStubRun(line, PATH, BARE_MAC)).toBe(stub)
  })

  it('a relative path is the stub only where it lands in /usr/bin', () => {
    expect(cltStubRun('./git status', PATH, BARE_MAC, '/usr/bin')).toBe('git')
    expect(cltStubRun('../bin/git status', PATH, BARE_MAC, '/usr/lib')).toBe('git')
    expect(cltStubRun('./git status', PATH, BARE_MAC, '/Users/me/repo')).toBeNull()
    expect(cltStubRun('cd /usr/bin; cd /tmp; ./git', PATH, BARE_MAC)).toBeNull()
  })

  it('looking a stub up runs none', () => {
    for (const line of ['command -v git', 'which git', 'type git', 'hash git 2>/dev/null', 'xcode-select -p', 'command -V xcodebuild']) {
      expect(cltStubRun(line, PATH, BARE_MAC), line).toBeNull()
    }
  })

  it('base macOS programs, `xcode-select -p` and a stub only named are fine', () => {
    for (const line of ['ls -la', 'uname -a', 'xcode-select -p', 'echo git', 'sw_vers', 'perl -e 1', 'cat /tmp/x', 'launchctl print gui/501']) {
      expect(cltStubRun(line, PATH, BARE_MAC), line).toBeNull()
    }
  })

  it('a bare name is fine when another copy comes first on the PATH; an explicit /usr/bin one is not', () => {
    const brew = fsWith(['/opt/homebrew/bin/git', '/usr/bin/git', '/opt/homebrew/bin/python3', '/usr/bin/python3'])
    expect(cltStubRun('git status', PATH, brew)).toBeNull()
    expect(cltStubRun('python3 -V', PATH, brew)).toBeNull()
    expect(cltStubRun('/usr/bin/git status', PATH, brew)).toBe('git')
    // A copy only after /usr/bin is never reached.
    expect(cltStubRun('git status', '/usr/bin:/opt/homebrew/bin', brew)).toBe('git')
  })

  it('every stub name is a plain program name, and the refusal says what to do', () => {
    for (const n of CLT_STUBS) expect(n).toMatch(/^[a-z0-9_+.-]+$/)
    const msg = cltMessage('xcodebuild', 'this Mac')
    expect(msg).toContain('Install Command Line Developer Tools')
    expect(msg).toContain('allow_prompts: true')
    expect(msg).toContain('Nothing ran')
  })
})

describe('the PATH a run gets is the login shell\'s', () => {
  it('path_helper order until the shell answers, then the PATH it printed, asked once', async () => {
    const sh = fakeShell('/opt/homebrew/bin:/usr/bin:/bin', 20)
    const get = loginPath({ spawn: sh.spawn as never, killGroup: sh.killGroup, plan, env: { PATH: '/usr/bin:/bin' }, home: '/Users/me' })
    expect(get()).toBe(pathHelperOrder({ PATH: '/usr/bin:/bin' }))
    expect(get().split(':').slice(0, 2)).toEqual(['/usr/local/bin', '/usr/bin'])
    await new Promise((r) => setTimeout(r, 60))
    expect(get()).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(sh.spawned).toHaveLength(1)
    expect(sh.spawned[0].args.join(' ')).toContain('"$PATH"')
  })

  it('a shell that never answers is killed after 5 s and the guess stays', async () => {
    let t = 0
    const sh = fakeShell(null)
    const get = loginPath({ spawn: sh.spawn as never, killGroup: sh.killGroup, plan, env: { PATH: '/usr/bin' }, home: '/h', now: () => t })
    expect(get()).toBe(pathHelperOrder({ PATH: '/usr/bin' }))
    await new Promise((r) => setTimeout(r, 5_100))
    expect(sh.killed).toHaveLength(1)
    t += 60_000
    expect(get()).toBe(pathHelperOrder({ PATH: '/usr/bin' }))
    expect(sh.spawned).toHaveLength(1)
  }, 10_000)

  it('Homebrew is first only when the shell says so: with path_helper order a bare git is the stub', () => {
    const brew = fsWith(['/opt/homebrew/bin/git', '/usr/bin/git'])
    expect(cltStubRun('git status', pathHelperOrder({ PATH: '/usr/bin:/bin' }), brew)).toBe('git')
    expect(cltStubRun('git status', '/opt/homebrew/bin:/usr/bin:/bin', brew)).toBeNull()
  })
})
