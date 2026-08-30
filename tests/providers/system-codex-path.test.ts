import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAcpAdapterEnv,
  EngineExecutableError,
  parseCodexBaseConfig,
  resolveAcpArtifacts,
  resolveCodexInitialMode,
  resolveEngineExecutable,
  resolveSystemCodexPath,
  SystemCodexPathError,
} from '../../src/providers/acp-session.js'
import { buildAcpLaneConfig } from '../../src/providers/claude-code-session.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-system-codex-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function executable(relativePath: string): string {
  const filePath = path.join(tmpDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return filePath
}

function resolveWith(env: NodeJS.ProcessEnv): string {
  return resolveSystemCodexPath({ env, systemDirectories: [] })
}

function resolutionError(run: () => unknown): SystemCodexPathError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SystemCodexPathError)
    return error as SystemCodexPathError
  }
  throw new Error('expected SystemCodexPathError')
}

describe('parseCodexBaseConfig', () => {
  it('accepts objects and rejects malformed or non-object JSON clearly', () => {
    expect(parseCodexBaseConfig('{"model_verbosity":"low"}')).toEqual({ model_verbosity: 'low' })
    expect(() => parseCodexBaseConfig('{bad json')).toThrow(/CODEX_CONFIG must be valid JSON/)
    expect(() => parseCodexBaseConfig('[]')).toThrow(/CODEX_CONFIG must be a JSON object/)
  })
})

describe('buildAcpAdapterEnv', () => {
  it('merges lane instructions without losing the user Codex config', () => {
    expect(buildAcpAdapterEnv('/usr/local/bin/codex', {
      disableProjectInstructions: true,
      developerInstructions: 'Walnut contract',
      baseConfig: { model_verbosity: 'low', developer_instructions: 'User Codex rule' },
    })).toEqual({
      CODEX_PATH: '/usr/local/bin/codex',
      CODEX_CONFIG: JSON.stringify({
        model_verbosity: 'low',
        developer_instructions: 'User Codex rule\n\nWalnut contract',
        project_doc_max_bytes: 0,
      }),
    })
    expect(buildAcpAdapterEnv('/usr/local/bin/codex')).toEqual({
      CODEX_PATH: '/usr/local/bin/codex',
    })
    expect(buildAcpAdapterEnv(undefined)).toBeUndefined()
  })

  it('passes the managed-session id through so `wn` can resolve its own sid', () => {
    // WALNUT_SESSION_ID is the managed-session identity the in-session `wn` CLI
    // reads to reach the daemon gateway. (It also used to classify the caller as
    // human vs agent for the completion guard; that whole distinction is gone.)
    const env = buildAcpAdapterEnv('/usr/local/bin/codex', { sessionId: 'acp-deadbeef' })
    expect(env).toEqual({ CODEX_PATH: '/usr/local/bin/codex', WALNUT_SESSION_ID: 'acp-deadbeef' })
    expect(buildAcpAdapterEnv('/usr/local/bin/codex')).toEqual({ CODEX_PATH: '/usr/local/bin/codex' })
  })

  it('forwards the startup approval preset as INITIAL_AGENT_MODE', () => {
    expect(buildAcpAdapterEnv('/usr/local/bin/codex', { initialAgentMode: 'agent-full-access' }))
      .toEqual({ CODEX_PATH: '/usr/local/bin/codex', INITIAL_AGENT_MODE: 'agent-full-access' })
  })
})

describe('resolveCodexInitialMode', () => {
  const writeToml = (content: string): NodeJS.ProcessEnv => {
    const home = fs.mkdtempSync(path.join(tmpDir, 'home-'))
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex/config.toml'), content)
    return { HOME: home }
  }

  it('maps sandbox danger-full-access to the full-access preset', () => {
    const env = writeToml('approval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n')
    expect(resolveCodexInitialMode({ env })).toBe('agent-full-access')
  })

  it('maps workspace-write to agent and read-only to read-only', () => {
    expect(resolveCodexInitialMode({ env: writeToml('sandbox_mode = "workspace-write"\n') })).toBe('agent')
    expect(resolveCodexInitialMode({ env: writeToml('sandbox_mode = "read-only"\n') })).toBe('read-only')
  })

  it('maps approval_policy never (no sandbox key) to full access', () => {
    expect(resolveCodexInitialMode({ env: writeToml('approval_policy = "never"\n') })).toBe('agent-full-access')
  })

  it('ignores keys inside [projects] tables', () => {
    const env = writeToml('[projects."/tmp/x"]\ntrust_level = "trusted"\nsandbox_mode = "danger-full-access"\n')
    expect(resolveCodexInitialMode({ env })).toBeUndefined()
  })

  it('falls back to the walnut default, validated', () => {
    const env = { HOME: fs.mkdtempSync(path.join(tmpDir, 'nohome-')) }
    expect(resolveCodexInitialMode({ env, walnutDefault: 'agent-full-access' })).toBe('agent-full-access')
    expect(resolveCodexInitialMode({ env, walnutDefault: 'bogus' })).toBeUndefined()
    expect(resolveCodexInitialMode({ env })).toBeUndefined()
  })
})

