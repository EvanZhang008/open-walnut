/**
 * Import from Claude Code for pi: the walnut-claude-code extension's collectors (what pi
 * gets from Claude Code's files) and the import that installs it (preview, apply, refusals).
 * Every fixture is an in-memory file tree; nothing here reads the machine's real files.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  claudeCodeContextFiles,
  claudeCodeEnv,
  claudeCodeMcpServers,
  claudeCodeResourceDirs,
  enabledPlugins,
  importedPaths,
  loadClaudeCodeFiles,
  toPiMcpServer,
  type ClaudeCodeReader,
} from '../../src/data/pi/walnut-claude-code.js'
import {
  applyClaudeCodeImport,
  extensionVersionOf,
  piInstallFrom,
  piStartFromClaudeCode,
  previewClaudeCodeImport,
  readExtensionSource,
  type ImportTransport,
} from '../../src/core/agents/claude-code-import.js'

const HOME = '/home/u'

/** A file tree: string = file, null = folder; `links` maps a path to its real path. */
function memReader(tree: Record<string, string | null>, links: Record<string, string> = {}): ClaudeCodeReader {
  const isDirPath = (p: string): boolean => tree[p] === null || Object.keys(tree).some((k) => k.startsWith(p + '/'))
  return {
    readText: (p) => (typeof tree[p] === 'string' ? tree[p] as string : undefined),
    isDir: (p) => isDirPath(p) && typeof tree[p] !== 'string',
    isFile: (p) => typeof tree[p] === 'string',
    listDir: (p) => [...new Set(Object.keys(tree).filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0]))],
    realpath: (p) => links[p] ?? p,
  }
}

const json = (v: unknown): string => JSON.stringify(v)

function files(reader: ClaudeCodeReader, env: Record<string, string | undefined> = {}) {
  return loadClaudeCodeFiles(reader, HOME, env)
}

describe('credentials from Claude Code settings', () => {
  const bedrockSettings = {
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'key-id-1', AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_BEARER_TOKEN_BEDROCK: '', ANTHROPIC_BEDROCK_BASE_URL: 'http://127.0.0.1:8402', DISABLE_TELEMETRY: '1',
    },
  }

  it('maps a Bedrock proxy setup onto the AWS SDK names, plain http needing HTTP/1.1', () => {
    const r = memReader({ [`${HOME}/.claude/settings.json`]: json(bedrockSettings) })
    const plan = claudeCodeEnv(files(r), {})
    expect(plan.bedrock).toBe(true)
    expect(plan.set).toEqual({
      AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'key-id-1', AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'http://127.0.0.1:8402', AWS_BEDROCK_FORCE_HTTP1: '1',
    })
    expect(plan.unset).toEqual([])
  })

  it('never replaces a value the process already has, and removes an inherited empty bearer token', () => {
    const r = memReader({ [`${HOME}/.claude/settings.json`]: json(bedrockSettings) })
    const plan = claudeCodeEnv(files(r), { AWS_REGION: 'eu-central-1', AWS_BEARER_TOKEN_BEDROCK: '' })
    expect(plan.set.AWS_REGION).toBeUndefined()
    expect(plan.unset).toEqual(['AWS_BEARER_TOKEN_BEDROCK'])
  })

  it('an https endpoint keeps HTTP/2, and skip-auth maps across', () => {
    const r = memReader({ [`${HOME}/.claude/settings.json`]: json({ env: { CLAUDE_CODE_USE_BEDROCK: 'true', ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.example.com/bedrock', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' } }) })
    const plan = claudeCodeEnv(files(r), {})
    expect(plan.set.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBe('https://gw.example.com/bedrock')
    expect(plan.set.AWS_BEDROCK_FORCE_HTTP1).toBeUndefined()
    expect(plan.set.AWS_BEDROCK_SKIP_AUTH).toBe('1')
  })

  it('without Bedrock, AWS variables stay behind and an Anthropic key comes over', () => {
    const r = memReader({ [`${HOME}/.claude/settings.json`]: json({ env: { ANTHROPIC_API_KEY: 'sk-test', AWS_PROFILE: 'other' } }) })
    const plan = claudeCodeEnv(files(r), {})
    expect(plan.bedrock).toBe(false)
    expect(plan.set).toEqual({ ANTHROPIC_API_KEY: 'sk-test' })
  })

  it('CLAUDE_CONFIG_DIR moves both files', () => {
    const r = memReader({ '/cfg/settings.json': json({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'p' } }), '/cfg/.claude.json': json({ mcpServers: { docs: { url: 'https://d.example.com/mcp' } } }) })
    const f = files(r, { CLAUDE_CONFIG_DIR: '/cfg' })
    expect(claudeCodeEnv(f, {}).set.AWS_PROFILE).toBe('p')
    expect(claudeCodeMcpServers(r, f).servers.map((s) => s.name)).toEqual(['docs'])
  })
})

