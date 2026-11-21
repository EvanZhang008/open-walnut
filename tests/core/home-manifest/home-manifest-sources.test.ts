/**
 * Source ratchet for the data-location manifest (src/core/home-manifest/): a store the
 * code adds without a manifest entry turns this red, so a standby copy of the leader
 * never forgets one.
 *
 * Three nets, members enumerated from the source:
 *  1. Every exported path of src/constants.ts, by value: under WALNUT_HOME it needs a
 *     home entry, anywhere else an outside entry (or a place on the list of code dirs).
 *  2. Every join under the home in src/: `join(WALNUT_HOME, 'a', "b", `c`)` (also through
 *     `path.resolve(<home>)`, a parameter defaulting to WALNUT_HOME, a demo's `paths.data`,
 *     `<x>, '.open-walnut', ...` as the daemon twins and host cores write it), a join on a
 *     dir constant imported from constants.ts (`join(TMP_DIR, 'x')`), and a template
 *     (`${WALNUT_HOME}/cache/x`): the literal path needs an entry.
 *  3. Every `open-walnut/<name>` under the XDG state or data dir in src/: an outside entry.
 * A path that only lands on a mixed dir's fallback (cache/, local/, sync/, tmp/) counts as
 * missing: those dirs hold all three classes, so each child the code names is listed. A
 * join that ends in a computed segment right under a mixed dir (`join(WALNUT_HOME,
 * 'cache', name)`) cannot be checked by name, so its file must be on DYNAMIC_UNDER_MIXED
 * with the reason its names are covered.
 *
 * What it still cannot see (the real-server test, tests/e2e/home-manifest-real-server.test.ts,
 * catches those a boot creates):
 *  - a home handed in under another name (`opts.dataDir`, `dataDir`, `root`), unless it
 *    defaults to WALNUT_HOME in the same file;
 *  - a helper that returns a path the caller joins further (`routingRulesPath(home)`), and
 *    a relative path constant joined elsewhere (`path.join('triage', 'routing-rules.json')`);
 *  - a segment held in a constant defined outside constants.ts (`SYNCED_FILES_DIR`);
 *  - paths built with `+` or `.concat` instead of join or a template.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as constants from '../../../src/constants.js'
import {
  classifyOutsideAbsolute, classifyOutsidePath, homeEntries, isUnnamedHomePath, type OutsideRootContext,
} from '../../../src/core/home-manifest/index.js'

const root = path.resolve(import.meta.dirname, '../../..')

/** Exports of constants.ts that name code or text, not state. */
const NOT_STATE = new Set([
  'WALNUT_HOME', 'LOG_PREFIX', 'WALNUT_REPO_URL', 'BUILTIN_COMMANDS_DIR', 'BUILTIN_SKILLS_DIR',
  'DAEMON_BINARIES_DIR', 'WALNUT_INSTALL_DIR', 'WALNUT_PACKAGE_ROOT',
])

/**
 * Files whose join ends in a computed name right under a mixed dir, each with why every
 * name it can make is covered. A new such join turns the ratchet red until it is listed.
 */
const DYNAMIC_UNDER_MIXED = new Map<string, string>([
  ['src/providers/daemon-update-store.ts', 'local/daemon-update-<kind>.json: the local.daemon-update pattern'],
  ['src/core/sync-reconciler.ts', 'sync/reconcile-<plugin>.json: the sync.reconcile pattern'],
  ['src/core/helper-build.ts', 'cache/<helper>-v<n>[.plist|.srchash]: the cache.native-helpers pattern'],
  ['src/core/protected-reader.ts', 'a ternary of two names: cache.fda-ok and cache.screentime-ok'],
])

const MIXED_DIRS = new Set(homeEntries().filter((e) => e.listsChildren).map((e) => e.path))

/** The exports of a constants module that are state paths no entry names. */
function unlistedConstants(mod: Record<string, unknown>, home: string, ctx: OutsideRootContext): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'string' || NOT_STATE.has(name) || !path.isAbsolute(value)) continue
    const rel = path.relative(home, value)
    const inHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    if (inHome ? isUnnamedHomePath(rel.split(path.sep).join('/')) : !classifyOutsideAbsolute(value, ctx)) out.push(`${name} = ${value}`)
  }
  return out
}

