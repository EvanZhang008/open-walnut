/**
 * The session classes reach the leader's data only through the session port
 * (src/core/sessions/session-port.ts).
 *
 * ClaudeCodeSession, SessionRunner and AcpSession (which also runs the Codex app-server engine)
 * will run on a host's own server, where the leader's data comes through a port: the leader when
 * it answers, else the host's local copy and a journal. So none of their files may import a
 * leader-data module itself, statically or with a dynamic import(). Type-only imports
 * (`import type`, `typeof import(...)`, `import('...').SomeType`) are fine: they leave no code.
 *
 * Fix a failure here by calling the module through the port:
 *   `await import('../core/session-tracker.js')`  ->  `await sessionPort().records.loadTracker()`
 *   a static `import { getQueue } from '../core/session-message-queue.js'`
 *                                                 ->  `sessionPort().messages.queue.getQueue(...)`
 * A function the port does not name yet: add it to the module's `Pick<...>` in session-port.ts
 * (a new module: a new member there, in session-port-leader.ts and in SESSION_PORT_MEMBERS).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_PORT_MEMBERS, installSessionPort, sessionPort, type SessionPort } from '../../../src/core/sessions/session-port.js'
import { leaderSessionPort } from '../../../src/core/sessions/session-port-leader.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** The session classes' files. */
function sessionClassFiles(): string[] {
  const codex = fs.readdirSync(path.join(ROOT, 'src/providers/codex-app-server'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/providers/codex-app-server/${f}`)
  return ['src/providers/claude-code-session.ts', 'src/providers/acp-session.ts', ...codex]
}

/** Leader-data modules (repo path without extension) and the port member that serves each. */
const BANNED: Record<string, string> = {
  'src/core/session-tracker': 'records.loadTracker() / records.tracker',
  'src/core/task-manager': 'tasks.loadTaskManager()',
  'src/core/phase': 'tasks.loadPhase()',
  'src/core/config-manager': 'config.loadConfigManager()',
  'src/core/sessions/session-context': 'launch.loadSessionContext()',
  'src/core/sessions/launch-place': 'launch.loadLaunchPlace()',
  'src/core/sessions/task-dir-place': 'launch.loadTaskDirPlace()',
  'src/core/sessions/org-own-folder': 'launch.loadOrgOwnFolder()',
  'src/core/sessions/profiles': 'launch.loadProfiles()',
  'src/core/sessions/walnut-mcp-mount': 'launch.loadWalnutMcpMount()',
  'src/core/host-model-catalog': 'launch.loadHostModelCatalog()',
  'src/core/router/areas': 'launch.loadRouterAreas()',
  'src/core/frequent-dirs': 'launch.loadFrequentDirs()',
  'src/core/session-message-queue': 'messages.loadMessageQueue() / messages.queue',
  'src/core/hints/hint-send': 'messages.loadHintSend()',
  'src/core/sessions/session-record-recovery': 'recovery.loadRecordRecovery()',
  'src/core/sessions/session-stop': 'recovery.loadSessionStop()',
  'src/core/sessions/folder-gone': 'recovery.loadFolderGone()',
  'src/core/sessions/prompt-refresh': 'recovery.loadPromptRefresh()',
  'src/core/session-title-reconciler': 'recovery.loadTitleReconciler()',
  'src/core/session-hooks/builtins': 'recovery.loadHookBuiltins()',
}

/** Static names a class may still import from a banned module: pure helpers that read no data. */
const PURE_NAMES: Record<string, Set<string>> = {
  // An error predicate (instanceof plus a code check).
  'src/core/sessions/session-stop': new Set(['isSessionStopSuperseded']),
}

function codeLines(source: string): string {
  return source.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n')
}

function resolveSpec(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(js|ts)$/, '')
}

interface Finding { file: string; line: number; module: string; kind: 'static' | 'dynamic' }

function scan(file: string, source: string): Finding[] {
  const code = codeLines(source)
  const lineOf = (index: number) => code.slice(0, index).split('\n').length
  const out: Finding[] = []
  // Static imports and re-exports, multi-line ones included; all-type ones leave no code.
  const staticRe = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm
  for (const m of code.matchAll(staticRe)) {
    if (m[2]) continue
    const target = resolveSpec(file, m[4]!)
    if (!target || !(target in BANNED)) continue
    const names = (/\{([^}]*)\}/.exec(m[3]!)?.[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean)
    const valueNames = names.filter((n) => !n.startsWith('type '))
    const bare = m[3]!.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
    if (!bare && valueNames.length === 0) continue
    if (!bare && valueNames.every((n) => PURE_NAMES[target]?.has(n.split(/\s+as\s+/)[0]!))) continue
    out.push({ file, line: lineOf(m.index!), module: target, kind: 'static' })
  }
  // Dynamic import() that loads code: not `typeof import(...)`, not `import('...').SomeType`.
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of code.matchAll(dynamicRe)) {
    const before = code.slice(Math.max(0, m.index! - 12), m.index!)
    if (/typeof\s+$/.test(before)) continue
    const after = code.slice(m.index! + m[0].length)
    const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after)
    if (member && !['then', 'catch', 'finally'].includes(member[1]!)) continue
    const target = resolveSpec(file, m[1]!)
    if (!target || !(target in BANNED)) continue
    out.push({ file, line: lineOf(m.index!), module: target, kind: 'dynamic' })
  }
  return out
}

describe('session classes reach leader data only through the session port', () => {
  it('no session class file imports a leader-data module itself', () => {
    const findings = sessionClassFiles().flatMap((file) => scan(file, fs.readFileSync(path.join(ROOT, file), 'utf8')))
    const report = findings.map((f) =>
      `${f.file}:${f.line}: ${f.kind} import of ${f.module} -- call it through sessionPort().${BANNED[f.module]} (src/core/sessions/session-port.ts)`)
    expect(report).toEqual([])
  })

  it('the scan sees each kind of import it bans', () => {
    const sample = [
      "import { getTask } from '../core/task-manager.js'",
      "import {\n  getQueue,\n} from '../core/session-message-queue.js'",
      "const { getConfig } = await import('../core/config-manager.js')",
      "void import('../core/phase.js').then(({ applySessionPhase }) => applySessionPhase())",
      "import { isSessionStopSuperseded } from '../core/sessions/session-stop.js'",
      "import type { QueuedMessage } from '../core/session-message-queue.js'",
      "let x: typeof import('../core/config-manager.js').getConfig",
      "let y: import('../core/sessions/walnut-mcp-mount.js').WalnutMcpMountInput",
      "// await import('../core/session-tracker.js')",
    ].join('\n')
    expect(scan('src/providers/x.ts', sample).map((f) => `${f.kind} ${f.module}`)).toEqual([
      'static src/core/task-manager',
      'static src/core/session-message-queue',
      'dynamic src/core/config-manager',
      'dynamic src/core/phase',
    ])
  })

  it('every banned module still exists (a moved module needs its new path here)', () => {
    for (const module of Object.keys(BANNED)) expect(fs.existsSync(path.join(ROOT, `${module}.ts`)), module).toBe(true)
  })

  it("the leader's port has exactly the interface's members", () => {
    const keys = Object.entries(leaderSessionPort).flatMap(([group, members]) =>
      Object.keys(members as object).map((member) => `${group}.${member}`))
    expect(keys.sort()).toEqual([...SESSION_PORT_MEMBERS].sort())
    for (const key of SESSION_PORT_MEMBERS) {
      const [group, member] = key.split('.') as [keyof SessionPort, string]
      const value = (leaderSessionPort[group] as Record<string, unknown>)[member]
      expect(typeof value, key).toBe(member.startsWith('load') ? 'function' : 'object')
    }
  })

  it('installSessionPort swaps the port and null restores the leader', () => {
    expect(sessionPort()).toBe(leaderSessionPort)
    const other = { ...leaderSessionPort } as SessionPort
    installSessionPort(other)
    try {
      expect(sessionPort()).toBe(other)
    } finally {
      installSessionPort(null)
    }
    expect(sessionPort()).toBe(leaderSessionPort)
  })
})
