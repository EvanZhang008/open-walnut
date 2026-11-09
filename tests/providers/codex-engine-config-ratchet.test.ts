/**
 * Every place in src/ that builds a Codex adapter env or starts codex goes through
 * the one function that applies engines.codex (resolveCodexAdapterConfig in
 * src/providers/codex-engine-config.ts). A remote dev host once ran every Codex
 * session with no provider override, so that host's ~/.codex/config.toml won and
 * each request was refused: a spawn path that skips the function routes the same
 * way. A new such place fails here until it uses the function or says why it
 * builds no Codex env.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ONE_FUNCTIONS = ['resolveCodexEngine(', 'resolveCodexAdapterConfig(']

/** Files that name or build a Codex spawn, and what each does about the provider. */
const KNOWN: Record<string, { applies: string } | { namesOnly: string }> = {
  'src/providers/acp-session.ts': { applies: 'buildAdapterEnv: the env of every Codex session start, on this machine and on another host' },
  'src/providers/engine-model-probe.ts': { applies: 'the model menu probe: the same env a session start gets' },
  'src/providers/codex-model-probe.ts': { applies: 'the daemon side of the probe: codexProviderStartupArgs puts the CODEX_CONFIG provider on its app-server' },
  'src/providers/codex-engine-config.ts': { applies: 'the function itself' },
  'src/providers/codex-app-server/launch.ts': { applies: 'the direct Codex session\'s app-server: codexProviderStartupArgs puts the CODEX_CONFIG provider on it, the env comes from acp-session.ts' },
  'src/providers/acp-worker/worker.ts': { namesOnly: 'picks the direct client when the start says app-server; the launch is codex-app-server/launch.ts' },
  'src/providers/codex-app-server/transport.ts': { namesOnly: 'names the transport setting\'s values; starts nothing' },
  'src/core/agents/engine-probe.ts': { namesOnly: 'checks the bundled adapter file exists; starts nothing' },
  'src/core/agents/host-adapter-spec.ts': { namesOnly: 'names the adapter bundle another host runs; its env comes from acp-session.ts' },
  'src/providers/acp-host-artifacts.ts': { namesOnly: 'finds the bundle and codex on a host; the env it runs with comes from the start' },
  'src/providers/daemon-version-check.ts': { namesOnly: 'hashes the adapter files for the daemon version' },
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(rel)
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [rel] : []
  })
}

/** Code without comments, so prose about codex is not a spawn. */
function codeOf(text: string): string {
  // A block comment opens a line or follows a space: `**/*.ts` in a string is no comment.
  return text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
}

