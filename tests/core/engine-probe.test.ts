/**
 * Engine availability probe (src/core/agents/engine-probe.ts).
 *
 * Pure-logic tier: every child process is injected (`runVersion`) and every
 * filesystem probe points at a temp HOME, so this file spawns nothing and its
 * answers do not depend on which provider CLIs this machine happens to have.
 *
 * The four rules under test are the ones that were shipped incidents elsewhere:
 * a probe never blocks a response past its deadline, a repeated probe does not
 * re-spawn (TTL), an override is fail-closed (never silently falls back to
 * PATH, never accepts a node_modules binary), and `reason` is set only when the
 * engine is genuinely unusable.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SESSION_ENGINE_IDS } from '../../src/core/types.js'
import {
  probeEngine,
  probeEngines,
  findEngineBinary,
  enginePathOverrideVar,
  usableExecutable,
  _resetEngineProbeCache,
  ENGINE_PROBE_TTL_MS,
  CUSTOM_ADAPTER_CMD_KEY,
  type EngineProbeOptions,
} from '../../src/core/agents/engine-probe.js'

const tmpDirs: string[] = []

function makeHome(): { home: string; bin: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-engine-probe-'))
  tmpDirs.push(home)
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  return { home, bin }
}

function installFakeBinary(bin: string, name: string): string {
  const file = path.join(bin, name)
  fs.writeFileSync(file, '#!/bin/sh\necho fake\n', { mode: 0o755 })
  return file
}

let home: string
let bin: string
let versionCalls: string[]

/** Base options: nothing resolvable except what a test explicitly installs. */
function baseOptions(extra: Partial<EngineProbeOptions> = {}): EngineProbeOptions {
  return {
    env: { HOME: home, PATH: bin } as NodeJS.ProcessEnv,
    cwd: home,
    systemDirectories: [],
    runVersion: async (binary, args) => {
      versionCalls.push(`${path.basename(binary)} ${args.join(' ')}`)
      return '1.2.3'
    },
    loadConfig: async () => ({}),
    bundledAdapterPresent: () => true,
    ...extra,
  }
}

beforeEach(() => {
  _resetEngineProbeCache()
  const made = makeHome()
  home = made.home
  bin = made.bin
  versionCalls = []
})

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('findEngineBinary', () => {
  it('finds an executable on PATH and refuses one inside node_modules', () => {
    installFakeBinary(bin, 'gemini')
    expect(findEngineBinary('gemini', { env: { HOME: home, PATH: bin } as NodeJS.ProcessEnv, cwd: home, systemDirectories: [] }))
      .toBe(path.join(bin, 'gemini'))

    const nm = path.join(home, 'node_modules', '.bin')
    fs.mkdirSync(nm, { recursive: true })
    installFakeBinary(nm, 'opencode')
    expect(findEngineBinary('opencode', { env: { HOME: home, PATH: nm } as NodeJS.ProcessEnv, cwd: home, systemDirectories: [] }))
      .toBeNull()
  })

  it('accepts a global install whose symlink target lives under a node_modules dir', () => {
    // homebrew and `npm i -g` put every node CLI under node_modules
    // (/opt/homebrew/bin/gemini -> Cellar/.../libexec/lib/node_modules/...), so a
    // realpath-wide ban would report gemini and opencode as "not installed".
    const cellar = path.join(home, 'cellar', 'libexec', 'lib', 'node_modules', '@vendor', 'cli', 'dist')
    fs.mkdirSync(cellar, { recursive: true })
    const real = installFakeBinary(cellar, 'index.js')
    const link = path.join(bin, 'gemini')
    fs.symlinkSync(real, link)
    expect(findEngineBinary('gemini', { env: { HOME: home, PATH: bin } as NodeJS.ProcessEnv, cwd: home, systemDirectories: [] }))
      .toBe(link)
  })

  it('probes the per-user bin dirs a service process often lacks', () => {
    const local = path.join(home, '.local', 'bin')
    fs.mkdirSync(local, { recursive: true })
    installFakeBinary(local, 'goose')
    expect(findEngineBinary('goose', { env: { HOME: home, PATH: '' } as NodeJS.ProcessEnv, cwd: home, systemDirectories: [] }))
      .toBe(path.join(local, 'goose'))
  })

  it('usableExecutable rejects a directory and a non-executable file', () => {
    const dir = path.join(home, 'adir')
    fs.mkdirSync(dir)
    expect(usableExecutable(dir)).toBeNull()
    const plain = path.join(home, 'plain')
    fs.writeFileSync(plain, 'x', { mode: 0o644 })
    expect(usableExecutable(plain)).toBeNull()
  })
})