describe('plugins and MCP servers', () => {
  const pluginRoot = `${HOME}/.claude/plugins/cache/market/acme/2.0.0`
  const oldRoot = `${HOME}/.claude/plugins/cache/market/acme/1.0.0`
  const tree = () => memReader({
    [`${HOME}/.claude/settings.json`]: json({
      enabledPlugins: { 'acme@market': true, 'off@market': false, 'proj@market': true },
      deniedMcpServers: [{ serverName: 'blocked' }],
    }),
    [`${HOME}/.claude.json`]: json({
      mcpServers: {
        docs: { url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
        tools: { command: 'tools-mcp', args: ['--fast'] },
        stream: { type: 'sse', url: 'https://old.example.com/sse' },
        helper: { type: 'http', url: 'https://h.example.com/mcp', headersHelper: 'print-headers' },
        blocked: { command: 'nope' },
        'bad.name': { command: 'x' },
      },
      projects: { '/work/app': { mcpServers: { tools: { command: 'tools-mcp', args: ['--local'] } }, enabledMcpjsonServers: ['shared'] } },
    }),
    [`${HOME}/.claude/plugins/installed_plugins.json`]: json({
      version: 2,
      plugins: {
        'acme@market': [
          { scope: 'project', projectPath: '/work', installPath: oldRoot },
          { scope: 'user', installPath: pluginRoot },
        ],
        'off@market': [{ scope: 'user', installPath: `${HOME}/off` }],
        'proj@market': [{ scope: 'project', projectPath: '/work/app', installPath: `${HOME}/proj` }],
      },
    }),
    [`${pluginRoot}/.mcp.json`]: json({ mcpServers: { search: { command: '${CLAUDE_PLUGIN_ROOT}/bin/search', args: ['--root', '${CLAUDE_PLUGIN_ROOT}'] }, tools: { command: 'tools-mcp', args: ['--fast'] } } }),
    [`${pluginRoot}/.claude-plugin/plugin.json`]: json({ name: 'acme', mcpServers: { docs: { url: 'https://acme.example.com/mcp' } } }),
    [`${HOME}/proj/.mcp.json`]: json({ mcpServers: { projtool: { command: 'p' } } }),
    '/work/app/.git': null,
    '/work/app/.mcp.json': json({ mcpServers: { shared: { command: 'shared-mcp' }, unapproved: { command: 'u' } } }),
  })

  it('a plugin counts only when enabled and installed for the user or a project containing the folder; the user copy wins', () => {
    const r = tree()
    expect(enabledPlugins(r, files(r)).map((p) => [p.name, p.installPath])).toEqual([['acme', pluginRoot]])
    expect(enabledPlugins(r, files(r), '/work/app/src').map((p) => p.name)).toEqual(['acme', 'proj'])
  })

  it('converts entries, keeps Claude Code precedence, and says why the rest stay behind', () => {
    const r = tree()
    const { servers, skipped } = claudeCodeMcpServers(r, files(r), '/work/app')
    expect(servers.map((s) => `${s.name}<${s.source}>`)).toEqual([
      'tools<local>', 'shared<project>', 'docs<user>', 'search<plugin:acme>', 'tools_acme<plugin:acme>', 'docs_acme<plugin:acme>', 'projtool<plugin:proj>',
    ])
    const search = servers.find((s) => s.name === 'search')!.config
    expect(search).toEqual({ exposure: 'deferred', command: `${pluginRoot}/bin/search`, args: ['--root', pluginRoot] })
    expect(servers.find((s) => s.name === 'docs')!.config.headers).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}' })
    const why = Object.fromEntries(skipped.map((s) => [s.name, s.why]))
    expect(why.stream).toMatch(/SSE/)
    expect(why.helper).toMatch(/headersHelper/)
    expect(why.blocked).toMatch(/turned off/)
    expect(why['bad.name']).toMatch(/name pi does not accept/)
    expect(why.unapproved).toMatch(/not approved/)
  })

  it('outside a project there are no local or project servers, and an identical plugin server starts once', () => {
    const r = tree()
    const { servers } = claudeCodeMcpServers(r, files(r))
    expect(servers.map((s) => s.name)).toEqual(['docs', 'tools', 'search', 'docs_acme'])
  })

  it('toPiMcpServer refuses an entry with nothing to start', () => {
    expect(toPiMcpServer({ args: ['x'] })).toEqual({ skip: 'has neither a command nor a url' })
    expect(toPiMcpServer({ type: 'ws', url: 'x' })).toMatchObject({ skip: expect.stringMatching(/"ws" transport/) })
  })
})