/** Each exported path of a constants module under the home, by name, home-relative. */
function homeDirConstants(mod: Record<string, unknown>, home: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'string' || NOT_STATE.has(name) || !path.isAbsolute(value)) continue
    const rel = path.relative(home, value)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.set(name, rel.split(path.sep).join('/'))
  }
  return out
}

const HOME_NAMES = ['WALNUT_HOME', 'constants\\.WALNUT_HOME', 'walnutHome', 'paths\\.data']
/** A parameter or const that defaults to WALNUT_HOME (`home = WALNUT_HOME`) names it in its file. */
const HOME_ALIAS = /\b([A-Za-z_$][\w$]*)(?:\s*:\s*string)?\s*=\s*(?:constants\.)?WALNUT_HOME\b(?!\s*[.+[(])/g
/** The names a file imports from constants.ts (`import { A, B as C } from '../constants.js'`). */
const CONSTANTS_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](?:\.{1,2}\/)+(?:[\w-]+\/)*constants(?:\.js)?['"]/g
/** One string literal: single, double, or a template with no `${`. */
const LITERAL = /^(?:'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`)/

interface Join {
  /** Home-relative path of the literal part. */
  rel: string
  /** Literal segments after the base (0: the base alone). */
  segments: number
  /** The path goes on with a computed segment. */
  dynamic: boolean
}

/** Reads the arguments after a join's base: literal segments, then `)` or a computed one. */
function readArgs(source: string, at: number, base: string): Join {
  const segs = base ? base.split('/') : []
  let i = at
  let added = 0
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i++
    if (source[i] !== ',') return { rel: segs.join('/'), segments: added, dynamic: source[i] !== ')' }
    i++
    while (/\s/.test(source[i] ?? '')) i++
    const m = LITERAL.exec(source.slice(i, i + 400))
    if (!m) return { rel: segs.join('/'), segments: added, dynamic: source[i] !== ')' }
    i += m[0].length
    let after = i
    while (/\s/.test(source[after] ?? '')) after++
    // `'x-' + id`: the literal is only the start of a segment, so the path goes on computed.
    if (source[after] === '+') return { rel: segs.join('/'), segments: added, dynamic: true }
    const parts = (m[1] ?? m[2] ?? m[3]).split('/').filter(Boolean)
    segs.push(...parts)
    added += parts.length
  }
}

/** `${NAME}/a/b`, then the end of the literal or a computed part. */
function readTemplate(source: string, at: number, base: string): Join {
  const m = /^((?:\/[A-Za-z0-9._-]+)*)(\/?)(\$\{)?/.exec(source.slice(at, at + 400))!
  const segs = [...(base ? base.split('/') : []), ...m[1].split('/').filter(Boolean)]
  let added = m[1].split('/').filter(Boolean).length
  // `${HOME}/cache/x-${id}`: the last segment is only the start of a name.
  if (m[3] && !m[2] && added > 0) { segs.pop(); added-- }
  return { rel: segs.join('/'), segments: added, dynamic: !!m[3] }
}

const escape = (s: string) => s.replace(/[$]/g, '\\$')

/** Every join under the home a source file makes. */
function homeJoins(source: string): Join[] {
  const aliases = [...new Set([...source.matchAll(HOME_ALIAS)].map((m) => escape(m[1])))]
  const imported = new Set<string>()
  for (const m of source.matchAll(CONSTANTS_IMPORT)) {
    for (const spec of m[1].split(',')) {
      const name = spec.trim()
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) imported.add(name)
    }
  }
  const bases = new Map<string, string>()
  for (const name of [...HOME_NAMES, ...aliases]) bases.set(name, '')
  for (const [name, rel] of DIR_CONSTANTS) {
    if (imported.has(name)) bases.set(name, rel)
    bases.set(`constants\\.${name}`, rel)
  }
  const names = [...bases.keys()].sort((a, b) => b.length - a.length).join('|')
  const baseOf = (raw: string) => bases.get(raw.replace(/\./g, '\\.').replace(/\$/g, '\\$')) ?? ''
  const out: Join[] = []
  const call = new RegExp(String.raw`\b(?:path\.)?(?:posix\.)?(?:join|resolve)\(\s*(?:path\.resolve\(\s*(${names})\s*\)|(${names}))(?![\w$.(\[])`, 'g')
  for (const m of source.matchAll(call)) out.push(readArgs(source, m.index + m[0].length, baseOf(m[1] ?? m[2])))
  const dotHome = /\b(?:path\.)?(?:posix\.)?(?:join|resolve)\(\s*[\w.$]+(?:\(\))?\s*,\s*(['"`])\.open-walnut\1/g
  for (const m of source.matchAll(dotHome)) out.push(readArgs(source, m.index + m[0].length, ''))
  const template = new RegExp(String.raw`\$\{\s*(${names})\s*\}`, 'g')
  for (const m of source.matchAll(template)) out.push(readTemplate(source, m.index + m[0].length, baseOf(m[1])))
  return out
}

const DIR_CONSTANTS = homeDirConstants(constants as unknown as Record<string, unknown>, constants.WALNUT_HOME)

/** Home-relative paths a source file joins from literals that no entry names, and computed joins right under a mixed dir. */
function unlistedHomeJoins(source: string, file = '<inline>'): string[] {
  const found = new Set<string>()
  for (const j of homeJoins(source)) {
    if (j.dynamic && MIXED_DIRS.has(j.rel)) {
      if (!DYNAMIC_UNDER_MIXED.has(file)) found.add(`${j.rel}/<computed> (name its children, or list the file in DYNAMIC_UNDER_MIXED with why)`)
      continue
    }
    if (j.segments === 0) continue // the base alone: the home, or a constant net 1 already checks
    if (isUnnamedHomePath(j.rel)) found.add(j.rel)
  }
  return [...found]
}

const STATE_NAME = [
  /'\.local',\s*'state',\s*'open-walnut',\s*'([^']+)'/g,
  /\(\s*state\s*,\s*'open-walnut',\s*'([^']+)'/g,
  /XDG_STATE_HOME(?::-[^}]*\})?\/open-walnut\/([A-Za-z0-9._-]+)/g,
]
const DATA_NAME = [/'\.local',\s*'share',\s*'open-walnut',\s*'([^']+)'/g]

