/**
 * A host other than the primary runs ACP engines itself (acp-host-artifacts.ts):
 * its daemon builds the worker and adapter commands from the files the remote
 * deploy put beside it and the engine CLIs on its own PATH, and says which engines
 * it can run. Every engine the registry describes must resolve (or be refused with
 * a reason), so a new engine cannot silently be unrunnable on a host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ACP_HOST_FILES, ACP_HOST_WORKER, createHostEngineProbe, findHostBinary, resolveHostAcpArtifacts } from '../../src/providers/acp-host-artifacts.js'
import { hostAdapterSpec } from '../../src/core/agents/host-adapter-spec.js'
import { guardedPath } from '../setup/exec-guard.js'
import { ENGINE_REGISTRY, isAcpEngine } from '../../src/core/agents/engine-registry.js'

let root: string
let artifactDir: string
let binDir: string
let home: string

function exe(dir: string, name: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, '#!/bin/sh\necho "' + name + ' 1.2.3"\n', { mode: 0o755 })
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-host-'))
  artifactDir = path.join(root, 'daemon')
  binDir = path.join(root, 'bin')
  home = path.join(root, 'home')
  for (const d of [artifactDir, binDir, home]) fs.mkdirSync(d, { recursive: true })
  for (const f of Object.keys(ACP_HOST_FILES)) fs.writeFileSync(path.join(artifactDir, f), '// stub\n')
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const deps = () => ({ artifactDir, execPath: '/usr/bin/bun', env: { PATH: guardedPath([binDir], '') }, home, extraDirs: [] as string[] })

describe('resolveHostAcpArtifacts', () => {
  it('runs a bundled adapter with the daemon runtime and hands it the host CLI', () => {
    const codex = exe(binDir, 'codex')
    const r = resolveHostAcpArtifacts(hostAdapterSpec('codex')!, deps())
    expect(r).toEqual({
      ok: true,
      workerCmd: ['/usr/bin/bun', path.join(artifactDir, ACP_HOST_WORKER)],
      adapterCmd: ['/usr/bin/bun', path.join(artifactDir, 'codex-acp.mjs')],
      env: { CODEX_PATH: codex },
    })
  })

  it('runs a cli adapter as the host binary with its args', () => {
    const opencode = exe(binDir, 'opencode')
    const r = resolveHostAcpArtifacts(hostAdapterSpec('opencode')!, deps())
    expect(r.ok && r.adapterCmd).toEqual([opencode, 'acp'])
  })

  it('finds a CLI in a per-user install dir off the PATH', () => {
    const dir = path.join(home, '.local/bin')
    fs.mkdirSync(dir, { recursive: true })
    const codex = exe(dir, 'codex')
    // The default search includes it.
    expect(findHostBinary({ binary: 'codex' }, { env: { PATH: guardedPath(['/nonexistent'], '') }, home }).path).toBe(codex)
    expect(findHostBinary({ binary: 'codex' }, { env: { PATH: guardedPath(['/nonexistent'], '') }, home, extraDirs: [dir] })).toEqual({ path: codex })
  })

  it('never takes a copy inside node_modules', () => {
    const nm = path.join(root, 'node_modules/.bin')
    fs.mkdirSync(nm, { recursive: true })
    exe(nm, 'codex')
    expect(findHostBinary({ binary: 'codex' }, { env: { PATH: guardedPath([nm], '') }, home, extraDirs: [] }).path).toBeUndefined()
  })

  it('says why: no CLI on the host', () => {
    const r = resolveHostAcpArtifacts(hostAdapterSpec('goose')!, deps())
    expect(r).toMatchObject({ ok: false, errorKind: 'provider_missing' })
    expect(!r.ok && r.error).toContain('goose is not installed')
  })

  it('says why: the daemon has no ACP worker (an older deploy)', () => {
    exe(binDir, 'codex')
    fs.rmSync(path.join(artifactDir, ACP_HOST_WORKER))
    expect(resolveHostAcpArtifacts(hostAdapterSpec('codex')!, deps())).toMatchObject({ ok: false, errorKind: 'acp_unsupported' })
  })

  it('honours the host override and refuses one that is not executable', () => {
    const own = exe(root, 'my-codex')
    expect(findHostBinary({ binary: 'codex', overrideEnv: 'WALNUT_CODEX_PATH' }, { env: { PATH: guardedPath([], ''), WALNUT_CODEX_PATH: own }, home, extraDirs: [] })).toEqual({ path: own })
    const bad = findHostBinary({ binary: 'codex', overrideEnv: 'WALNUT_CODEX_PATH' }, { env: { PATH: guardedPath([binDir], ''), WALNUT_CODEX_PATH: '/nope' }, home, extraDirs: [] })
    expect(bad.path).toBeUndefined()
    expect(bad.reason).toContain('WALNUT_CODEX_PATH')
  })
})

describe('a spec the primary sends is checked before anything runs', () => {
  it('refuses a binary that is a path, a bundle the daemon does not ship, or a stray env key', () => {
    exe(binDir, 'codex')
    const codex = hostAdapterSpec('codex')!
    for (const bad of [
      { ...codex, binary: '../codex' },
      { ...codex, binary: '/bin/sh' },
      { ...codex, bundle: '../../etc/x.mjs' },
      { ...codex, binaryEnv: 'LD_PRELOAD' },
    ]) {
      expect(resolveHostAcpArtifacts(bad, deps()), JSON.stringify(bad)).toMatchObject({ ok: false, errorKind: 'acp_unsupported' })
    }
  })

  it('never searches a relative PATH entry (it would resolve against the daemon\'s own dir)', () => {
    expect(findHostBinary({ binary: 'codex' }, { env: { PATH: guardedPath(['.'], '') }, home, extraDirs: [] }).path).toBeUndefined()
  })
})

describe('hostAdapterSpec covers every ACP engine', () => {
  it('describes each one, except the custom engine (its command is the primary machine\'s config)', () => {
    for (const id of ENGINE_REGISTRY.keys()) {
      if (!isAcpEngine(id)) { expect(hostAdapterSpec(id)).toBeNull(); continue }
      const spec = hostAdapterSpec(id)
      if (id === 'custom') { expect(spec).toBeNull(); continue }
      expect(spec, id).not.toBeNull()
      // A bundled adapter must name a file the remote deploy ships.
      if (spec!.source === 'bundled') expect(Object.keys(ACP_HOST_FILES), id).toContain(spec!.bundle)
    }
  })
})

describe('createHostEngineProbe', () => {
  it('reports installed engines with their version and the missing ones with a reason', async () => {
    exe(binDir, 'codex')
    exe(binDir, 'opencode')
    const specs = ['codex', 'opencode', 'goose'].map((e) => hostAdapterSpec(e as never)!)
    const out = await createHostEngineProbe(deps()).probe(specs)
    expect(out.codex).toMatchObject({ installed: true, version: 'codex 1.2.3', reason: null })
    expect(out.opencode).toMatchObject({ installed: true, version: 'opencode 1.2.3' })
    expect(out.goose).toEqual({ installed: false, version: null, reason: 'goose is not installed' })
  })
})
