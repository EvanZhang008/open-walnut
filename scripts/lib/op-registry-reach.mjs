/**
 * The tests that read an op's definition through the op registry (src/ops/index.ts), for choosing
 * which tests a change to an op module needs (scripts/test-layers.mjs).
 *
 * An op module (src/ops/host-exec.ts) is loaded by the registry for its side effect: its
 * defineOp() calls run at import time. A test reads the op through the registry (getOp('x'),
 * listOps()), so it imports src/ops/index and never the op module: the change is two import steps
 * away, past the local layer's depth 1, and a test of the slow tier (tests/mcp) is in no layer at
 * all. 2026-11-25: three reds reached main from commits that changed only an op's text
 * (src/ops/host-exec.ts: tests/mcp/answer-shapes.test.ts; src/ops/org-threads.ts:
 * tests/scripts/generated-ops-docs.test.ts and tests/core/org/thread-op-size.test.ts).
 *
 * A change to an op module reaches, of the tests reading the registry:
 *   - every one reading the whole registry (listOps(), listOpEntries(), opNames(): a size cap over
 *     all ops, a generated op table), itself or through a test helper or script it loads, and
 *   - every one naming one of the module's ops in a string ('host_exec_read').
 * The other readers (about 200 import the registry to run one op by name) are left alone, so a
 * change to one op module selects tens of tests, not hundreds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isTestFile } from './import-graph.mjs'

/** The op registry: importing it loads every op module. */
export const OP_REGISTRY = 'src/ops/index.ts'
/** Why a reader is reached: it reads every op, or it names an op of the changed module. */
export const READS_EVERY_OP = 'reads every op of the registry'
export const READS_CHANGED_OP = 'reads a changed op from the registry'

// The registry's side-effect imports (`import './tasks.js'`): its op modules.
const MEMBER = /^import\s+['"](\.\/[^'"]+)['"]/gm
// The first `name:` of each defineOp({ ... }) call (a spread op names itself after the spread).
const OP_NAME = /defineOp\s*\(\s*\{[\s\S]*?\bname:\s*['"`]([\w-]+)['"`]/g
// A call that reads every op of the registry.
const WHOLE = /\b(?:listOps|listOpEntries|opNames|summarizeGroups|countOwnerOps|listedForRole|generateOpsCatalog)\s*\(/
// A file that loads the registry by a path built at run time: import(path.join(repo, 'src', 'ops', 'index.ts')).
const LOADS_BY_PATH = /\bimport\(\s*[^)]*\bsrc['"`/,\s]+ops['"`/,\s]+index\b/
// Files outside these are the test side: test helpers under tests/, scripts a test loads.
const PRODUCT = /^(?:src|web\/src|packages)\//

const readText = (root) => (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8') } catch { return '' } }
// A file's code without its comments: a comment naming listOps() reads nothing.
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** The op modules the registry loads, repo-relative (a new one is a new import line there). */
export function registryMembers(read) {
  const out = []
  for (const m of read(OP_REGISTRY).matchAll(MEMBER)) out.push(path.posix.join('src/ops', m[1].replace(/\.js$/, '.ts')))
  return out
}

/** The op names an op module defines. */
export const opNamesOf = (text) => [...text.matchAll(OP_NAME)].map((m) => m[1])

/**
 * The test files reading the registry: { file, text, whole } for each, where text is the test's own
 * and whole says it, or a helper or script on its way to the registry, reads every op. A test
 * reaches the registry through any chain of files on the test side (never through product code:
 * a test of the MCP server runs ops, it does not read their definitions).
 */
export function registryReaders({ graph, files, read }) {
  if (typeof files === 'function') files = files()
  const importers = (f) => graph.importersOf?.(f) ?? []
  // The test-side files that load the registry directly: by import, or by a path built at run time.
  const start = new Set(importers(OP_REGISTRY).filter((f) => !PRODUCT.test(f)))
  for (const f of files) if (!PRODUCT.test(f) && !start.has(f) && f !== OP_REGISTRY && LOADS_BY_PATH.test(codeOf(read(f)))) start.add(f)
  // Walk up the test side; a file is whole when it or a file between it and the registry is.
  const whole = new Map()
  let frontier = [...start]
  for (const f of frontier) whole.set(f, WHOLE.test(codeOf(read(f))))
  while (frontier.length) {
    const next = []
    for (const f of frontier) {
      for (const g of importers(f)) {
        if (PRODUCT.test(g)) continue
        const w = whole.get(f) || WHOLE.test(codeOf(read(g)))
        if (!whole.has(g)) { whole.set(g, w); next.push(g) } else if (w && !whole.get(g)) { whole.set(g, true); next.push(g) }
      }
    }
    frontier = next
  }
  return [...whole].filter(([f]) => isTestFile(f)).map(([file, w]) => ({ file, text: read(file), whole: w })).sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * A helper of the op modules (src/ops/host-exec-shown.ts: the text and caps host-exec.ts answers
 * with) changes their ops as much as the modules themselves: it stands for the op modules that
 * import it, through other helpers of src/ops. A file of src/ops that more op modules than this
 * import (registry.ts, executor.ts, answer.ts: the machinery every op uses) is left to the import
 * and scan rules: through it, every reader would read every op.
 */
export const HELPER_MAX_MODULES = 8

/** The op modules a changed file of src/ops stands for: itself, or the modules a helper serves. */
export function opModulesOf(file, { graph, members }) {
  if (members.has(file)) return [file]
  if (!file.startsWith('src/ops/') || file === OP_REGISTRY || !graph.importersOf) return []
  const found = new Set(), seen = new Set([file])
  let frontier = [file]
  while (frontier.length) {
    const next = []
    for (const f of frontier) {
      for (const g of graph.importersOf(f)) {
        if (seen.has(g) || !g.startsWith('src/ops/') || g === OP_REGISTRY) continue
        seen.add(g)
        if (members.has(g)) found.add(g); else next.push(g)
      }
    }
    frontier = next
  }
  return found.size <= HELPER_MAX_MODULES ? [...found] : []
}

// The readers of one tree, kept for the process: a layer is asked several times per run.
const readersCache = new Map()

/**
 * The tests a change reaches through the op registry: Map file -> why. Empty for a change to no
 * op module or helper of a few (opModulesOf). `graph`: scripts/lib/import-graph.mjs (one without
 * importersOf, a test's stand-in, reaches nothing); `files`: the repo's code files (or a function
 * giving them, called only for a change to an op module), to find run-time loaders; `readers`:
 * those of registryReaders, when the caller asks for many changes (by default kept per root when
 * the tree's own files are read).
 */
export function opRegistryReach(changed, { root, graph, files = [], read, readers }) {
  const out = new Map()
  if (!changed.some((f) => f.startsWith('src/ops/')) || !graph.importersOf) return out
  const own = !read
  read ??= readText(root)
  const members = new Set(registryMembers(read))
  const hit = [...new Set(changed.flatMap((f) => opModulesOf(f, { graph, members })))]
  if (!hit.length) return out
  const names = new Set(hit.flatMap((f) => opNamesOf(read(f))))
  if (!readers && own && readersCache.has(root)) readers = readersCache.get(root)
  readers ??= registryReaders({ graph, files, read })
  if (own) readersCache.set(root, readers)
  for (const r of readers) {
    if (r.whole) { out.set(r.file, READS_EVERY_OP); continue }
    for (const m of r.text.matchAll(/['"`]([\w-]+)['"`]/g)) if (names.has(m[1])) { out.set(r.file, READS_CHANGED_OP); break }
  }
  return out
}
