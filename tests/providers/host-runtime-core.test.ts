/**
 * Host runtime discovery (src/providers/host-runtime-core.ts): the daemon PATH
 * order, the claude/node spawn gate and the host.preflight answer.
 *
 * Only the fs + exec layer is faked (a map of files, a scripted execFile), so
 * the real classification, search order, caching and message text all run.
 * The factory is also re-materialized from its toString(), because that text
 * is what the source-deployed daemon twin actually runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildDaemonPath,
  classifyClaudeHead,
  createHostRuntime,
  defaultDaemonExtraPaths,
  describeClaudeLaunchFailure,
  HOST_RUNTIME_MESSAGES,
  nodeCandidateDirs,
  type HostRuntimeDeps,
} from '../../src/providers/host-runtime-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOME = '/home/dev'
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const NEEDS_NODE = 'Claude Code on this host is the npm build and needs Node.js, but no working node was found'
  + ' (checked PATH, nvm, fnm, volta, asdf). Install the native build, which needs no Node: ' + INSTALL
const MISSING = 'Claude Code is not installed on this host. Install it: ' + INSTALL

// ── Fake host ────────────────────────────────────────────────────────────────

interface FakeFile { content: string; exec?: boolean; linkTo?: string }
type ExecScript = (file: string, args: string[], opts: Record<string, unknown>) => { code: number; stdout?: string; stderr?: string }

function fakeHost(files: Record<string, FakeFile>, script: ExecScript, env: Record<string, string | undefined>) {
  const calls: Array<{ file: string; args: string[]; timeout: number; env: Record<string, unknown> }> = []
  const resolve = (p: string): FakeFile | undefined => {
    let f = files[p]
    for (let i = 0; f?.linkTo && i < 5; i++) f = files[f.linkTo]
    return f
  }
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const fds = new Map<number, FakeFile>()
  let nextFd = 3
  const fakeFs = {
    constants: fs.constants,
    existsSync: (p: string) => !!resolve(String(p)) || Object.keys(files).some((k) => k.startsWith(String(p) + '/')),
    statSync: (p: string) => {
      const f = resolve(String(p))
      if (!f) throw enoent(String(p))
      return { isFile: () => true }
    },
    accessSync: (p: string) => { if (!resolve(String(p))?.exec) throw enoent(String(p)) },
    openSync: (p: string) => {
      const f = resolve(String(p))
      if (!f) throw enoent(String(p))
      fds.set(nextFd, f)
      return nextFd++
    },
    readSync: (fd: number, buf: Buffer) => {
      const bytes = Buffer.from(fds.get(fd)!.content, 'latin1')
      bytes.copy(buf, 0, 0, Math.min(bytes.length, buf.length))
      return Math.min(bytes.length, buf.length)
    },
    closeSync: (fd: number) => { fds.delete(fd) },
    readdirSync: (dir: string) => {
      const prefix = String(dir).replace(/\/$/, '') + '/'
      const names = new Set<string>()
      for (const k of Object.keys(files)) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
      if (!names.size) throw enoent(String(dir))
      return [...names]
    },
  }
  const execFile: HostRuntimeDeps['execFile'] = (file, args, opts, cb) => {
    calls.push({ file, args, timeout: Number(opts.timeout), env: opts.env as Record<string, unknown> })
    const r = script(file, args, opts)
    const err = r.code === 0 ? null : Object.assign(new Error(`exit ${r.code}`), { code: r.code })
    queueMicrotask(() => cb(err, r.stdout ?? '', r.stderr ?? ''))
    return undefined
  }
  const deps: HostRuntimeDeps = { fs: fakeFs as unknown as HostRuntimeDeps['fs'], execFile, env }
  return { deps, calls }
}

const NPM_CLI = '#!/usr/bin/env node\nimport "./dist/cli.js"\n'
const ELF = '\x7fELF\x02\x01\x01\x00rest-of-binary'
const glibcFail = { code: 1, stderr: "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)" }

/** The fixture a remote user hit: npm claude symlinked into ~/.local/bin, nvm with too-new nodes. */
function npmHostFiles(extra: Record<string, FakeFile> = {}): Record<string, FakeFile> {
  return {
    [`${HOME}/.local/bin/claude`]: { content: '', exec: true, linkTo: `${HOME}/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js` },
    [`${HOME}/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js`]: { content: NPM_CLI, exec: true },
    ...extra,
  }
}

// ── Classification ───────────────────────────────────────────────────────────

