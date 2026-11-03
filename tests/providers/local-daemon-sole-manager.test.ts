/**
 * A daemon only this server manages is replaced by this server's new build, whoever its
 * record names (2026-11-03: the cloud companion's tunnel daemon serves the Mac, whose
 * pushes come through the companion with the Mac's home; the shared-daemon rule,
 * daemon-shared.ts, read that as another Walnut using it and kept the old build, so a
 * companion on a new build never replaced it: tests/e2e/cloud-box-tunnel-e2e.test.ts).
 *
 * Pinned:
 *   - a sole-manager LocalDaemon never keeps another build, a default one still does;
 *   - the tunnel daemon is a sole manager;
 *   - every LocalDaemon src constructs is listed here with its choice, so a new one
 *     decides whether a Walnut can reach its daemon other than through this server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { getTunnelDaemon, resetTunnelDaemonForTest } from '../../src/providers/cloud-tunnel-daemon.js'
import { ourDaemonCapabilities } from '../../src/providers/daemon-shared.js'
import { log } from '../../src/logging/index.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const RUNNING = 'walnut-daemon-running00001'
const EXPECTED = 'walnut-daemon-expected0002'
/** A hello from a daemon of another build that another Walnut used a minute ago, with every capability. */
const hello = () => ({
  version: RUNNING,
  served: { version: RUNNING, twin: 'binary' as const, capabilities: ourDaemonCapabilities('binary'), walnuts: { cccccccccccccccc: Date.now() - 60_000 } },
})
const keeps = (d: LocalDaemon) => (d as unknown as { keepSharedDaemon: (h: unknown, e: string) => boolean }).keepSharedDaemon(hello(), EXPECTED)

/**
 * Every `new LocalDaemon(...)` in src, per file in source order, and whether that call is
 * the only manager of its daemon (`soleManager: true` in its own options).
 */
const CONSTRUCTED: Record<string, boolean[]> = {
  // This machine's own daemon: another Walnut of the same OS account may share it.
  'src/providers/local-daemon.ts': [false],
  // The companion's tunnel daemon: the Mac reaches it only through this companion.
  'src/providers/cloud-tunnel-daemon.ts': [true],
}

/** Whether an options object literal sets `soleManager: true` itself. */
function setsSoleManager(arg: ts.Expression | undefined): boolean {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false
  return arg.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'soleManager'
    && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
}

/**
 * The LocalDaemon constructions and subclasses in one file: the names it binds to the class
 * (its own declaration, or an import under any alias), then each `new <name>(...)` with its
 * own options, and each `class X extends <name>` (a subclass would construct it unseen).
 */
function constructions(file: string, text: string): { calls: boolean[]; subclasses: string[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const names = new Set<string>()
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name?.text === 'LocalDaemon') names.add('LocalDaemon')
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) {
        if ((el.propertyName ?? el.name).text === 'LocalDaemon') names.add(el.name.text)
      }
    }
  }
  const calls: boolean[] = []
  const subclasses: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      calls.push(setsSoleManager(node.arguments?.[0]))
    }
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) {
        for (const t of clause.types) if (ts.isIdentifier(t.expression) && names.has(t.expression.text)) subclasses.push(node.name?.text ?? '(anonymous)')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { calls, subclasses }
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return srcFiles(p)
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
}

afterEach(() => {
  resetTunnelDaemonForTest()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('a daemon only this server manages', () => {
  it('is replaced by a new build whoever its record names; a default one is kept', () => {
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sole-manager-'))
    try {
      expect(keeps(new LocalDaemon({ daemonDir: path.join(dir, 'shared') }))).toBe(true)
      expect(keeps(new LocalDaemon({ daemonDir: path.join(dir, 'sole'), soleManager: true }))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('the companion\'s tunnel daemon is one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-tunnel-daemon-'))
    try {
      vi.stubEnv('WALNUT_TUNNEL_DAEMON_DIR', path.join(dir, 'primary-daemon'))
      expect(keeps(getTunnelDaemon())).toBe(false)
      expect(keeps(getTunnelDaemon('mac-device-1'))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('every LocalDaemon src constructs is listed with its choice', () => {
    const found: Record<string, boolean[]> = {}
    const subclasses: string[] = []
    for (const file of srcFiles(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes('LocalDaemon')) continue
      const rel = path.relative(ROOT, file)
      const seen = constructions(rel, text)
      if (seen.calls.length) found[rel] = seen.calls
      subclasses.push(...seen.subclasses.map((name) => `${rel}: ${name}`))
    }
    // A new site: decide whether a Walnut can reach its daemon other than through this
    // server (soleManager: true when not), then list it in CONSTRUCTED.
    expect(found).toEqual(CONSTRUCTED)
    expect(subclasses, 'a LocalDaemon subclass constructs one this list does not see').toEqual([])
  })

  it('the scan sees an aliased import, a second call in a listed file and a subclass', () => {
    const text = [
      "import { LocalDaemon as LD } from './local-daemon.js'",
      'const a = new LD({ soleManager: true })',
      'const b = new LD ({ daemonDir: "/x" })',
      'class Mine extends LD {}',
    ].join('\n')
    expect(constructions('probe.ts', text)).toEqual({ calls: [true, false], subclasses: ['Mine'] })
  })
})
