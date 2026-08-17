import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAcpAdapterEnv,
  parseCodexBaseConfig,
  resolveSystemCodexPath,
  SystemCodexPathError,
} from '../../src/providers/acp-session.js'
import { buildAcpLaneConfig } from '../../src/providers/claude-code-session.js'
import { opCallerFromEnv } from '../../src/ops/executor.js'

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

  it('marks the session as Walnut-managed so the CLI classifies itself as an agent', () => {
    // Without this, `walnut done <id>` inside a Codex session read as a human
    // and bypassed the human-only completion guard (native claude was blocked).
    const env = buildAcpAdapterEnv('/usr/local/bin/codex', { sessionId: 'acp-deadbeef' })
    expect(env).toEqual({ CODEX_PATH: '/usr/local/bin/codex', WALNUT_SESSION_ID: 'acp-deadbeef' })
    expect(opCallerFromEnv(env as NodeJS.ProcessEnv)).toBe('agent')
    expect(opCallerFromEnv({ CODEX_PATH: '/usr/local/bin/codex' } as NodeJS.ProcessEnv)).toBe('human')
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

  it('rejects a symlink whose canonical target is inside node_modules', () => {
    const bundled = executable('node_modules/@openai/codex/bin/codex')
    const override = path.join(tmpDir, 'system-bin', 'codex')
    fs.mkdirSync(path.dirname(override), { recursive: true })
    fs.symlinkSync(bundled, override)

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

  it('skips PATH candidates that resolve inside node_modules', () => {
    const bundled = executable('node_modules/@openai/codex/bin/codex')
    const pathLink = path.join(tmpDir, 'path-bin', 'codex')
    fs.mkdirSync(path.dirname(pathLink), { recursive: true })
    fs.symlinkSync(bundled, pathLink)
    const safe = executable('safe-bin/codex')

    expect(resolveWith({
      PATH: [path.dirname(pathLink), path.dirname(safe)].join(path.delimiter),
      HOME: path.join(tmpDir, 'home'),
    })).toBe(safe)
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