describe('classifyClaudeHead', () => {
  it('reads ELF and every Mach-O magic as a native build that needs no node', () => {
    for (const magic of ['\x7fELF', '\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xce\xfa\xed\xfe', '\xcf\xfa\xed\xfe', '\xca\xfe\xba\xbe']) {
      expect(classifyClaudeHead(magic + '\x00\x00rest')).toEqual({ kind: 'native', needsNode: false })
    }
  })

  it('reads an `env node` shebang (with -S, flags, env assignments, CRLF) as the npm build', () => {
    for (const line of [
      '#!/usr/bin/env node\n',
      '#!/usr/bin/env node\r\n',
      '#! /usr/bin/env node --no-warnings\n',
      '#!/usr/bin/env -S node --max-old-space-size=4096\n',
      '#!/usr/bin/env NODE_OPTIONS=--no-deprecation node\n',
      '#!/usr/bin/env nodejs\n',
    ]) {
      expect(classifyClaudeHead(line), line).toEqual({ kind: 'npm', needsNode: true })
    }
  })

  it('keeps an absolute node interpreter so the gate runs THAT node, not one from PATH', () => {
    expect(classifyClaudeHead('#!/opt/node/bin/node\n')).toEqual({ kind: 'npm', needsNode: true, interpreter: '/opt/node/bin/node' })
  })

  it('never blocks a wrapper it cannot see through (shell script, other env program, no shebang)', () => {
    for (const head of ['#!/bin/sh\nexec node x.js\n', '#!/usr/bin/env bash\n', '#!/usr/bin/env -S\n', 'plain text', '']) {
      expect(classifyClaudeHead(head), head).toEqual({ kind: 'unknown', needsNode: false })
    }
  })
})

// ── Candidate order ──────────────────────────────────────────────────────────

describe('nodeCandidateDirs', () => {
  const tree: Record<string, string[]> = {
    [`${HOME}/.nvm/versions/node`]: ['v9.11.2', 'v16.20.2', 'v22.1.0', 'v18.20.4'],
    [`${HOME}/.fnm/node-versions`]: ['v20.1.0'],
    [`${HOME}/.volta/tools/image/node`]: ['18.0.0', '20.5.1'],
    [`${HOME}/.asdf/installs/nodejs`]: ['16.0.0'],
  }
  const listDir = (dir: string) => tree[dir] ?? []

  it('walks nvm newest first by VERSION (not by ls order), then fnm, volta, asdf, then the plain dirs', () => {
    expect(nodeCandidateDirs(HOME, {}, listDir)).toEqual([
      `${HOME}/.nvm/versions/node/v22.1.0/bin`,
      `${HOME}/.nvm/versions/node/v18.20.4/bin`,
      `${HOME}/.nvm/versions/node/v16.20.2/bin`,
      `${HOME}/.nvm/versions/node/v9.11.2/bin`,
      `${HOME}/.fnm/node-versions/v20.1.0/installation/bin`,
      `${HOME}/.volta/tools/image/node/20.5.1/bin`,
      `${HOME}/.volta/tools/image/node/18.0.0/bin`,
      `${HOME}/.volta/bin`,
      `${HOME}/.asdf/installs/nodejs/16.0.0/bin`,
      `${HOME}/.asdf/shims`,
      `${HOME}/.local/bin`,
      `${HOME}/.npm-global/bin`,
      '/usr/local/bin',
    ])
  })

  it('honours NVM_DIR and sorts names that are not versions last', () => {
    const dirs = nodeCandidateDirs(HOME, { NVM_DIR: '/opt/nvm' }, (d) => d === '/opt/nvm/versions/node' ? ['system', 'v20.0.0'] : [])
    expect(dirs.slice(0, 2)).toEqual(['/opt/nvm/versions/node/v20.0.0/bin', '/opt/nvm/versions/node/system/bin'])
  })
})

// ── Daemon PATH order ────────────────────────────────────────────────────────