/** Outside-home names (`open-walnut/<name>` under the state or data dir) no entry names. */
function unlistedOutside(source: string): string[] {
  const found = new Set<string>()
  for (const [rootName, patterns] of [['xdg-state', STATE_NAME], ['xdg-data', DATA_NAME]] as const) {
    for (const re of patterns) {
      for (const m of source.matchAll(re)) {
        const rel = `open-walnut/${m[1]}`
        if (!classifyOutsidePath(rootName, rel)) found.add(`${rootName}:${rel}`)
      }
    }
  }
  return [...found]
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const ctx: OutsideRootContext = {
  env: process.env, userHome: os.homedir(), daemonDir: constants.LOG_DIR, claudeHome: constants.CLAUDE_HOME,
}

describe('every state path the code names has a manifest entry', () => {
  it('covers every exported path of src/constants.ts', () => {
    expect(unlistedConstants(constants as unknown as Record<string, unknown>, constants.WALNUT_HOME, ctx)).toEqual([])
  })

  it('covers every literal join under WALNUT_HOME and every outside-home name in src/', () => {
    const files = sourceFiles(path.join(root, 'src'))
    expect(files.length).toBeGreaterThan(500)
    const missing: string[] = []
    let joins = 0
    const dynamicFiles = new Set<string>()
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      const text = fs.readFileSync(file, 'utf8')
      const found = homeJoins(text)
      joins += found.length
      if (found.some((j) => j.dynamic && MIXED_DIRS.has(j.rel))) dynamicFiles.add(rel)
      for (const p of unlistedHomeJoins(text, rel)) missing.push(`${rel}: ${p}`)
      for (const name of unlistedOutside(text)) missing.push(`${rel}: ${name}`)
    }
    // The scan itself still finds the joins (a rename of WALNUT_HOME would make it see none).
    expect(joins).toBeGreaterThan(300)
    expect(missing, 'add an entry to src/core/home-manifest/ for each').toEqual([])
    // An allowlisted file that no longer makes such a join comes off the list.
    expect([...DYNAMIC_UNDER_MIXED.keys()].filter((f) => !dynamicFiles.has(f))).toEqual([])
  })
})