describe('skills and commands', () => {
  it('adds Claude Code folders pi does not read, never the one pi already reads through ~/.agents/skills', () => {
    const tree = {
      [`${HOME}/.claude/skills/one/SKILL.md`]: 'x',
      [`${HOME}/.claude/commands/go.md`]: 'x',
      [`${HOME}/.claude/settings.json`]: json({ enabledPlugins: { 'acme@m': true } }),
      [`${HOME}/.claude/plugins/installed_plugins.json`]: json({ plugins: { 'acme@m': [{ scope: 'user', installPath: '/p/acme' }] } }),
      '/p/acme/skills/two/SKILL.md': 'x',
      '/repo/.git': null,
      '/repo/.claude/skills/three/SKILL.md': 'x',
      '/repo/.claude/commands/c.md': 'x',
    }
    const linked = memReader(tree, { [`${HOME}/.agents/skills`]: `${HOME}/.claude/skills` })
    const dirs = claudeCodeResourceDirs(linked, files(linked), '/repo/pkg')
    expect(dirs.skills.map((d) => d.path)).toEqual(['/repo/.claude/skills', '/p/acme/skills'])
    expect(dirs.prompts.map((d) => d.path)).toEqual([`${HOME}/.claude/commands`, '/repo/.claude/commands'])
    const separate = memReader(tree)
    expect(claudeCodeResourceDirs(separate, files(separate)).skills.map((d) => d.path)).toEqual([`${HOME}/.claude/skills`, '/p/acme/skills'])
  })
})

