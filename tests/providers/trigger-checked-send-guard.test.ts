/**
 * Guard: a daemon's check report is never dropped on the floor. `sendTriggerEvent` returns whether
 * any server of the trigger's Walnut took the event; a `trigger.checked` send that ignores it loses
 * the check when no server is there (2026-11-25: a clouddev trigger's checks from 05:09 to 08:40Z
 * while the Mac slept, a four-hour hole in its record). `reportCheck` (daemon-trigger-runs.ts) is
 * the one send path: it keeps a check no server took for the next configure
 * (trigger-unsent-checks.ts). Any other `trigger.checked` send in src/providers/daemon-trigger-*.ts
 * must use the return value (or, better, go through reportCheck).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, 'src/providers')
/** The function allowed to send without reading every return: it reads the one that decides. */
const ALLOWED_FN = 'reportCheck'

interface Send { line: number; fn: string | undefined; ignored: boolean }

function nameOf(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText()
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText()
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText()
  return undefined
}

/** The innermost named function around `node`. */
function enclosingFn(node: ts.Node): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const name = nameOf(n)
      if (name) return name
    }
  }
  return undefined
}

/** Whether the call's value goes nowhere: a statement of its own, `void`, or the left of a comma. */
function valueIgnored(call: ts.CallExpression): boolean {
  let n: ts.Node = call
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent
  const p = n.parent
  if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) return true
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.left === n) return true
  return false
}

/** Every `sendTriggerEvent(_, 'trigger.checked', ...)` in `source`. */
function checkedSends(source: string, file = 'x.ts'): Send[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Send[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sendTriggerEvent') {
      const ev = node.arguments[1]
      if (ev && ts.isStringLiteralLike(ev) && ev.text === 'trigger.checked') {
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, fn: enclosingFn(node), ignored: valueIgnored(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** The sends that would drop a check: their value ignored, outside reportCheck. */
function droppingSends(source: string, file = 'x.ts'): Send[] {
  return checkedSends(source, file).filter((s) => s.ignored && s.fn !== ALLOWED_FN)
}

const files = fs.readdirSync(DIR).filter((f) => /^daemon-trigger-.*\.ts$/.test(f)).map((f) => path.join(DIR, f))

describe('every trigger.checked send reads whether a server took it', () => {
  it('finds the daemon trigger files and the sends in reportCheck (the scan still sees them)', () => {
    expect(files.map((f) => path.basename(f))).toContain('daemon-trigger-runs.ts')
    const runs = checkedSends(fs.readFileSync(path.join(DIR, 'daemon-trigger-runs.ts'), 'utf8'))
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.filter((s) => s.fn === ALLOWED_FN && !s.ignored).length, 'reportCheck reads the return of the send that decides').toBeGreaterThan(0)
  })

  it('no send in src/providers/daemon-trigger-*.ts ignores its return outside reportCheck', () => {
    const bad = files.flatMap((f) => droppingSends(fs.readFileSync(f, 'utf8'), f).map((s) => `${path.relative(ROOT, f)}:${s.line} (in ${s.fn ?? 'top level'})`))
    expect(bad, 'send the check through reportCheck (daemon-trigger-runs.ts), which keeps one no server took').toEqual([])
  })

  it('the scan flags a send that drops its result (synthetic samples)', () => {
    const sample = [
      "function runTrigger(entry) {",
      "  sendTriggerEvent(entry.home, 'trigger.checked', { ...entry.state.lastCheck })",
      "}",
      "const replayAll = (entry) => { void sendTriggerEvent(entry.home, \"trigger.checked\", {}) }",
      "function both(entry) { (sendTriggerEvent(entry.home, `trigger.checked`, {})), keep() }",
      "function inLoop(list) { for (const c of list) sendTriggerEvent(c.home, 'trigger.checked', c) }",
    ].join('\n')
    expect(droppingSends(sample).map((s) => [s.line, s.fn])).toEqual([
      [2, 'runTrigger'], [4, 'replayAll'], [5, 'both'], [6, 'inLoop'],
    ])
  })

  it('the scan passes a send whose result is read, one in reportCheck, and other events', () => {
    const sample = [
      "function a(e) { if (!sendTriggerEvent(e.home, 'trigger.checked', {})) keepUnsentCheck(e.state, e.state.lastCheck) }",
      "function b(e) { const took = sendTriggerEvent(e.home, 'trigger.checked', {}); return took }",
      "function c(e) { return sendTriggerEvent(e.home, 'trigger.checked', {}) || keep() }",
      "function reportCheck(e) { for (const k of e.kept) sendTriggerEvent(e.home, 'trigger.checked', k) }",
      "function d(e) { sendTriggerEvent(e.home, 'trigger.fired', {}) }",
      "function f(e) { other.sendTriggerEvent(e.home, 'trigger.checked', {}) }",
    ].join('\n')
    expect(checkedSends(sample).length).toBe(4)
    expect(droppingSends(sample)).toEqual([])
  })
})
