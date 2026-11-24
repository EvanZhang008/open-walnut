/** Execute the real daemon control reducers, with only their IO supplied by the replay.
 * No third copy of permission tracking: a changed/removed daemon branch fails extraction.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { daemonRuntimeText } from './daemon-runtime-text.js'

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

// The whole runtime (daemon-standalone.ts and its area modules): the inbound branch lives in
// whichever module holds the session tailer now (daemon-session-tailer.ts since the split).
const standalone = daemonRuntimeText()
const inbound = new Function('parsed', 's', 'persistRegistry', 'shouldAutoRespond', 'hookActions', 'logMsg', 'sid',
  `for (let replayLine = 0; replayLine < 1; replayLine++) { ${branch(standalone, text => text.startsWith("if (parsed.type === 'control_request'") && text.includes('control_cancel_request') && text.includes('s.pendingCtrl'))} }`)
const core = fs.readFileSync(path.join(import.meta.dirname, '../../src/providers/daemon-core.ts'), 'utf8')
const outbound = new Function('session', 'raw', 'persistRegistry', 'logger', 'sid', 'pushSnapshotFn',
  branch(core, text => text.startsWith('if (session.pendingCtrl)') && text.includes('sendRaw cleared pending control_response')))

export function replayControlTracker() {
  const session = { pendingCtrl: null as ReplayControl | null }
  const noop = () => {}
  return {
    inbound(event: Record<string, unknown>) {
      inbound(event, session, noop, () => false, () => [], noop, 'replay')
    },
    delivered(raw: string) {
      outbound(session, raw, noop, noop, 'replay', null)
    },
    pending() {
      const ctrl = session.pendingCtrl
      return ctrl ? { requestId: ctrl.reqId, toolName: ctrl.toolName } : null
    },
  }
}