describe('instructions', () => {
  it('reads @path imports the way Claude Code does, ignoring code and missing files', () => {
    const r = memReader({ '/a/rules/x.md': 'x', [`${HOME}/r.md`]: 'r', '/a/deep/y.md': 'y' })
    const text = 'See @rules/x.md and @~/r.md.\n`@rules/x.md` inline\n```\n@deep/y.md\n```\nmail me at a@b.com, @types/node, @missing/file.md'
    expect(importedPaths(text, '/a/CLAUDE.md', HOME, r)).toEqual(['/a/rules/x.md', `${HOME}/r.md`])
  })

  it('adds the user file, CLAUDE.local.md, .claude/CLAUDE.md and imports, never a file pi loaded or a copy of one', () => {
    const r = memReader({
      [`${HOME}/.claude/CLAUDE.md`]: 'user rules @~/.claude/rules/style.md',
      [`${HOME}/.claude/rules/style.md`]: 'style',
      '/repo/AGENTS.md': 'agents copy',
      '/repo/CLAUDE.md': 'agents copy',
      '/repo/CLAUDE.local.md': 'local rules',
      '/repo/sub/.claude/CLAUDE.md': 'nested @../extra.md',
      '/repo/sub/extra.md': 'extra',
      '/repo/sub/CLAUDE.md': 'loaded by pi @notes.md',
      '/repo/sub/notes.md': 'notes',
    })
    const loaded = [{ path: '/repo/AGENTS.md', content: 'agents copy' }, { path: '/repo/sub/CLAUDE.md', content: 'loaded by pi @notes.md' }]
    const added = claudeCodeContextFiles(r, files(r), '/repo/sub', loaded).map((f) => f.path)
    expect(added).toEqual([
      `${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/rules/style.md`, '/repo/CLAUDE.local.md',
      '/repo/sub/.claude/CLAUDE.md', '/repo/sub/extra.md', '/repo/sub/notes.md',
    ])
  })

  it('reads ~/.claude/rules and a project\'s .claude/rules, leaving out rules limited to certain paths', () => {
    const r = memReader({
      [`${HOME}/.claude/rules/b.md`]: 'b',
      [`${HOME}/.claude/rules/a.md`]: 'a',
      [`${HOME}/.claude/rules/web/ui.md`]: '---\npaths:\n  - web/**\n---\nui only',
      [`${HOME}/.claude/rules/web/always.md`]: '---\ndescription: x\n---\nalways',
      '/repo/.claude/rules/test.md': 'tests',
    })
    expect(claudeCodeContextFiles(r, files(r), '/repo', []).map((f) => f.path)).toEqual([
      `${HOME}/.claude/rules/a.md`, `${HOME}/.claude/rules/b.md`, `${HOME}/.claude/rules/web/always.md`, '/repo/.claude/rules/test.md',
    ])
  })

  it('stops at Claude Code\'s import depth and never loops on a cycle', () => {
    const tree: Record<string, string> = { [`${HOME}/.claude/CLAUDE.md`]: '@/d/1.md' }
    for (let i = 1; i <= 8; i++) tree[`/d/${i}.md`] = `level ${i} @/d/${i + 1}.md @/d/1.md`
    const r = memReader(tree)
    expect(claudeCodeContextFiles(r, files(r), '/', []).map((f) => f.path)).toEqual([`${HOME}/.claude/CLAUDE.md`, '/d/1.md', '/d/2.md', '/d/3.md', '/d/4.md', '/d/5.md'])
  })
})