describe('probeEngine — cli-sourced engines', () => {
  it('reports installed with a version when the CLI is on PATH', async () => {
    installFakeBinary(bin, 'gemini')
    const result = await probeEngine('gemini', baseOptions())
    expect(result).toEqual({ installed: true, version: '1.2.3', reason: null })
    // registry versionArgs, not a hardcoded flag
    expect(versionCalls).toEqual(['gemini --version'])
  })

  it('reports not installed with an actionable reason naming the binary and the override var', async () => {
    const result = await probeEngine('opencode', baseOptions())
    expect(result.installed).toBe(false)
    expect(result.version).toBeNull()
    expect(result.reason).toContain('opencode')
    expect(result.reason).toContain(enginePathOverrideVar('opencode'))
    expect(versionCalls).toEqual([])
  })

  it('honors a WALNUT_<ID>_PATH override', async () => {
    const custom = installFakeBinary(bin, 'goose-nightly')
    const result = await probeEngine('goose', baseOptions({
      env: { HOME: home, PATH: '', WALNUT_GOOSE_PATH: custom } as NodeJS.ProcessEnv,
    }))
    expect(result.installed).toBe(true)
    expect(versionCalls).toEqual(['goose-nightly --version'])
  })

  it('an override is fail-closed: a bad override never falls back to PATH discovery', async () => {
    installFakeBinary(bin, 'goose')
    const result = await probeEngine('goose', baseOptions({
      env: { HOME: home, PATH: bin, WALNUT_GOOSE_PATH: path.join(home, 'nope') } as NodeJS.ProcessEnv,
    }))
    expect(result.installed).toBe(false)
    expect(result.reason).toContain('WALNUT_GOOSE_PATH')
    expect(versionCalls).toEqual([])
  })

  it('an override inside node_modules is refused (npm prepends node_modules/.bin to PATH)', async () => {
    const nm = path.join(home, 'node_modules', '.bin')
    fs.mkdirSync(nm, { recursive: true })
    const bundled = installFakeBinary(nm, 'gemini')
    const result = await probeEngine('gemini', baseOptions({
      env: { HOME: home, PATH: '', WALNUT_GEMINI_PATH: bundled } as NodeJS.ProcessEnv,
    }))
    expect(result.installed).toBe(false)
    // Distinct from the "not a file" rejection: the fix is different (choose a
    // system install vs fix the path), so the reason must say which happened.
    expect(result.reason).toContain('node_modules')
    expect(result.reason).toContain('npm-injected')
  })

  it('a failing version command still counts as installed (version unknown, no reason)', async () => {
    installFakeBinary(bin, 'gemini')
    const result = await probeEngine('gemini', baseOptions({ runVersion: async () => null }))
    expect(result).toEqual({ installed: true, version: null, reason: null })
  })
})

describe('probeEngine — bundled-adapter engine (codex)', () => {
  it('needs BOTH the provider CLI and the bundled adapter', async () => {
    installFakeBinary(bin, 'codex')
    const ok = await probeEngine('codex', baseOptions())
    expect(ok.installed).toBe(true)

    _resetEngineProbeCache()
    const missingAdapter = await probeEngine('codex', baseOptions({ bundledAdapterPresent: () => false }))
    expect(missingAdapter.installed).toBe(false)
    expect(missingAdapter.reason).toContain('codex-acp')
  })

  it('reports not installed when the CLI is absent even though the adapter ships', async () => {
    const result = await probeEngine('codex', baseOptions())
    expect(result.installed).toBe(false)
    expect(result.reason).toContain('WALNUT_CODEX_PATH')
  })
})

