/**
 * Guard: a daemon's check report is never dropped on the floor. A report on the wire is not a report
 * read: it is kept in the trigger's file until a socket it went on answers a later ping
 * (trigger-unsent-checks.ts settleChecksOnWire), and `sendCheck` (daemon-trigger-store.ts) is what
 * marks it so. Every `trigger.checked` send in src/providers/daemon-trigger-*.ts goes through
 * sendCheck (reportCheck in daemon-trigger-runs.ts and the configure replay both do).
 *
 * 2026-11-25: a clouddev trigger's checks from 05:09 to 08:40Z were dropped while the Mac slept (no
 * server took them). Then 18:12 to 19:25Z, with the Mac's lid shut, checks sent into a socket left
 * open but silent after a dark wake, and the configure replay of 19:22:07 ten seconds before the Mac
 * slept again, were all lost: each was counted as taken because the send itself succeeded.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, 'src/providers')
/** The one function a check report may go on the wire from: the one that marks it. */
const ALLOWED_FNS = new Set(['sendCheck'])
const SENDERS = new Set(['sendTriggerEvent', 'sendTriggerEventTo', 'sendEvent'])

interface Send { line: number; fn: string | undefined }

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

/** Every send of a `trigger.checked` event in `source`, by any of the runtime's send functions. */
function checkedSends(source: string, file = 'x.ts'): Send[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Send[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SENDERS.has(node.expression.text)) {
      if (node.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === 'trigger.checked')) {
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, fn: enclosingFn(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** The sends that would lose a check: outside sendCheck. */
function droppingSends(source: string, file = 'x.ts'): Send[] {
  return checkedSends(source, file).filter((s) => !ALLOWED_FNS.has(s.fn ?? ''))
}

const files = fs.readdirSync(DIR).filter((f) => /^daemon-trigger-.*\.ts$/.test(f)).map((f) => path.join(DIR, f))

describe('every trigger.checked send is kept until a server read it', () => {
  it('finds the daemon trigger files and the send in sendCheck (the scan still sees it)', () => {
    expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['daemon-trigger-runs.ts', 'daemon-trigger-store.ts', 'daemon-trigger-set.ts']))
    const store = checkedSends(fs.readFileSync(path.join(DIR, 'daemon-trigger-store.ts'), 'utf8'))
    expect(store.filter((s) => s.fn === 'sendCheck').length).toBeGreaterThan(0)
  })

  it('no trigger.checked send in src/providers/daemon-trigger-*.ts goes around sendCheck', () => {
    const bad = files.flatMap((f) => droppingSends(fs.readFileSync(f, 'utf8'), f).map((s) => `${path.relative(ROOT, f)}:${s.line} (in ${s.fn ?? 'top level'})`))
    expect(bad, 'send a check report with sendCheck (daemon-trigger-store.ts), which keeps it until a server read it').toEqual([])
  })

  it('the scan flags a send around sendCheck (synthetic samples)', () => {
    const sample = [
      "function runTrigger(entry) {",
      "  sendTriggerEvent(entry.home, 'trigger.checked', { ...entry.state.lastCheck })",
      "}",
      "const replayAll = (entry) => { void sendTriggerEvent(entry.home, \"trigger.checked\", {}) }",
      "function configure(ws, c) { sendEvent(ws, `trigger.checked`, { ...c, replay: true }) }",
      "function a(e) { if (!sendTriggerEvent(e.home, 'trigger.checked', {})) keepUnsentCheck(e.state, e.state.lastCheck) }",
      "function sendCheck(e, f) { return sendTriggerEventTo(e.home, 'trigger.checked', f) }",
      "function reportCheck(e) { for (const k of e.kept) sendTriggerEvent(e.home, 'trigger.checked', k) }",
      "function d(e) { sendTriggerEvent(e.home, 'trigger.fired', {}) }",
      "function f(e) { other.sendTriggerEvent(e.home, 'trigger.checked', {}) }",
    ].join('\n')
    expect(checkedSends(sample).length).toBe(6)
    expect(droppingSends(sample).map((s) => s.fn)).toEqual(['runTrigger', 'replayAll', 'configure', 'a', 'reportCheck'])
  })
})
