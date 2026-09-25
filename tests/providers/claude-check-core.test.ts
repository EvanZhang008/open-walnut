/**
 * Claude Code sign-in and version checks (src/providers/claude-check-core.ts):
 * the rule host.preflight uses to say `claude.auth` and `claude.versionOk`.
 *
 * Only the fs, env and exec layer is faked. The scripted `claude auth status
 * --json` answers are the exact shapes the 2.1.240 / 2.1.258 / 2.1.280 binaries
 * print (captured with an empty CLAUDE_CONFIG_DIR, one variable at a time).
 * The factory is also re-materialized from its toString(), because that text is
 * what the source-deployed daemon twin runs.
 */
import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { createClaudeCheck, type ClaudeCheckDeps, type ClaudeCheckInput } from '../../src/providers/claude-check-core.js'
import { getDaemonSource, validateFoldInjection } from '../../src/providers/daemon-source.js'
import { foldLine, initialFoldState, assembleSnapshot } from '../../src/providers/daemon-fold.js'

const HOME = '/home/dev'
const NATIVE = `${HOME}/.local/bin/claude`
const SIGNED_OUT = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n'
const BEDROCK = '{\n  "loggedIn": true,\n  "authMethod": "third_party",\n  "apiProvider": "bedrock"\n}\n'
const ACCOUNT = '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "someone@example.test", "orgName": "Example"}'

/** `hang: true` = the child never answers (a grandchild holding stdout open). */
type Script = (file: string, args: string[]) => { code: number; stdout?: string; killed?: boolean; hang?: boolean }

function fake(opts: { files?: Record<string, string>; links?: Record<string, string>; env?: Record<string, string>; script?: Script; pid?: number; now?: () => number } = {}) {
  const files = opts.files ?? {}
  const calls: Array<{ file: string; args: string[]; env: Record<string, unknown>; detached: unknown }> = []
  const kills: Array<[number, string]> = []
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const fakeFs = {
    constants: fs.constants,
    existsSync: (p: string) => String(p) in files,
    readFileSync: (p: string) => { if (!(String(p) in files)) throw enoent(String(p)); return files[String(p)] },
    realpathSync: (p: string) => opts.links?.[String(p)] ?? String(p),
    statSync: (p: string) => { if (!(String(p) in files)) throw enoent(String(p)); return { isFile: () => true } },
    accessSync: (p: string) => { if (!(String(p) in files)) throw enoent(String(p)) },
  }
  const execFile: ClaudeCheckDeps['execFile'] = (file, args, o, cb) => {
    calls.push({ file, args, env: o.env as Record<string, unknown>, detached: o.detached })
    const r = (opts.script ?? (() => ({ code: 1, stdout: SIGNED_OUT })))(file, args)
    const err = r.code === 0 ? null : Object.assign(new Error(`exit ${r.code}`), { code: r.killed ? null : r.code, killed: !!r.killed, signal: r.killed ? 'SIGKILL' : null })
    if (!r.hang) queueMicrotask(() => cb(err, r.stdout ?? '', ''))
    return { pid: opts.pid, stdin: { end: () => {} } }
  }
  const deps: ClaudeCheckDeps = {
    fs: fakeFs as unknown as ClaudeCheckDeps['fs'], execFile, env: { HOME, PATH: '/usr/bin', ...opts.env },
    kill: (pid, signal) => { kills.push([pid, signal]) },
    ...(opts.now ? { now: opts.now } : {}),
  }
  return { deps, calls, kills }
}

const input = (over: Partial<ClaudeCheckInput> = {}): ClaudeCheckInput => ({
  path: NATIVE, version: '2.1.280', kind: 'native', deadline: Date.now() + 10_000, ...over,
})