/** What makes a file a Codex spawn site. */
const TRIGGERS: Array<[string, RegExp]> = [
  ['calls buildAcpAdapterEnv', /(?<!function )\bbuildAcpAdapterEnv\(/],
  ['writes CODEX_CONFIG', /\bCODEX_CONFIG\s*:|\[['"]CODEX_CONFIG['"]\]\s*=|\.CODEX_CONFIG\s*=(?!=)/],
  ['parses CODEX_CONFIG', /(?<!function )\bparseCodexBaseConfig\(/],
  ['names the codex-acp adapter', /codex-acp(?:\.mjs|['"/])/],
  ['starts a codex app-server', /['"`]app-server['"`]/],
]

const files = sourceFiles('src').map((file) => ({ file, code: codeOf(fs.readFileSync(path.join(ROOT, file), 'utf8')) }))

/** The text of each `buildAcpAdapterEnv(...)` call, parentheses balanced. */
function calls(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/(?<!function )\bbuildAcpAdapterEnv\(/g)) {
    let depth = 0
    for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) { out.push(code.slice(m.index!, i + 1)); break }
    }
  }
  return out
}

/** A write of CODEX_CONFIG: an object key, or an assignment. */
const CODEX_CONFIG_WRITE = /(?:[{,]|^)\s*['"]?CODEX_CONFIG['"]?\s*:|\.CODEX_CONFIG\s*=(?!=)|\[['"]CODEX_CONFIG['"]\]\s*=(?!=)/gm

describe('every Codex spawn applies engines.codex through one function', () => {
  it('each file that builds a Codex env or starts codex is known', () => {
    const found: Record<string, string[]> = {}
    for (const { file, code } of files) {
      const why = TRIGGERS.filter(([, re]) => re.test(code)).map(([name]) => name)
      if (why.length) found[file] = why
    }
    // A new spawn path: send its env through resolveCodexAdapterConfig and list it as applies,
    // or list it as namesOnly with why it builds no Codex env.
    expect(Object.keys(found).filter((file) => !(file in KNOWN)).map((file) => `${file}: ${found[file].join(', ')}`)).toEqual([])
    // A listed file that no longer matches is stale.
    expect(Object.keys(KNOWN).filter((file) => !(file in found))).toEqual([])
  })

  it('each file that applies it calls the function (the probe the startup-args twin)', () => {
    for (const [file, role] of Object.entries(KNOWN)) {
      if (!('applies' in role)) continue
      const code = files.find((f) => f.file === file)!.code
      const uses = file.endsWith('codex-model-probe.ts') || file.endsWith('codex-app-server/launch.ts') ? /codexProviderStartupArgs\(/ : file.endsWith('codex-engine-config.ts') ? /function resolveCodexEngine\(/ : /resolveCodexEngine\(/
      expect([file, uses.test(code)]).toEqual([file, true])
    }
  })

  it('CODEX_CONFIG is written only by buildAcpAdapterEnv, whose base config comes from the function', () => {
    const writes: string[] = []
    for (const { file, code } of files) {
      const from = file === 'src/providers/acp-session.ts' ? code.indexOf('export function buildAcpAdapterEnv(') : -1
      const to = from >= 0 ? code.indexOf('\n}\n', from) : -1
      for (const m of code.matchAll(CODEX_CONFIG_WRITE)) {
        if (from >= 0 && m.index! > from && m.index! < to) continue
        writes.push(`${file}: ${code.slice(m.index!, m.index! + 60).trim()}`)
      }
    }
    expect(writes).toEqual([])
  })

  it('CODEX_CONFIG is parsed only inside the function', () => {
    const parsers = files.filter(({ code }) => /(?<!function )\bparseCodexBaseConfig\(/.test(code)).map(({ file }) => file)
    expect(parsers).toEqual(['src/providers/codex-engine-config.ts'])
  })

  it('a buildAcpAdapterEnv call for Codex takes its base config from the function', () => {
    const seen: string[] = []
    for (const { file, code } of files) {
      for (const call of calls(code)) {
        const firstArg = call.slice('buildAcpAdapterEnv('.length).trim()
        // `undefined` first = not Codex (no CODEX_PATH): those get no Codex config at all.
        if (firstArg.startsWith('undefined')) {
          expect([file, /baseConfig\s*:/.test(call)]).toEqual([file, false])
          continue
        }
        seen.push(file)
        // `baseConfig: resolveCodexEngine(...).baseConfig`, or a name (`codex.baseConfig`) assigned from it.
        const base = /baseConfig\s*:\s*([A-Za-z_$][\w$]*)(\s*\()?/.exec(call)
        expect([file, call.slice(0, 120), !!base]).toEqual([file, call.slice(0, 120), true])
        if (base![2]) {
          expect([file, ONE_FUNCTIONS.includes(`${base![1]}(`)]).toEqual([file, true])
        } else {
          const assigned = new RegExp(`\\b${base![1]}\\s*=[^;]*?\\bresolveCodex(?:Engine|AdapterConfig)\\(`).test(code)
          expect([file, base![1], assigned]).toEqual([file, base![1], true])
        }
      }
    }
    // The two Codex env builders: a session start and the model probe.
    expect([...new Set(seen)].sort()).toEqual(['src/providers/acp-session.ts', 'src/providers/engine-model-probe.ts'])
  })

  it('each caller resolves against codexWalnutConfig, so a server off the Mac reads the Mac\'s engine settings', () => {
    // The companion's own config.yaml has no engines.codex: a caller reading getConfig()
    // there would start Codex on the host's own provider (codex-engine-source.ts).
    const callers = files.filter(({ file, code }) => !file.endsWith('codex-engine-config.ts') && /(?<!function )\bresolveCodex(?:Engine|AdapterConfig)\(/.test(code))
    expect(callers.length).toBeGreaterThan(0)
    for (const { file, code } of callers) expect([file, /\bcodexWalnutConfig\(/.test(code)]).toEqual([file, true])
  })
})