describe('buildDaemonPath', () => {
  const extras = defaultDaemonExtraPaths(HOME)

  it("keeps the user's version-manager node first and puts the inherited node after the user's entries", () => {
    // The Mac report: the server's shell had node@18 first, the user's .zshrc picks node@22.
    const user = `${HOME}/.nvm/versions/node/v22.1.0/bin:/opt/homebrew/bin:/usr/bin:/bin`
    const inherited = '/opt/homebrew/opt/node@18/bin:/usr/bin:/bin'
    const parts = buildDaemonPath(user, extras, inherited).split(':')
    expect(parts[0]).toBe(`${HOME}/.nvm/versions/node/v22.1.0/bin`)
    const inheritedNode = parts.indexOf('/opt/homebrew/opt/node@18/bin')
    for (const entry of user.split(':')) expect(parts.indexOf(entry)).toBeLessThan(inheritedNode)
    // ...and after every fallback too: the inherited PATH is the last resort.
    for (const entry of extras) expect(parts.indexOf(entry)).toBeLessThan(inheritedNode)
  })

  it('never lets ~/.toolbox/bin jump ahead of the user PATH, but it still leads the fallbacks', () => {
    const parts = buildDaemonPath(`${HOME}/.local/bin:/usr/bin`, extras, '').split(':')
    expect(parts.slice(0, 3)).toEqual([`${HOME}/.local/bin`, '/usr/bin', `${HOME}/.toolbox/bin`])
  })

  it('dedupes keeping the FIRST occurrence and drops empty segments', () => {
    expect(buildDaemonPath('/a::/b:/a', ['/b', '/c'], '/c:/d::/a')).toBe('/a:/b:/c:/d')
  })

  it('with no user PATH: fallbacks first, then the inherited PATH', () => {
    expect(buildDaemonPath('', ['/x', '/y'], '/y:/z')).toBe('/x:/y:/z')
  })
})

describe('computeDaemonPath: login-shell capture', () => {
  function withSyncExec(env: Record<string, string | undefined>, answer: (file: string, args: string[], opts: Record<string, unknown>) => string) {
    const syncCalls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    const { deps } = fakeHost({ '/bin/zsh': { content: ELF, exec: true }, '/bin/bash': { content: ELF, exec: true }, [`${HOME}/.zshrc`]: { content: '' } }, () => ({ code: 0 }), env)
    deps.execFileSync = (file, args, opts) => { syncCalls.push({ file, args, opts }); return answer(file, args, opts) }
    return { rt: createHostRuntime(deps), syncCalls }
  }

  it('runs $SHELL -lc from a CLEAN env, so the inherited PATH and env cannot leak into the answer', () => {
    const env = { HOME, USER: 'dev', SHELL: '/bin/zsh', PATH: '/opt/homebrew/opt/node@18/bin:/usr/bin', NODE_OPTIONS: '--inspect' }
    const { rt, syncCalls } = withSyncExec(env, () => 'motd banner\n\n__WALNUT_LOGIN_PATH__=/u/nvm22/bin:/usr/bin:/bin\n')
    const out = rt.computeDaemonPath()
    expect(out.source).toBe('login-shell')
    expect(syncCalls[0].file).toBe('/bin/zsh')
    expect(syncCalls[0].args[0]).toBe('-lc')
    expect(syncCalls[0].args[1]).toContain('. "$HOME/.zshrc"')
    expect(syncCalls[0].opts.timeout).toBe(5000)
    expect(syncCalls[0].opts.env).toEqual({ PATH: '/usr/bin:/bin', TERM: 'dumb', HOME, USER: 'dev', SHELL: '/bin/zsh' })
    const parts = out.path.split(':')
    expect(parts[0]).toBe('/u/nvm22/bin')
    expect(parts.indexOf('/opt/homebrew/opt/node@18/bin')).toBe(parts.length - 1)
  })

  it('falls back to rc sourcing (inherited env) when $SHELL is missing', () => {
    const { rt, syncCalls } = withSyncExec({ HOME, PATH: '/usr/bin' }, () => '/from/rc/bin:/usr/local/bin:/usr/bin:/bin\n')
    const out = rt.computeDaemonPath()
    expect(out.source).toBe('rc')
    expect(syncCalls[0].args).toEqual(['-c', `source ${JSON.stringify(`${HOME}/.zshrc`)} 2>/dev/null; echo "$PATH"`])
    expect(out.path.split(':')[0]).toBe('/from/rc/bin')
  })

  it('falls back when the login shell fails, and answers extras + inherited when nothing works', () => {
    const { rt } = withSyncExec({ HOME, SHELL: '/bin/zsh', PATH: '/inherited' }, () => { throw new Error('timed out') })
    const out = rt.computeDaemonPath()
    expect(out.source).toBe('none')
    expect(out.path).toBe([...defaultDaemonExtraPaths(HOME), '/inherited'].join(':'))
  })

  it('does not feed an sh script to a shell that is not sh-compatible (fish)', () => {
    expect(createHostRuntime({ env: {} }).loginShellScript('/usr/bin/fish')).toBeNull()
    expect(createHostRuntime({ env: {} }).parseLoginShellPath('x\n__WALNUT_LOGIN_PATH__=relative-only\n')).toBeNull()
  })
})