describe('version floor', () => {
  const ck = createClaudeCheck({ env: {} })

  it('compares major.minor.patch numerically and ignores a pre-release tag', () => {
    expect(ck.versionAtLeast('2.1.280', '2.1.280')).toBe(true)
    expect(ck.versionAtLeast('2.1.281', '2.1.280')).toBe(true)
    expect(ck.versionAtLeast('2.1.258', '2.1.280')).toBe(false)
    expect(ck.versionAtLeast('2.1.99', '2.1.280')).toBe(false)
    expect(ck.versionAtLeast('2.10.0', '2.9.999')).toBe(true)
    expect(ck.versionAtLeast('3.0.0-beta.1', '2.1.280')).toBe(true)
    expect(ck.versionAtLeast(undefined, '2.1.280')).toBeNull()
    expect(ck.versionAtLeast('garbage', '2.1.280')).toBeNull()
  })

  it('versionOk: true with no floor, false below it, and absent when the version is unknown', async () => {
    const { deps } = fake({ script: () => ({ code: 0, stdout: BEDROCK }) })
    const rt = createClaudeCheck(deps)
    expect(await rt.check(input())).toMatchObject({ versionOk: true })
    expect((await rt.check(input())).minVersion).toBeUndefined()
    expect(await rt.check(input({ version: '2.1.258', minVersion: '2.1.280' }))).toMatchObject({ versionOk: false, minVersion: '2.1.280' })
    expect(await rt.check(input({ version: '2.1.280', minVersion: '2.1.280' }))).toMatchObject({ versionOk: true, minVersion: '2.1.280' })
    const unknown = await rt.check(input({ version: undefined, minVersion: '2.1.280' }))
    expect(unknown.minVersion).toBe('2.1.280')
    expect('versionOk' in unknown).toBe(false)
  })
})