describe('buildAcpLaneConfig', () => {
  it('keeps project docs off and mounts this Walnut install for Main Agent lanes', async () => {
    const config = await buildAcpLaneConfig('chat:general:conv-codex')
    expect(config.lane).toBe('chat:general:conv-codex')
    expect(config.disableProjectInstructions).toBe(true)
    expect(config.walnutMcpServer.name).toBe('walnut')
    expect(config.walnutMcpServer.args.at(-1)).toBe('mcp')
    expect(config.walnutMcpServer.env).toEqual([])
  })
})

describe('resolveSystemCodexPath', () => {
  it('uses a valid explicit override before every discovered candidate', () => {
    const override = executable('override/codex')
    const pathCandidate = executable('path-bin/codex')

    expect(resolveWith({
      WALNUT_CODEX_PATH: override,
      PATH: path.dirname(pathCandidate),
      HOME: path.join(tmpDir, 'home'),
    })).toBe(override)
  })

  it('fails closed for an invalid override instead of falling back to PATH', () => {
    const pathCandidate = executable('path-bin/codex')
    const missingOverride = path.join(tmpDir, 'missing', 'codex')

    const error = resolutionError(() => resolveWith({
      WALNUT_CODEX_PATH: missingOverride,
      PATH: path.dirname(pathCandidate),
      HOME: path.join(tmpDir, 'home'),
    }))

    expect(error.reason).toBe('override_missing')
    expect(error.message).toContain('WALNUT_CODEX_PATH')
    expect(error.message).toContain('does not exist')
  })

  it.skipIf(process.platform === 'win32')('rejects a non-executable override', () => {
    const override = executable('override/codex')
    fs.chmodSync(override, 0o644)

    const error = resolutionError(() => resolveWith({
      WALNUT_CODEX_PATH: override,
      PATH: '',
      HOME: path.join(tmpDir, 'home'),
    }))

    expect(error.reason).toBe('override_not_executable')
    expect(error.message).toContain('not executable')
  })

  it.skipIf(process.platform === 'win32')('skips a non-executable discovered candidate', () => {
    const blocked = executable('blocked-bin/codex')
    fs.chmodSync(blocked, 0o644)
    const safe = executable('safe-bin/codex')

    expect(resolveWith({
      PATH: [path.dirname(blocked), path.dirname(safe)].join(path.delimiter),
      HOME: path.join(tmpDir, 'home'),
    })).toBe(safe)
  })

  it('rejects an override located lexically inside node_modules', () => {
    const bundled = executable('node_modules/.bin/codex')

    const error = resolutionError(() => resolveWith({
      WALNUT_CODEX_PATH: bundled,
      PATH: '',
      HOME: path.join(tmpDir, 'home'),
    }))

    expect(error.reason).toBe('override_forbidden')
    expect(error.message).toContain('node_modules')
  })

  it('accepts a symlink whose canonical target is a FOREIGN node_modules install', () => {
    // Deliberate, verified loosening (2026-08-30): every homebrew / `npm i -g`
    // node CLI realpaths into some node_modules dir, so a blanket realpath ban
    // reported real installations as missing. Only walnut's OWN bundle is banned.
    const bundled = executable('node_modules/@openai/codex/bin/codex')
    const override = path.join(tmpDir, 'system-bin', 'codex')
    fs.mkdirSync(path.dirname(override), { recursive: true })
    fs.symlinkSync(bundled, override)

    expect(resolveWith({
      WALNUT_CODEX_PATH: override,
      PATH: '',
      HOME: path.join(tmpDir, 'home'),
    })).toBe(override)
  })

  it('rejects a symlink whose canonical target is inside WALNUT own node_modules', () => {
    // The real hazard: a binary shipped with this walnut install can carry a
    // different auth chain than the user's own installation.
    const walnutBundled = path.resolve(__dirname, '../../node_modules/.bin/vitest')
    expect(fs.existsSync(walnutBundled)).toBe(true)
    const override = path.join(tmpDir, 'system-bin', 'codex')
    fs.mkdirSync(path.dirname(override), { recursive: true })
    fs.symlinkSync(walnutBundled, override)

    const error = resolutionError(() => resolveWith({
      WALNUT_CODEX_PATH: override,
      PATH: '',
      HOME: path.join(tmpDir, 'home'),
    }))

    expect(error.reason).toBe('override_forbidden')
    expect(error.message).toContain('resolves inside node_modules')
  })

  it('uses deterministic PATH then home fallback ordering under a minimal PATH', () => {
    const pathCandidate = executable('minimal-bin/codex')
    const home = path.join(tmpDir, 'home')
    const toolboxCandidate = executable('home/.toolbox/bin/codex')
    executable('home/.local/bin/codex')

    expect(resolveWith({
      PATH: path.dirname(pathCandidate),
      HOME: home,
    })).toBe(pathCandidate)

    fs.rmSync(pathCandidate)
    expect(resolveWith({
      PATH: path.dirname(pathCandidate),
      HOME: home,
    })).toBe(toolboxCandidate)
  })

  it('skips a PATH ENTRY that is itself inside node_modules (npm-injected shim)', () => {
    // npm prepends node_modules/.bin to PATH for every script it runs — that
    // shim must never win over the user's system install.
    const injected = executable('node_modules/.bin/codex')
    const safe = executable('safe-bin/codex')

    expect(resolveWith({
      PATH: [path.dirname(injected), path.dirname(safe)].join(path.delimiter),
      HOME: path.join(tmpDir, 'home'),
    })).toBe(safe)
  })

  it('accepts a PATH candidate that realpaths into a foreign node_modules', () => {
    const bundled = executable('node_modules/@openai/codex/bin/codex')
    const pathLink = path.join(tmpDir, 'path-bin', 'codex')
    fs.mkdirSync(path.dirname(pathLink), { recursive: true })
    fs.symlinkSync(bundled, pathLink)

    // Returns the REQUESTED path, not the realpath: dispatch wrappers read argv[0].
    expect(resolveWith({
      PATH: path.dirname(pathLink),
      HOME: path.join(tmpDir, 'home'),
    })).toBe(pathLink)
  })

  it('throws a typed actionable error when no candidate exists', () => {
    const error = resolutionError(() => resolveWith({
      PATH: path.join(tmpDir, 'minimal-empty-path'),
      HOME: path.join(tmpDir, 'empty-home'),
    }))

    expect(error.reason).toBe('not_found')
    expect(error.code).toBe('SYSTEM_CODEX_UNAVAILABLE')
    expect(error.kind).toBe('provider_missing')
    expect(error.message).toContain('Install Codex')
    expect(error.message).toContain('WALNUT_CODEX_PATH')
    expect(error.message).toContain('outside node_modules')
  })
})