describe('the start choice', () => {
  const start = (settings: unknown) => piStartFromClaudeCode(files(memReader({ [`${HOME}/.claude/settings.json`]: json(settings) })), {})

  it('takes Claude Code\'s model, effort and provider', () => {
    expect(start({ model: 'global.anthropic.claude-opus-5-5[1m]', effortLevel: 'xhigh', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
      .toEqual({ provider: 'amazon-bedrock', model: 'global.anthropic.claude-opus-5-5', thinking: 'xhigh', notes: [] })
  })

  it('resolves an alias through the model variables, and says when it cannot', () => {
    expect(start({ model: 'opus[1m]', env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-5-5[1m]' } }).model).toBe('us.anthropic.claude-opus-5-5')
    const unresolved = start({ model: 'sonnet' })
    expect(unresolved.model).toBeUndefined()
    expect(unresolved.provider).toBe('anthropic')
    expect(unresolved.notes[0]).toMatch(/"sonnet" alias/)
  })

  it('thinking off when Claude Code turned it off', () => {
    expect(start({ alwaysThinkingEnabled: false, effortLevel: 'high' }).thinking).toBe('off')
  })

  it('reads the pi version and whether MCP needs an update', () => {
    expect(piInstallFrom({ installed: true, version: '0.85.1' })).toEqual({ installed: true, version: '0.85.1', needsUpdateForMcp: true })
    expect(piInstallFrom({ installed: true, version: 'pi 1.4.0' }).needsUpdateForMcp).toBe(false)
    expect(piInstallFrom(null)).toEqual({ installed: false, version: null, needsUpdateForMcp: false })
  })
})

/** A host's files behind the import transport, with the daemon's guarded write. */
/** A host's files in memory: a string is a file's text, a Uint8Array its raw bytes, null a folder. */
function memTransport(tree: Record<string, string | Uint8Array | null>, opts: { failRead?: RegExp; tooLarge?: RegExp } = {}): ImportTransport & { tree: Record<string, string | Uint8Array | null>; writes: string[] } {
  const bytesOf = (v: string | Uint8Array) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : v)
  const sha = (v: string | Uint8Array) => createHash('sha256').update(bytesOf(v)).digest('hex')
  const writes: string[] = []
  return {
    tree, writes,
    readBytes: async (p) => {
      if (opts.failRead?.test(p)) throw new Error('fs.read transport failure: socket closed')
      if (opts.tooLarge?.test(p)) throw new Error('file is 99999999 bytes, larger than the limit for this read (EFBIG)')
      if (tree[p] === null) throw new Error('EISDIR')
      const v = tree[p]
      return v === undefined ? null : bytesOf(v)
    },
    listDir: async (p) => {
      const names = Object.keys(tree).filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0])
      if (names.length === 0 && tree[p] !== null) throw new Error('ENOENT')
      return [...new Set(names)]
    },
    writeAtomic: async (p, text, expected) => {
      const v = tree[p]
      const current = v === undefined || v === null ? 'absent' : sha(v)
      if (current !== expected) throw new Error('fs.write refused: file changed since it was read (EMODIFIED)')
      tree[p] = text
      writes.push(p)
    },
  }
}

describe('preview and apply', () => {
  const pi = { installed: true, version: '1.4.0', needsUpdateForMcp: false }
  const host = () => memTransport({
    '~/.claude/settings.json': json({
      model: 'global.anthropic.claude-opus-5-5[1m]', effortLevel: 'high', hooks: { Stop: [] },
      permissions: { defaultMode: 'bypassPermissions' },
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_SECRET_ACCESS_KEY: 's3cret', ANTHROPIC_BEDROCK_BASE_URL: 'http://127.0.0.1:9000' },
    }),
    '~/.claude.json': json({ mcpServers: { docs: { url: 'https://docs.example.com/mcp' }, legacy: { type: 'sse', url: 'https://x.example.com/sse' } } }),
    '~/.claude/skills/one/SKILL.md': 'x',
    '~/.claude/CLAUDE.md': 'rules',
    '~/.pi/agent/settings.json': json({ theme: 'dark', defaultProvider: 'other' }) + '\n',
  })

  it('shows what comes over and what cannot, with no secret value in it', async () => {
    const preview = await previewClaudeCodeImport('h', host(), pi)
    expect(preview.extension.state).toBe('absent')
    expect(preview.settings.changes).toEqual([
      { key: 'defaultProvider', from: 'other', to: 'amazon-bedrock' },
      { key: 'defaultModel', from: undefined, to: 'global.anthropic.claude-opus-5-5' },
      { key: 'defaultThinkingLevel', from: undefined, to: 'high' },
      { key: 'quietStartup', from: undefined, to: true },
    ])
    expect(preview.credentials.kind).toBe('bedrock')
    expect(preview.credentials.vars).toContainEqual({ name: 'AWS_SECRET_ACCESS_KEY' })
    expect(preview.credentials.vars).toContainEqual({ name: 'AWS_REGION', value: 'us-west-2' })
    expect(JSON.stringify(preview)).not.toContain('s3cret')
    expect(preview.mcpServers.map((s) => s.name)).toEqual(['docs'])
    expect(preview.skippedMcpServers.map((s) => s.name)).toEqual(['legacy'])
    expect(preview.skills).toEqual([{ name: '~/.claude/skills', detail: '1 skill', source: 'user' }])
    expect(preview.instructions[0].name).toBe('~/.claude/CLAUDE.md')
    expect(preview.cannotCarry.map((c) => c.what)).toEqual(['Hooks', 'Permission mode and rules'])
    expect(preview.upToDate).toBe(false)
  })

  it('writes the extension and only the named settings keys, then reads as up to date', async () => {
    const t = host()
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).toEqual(['~/.pi/agent/extensions/walnut-claude-code.ts', '~/.pi/agent/settings.json'])
    expect(t.tree['~/.pi/agent/extensions/walnut-claude-code.ts']).toBe(readExtensionSource())
    const settings = JSON.parse(t.tree['~/.pi/agent/settings.json'] as string)
    expect(settings).toEqual({ theme: 'dark', defaultProvider: 'amazon-bedrock', defaultModel: 'global.anthropic.claude-opus-5-5', defaultThinkingLevel: 'high', quietStartup: true })
    expect((t.tree['~/.pi/agent/settings.json'] as string).endsWith('\n')).toBe(true)
    expect(result.preview.upToDate).toBe(true)
    const again = await applyClaudeCodeImport('h', t, pi)
    expect(again.written).toEqual([])
  })

  it('replaces an older Walnut extension, refuses a file Walnut did not write and an unreadable settings file', async () => {
    const older = host()
    older.tree['~/.pi/agent/extensions/walnut-claude-code.ts'] = 'export const WALNUT_CLAUDE_CODE_EXTENSION_VERSION = 0'
    expect((await previewClaudeCodeImport('h', older, pi)).extension.state).toBe('outdated')
    expect((await applyClaudeCodeImport('h', older, pi)).written).toContain('~/.pi/agent/extensions/walnut-claude-code.ts')

    const foreign = host()
    foreign.tree['~/.pi/agent/extensions/walnut-claude-code.ts'] = 'export default () => {}'
    await expect(applyClaudeCodeImport('h', foreign, pi)).rejects.toMatchObject({ status: 409 })
    expect(foreign.writes).toEqual([])

    const broken = host()
    broken.tree['~/.pi/agent/settings.json'] = '{ not json'
    await expect(applyClaudeCodeImport('h', broken, pi)).rejects.toMatchObject({ status: 409 })
    expect(broken.writes).toEqual([])
  })

  it('a pi too old for MCP still imports the rest and says how to update', async () => {
    const preview = await previewClaudeCodeImport('h', host(), { installed: true, version: '0.85.1', needsUpdateForMcp: true })
    expect(preview.cannotCarry.find((c) => c.what.startsWith('MCP'))?.nearest).toMatch(/npm install -g @earendil-works\/pi-coding-agent@latest/)
  })

  it('a file too large to read is named, a transport failure fails the preview, never "absent"', async () => {
    const big = await previewClaudeCodeImport('h', memTransport({ ...host().tree }, { tooLarge: /\.claude\.json$/ }), pi)
    expect(big.claudeCode.found).toBe(true)
    expect(big.warnings.join(' ')).toContain('~/.claude.json is larger than')
    await expect(previewClaudeCodeImport('h', memTransport({ ...host().tree }, { failRead: /settings\.json$/ }), pi)).rejects.toThrow(/transport failure/)
  })

  it('keeps a provider and model pi already pairs when Claude Code names no model', async () => {
    const t = memTransport({
      '~/.claude/settings.json': json({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' } }),
      '~/.pi/agent/settings.json': json({ defaultProvider: 'openai', defaultModel: 'gpt-x' }),
    })
    const preview = await previewClaudeCodeImport('h', t, pi)
    expect(preview.settings.changes.map((c) => c.key)).not.toContain('defaultProvider')
    expect(preview.credentials.kind).toBe('bedrock')
  })

  it('writes over a settings file holding a byte that is not UTF-8 (the guard hashes bytes)', async () => {
    const raw = Buffer.concat([Buffer.from('{"theme":"dark","note":"'), Buffer.from([0xff]), Buffer.from('"}\n')])
    const t = memTransport({ ...host().tree, '~/.pi/agent/settings.json': raw })
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).toContain('~/.pi/agent/settings.json')
  })

  it('a host with no Claude Code says so', async () => {
    const preview = await previewClaudeCodeImport('h', memTransport({}), pi)
    expect(preview.claudeCode.found).toBe(false)
    expect(preview.credentials.kind).toBe('none')
  })
})

describe('the shipped extension', () => {
  const file = path.join(import.meta.dirname, '../../src/data/pi/walnut-claude-code.ts')
  const source = fs.readFileSync(file, 'utf8')

  it('imports node builtins only, so pi can load the file on any machine', () => {
    const specifiers = [...source.matchAll(/^import\s.+?from\s+'([^']+)'/gm)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) expect(s, s).toMatch(/^node:/)
    expect(source).not.toMatch(/\brequire\(/)
  })

  it('is what the import installs, and declares its version', () => {
    expect(readExtensionSource()).toBe(source)
    expect(extensionVersionOf(source)).toBeGreaterThanOrEqual(1)
  })
})