describe('sign-in: `claude auth status --json` (2.1.41 and newer)', () => {
  it('signed in through Bedrock reads ok, and the call is the read-only subcommand in its own process group', async () => {
    const { deps, calls } = fake({ script: () => ({ code: 0, stdout: BEDROCK }) })
    expect(await createClaudeCheck(deps).check(input())).toMatchObject({ auth: 'ok', authDetail: 'Bedrock' })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(NATIVE)
    expect(calls[0].args).toEqual(['auth', 'status', '--json'])
    expect(calls[0].detached).toBe(true)
  })

  it('never carries the account email or org name out of the CLI answer', async () => {
    const { deps } = fake({ script: () => ({ code: 0, stdout: ACCOUNT }) })
    const out = await createClaudeCheck(deps).check(input())
    expect(out).toMatchObject({ auth: 'ok', authDetail: 'a Claude account' })
    expect(JSON.stringify(out)).not.toMatch(/example\.test|Example/)
  })

  it('maps every authMethod the CLI prints to a plain phrase', () => {
    const ck = createClaudeCheck({ env: {} })
    const detail = (authMethod: string, apiProvider = 'firstParty') => ck.parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider }))?.detail
    expect(detail('third_party', 'vertex')).toBe('Vertex AI')
    expect(detail('third_party', 'foundry')).toBe('Microsoft Foundry')
    expect(detail('api_key_helper')).toBe('an API key helper')
    expect(detail('oauth_token')).toBe('an OAuth token')
    expect(detail('api_key')).toBe('an Anthropic API key')
    expect(ck.parseAuthStatus('Not logged in. Run claude auth login to authenticate.\n')).toBeNull()
    expect(ck.parseAuthStatus('warning: something\n' + SIGNED_OUT)).toEqual({ state: 'not-logged-in', detail: 'claude auth status: not logged in' })
  })

  it('signed out directly AND through the rc-sourced shell is not-logged-in', async () => {
    const { deps, calls } = fake({ files: { '/bin/zsh': '' }, env: { SHELL: '/bin/zsh' } })
    expect(await createClaudeCheck(deps).check(input())).toMatchObject({ auth: 'not-logged-in' })
    expect(calls.map((c) => c.file)).toEqual([NATIVE, '/bin/zsh'])
    // The shell pass sources the rc file the spawn preamble sources, and the path rides as $0.
    expect(calls[1].args[0]).toBe('-c')
    expect(calls[1].args[1]).toContain('. "$HOME/.zshrc"')
    expect(calls[1].args[1]).toContain('exec "$0" auth status --json')
    expect(calls[1].args[2]).toBe(NATIVE)
  })

  it('a provider switch exported only in ~/.bashrc reaches sessions, so it reads ok', async () => {
    const { deps } = fake({
      files: { '/bin/bash': '' }, env: { SHELL: '/bin/bash' },
      script: (file) => (file === '/bin/bash' ? { code: 0, stdout: BEDROCK } : { code: 1, stdout: SIGNED_OUT }),
    })
    expect(await createClaudeCheck(deps).check(input())).toMatchObject({ auth: 'ok', authDetail: 'Bedrock' })
  })

  it('the npm build asks with its node dir first on PATH, directly and through the shell', async () => {
    const { deps, calls } = fake({ files: { '/bin/zsh': '' }, env: { SHELL: '/bin/zsh' } })
    await createClaudeCheck(deps).check(input({ kind: 'npm', nodeDir: '/opt/node/bin' }))
    expect(String(calls[0].env.PATH).split(':')[0]).toBe('/opt/node/bin')
    expect(calls[1].args[1]).toContain('PATH="$1:$PATH"')
    expect(calls[1].args.slice(2)).toEqual([NATIVE, '/opt/node/bin'])
  })

  // Review round 1, item 6: a shell pass with no answer is not a second "no".
  it('signed out directly but the shell pass gave no answer (timed out, no time left, not JSON) is unknown, never not-logged-in', async () => {
    const zsh = { files: { '/bin/zsh': '' }, env: { SHELL: '/bin/zsh' } }
    const timedOut = fake({ ...zsh, script: (file) => (file === '/bin/zsh' ? { code: -1, killed: true } : { code: 1, stdout: SIGNED_OUT }) })
    const a = await createClaudeCheck(timedOut.deps).check(input())
    expect(a.auth).toBe('unknown')
    expect(a.authDetail).toBe('claude auth status read signed out, and the check through zsh with ~/.zshrc gave no answer')
    expect(timedOut.calls.map((c) => c.file)).toEqual([NATIVE, '/bin/zsh'])

    const junk = fake({ ...zsh, script: (file) => (file === '/bin/zsh' ? { code: 127, stdout: 'zsh: command not found: nvm\n' } : { code: 1, stdout: SIGNED_OUT }) })
    expect((await createClaudeCheck(junk.deps).check(input())).auth).toBe('unknown')

    // The direct call used up the budget: the shell pass is never started, and that is no "no" either.
    let t = 0
    const late = fake({ ...zsh, now: () => t, script: () => { t = 9_900; return { code: 1, stdout: SIGNED_OUT } } })
    expect((await createClaudeCheck(late.deps).check(input({ deadline: 10_000 }))).auth).toBe('unknown')
    expect(late.calls.map((c) => c.file)).toEqual([NATIVE])
  })

  it('a $SHELL whose sessions source no rc file keeps the direct "not logged in"', async () => {
    const { deps, calls } = fake({ files: { '/usr/bin/fish': '' }, env: { SHELL: '/usr/bin/fish' } })
    expect(await createClaudeCheck(deps).check(input())).toMatchObject({ auth: 'not-logged-in' })
    expect(calls).toHaveLength(1)
  })

  // Review round 1, item 11: the cap must hold against a child that never lets go of stdout.
  it('a child that never answers is killed as a whole process group at the cap, and the check answers anyway', async () => {
    const { deps, calls, kills } = fake({ pid: 4242, script: () => ({ code: 0, hang: true }) })
    const started = Date.now()
    const out = await createClaudeCheck(deps).check(input({ deadline: Date.now() + 400 }))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(out).toMatchObject({ auth: 'unknown', authDetail: 'claude auth status gave no answer' })
    expect(calls[0].detached).toBe(true)
    expect(kills).toEqual([[-4242, 'SIGKILL']])
  })

  it('never signals pid 1 or below, even when a child reports one', async () => {
    const { deps, kills } = fake({ pid: 1, script: () => ({ code: 0, hang: true }) })
    expect((await createClaudeCheck(deps).check(input({ deadline: Date.now() + 350 }))).auth).toBe('unknown')
    expect(kills).toEqual([])
  })

  it('a hung auth status falls back to the presence rule instead of guessing', async () => {
    const { deps } = fake({ script: () => ({ code: -1, killed: true }) })
    expect(await createClaudeCheck(deps).check(input())).toMatchObject({ auth: 'unknown', authDetail: 'claude auth status gave no answer' })
  })

  it('no time left: nothing is spawned', async () => {
    const { deps, calls } = fake()
    await createClaudeCheck(deps).check(input({ deadline: Date.now() + 100 }))
    expect(calls).toEqual([])
  })
})

