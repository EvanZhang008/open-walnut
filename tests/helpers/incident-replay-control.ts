/** Execute the real daemon control reducers, with only their IO supplied by the replay.
 * No third copy of permission tracking: a changed/removed daemon branch fails extraction.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

export interface ReplayControl { reqId: string; toolName?: string; request?: Record<string, unknown>; receivedAt?: number }

function branch(source: string, matches: (text: string) => boolean): string {
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  let found: string | undefined
  function visit(node: ts.Node): void {
    if (found) return
    if (ts.isIfStatement(node)) {
      const text = node.getText(ast)
      if (matches(text)) { found = text; return }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!found) throw new Error('Replay could not locate the production daemon control branch')
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

const standalone = fs.readFileSync(path.join(import.meta.dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
const sources = [standalone, getDaemonSource()]
const inbound = sources.map(source => new Function('parsed', 's', 'persistRegistry', 'shouldAutoRespond', 'hookActions', 'logMsg', 'sid',
  `for (let replayLine = 0; replayLine < 1; replayLine++) { ${branch(source, text => text.startsWith("if (parsed.type === 'control_request'") && text.includes('control_cancel_request') && text.includes('s.pendingCtrl'))} }`))
const core = fs.readFileSync(path.join(import.meta.dirname, '../../src/providers/daemon-core.ts'), 'utf8')
const outbound = new Function('session', 'raw', 'persistRegistry', 'logger', 'sid', 'pushSnapshotFn',
  branch(core, text => text.startsWith('if (session.pendingCtrl)') && text.includes('sendRaw cleared pending control_response')))

export function replayControlTracker() {
  const twins = [{ pendingCtrl: null as ReplayControl | null }, { pendingCtrl: null as ReplayControl | null }]
  const noop = () => {}
  return {
    inbound(event: Record<string, unknown>) {
      for (let i = 0; i < twins.length; i++) inbound[i](event, twins[i], noop, () => false, () => [], noop, 'replay')
      if (JSON.stringify(twins[0].pendingCtrl?.reqId) !== JSON.stringify(twins[1].pendingCtrl?.reqId)) throw new Error('Daemon control twins disagreed')
    },
    delivered(raw: string) {
      for (const twin of twins) outbound(twin, raw, noop, noop, 'replay', null)
    },
    pending() {
      const ctrl = twins[0].pendingCtrl
      return ctrl ? { requestId: ctrl.reqId, toolName: ctrl.toolName } : null
    },
  }
}