describe('resolveEngineExecutable (generalized resolver)', () => {
  it('keeps the codex entry point as an alias of the generic resolver', () => {
    const codex = executable('generic/codex')
    const env = { PATH: path.dirname(codex), HOME: path.join(tmpDir, 'home') }
    expect(resolveEngineExecutable({ engine: 'codex', env, systemDirectories: [] })).toBe(codex)
    expect(resolveSystemCodexPath({ env, systemDirectories: [] })).toBe(codex)
  })

  it('probes the engine own binary name and its own override variable', () => {
    const gemini = executable('gemini-bin/gemini')
    const override = executable('gemini-override/gemini')
    const env = { PATH: path.dirname(gemini), HOME: path.join(tmpDir, 'home') }
    expect(resolveEngineExecutable({ engine: 'gemini', env, systemDirectories: [] })).toBe(gemini)
    expect(resolveEngineExecutable({
      engine: 'gemini',
      env: { ...env, WALNUT_GEMINI_PATH: override },
      systemDirectories: [],
    })).toBe(override)
    // A codex binary on PATH must NOT satisfy a gemini lookup.
    executable('codex-only/codex')
    expect(() => resolveEngineExecutable({
      engine: 'gemini',
      env: { PATH: path.join(tmpDir, 'codex-only'), HOME: path.join(tmpDir, 'home') },
      systemDirectories: [],
    })).toThrow(/No system Gemini executable/)
  })

  it('fails closed per engine with an engine-scoped code and actionable prose', () => {
    let error: EngineExecutableError | undefined
    try {
      resolveEngineExecutable({
        engine: 'goose',
        env: { PATH: path.join(tmpDir, 'nothing'), HOME: path.join(tmpDir, 'empty') },
        systemDirectories: [],
      })
    } catch (thrown) {
      error = thrown as EngineExecutableError
    }
    expect(error).toBeInstanceOf(EngineExecutableError)
    expect(error!.engine).toBe('goose')
    expect(error!.reason).toBe('not_found')
    expect(error!.code).toBe('SYSTEM_GOOSE_UNAVAILABLE')
    expect(error!.message).toContain('Install Goose')
    expect(error!.message).toContain('WALNUT_GOOSE_PATH')
  })

  it('keeps the node_modules ban for every engine', () => {
    const bundled = executable('node_modules/.bin/opencode')
    let error: EngineExecutableError | undefined
    try {
      resolveEngineExecutable({
        engine: 'opencode',
        env: { WALNUT_OPENCODE_PATH: bundled, PATH: '', HOME: path.join(tmpDir, 'home') },
        systemDirectories: [],
      })
    } catch (thrown) {
      error = thrown as EngineExecutableError
    }
    expect(error?.reason).toBe('override_forbidden')
    expect(error?.message).toContain('node_modules')
  })
})