describe('sign-in: presence rule (older CLI or no answer)', () => {
  const old = (over: Partial<ClaudeCheckInput> = {}) => input({ version: '2.1.30', ...over })

  it('never runs `auth status` on a CLI older than 2.1.41 (it would read the words as a prompt)', async () => {
    const { deps, calls } = fake()
    const out = await createClaudeCheck(deps).check(old())
    expect(calls).toEqual([])
    expect(out).toMatchObject({ auth: 'unknown' })
    expect(out.authDetail).toContain('2.1.41')
  })

  it('reads ok from a provider switch or key in the env, and from settings.json `env` over it', async () => {
    for (const env of [{ CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: 'true' }, { ANTHROPIC_API_KEY: 'k' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }]) {
      expect((await createClaudeCheck(fake({ env }).deps).check(old())).auth, JSON.stringify(env)).toBe('ok')
    }
    const settings = { [`${HOME}/.claude/settings.json`]: JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: 'yes' } }) }
    expect(await createClaudeCheck(fake({ files: settings }).deps).check(old())).toMatchObject({ auth: 'ok', authDetail: 'Bedrock' })
    // The CLI's isEnvTruthy: "0" and "false" are off.
    expect((await createClaudeCheck(fake({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } }).deps).check(old())).auth).toBe('unknown')
  })

  it('reads ok from an apiKeyHelper or the credentials file under CLAUDE_CONFIG_DIR, never reading a value out', async () => {
    const helper = { [`${HOME}/.claude/settings.json`]: JSON.stringify({ apiKeyHelper: '/usr/local/bin/key-helper' }) }
    expect(await createClaudeCheck(fake({ files: helper }).deps).check(old())).toMatchObject({ auth: 'ok', authDetail: 'an API key helper' })
    const creds = { '/cfg/.credentials.json': '{"claudeAiOauth":{"accessToken":"secret-value"}}' }
    const out = await createClaudeCheck(fake({ files: creds, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).deps).check(old())
    expect(out).toMatchObject({ auth: 'ok', authDetail: 'a Claude account' })
    expect(JSON.stringify(out)).not.toContain('secret-value')
  })

  it('an unknown version skips the CLI and says why', async () => {
    const { deps, calls } = fake()
    expect(await createClaudeCheck(deps).check(input({ version: undefined }))).toMatchObject({ auth: 'unknown', authDetail: expect.stringContaining('version is unknown') })
    expect(calls).toEqual([])
  })
})

describe('install method', () => {
  it('native installer, npm, Homebrew, and anything else (a wrapper launcher)', () => {
    const { deps } = fake({
      links: {
        [NATIVE]: `${HOME}/.local/share/claude/versions/2.1.280`,
        '/usr/local/bin/claude': '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '/opt/homebrew/bin/claude': '/opt/homebrew/Caskroom/claude-code/2.1.280/claude',
      },
    })
    const ck = createClaudeCheck(deps)
    expect(ck.installMethod(NATIVE, 'native')).toBe('native')
    expect(ck.installMethod('/usr/local/bin/claude', 'unknown')).toBe('npm')
    expect(ck.installMethod('/anything', 'npm')).toBe('npm')
    expect(ck.installMethod('/opt/homebrew/bin/claude', 'native')).toBe('homebrew')
    expect(ck.installMethod(`${HOME}/.wrappers/bin/claude`, 'native')).toBe('other')
  })
})

describe('injection into the source daemon twin', () => {
  it('toString() carries no module-scope or bundler identifiers, and a re-materialized copy answers the same', async () => {
    const src = createClaudeCheck.toString()
    for (const re of [/\b__name\b/, /\b__spreadValues\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bexports\./]) expect(src).not.toMatch(re)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const copy = new Function('"use strict"; return ' + src)() as typeof createClaudeCheck
    const run = async (factory: typeof createClaudeCheck) => {
      const { deps } = fake({ files: { '/bin/zsh': '' }, env: { SHELL: '/bin/zsh' } })
      return factory(deps).check(input({ version: '2.1.258', minVersion: '2.1.280' }))
    }
    expect(await run(copy)).toEqual(await run(createClaudeCheck))
  })

  it('the template carries no residue, and the deploy-time smoke refuses a corrupted version gate', () => {
    expect(getDaemonSource()).not.toContain('__CREATE_CLAUDE_CHECK__')
    const fold: Array<[string, string]> = [
      ['__FOLD_LINE__', foldLine.toString()],
      ['__INITIAL_FOLD_STATE__', initialFoldState.toString()],
      ['__ASSEMBLE_SNAPSHOT__', assembleSnapshot.toString()],
    ]
    const good = createClaudeCheck.toString()
    expect(() => validateFoldInjection(fold.concat([['__CREATE_CLAUDE_CHECK__', good]]))).not.toThrow()
    const GATE = /return a\[i\] > b\[i\]/
    expect(good).toMatch(GATE)
    const broken = good.replace(GATE, 'return a[i] < b[i]')
    expect(() => validateFoldInjection(fold.concat([['__CREATE_CLAUDE_CHECK__', broken]]))).toThrow(/compared versions wrongly/)
  })
})