describe('the ratchet turns red on a store with no entry', () => {
  it('flags a new constant under the home and one outside it', () => {
    const fake = {
      NEW_STORE_FILE: '/h/brand-new-store.json',
      NEW_CACHE_DIR: '/h/cache/brand-new-queue',
      TASKS_FILE: '/h/tasks/tasks.json',
      ELSEWHERE: '/opt/somewhere/state.json',
      LOG_PREFIX: 'open-walnut-',
    }
    const fakeCtx = { env: {}, userHome: '/u', daemonDir: '/tmp/open-walnut', claudeHome: '/u/.claude' }
    expect(unlistedConstants(fake, '/h', fakeCtx)).toEqual([
      'NEW_STORE_FILE = /h/brand-new-store.json',
      'NEW_CACHE_DIR = /h/cache/brand-new-queue',
      'ELSEWHERE = /opt/somewhere/state.json',
    ])
  })

  it('flags a new literal join, including a new child of a mixed dir', () => {
    const source = [
      "const A = path.join(WALNUT_HOME, 'brand-new-store.json')",
      "const B = join(WALNUT_HOME, 'cache', 'brand-new-queue')",
      "const C = path.join(homeDir, '.open-walnut', 'local', 'brand-new.json')",
      "const D = path.join(WALNUT_HOME, 'tasks', 'x.json')",
      "const E = path.join(WALNUT_HOME, 'cache', 'applied-ops.sqlite')",
      "function f(home = WALNUT_HOME) { return path.join(path.resolve(home), 'aliased-new', 'x.json') }",
    ].join('\n')
    expect(unlistedHomeJoins(source).sort()).toEqual(['aliased-new/x.json', 'brand-new-store.json', 'cache/brand-new-queue', 'local/brand-new.json'])
  })

  it('reads double-quoted and template segments, home templates and dir constants', () => {
    const source = [
      "import { TMP_DIR, SYNC_DIR } from '../constants.js'",
      'const A = path.join(WALNUT_HOME, "double-new.json")',
      'const B = path.join(WALNUT_HOME, `template-new`, "x.json")',
      'const C = `${WALNUT_HOME}/cache/template-cache-new.json`',
      'const D = `${WALNUT_HOME}/tasks/${id}.json`',
      "const E = path.join(TMP_DIR, 'tmp-new')",
      "const F = path.join(SYNC_DIR, 'cloud-unpaired.json')",
      "const G = path.join(paths.data, 'local', 'demo-new')",
      "const H = path.join(constants.CACHE_UNKNOWN_DIR, 'x')",
    ].join('\n')
    expect(unlistedHomeJoins(source).sort()).toEqual(['cache/template-cache-new.json', 'double-new.json', 'local/demo-new', 'template-new/x.json', 'tmp/tmp-new'])
  })

  it('flags a computed name right under a mixed dir, but not under a named child', () => {
    const red = [
      'path.join(WALNUT_HOME, "cache", name)',
      "path.join(WALNUT_HOME, 'local', `${kind}.json`)",
      "path.join(WALNUT_HOME, 'cache', 'x-' + id + '.json')",
      '`${WALNUT_HOME}/sync/${plugin}.json`',
      '`${WALNUT_HOME}/tmp/run-${id}`',
      "import { SYNC_DIR } from '../constants.js'\npath.join(SYNC_DIR, `reconcile-${id}.json`)",
    ]
    for (const source of red) expect(unlistedHomeJoins(source), source).toEqual([expect.stringMatching(/^(cache|local|sync|tmp)\/<computed>/)])
    for (const source of [
      "path.join(WALNUT_HOME, 'cache', 'history', id)",
      '`${WALNUT_HOME}/cache/task-queue/${id}.json`',
      'path.join(WALNUT_HOME, id)',
      "path.join(WALNUT_HOME, 'cache')",
    ]) expect(unlistedHomeJoins(source), source).toEqual([])
    expect(unlistedHomeJoins('path.join(WALNUT_HOME, "sync", name)', 'src/core/sync-reconciler.ts')).toEqual([])
  })

  it('flags a new name in the XDG state dir', () => {
    const source = "path.join(state, 'open-walnut', 'brand-new')\n'dir=\"${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/other-new\"'\npath.join(state, 'open-walnut', 'vault')"
    expect(unlistedOutside(source)).toEqual(['xdg-state:open-walnut/brand-new', 'xdg-state:open-walnut/other-new'])
  })
})