describe('resolveAcpArtifacts', () => {
  function probe(...dirs: string[]): { executable: { env: NodeJS.ProcessEnv; systemDirectories: string[] } } {
    return {
      executable: {
        env: { PATH: dirs.join(path.delimiter), HOME: path.join(tmpDir, 'home') },
        systemDirectories: [],
      },
    }
  }

  it('serves the engine-neutral worker bundle to every engine', () => {
    const { workerCmd } = resolveAcpArtifacts('codex')
    expect(workerCmd[0]).toBe(process.execPath)
    expect(workerCmd[1].replace(/\\/g, '/')).toContain('dist/daemon-binaries/acp-worker.js')
  })

  it('runs the bundled adapter package for codex', () => {
    const { adapterCmd } = resolveAcpArtifacts('codex')
    expect(adapterCmd[0]).toBe(process.execPath)
    expect(adapterCmd[1].replace(/\\/g, '/')).toContain('@agentclientprotocol/codex-acp/dist/index.js')
    // Default argument keeps the pre-multi-engine call shape working.
    expect(resolveAcpArtifacts().adapterCmd).toEqual(adapterCmd)
  })

  it.each([
    ['gemini', 'gemini', ['--experimental-acp']],
    ['opencode', 'opencode', ['acp']],
    ['goose', 'goose', ['acp']],
  ] as const)('runs the provider CLI itself for %s', (engine, binary, args) => {
    const bin = executable(`${engine}-cli/${binary}`)
    const { adapterCmd } = resolveAcpArtifacts(engine, probe(path.dirname(bin)))
    expect(adapterCmd).toEqual([bin, ...args])
  })

  it('takes the custom engine argv from config and names the key when unset', () => {
    expect(resolveAcpArtifacts('custom', {
      configuredAdapterCmd: ['/usr/local/bin/my-agent', 'acp'],
    }).adapterCmd).toEqual(['/usr/local/bin/my-agent', 'acp'])
    // Blank entries are not a configuration.
    expect(() => resolveAcpArtifacts('custom', { configuredAdapterCmd: ['', ''] }))
      .toThrow(/engines\.custom\.adapter_cmd/)
    expect(() => resolveAcpArtifacts('custom')).toThrow(/engines\.custom\.adapter_cmd/)
  })

  it('refuses a native engine instead of inventing an adapter', () => {
    expect(() => resolveAcpArtifacts('claude')).toThrow(/no ACP adapter/)
  })
})