// ── Spawn gate ───────────────────────────────────────────────────────────────

describe('ensureClaude', () => {
  it('npm claude + broken PATH node + too-new nvm nodes: finds the older nvm node that RUNS and caches it', async () => {
    const files = npmHostFiles({
      '/usr/bin/node': { content: ELF, exec: true },
      [`${HOME}/.nvm/versions/node/v22.1.0/bin/node`]: { content: ELF, exec: true },
      [`${HOME}/.nvm/versions/node/v16.20.2/bin/node`]: { content: ELF, exec: true },
    })
    const { deps, calls } = fakeHost(files, (file) => file.includes('v16.20.2') ? { code: 0, stdout: 'v16.20.2\n' } : glibcFail,
      { HOME, PATH: `${HOME}/.local/bin:/usr/bin:/bin` })
    const rt = createHostRuntime(deps)
    const r = await rt.ensureClaude('claude', deps.env.PATH!)
    expect(r).toEqual({ ok: true, path: `${HOME}/.local/bin/claude`, kind: 'npm', nodeDir: `${HOME}/.nvm/versions/node/v16.20.2/bin` })
    expect(calls.map((c) => c.file)).toEqual(['/usr/bin/node', `${HOME}/.nvm/versions/node/v22.1.0/bin/node`, `${HOME}/.nvm/versions/node/v16.20.2/bin/node`])
    for (const c of calls) expect(c.timeout).toBeLessThanOrEqual(5000)
    // Per daemon process: the second spawn does not re-walk.
    await rt.ensureClaude('claude', deps.env.PATH!)
    expect(calls).toHaveLength(3)
  })

  it('npm claude with no runnable node anywhere: the exact Node.js sentence, and a later install is seen', async () => {
    const files = npmHostFiles({ [`${HOME}/.nvm/versions/node/v22.1.0/bin/node`]: { content: ELF, exec: true } })
    let nodeWorks = false
    const { deps } = fakeHost(files, () => nodeWorks ? { code: 0, stdout: 'v22.1.0' } : glibcFail, { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    const rt = createHostRuntime(deps)
    expect(await rt.ensureClaude('claude', deps.env.PATH!)).toEqual({ ok: false, code: 'claude_needs_node', message: NEEDS_NODE })
    nodeWorks = true  // the user fixed it; a failure is never cached
    expect(await rt.ensureClaude('claude', deps.env.PATH!)).toMatchObject({ ok: true, nodeDir: `${HOME}/.nvm/versions/node/v22.1.0/bin` })
  })

  it('a working node on PATH needs no prepend', async () => {
    const { deps } = fakeHost(npmHostFiles({ '/usr/bin/node': { content: ELF, exec: true } }), () => ({ code: 0, stdout: 'v20.0.0\n' }), { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    expect(await createHostRuntime(deps).ensureClaude('claude', deps.env.PATH!)).toEqual({ ok: true, path: `${HOME}/.local/bin/claude`, kind: 'npm' })
  })

  it('a native claude never executes anything', async () => {
    const { deps, calls } = fakeHost({ [`${HOME}/.local/bin/claude`]: { content: ELF, exec: true } }, () => glibcFail, { HOME, PATH: `${HOME}/.local/bin` })
    expect(await createHostRuntime(deps).ensureClaude('claude', deps.env.PATH!)).toEqual({ ok: true, path: `${HOME}/.local/bin/claude`, kind: 'native' })
    expect(calls).toEqual([])
  })

  it('claude absent: the exact not-installed sentence; a custom command is named', async () => {
    const { deps } = fakeHost({}, () => ({ code: 0 }), { HOME, PATH: '/usr/bin' })
    const rt = createHostRuntime(deps)
    expect(await rt.ensureClaude('claude', '/usr/bin')).toEqual({ ok: false, code: 'claude_missing', message: MISSING })
    expect(await rt.ensureClaude('/opt/tools/claude-fork', '/usr/bin')).toMatchObject({ ok: false, code: 'claude_missing', message: 'The Claude Code command "/opt/tools/claude-fork" was not found on this host.' })
  })
})

// ── host.preflight ───────────────────────────────────────────────────────────

describe('preflight', () => {
  it('the fresh AL2-class host: npm claude, no node, no gcc, no dtach', async () => {
    const { deps } = fakeHost(npmHostFiles(), () => glibcFail, { HOME, PATH: `${HOME}/.local/bin:/usr/bin:/bin` })
    expect(await createHostRuntime(deps).preflight()).toEqual({
      claude: { found: true, path: `${HOME}/.local/bin/claude`, kind: 'npm', needsNode: true, nodeFound: false, error: NEEDS_NODE },
      compiler: { found: false },
      dtach: { found: false },
    })
  })

  it('a ready host: native claude with its version, gcc, and Walnut\'s own dtach build', async () => {
    const files = {
      [`${HOME}/.local/bin/claude`]: { content: ELF, exec: true },
      '/usr/bin/gcc': { content: ELF, exec: true },
      [`${HOME}/.local/bin/walnut-dtach`]: { content: ELF, exec: true },
    }
    const { deps, calls } = fakeHost(files, (file, args) => args[0] === '--version' ? { code: 0, stdout: '2.1.280 (Claude Code)\n' } : { code: 1 },
      { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    expect(await createHostRuntime(deps).preflight()).toEqual({
      claude: { found: true, path: `${HOME}/.local/bin/claude`, kind: 'native', needsNode: false, version: '2.1.280' },
      compiler: { found: true, name: 'gcc' },
      dtach: { found: true, path: `${HOME}/.local/bin/walnut-dtach` },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].timeout).toBeLessThanOrEqual(5000)
  })

  it('runs `claude --version` with the discovered node dir first on PATH, and reports a crash', async () => {
    const files = npmHostFiles({ [`${HOME}/.nvm/versions/node/v16.20.2/bin/node`]: { content: ELF, exec: true }, '/usr/bin/dtach': { content: ELF, exec: true } })
    const { deps, calls } = fakeHost(files, (file, args) => {
      if (args[0] === '-v') return { code: 0, stdout: 'v16.20.2' }
      return { code: 1, stderr: 'SyntaxError: Unexpected token\n    at node:internal' }
    }, { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    const out = await createHostRuntime(deps).preflight()
    expect(out.claude).toMatchObject({ found: true, kind: 'npm', nodeFound: true, nodeVersion: 'v16.20.2', error: 'claude --version exited with code 1: SyntaxError: Unexpected token' })
    expect(out.dtach).toEqual({ found: true, path: '/usr/bin/dtach' })
    const versionCall = calls.find((c) => c.args[0] === '--version')!
    expect(String(versionCall.env.PATH).split(':')[0]).toBe(`${HOME}/.nvm/versions/node/v16.20.2/bin`)
  })

  it('with claudeCheck: sign-in and the floor ride on the claude block, the floor comes from the RPC args', async () => {
    const files = { [`${HOME}/.local/bin/claude`]: { content: ELF, exec: true }, '/usr/bin/gcc': { content: ELF, exec: true } }
    const { deps } = fakeHost(files, (file, args) => args[0] === '--version' ? { code: 0, stdout: '2.1.258 (Claude Code)\n' } : { code: 1 },
      { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    const seen: unknown[] = []
    const claudeCheck = {
      check: async (input: Record<string, unknown>) => {
        seen.push(input)
        return { auth: 'not-logged-in' as const, versionOk: false, minVersion: '2.1.280', installMethod: 'native' as const }
      },
    }
    const out = await createHostRuntime({ ...deps, claudeCheck }).preflight({ minClaudeVersion: '2.1.280' })
    expect(out.claude).toEqual({
      found: true, path: `${HOME}/.local/bin/claude`, kind: 'native', needsNode: false, version: '2.1.258',
      auth: 'not-logged-in', versionOk: false, minVersion: '2.1.280', installMethod: 'native',
    })
    expect(seen).toEqual([expect.objectContaining({ path: `${HOME}/.local/bin/claude`, version: '2.1.258', kind: 'native', minVersion: '2.1.280', deadline: expect.any(Number) })])
    // A floor that is not a plain version is ignored, never passed on.
    await createHostRuntime({ ...deps, claudeCheck }).preflight({ minClaudeVersion: '2.1.280; rm -rf /' })
    expect((seen[1] as { minVersion?: string }).minVersion).toBeUndefined()
  })

  it('with claudeCheck: a claude that does not start is never asked about sign-in', async () => {
    const { deps } = fakeHost(npmHostFiles(), () => glibcFail, { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
    let asked = false
    const out = await createHostRuntime({ ...deps, claudeCheck: { check: async () => { asked = true; return { auth: 'ok' as const, installMethod: 'npm' as const } } } }).preflight()
    expect(asked).toBe(false)
    expect(out.claude.auth).toBeUndefined()
  })

  it('claude missing entirely', async () => {
    const { deps } = fakeHost({ '/usr/bin/cc': { content: ELF, exec: true } }, () => ({ code: 0 }), { HOME, PATH: '/usr/bin' })
    const out = await createHostRuntime(deps).preflight()
    expect(out.claude).toEqual({ found: false, error: MISSING })
    expect(out.compiler).toEqual({ found: true, name: 'cc' })
  })
})

// ── Exit-127 stderr → the same sentences ─────────────────────────────────────

describe('describeClaudeLaunchFailure', () => {
  it('maps every shell\'s not-found shape and the env-node shape', () => {
    expect(describeClaudeLaunchFailure("/usr/bin/env: 'node': No such file or directory")).toBe(NEEDS_NODE)
    expect(describeClaudeLaunchFailure('/usr/bin/env: \u2018node\u2019: No such file or directory')).toBe(NEEDS_NODE)
    expect(describeClaudeLaunchFailure('env: node: No such file or directory')).toBe(NEEDS_NODE)
    expect(describeClaudeLaunchFailure('bash: line 0: exec: claude: not found')).toBe(MISSING)
    expect(describeClaudeLaunchFailure('claude: command not found')).toBe(MISSING)
    expect(describeClaudeLaunchFailure('zsh:1: command not found: claude')).toBe(MISSING)
    expect(describeClaudeLaunchFailure('Error: ENOSPC: no space left on device')).toBeNull()
    expect(HOST_RUNTIME_MESSAGES.claudeMissing).toBe(MISSING)
  })
})

// ── The text the source twin runs ────────────────────────────────────────────

describe('injection into the source daemon twin', () => {
  const FORBIDDEN = [/\b__name\b/, /\b__publicField\b/, /\b__defProp\b/, /\b__spreadValues\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bexports\./, /\bmodule\.exports\b/]

  it('createHostRuntime.toString() carries no module-scope or bundler identifiers', () => {
    const src = createHostRuntime.toString()
    for (const re of FORBIDDEN) expect(src, `forbidden ${re}`).not.toMatch(re)
  })

  it('a re-materialized copy gives the same gate and preflight answers as the import', async () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const copy = new Function('"use strict"; return ' + createHostRuntime.toString())() as typeof createHostRuntime
    const run = async (factory: typeof createHostRuntime) => {
      const { deps } = fakeHost(npmHostFiles(), () => glibcFail, { HOME, PATH: `${HOME}/.local/bin:/usr/bin` })
      const rt = factory(deps)
      return [await rt.ensureClaude('claude', deps.env.PATH!), await rt.preflight(), rt.buildDaemonPath('/u', ['/x'], '/i:/u')]
    }
    expect(await run(copy)).toEqual(await run(createHostRuntime))
  })

  it('the deployed template has no placeholder residue and wires the gate + preflight like the binary twin', () => {
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_HOST_RUNTIME__')
    expect(generated).not.toContain('__CREATE_CLAUDE_CHECK__')
    const root = path.resolve(__dirname, '../..')
    const standalone = fs.readFileSync(path.join(root, 'src/providers/daemon-standalone.ts'), 'utf-8')
    const template = fs.readFileSync(path.join(root, 'src/providers/daemon-source.ts'), 'utf-8')
    for (const [label, src] of [['standalone', standalone], ['template', template]] as const) {
      expect(src, label).toMatch(/process\.env\.PATH = bootPath\.path/)
      expect(src, label).toMatch(/case 'host\.preflight':/)
      // The server's floor reaches the daemon, and both twins hand the runtime a sign-in check.
      expect(src, label).toMatch(/hostRuntime\.preflight\(cmd\)/)
      expect(src, label).toMatch(/claudeCheck: (createClaudeCheck|\(__CREATE_CLAUDE_CHECK__\))\(\{ fs(: fs)?, execFile(: execFile)?, env: process\.env \}\)/)
      expect(src, label).toMatch(/const launch = await gateClaudeLaunch\(args\)/)
      expect(src, label).toMatch(/code: 'CLAUDE_RUNTIME', errorKind: gate\.code/)
      // The reason reaches the client verbatim, not as an "internal daemon error".
      expect(src, label).toMatch(/sendError\(ws, id, result(\.runtimeError)?\.message, \{ errorKind: result(\.runtimeError)?\.errorKind \}\)/)
    }
    for (const src of [standalone, template]) {
      const allow = src.slice(src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')))
      expect(allow).not.toContain('host.preflight')
    }
  })
})
