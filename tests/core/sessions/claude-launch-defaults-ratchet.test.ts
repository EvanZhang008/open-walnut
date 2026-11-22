/**
 * Ratchet: every Claude Code spawn takes its model and effort through ONE rule
 * (src/core/sessions/claude-launch-defaults.ts), so a default the user sets in Settings > Sessions
 * reaches every way a session starts: a new task, task_start, a restart, a compaction's respawn, a
 * resume, an engine switch, a start a host makes while the Mac is away.
 *
 * It fails when a NEW way in appears that does not go through the rule:
 *   1. a source file that puts `--effort` on a CLI command line, other than the known ones;
 *   2. a spawn in the session runner (a `.send(` with a model argument) whose model or effort is
 *      not the value resolveResumeArgs or resolveClaudeSpawnDefaults returned in its function;
 *   3. a read of the default effort's older key (`agent.session_effort`) outside the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SRC = path.join(ROOT, 'src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')

/** Files that put `--effort` on a command line, and where their effort comes from. */
const EFFORT_SPAWNERS: Record<string, string> = {
  'src/providers/claude-code-session.ts': 'send(): its callers resolve through the rule (checked below)',
  'src/providers/host-start-core.ts': 'a start a host makes itself; its spec comes from freshClaudeStart / offline-run, both through the rule',
  'src/providers/micro-claude-warm.ts': 'Walnut\'s own small background jobs (titles, parses), with an explicit effort; no task session',
  'src/providers/inline-subagent.ts': 'a subagent run inside a turn, with the effort its caller names; no task session',
}

describe('every Claude Code spawn resolves its model and effort through claude-launch-defaults', () => {
  const files = sourceFiles(SRC)

  it('no new file puts --effort on a command line', () => {
    const found = files.filter((f) => /['"]--effort['"]\s*,\s*[A-Za-z_$]/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
    expect(found, 'a new spawner: resolve its effort through claude-launch-defaults.ts, then name it here').toEqual(Object.keys(EFFORT_SPAWNERS).sort())
  })

  it('every spawn in the session runner takes its model and effort from the rule', () => {
    const file = path.join(SRC, 'providers/claude-code-session.ts')
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const RESOLVERS = new Set(['resolveResumeArgs', 'resolveClaudeSpawnDefaults'])
    const enclosingBody = (node: ts.Node): ts.Node | undefined => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) return n
      }
      return undefined
    }
    const calleeName = (call: ts.CallExpression): string | undefined => {
      const e = call.expression
      return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined
    }
    /** The initializer `name` is declared with in `scope` (a plain or a destructured const/let). */
    const initializerOf = (name: string, scope: ts.Node): ts.Expression | undefined => {
      let found: ts.Expression | undefined
      const walk = (n: ts.Node) => {
        if (found) return
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const names: string[] = []
          const collect = (b: ts.BindingName) => {
            if (ts.isIdentifier(b)) names.push(b.text)
            else for (const el of b.elements) if (ts.isBindingElement(el)) collect(el.name)
          }
          collect(n.name)
          if (names.includes(name)) { found = n.initializer; return }
        }
        ts.forEachChild(n, walk)
      }
      walk(scope)
      return found
    }
    /** True when the value `expr` names comes from a resolver call in `scope` (through awaits and `.x` reads). */
    const fromResolver = (expr: ts.Expression, scope: ts.Node, depth = 0): boolean => {
      if (depth > 6) return false
      let e: ts.Expression = expr
      while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
      if (ts.isCallExpression(e)) return RESOLVERS.has(calleeName(e) ?? '')
      if (ts.isPropertyAccessExpression(e)) return fromResolver(e.expression, scope, depth + 1)
      if (ts.isIdentifier(e)) {
        const init = initializerOf(e.text, scope)
        if (!init) return false
        // A destructured binding reads the call itself; `x = a.b` reads `a`.
        return fromResolver(init, scope, depth + 1)
      }
      return false
    }
    const spawns: Array<{ line: number; ok: boolean }> = []
    const visit = (node: ts.Node) => {
      // A spawn: `<session>.send(message, cwd, resume, mode, model, prompt, host, ssh, fork, permissionPrompt, spill, partial, effort, …)`.
      // Five arguments already name a model, so a shorter new spawn is caught too.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'send' && node.arguments.length >= 5) {
        const scope = enclosingBody(node)
        const model = node.arguments[4]
        const effort = node.arguments[12]
        const ok = !!scope && !!effort && fromResolver(model, scope) && fromResolver(effort, scope)
        spawns.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, ok })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(spawns.length, 'the runner\'s spawns were not found: the check no longer sees them').toBeGreaterThanOrEqual(4)
    expect(spawns.filter((s) => !s.ok).map((s) => `claude-code-session.ts:${s.line} passes a model or effort that is not the rule's`)).toEqual([])
    // The two places the rule is applied: a fresh start and a resume (calls, not comments).
    let resolverCalls = 0
    const count = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'resolveClaudeSpawnDefaults') resolverCalls++
      ts.forEachChild(n, count)
    }
    count(sf)
    expect(resolverCalls).toBe(2)
    expect(sf.getFullText()).not.toMatch(/\.session_effort\b/)
  })

  it('the SDK start names no model or effort (a known gap: it runs on Claude Code\'s own settings)', () => {
    // handleStartSdk -> sdkClient.startSession passes neither, a pick at create included. When it
    // starts passing them, they must come from the rule: update this check then.
    const text = fs.readFileSync(path.join(SRC, 'providers/claude-code-session.ts'), 'utf8')
    const call = /sdkClient\.startSession\(([^)]*)\)/.exec(text)?.[1] ?? ''
    expect(call).not.toMatch(/\b(model|effort)\b/)
  })

  it('the older default-effort key is read only by the rule (and the Ask Walnut lane, which keeps its own level)', () => {
    const allowed = new Set([
      'src/core/sessions/claude-launch-defaults.ts',
      // Ask Walnut's chat lane: its own first-run level (medium) unless agent.session_effort is set.
      'src/core/sessions/personal-ai-lane.ts',
      // Comments naming the key, and the console's read-only config echo.
      'src/core/sessions/ask-walnut-launch.ts',
      'src/core/replication/kinds/personas.ts',
      'src/web/routes/console-v1.ts',
    ])
    const readers = files.filter((f) => /\.session_effort\b/.test(fs.readFileSync(f, 'utf8'))).map(rel)
    expect(readers.filter((f) => !allowed.has(f))).toEqual([])
  })
})