describe('probeEngine — config-sourced engine (custom)', () => {
  it('is unavailable until engines.custom.adapter_cmd is set, and says so', async () => {
    const result = await probeEngine('custom', baseOptions())
    expect(result.installed).toBe(false)
    expect(result.reason).toContain(CUSTOM_ADAPTER_CMD_KEY)
  })

  it('is installed once a non-empty adapter argv is configured', async () => {
    const result = await probeEngine('custom', baseOptions({
      loadConfig: async () => ({ engines: { custom: { adapter_cmd: ['/opt/acp/adapter', 'serve'] } } }),
    }))
    expect(result).toEqual({ installed: true, version: null, reason: null })
  })

  it('ignores a malformed adapter_cmd (empty array, wrong type)', async () => {
    for (const adapter_cmd of [[], '', ['']] as unknown[]) {
      _resetEngineProbeCache()
      const result = await probeEngine('custom', baseOptions({
        loadConfig: async () => ({ engines: { custom: { adapter_cmd } } }),
      }))
      expect(result.installed).toBe(false)
    }
  })

  it('a config read that throws degrades to "not configured", never to a rejection', async () => {
    const result = await probeEngine('custom', baseOptions({
      loadConfig: async () => { throw new Error('config.yaml is gone') },
    }))
    expect(result.installed).toBe(false)
    expect(result.reason).toContain(CUSTOM_ADAPTER_CMD_KEY)
  })
})

describe('probeEngine — native engine (claude)', () => {
  it('is always installed: walnut spawns it as its own substrate', async () => {
    const result = await probeEngine('claude', baseOptions())
    expect(result.installed).toBe(true)
    expect(result.reason).toBeNull()
  })
})

describe('caching', () => {
  it('does not re-spawn inside the TTL and does re-probe after it', async () => {
    installFakeBinary(bin, 'gemini')
    let clock = 1_000
    const opts = baseOptions({ now: () => clock })
    await probeEngine('gemini', opts)
    await probeEngine('gemini', opts)
    expect(versionCalls).toHaveLength(1)

    clock += ENGINE_PROBE_TTL_MS + 1
    await probeEngine('gemini', opts)
    expect(versionCalls).toHaveLength(2)
  })

  it('dedupes concurrent probes onto one child process', async () => {
    installFakeBinary(bin, 'gemini')
    const opts = baseOptions()
    const [a, b] = await Promise.all([probeEngine('gemini', opts), probeEngine('gemini', opts)])
    expect(a).toEqual(b)
    expect(versionCalls).toHaveLength(1)
  })
})

describe('probeEngines', () => {
  it('covers every registered engine and only sets reason when unusable', async () => {
    installFakeBinary(bin, 'gemini')
    const all = await probeEngines(baseOptions())
    expect([...all.keys()]).toEqual([...SESSION_ENGINE_IDS])
    for (const [id, availability] of all) {
      if (availability.installed) expect(availability.reason, id).toBeNull()
      else expect(typeof availability.reason, id).toBe('string')
    }
  })

  it('answers as soon as presence is known — a hanging version spawn must not make it sit out the deadline', async () => {
    installFakeBinary(bin, 'gemini')
    let release: ((v: string | null) => void) | undefined
    // Production deadline on purpose: the regression this pins is the batch
    // waiting out ALL of it (GET /api/engines took a flat 2.5s on every cache
    // miss, holding one of the browser's six connections) because the raced
    // promise included the cosmetic `--version` child.
    const opts = baseOptions({
      deadlineMs: 2_500,
      runVersion: (binary) => new Promise<string | null>((resolve) => {
        if (path.basename(binary) === 'gemini') release = resolve
        else resolve('1.2.3')
      }),
    })

    const started = Date.now()
    const first = await probeEngines(opts)
    expect(Date.now() - started).toBeLessThan(500)
    // Installed-ness is decided from binary presence (synchronous), so a hanging
    // `--version` does NOT hold it back: the deadline answer is installed with the
    // version still unknown, never a "still checking" that locks the toggle.
    expect(first.get('gemini')).toEqual({ installed: true, version: null, reason: null })
    // Engines that answered are already exact in the same partial response.
    expect(first.get('custom')?.installed).toBe(false)

    release?.('0.26.0')
    await new Promise((r) => setTimeout(r, 20))
    const second = await probeEngines(opts)
    expect(second.get('gemini')).toEqual({ installed: true, version: '0.26.0', reason: null })
  })

  it('WALNUT_ENGINE_PROBE_ALL=1 forces installed and spawns nothing', async () => {
    const all = await probeEngines(baseOptions({
      env: { HOME: home, PATH: '', WALNUT_ENGINE_PROBE_ALL: '1' } as NodeJS.ProcessEnv,
    }))
    expect([...all.values()].every((a) => a.installed)).toBe(true)
    expect(versionCalls).toEqual([])
  })
})
