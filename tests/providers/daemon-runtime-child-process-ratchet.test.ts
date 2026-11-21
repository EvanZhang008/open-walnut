/**
 * Every child process the daemon runtime starts gets the runtime's env and umask 077, even for
 * the modules it imports that start children themselves.
 *
 * createDaemonRuntime (daemon-standalone.ts) runs inside another process (the Walnut server),
 * so a module that calls node:child_process directly would hand its child the HOST's umask
 * (usually 022) and the host's process.env. Each such module therefore takes the functions it
 * uses (and the env it builds a child's env from) from its caller, node's own by default
 * (ChildProcessUse, daemon-child-spawn.ts), and the runtime passes its wrapped ones (`childUse`).
 *
 * This walks the value-import graph of daemon-standalone.ts and holds:
 *   1. the modules in it that value-import child_process (or call Bun.spawn) are exactly the
 *      allowlist below, each with its reason and where the runtime injects it;
 *   2. at each injection point the runtime (or the module in between) passes its own.
 * A new direct importer fails (1) and says how to inject it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const STANDALONE = 'src/providers/daemon-standalone.ts'
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Comments out (a `//` or `/*` only where a comment can start: line start or after a space). */
function stripComments(text: string): string {
  return text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Whether `index` on its line sits inside a quoted string (an odd count of a quote before it). */
function insideString(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const before = text.slice(lineStart, index).replace(/\\./g, '')
  return ['"', "'", '`'].some((q) => before.split(q).length % 2 === 0)
}

/** The relative specifiers a module loads at run time (type-only imports left out). */
function valueImports(text: string, file: string): string[] {
  const out: string[] = []
  // The clause holds no quote or `;`, so a match never runs on into the next statement.
  const stat = /^\s*(import|export)\s+(type\s+)?([^'"`;]*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (let m; (m = stat.exec(text));) {
    if (m[2]) continue
    const braces = /^\{([\s\S]*)\}$/.exec(m[3]!.trim())
    const names = braces ? braces[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null
    if (names && names.length > 0 && names.every((n) => n.startsWith('type '))) continue
    out.push(m[4]!)
  }
  for (let m, side = /^\s*import\s+['"]([^'"]+)['"]/gm; (m = side.exec(text));) out.push(m[1]!)
  // import('x') as a value: `import('x').Name` is a type position, `.then` is not.
  for (let m, dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)(\.(\w+))?/g; (m = dyn.exec(text));) {
    if (m[3] && m[3] !== 'then') continue
    // daemon-standalone.ts's own entry (after the runtime) loads the walnut CLI: that program, not the runtime.
    if (file === STANDALONE && m.index > text.indexOf('// ── The daemon as a program of its own')) continue
    out.push(m[1]!)
  }
  for (let m, req = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g; (m = req.exec(text));) if (!insideString(text, m.index)) out.push(m[1]!)
  return out
}

function usesChildProcess(text: string): boolean {
  const code = stripComments(text)
  const stat = /^\s*(import|export)\s+(?!type\s)([^'"`;]*?)\s+from\s+['"](node:)?child_process['"]/gm
  for (let m; (m = stat.exec(code));) {
    const braces = /^\{([\s\S]*)\}$/.exec(m[2]!.trim())
    const names = braces ? braces[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null
    if (!(names && names.every((n) => n.startsWith('type ')))) return true
  }
  for (const re of [/\b(require|import)\(\s*['"](node:)?child_process['"]\s*\)/g, /\bBun\.spawn(Sync)?\(/g]) {
    for (let m; (m = re.exec(code));) if (!insideString(code, m.index)) return true
  }
  return false
}

function resolveImport(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(ROOT, from)), spec)
  for (const c of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(ROOT, c)
  }
  return null
}

/** The runtime's import graph, and the modules in it that start children themselves. */
function walk(): { files: Set<string>; direct: string[]; unresolved: string[] } {
  const files = new Set<string>()
  const direct: string[] = []
  const unresolved: string[] = []
  const queue = [STANDALONE]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.has(file)) continue
    files.add(file)
    const text = read(file)
    if (usesChildProcess(text)) direct.push(file)
    for (const spec of valueImports(stripComments(text), file)) {
      if (!spec.startsWith('.')) continue
      const next = resolveImport(file, spec)
      if (next) queue.push(next)
      else unresolved.push(`${file} -> ${spec}`)
    }
  }
  return { files, direct: direct.sort(), unresolved }
}

/** The runtime's body (createDaemonRuntime up to the process entry), comments out. */
function runtimeBody(): string {
  const text = read(STANDALONE)
  const start = text.indexOf('export async function createDaemonRuntime(')
  const end = text.indexOf('// ── The daemon as a program of its own')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return stripComments(text.slice(start, end))
}

/** The argument text of every call of `name` (not its definition), parens balanced; `name<T>(` counts. */
function callsOf(text: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?<![\\w.$])${name.replace(/[.$]/g, '\\$&')}\\b`, 'g')
  for (let m; (m = re.exec(text));) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    let i = m.index + m[0].length
    if (text[i] === '<') {
      let depth = 0
      for (; i < text.length; i++) { if (text[i] === '<') depth++; else if (text[i] === '>' && --depth === 0) { i++; break } }
    }
    if (text[i] !== '(') continue
    let depth = 0
    const from = i
    for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break }
    out.push(text.slice(from + 1, i))
  }
  return out
}

type Check =
  /** Every call of `call` in `file` (the runtime's body for daemon-standalone.ts) has `has` in its arguments. */
  | { file: string; call: string; has: RegExp }
  /** `file` matches `re`. */
  | { file: string; re: RegExp }

interface Entry { reason: string; injection: string; checks: Check[] }

const S = STANDALONE
const P = 'src/providers/'
const createHostExec: Check = { file: S, call: 'createHostExec', has: /childProcess: childUse/ }
const createAcpDaemon: Check = { file: S, call: 'createAcpDaemon', has: /childProcess: childUse/ }

/** The modules of the runtime's graph that start children themselves, each with where the runtime injects its own. */
const ALLOWED: Record<string, Entry> = {
  [S]: {
    reason: 'the raw functions, handed once to createDaemonChildSpawn (daemon-runtime-in-process.test.ts holds the one line)',
    injection: 'const childUse = { spawn, execFile, execFileSync, execSync, env: daemonEnv }',
    checks: [{ file: S, re: /const childUse: ChildProcessUse = \{ spawn, execFile, execFileSync, execSync, env: daemonEnv \}/ }],
  },
  [`${P}daemon-spawn-barrier.ts`]: {
    reason: 'a service-mode session CLI starts behind the registry barrier',
    injection: 'spawnBehindRegistry(program, args, options, childUse)',
    checks: [{ file: S, call: 'spawnBehindRegistry', has: /,\s*childUse\s*$/ }],
  },
  [`${P}daemon-core.ts`]: {
    reason: 'ps for a pid\'s start time (macOS)',
    injection: 'defaultReadStartTime(fs, pid, childUse), defaultReadStartTimes(fs, pids, childUse), createAsyncStartTimeReader({ env: daemonEnv })',
    checks: [
      { file: S, call: 'defaultReadStartTime', has: /,\s*childUse\s*$/ },
      { file: S, call: 'defaultReadStartTimes', has: /,\s*childUse\s*$/ },
      { file: S, call: 'createAsyncStartTimeReader', has: /env: daemonEnv/ },
    ],
  },
  [`${P}acp-daemon.ts`]: {
    reason: 'the ACP workers, and ps for their identity',
    injection: 'createAcpDaemon({ childProcess: childUse })',
    checks: [createAcpDaemon, { file: `${P}acp-daemon.ts`, re: /env: mergeAcpSpawnEnv\(baseEnv, env\)/ }],
  },
  [`${P}codex-model-probe.ts`]: {
    reason: 'the Codex app-server for the model menu (acp-daemon.ts modelCatalog)',
    injection: 'createAcpDaemon({ childProcess }) -> probeCodexModels(binary, { env, spawn: use.spawn })',
    checks: [createAcpDaemon, { file: `${P}acp-daemon.ts`, call: 'probeCodexModels', has: /spawn: use\.spawn/ }],
  },
  [`${P}acp-host-artifacts.ts`]: {
    reason: 'an engine CLI\'s version probe, and PATH for its lookup',
    injection: 'createAcpDaemon({ childProcess }) -> createHostEngineProbe({ env, execFile }), resolveHostAcpArtifacts({ env })',
    checks: [
      createAcpDaemon,
      { file: `${P}acp-daemon.ts`, call: 'createHostEngineProbe', has: /env: use\.env, execFile: use\.execFile/ },
      { file: `${P}acp-daemon.ts`, call: 'resolveHostAcpArtifacts', has: /env: use\.env/ },
    ],
  },
  [`${P}acp-survive.ts`]: {
    reason: 'mkfifo for a surviving worker\'s pipe',
    injection: 'createAcpDaemon({ childProcess }) -> prepareSurviveFiles(paths, use)',
    checks: [createAcpDaemon, { file: `${P}acp-daemon.ts`, call: 'prepareSurviveFiles', has: /,\s*use\s*$/ }],
  },
  [`${P}detached-registry.ts`]: {
    reason: 'ps for a detached run\'s start (processStart)',
    injection: 'createAcpDaemon({ childProcess }) and createHostExec({ childProcess }) -> processStart(pid, use)',
    checks: [
      createAcpDaemon, createHostExec,
      { file: `${P}acp-daemon.ts`, call: 'psStart', has: /,\s*use\s*$/ },
      { file: `${P}host-exec-core.ts`, call: 'psStart', has: /,\s*deps\.childProcess\s*$/ },
    ],
  },
  [`${P}host-exec-watch.ts`]: {
    reason: 'ps and log for a macOS dialog a run waits on',
    injection: 'createHostExec({ childProcess }) -> macPromptProbe(now, deps.childProcess?.execFile)',
    checks: [createHostExec, { file: `${P}host-exec-core.ts`, call: 'macPromptProbe', has: /deps\.childProcess\?\.execFile/ }],
  },
  [`${P}host-exec-matcher.ts`]: {
    reason: 'ps for the wait_for matcher\'s CPU, and the env it starts with',
    injection: 'createHostExec({ childProcess }) -> createMatcher(start, spawn, { childProcess })',
    checks: [createHostExec, { file: `${P}host-exec-core.ts`, call: 'createMatcher', has: /childProcess: deps\.childProcess/ }],
  },
  [`${P}trigger-check-core.ts`]: {
    reason: 'a trigger\'s check script (sh -c)',
    injection: 'runCheckProcess(spec, stdin, { ...checkRunFence() }) with checkRunFence() carrying childProcess: childUse',
    checks: [
      { file: S, call: 'runCheckProcess', has: /\.\.\.checkRunFence\(\)/ },
      { file: S, re: /function checkRunFence\(\)[^\n]*\n\s*return \{[^\n]*childProcess: childUse/ },
    ],
  },
  [`${P}session-changes-core.ts`]: {
    reason: 'git for a session\'s changed files',
    injection: 'computeHostLocalChanges({ childProcess: childUse })',
    checks: [{ file: S, call: 'computeHostLocalChanges', has: /childProcess: childUse/ }],
  },
  [`${P}path-resolve-core.ts`]: {
    reason: 'git ls-files and find for a path a session named',
    injection: 'resolvePathHostLocal({ childProcess: childUse })',
    checks: [{ file: S, call: 'resolvePathHostLocal', has: /childProcess: childUse/ }],
  },
  [`${P}search-grep-core.ts`]: {
    reason: 'git grep and grep for a symbol\'s references',
    injection: 'grepReferencesHostLocal({ childProcess: childUse })',
    checks: [{ file: S, call: 'grepReferencesHostLocal', has: /childProcess: childUse/ }],
  },
  [`${P}port-scan-core.ts`]: {
    reason: 'lsof, ps and ss for the servers a session started',
    injection: 'createDaemonPorts({ io: defaultPortScanIo(childUse) })',
    checks: [{ file: S, call: 'createDaemonPorts', has: /io: defaultPortScanIo\(childUse\)/ }],
  },
  [`${P}task-dir-core.ts`]: {
    reason: 'git for the task dir sweeps, lsof for the paths in use',
    injection: 'gitRunnerWith(childUse) as `git` of removeTaskDirs / pruneTaskDirs / pruneTaskBuilds, readOpenPaths(root, childUse)',
    checks: [
      { file: S, re: /const taskDirGit = gitRunnerWith\(childUse\)/ },
      { file: S, call: 'removeTaskDirs', has: /git: taskDirGit/ },
      { file: S, call: 'pruneTaskDirs', has: /git: taskDirGit/ },
      { file: S, call: 'pruneTaskBuilds', has: /git: taskDirGit/ },
      { file: S, call: 'readOpenPaths', has: /,\s*childUse\s*$/ },
    ],
  },
  [`${P}session-cost-core.ts`]: {
    reason: '`opencode export` for a session\'s usage',
    injection: 'createUsageBudgetRuntime({ childProcess: childUse }) -> scan({ childProcess })',
    checks: [
      { file: S, call: 'createUsageBudgetRuntime', has: /childProcess: childUse/ },
      { file: `${P}usage-budget-runtime.ts`, call: 'scan', has: /childProcess: options\.childProcess/ },
    ],
  },
  [`${P}vscode-server-core.ts`]: {
    reason: 'code-server, its install, ps and git',
    injection: 'createCodeServer(childUse); the module\'s own exports are the process\'s',
    checks: [{ file: S, re: /const codeServer = createCodeServer\(childUse\)/ }],
  },
  [`${P}daemon-cron-host.ts`]: {
    reason: 'sysctl, ps and `claude --version` for cron supervision and the handover',
    injection: 'readCronBootId(platform, signal, childUse), createDaemonCronRuntime / prepare|consumeDaemonServiceHandover({ childProcess: childUse })',
    checks: [
      { file: S, call: 'readCronBootId', has: /,\s*childUse\s*$/ },
      { file: S, call: 'createDaemonCronRuntime', has: /childProcess: childUse/ },
      { file: S, call: 'prepareDaemonServiceHandover', has: /childProcess: childUse/ },
      { file: S, call: 'consumeDaemonServiceHandover', has: /childProcess: childUse/ },
      { file: `${P}daemon-cron-runtime.ts`, call: 'readCronBootId', has: /,\s*use\s*$/ },
      { file: `${P}daemon-cron-runtime.ts`, call: 'probeCronProcess', has: /,\s*use\s*$/ },
      { file: `${P}daemon-cron-runtime.ts`, call: 'readCronCliVersion', has: /,\s*use\s*$/ },
      { file: `${P}daemon-service-handover.ts`, call: 'readCronBootId', has: /input\.childProcess\s*$/ },
      { file: `${P}daemon-service-handover.ts`, call: 'probeCronProcess', has: /input\.childProcess\s*$/ },
    ],
  },
}

const HOW = 'take the child-process functions it uses (and the env it builds a child env from) from its caller: '
  + "an options field or a trailing parameter typed ChildProcessUse<'spawn' | 'execFile' ...> (daemon-child-spawn.ts), "
  + "node's own and process.env by default, and pass `childUse` at its call in daemon-standalone.ts; then add it to ALLOWED here"

describe('the daemon runtime\'s modules start children with its env and umask', () => {
  const graph = walk()

  it('walks the whole graph', () => {
    expect(graph.unresolved).toEqual([])
    expect(graph.files.size).toBeGreaterThan(100)
    expect(graph.files.has(`${P}daemon-core.ts`)).toBe(true)
  })

  it('the modules that start children themselves are exactly the allowlist', () => {
    const unknown = graph.direct.filter((f) => !(f in ALLOWED))
    expect(unknown, `these modules start children with node:child_process directly; each must ${HOW}`).toEqual([])
    const gone = Object.keys(ALLOWED).filter((f) => !graph.direct.includes(f))
    expect(gone, 'these no longer start children themselves (or left the graph): drop them from ALLOWED').toEqual([])
  })

  const body = runtimeBody()
  const textOf = (file: string) => (file === S ? body : stripComments(read(file)))
  for (const [file, entry] of Object.entries(ALLOWED)) {
    it(`${path.basename(file)}: ${entry.injection}`, () => {
      expect(entry.reason.length).toBeGreaterThan(0)
      for (const check of entry.checks) {
        const text = textOf(check.file)
        if ('re' in check) {
          expect(check.re.test(text), `${check.file} should match ${check.re}`).toBe(true)
          continue
        }
        const calls = callsOf(text, check.call)
        expect(calls.length, `${check.file} calls ${check.call}`).toBeGreaterThan(0)
        for (const args of calls) expect(args, `${check.file}: ${check.call}(...) must pass ${check.has}`).toMatch(check.has)
      }
    })
  }

  it('the runtime uses only its own code-server, never the process\'s', () => {
    expect(body).not.toMatch(/(?<![\w.])(ensureCodeServer|codeServerStatus|reapIdleCodeServer|stopCodeServer|resolveOpenTarget)\(/)
  })
})

describe('the graph walk itself', () => {
  it('tells a value import from a type-only one, and code from a comment or a string', () => {
    expect(usesChildProcess("import { spawn } from 'node:child_process'")).toBe(true)
    expect(usesChildProcess("import * as cp from 'child_process'")).toBe(true)
    expect(usesChildProcess("import { type ChildProcess } from 'node:child_process'")).toBe(false)
    expect(usesChildProcess("import type { ChildProcess } from 'node:child_process'")).toBe(false)
    expect(usesChildProcess("import fs from 'node:fs'\nimport type { ChildProcess } from 'node:child_process'")).toBe(false)
    expect(usesChildProcess("const cp = require('node:child_process')")).toBe(true)
    expect(usesChildProcess("  \"  require('node:child_process').execFileSync(x)\",")).toBe(false)
    expect(usesChildProcess('const p = Bun.spawn(["ls"])')).toBe(true)
    expect(usesChildProcess('/** like `Bun.spawn(argv)` */\nconst x = 1')).toBe(false)
    expect(valueImports("import type { A } from './a.js'\nimport { type B } from './b.js'\nimport { c } from './c.js'", 'x')).toEqual(['./c.js'])
    expect(valueImports("type T = import('./t.js').T\nconst m = await import('./m.js')", 'x')).toEqual(['./m.js'])
  })

  it('reads every call of a name with its arguments, generics included', () => {
    expect(callsOf('function f(a) {}\nf(1, g(2))\nconst y = o.f(3)\nh<T>(4)', 'f')).toEqual(['1, g(2)'])
    expect(callsOf('h<A<B>>({ x: 1 })', 'h')).toEqual(['{ x: 1 }'])
  })
})
