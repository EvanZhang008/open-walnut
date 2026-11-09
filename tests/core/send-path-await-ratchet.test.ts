/**
 * Send-path await ratchet: nothing before SESSION_SEND waits on a host, the
 * daemon, the network or a model.
 *
 * 2026-11-09, the user: messages must send instantly; Walnut's own share of a send
 * must be near zero. Production logs that day put it at 12 ms p50 from the RPC to
 * the row being stored. Everything sendMessageToSession (src/core/session-message-queue.ts)
 * awaits before it emits SESSION_SEND is on that path for EVERY send (a person's, a
 * task's, a trigger's), so one awaited host read there, a model call, a lock held
 * across the network, turns every send into a wait. tests/e2e/send-budget.test.ts
 * measures the path; this test keeps its shape, so a new slow step is caught at
 * review time, before it ever runs.
 *
 * Read from the TypeScript AST of the function, up to the statement that emits
 * SESSION_SEND, and of every same-file function it calls there (followed through):
 *  - every module it loads with `import('./x')` (awaited or fire-and-forget), and
 *  - every call it awaits (`await f(...)`, by the callee's text).
 * Both lists must match the allowlists below exactly: a new entry fails until it is
 * listed with a one-line reason that says why it never leaves this machine (local
 * store, in-memory state, file on this machine); an entry gone from the code fails
 * until its line is removed, so the lists stay today's truth.
 *
 * Adding one? Make sure it reads only this machine's own data with a bounded cost.
 * Anything that reaches a host, the daemon, the network or a model belongs after
 * the emit (the runner's drain), fire-and-forget, or on a cached value.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const FILE = path.resolve(__dirname, '../../src/core/session-message-queue.ts')
const ENTRY = 'sendMessageToSession'

/** Modules loaded with import() on the path to SESSION_SEND, each with why it stays local. */
const ALLOWED_MODULES: Record<string, string> = {
  './event-bus.js': 'the in-process bus itself',
  './sessions/engine-switch.js': 'active session for a switched task: in-memory switch state and the local session store (waits only while a switch of this task runs)',
  './session-tracker.js': 'session record from the local sessions store',
  './router/delivery-scope.js': 'pure check of the router wake grant on the record',
  './org/org-enabled.js': 'org switch from the cached local config',
  './task-manager.js': 'task from the local task store (only while the org is off)',
  './sessions/engine-switch-io.js': 'move-held reason constant and the switch context kept in the local store',
  './sessions/queue-after-turn.js': 'after-turn hold: the runner\'s in-memory turn state',
  './sessions/place-notice.js': 'place note from the local task and session records',
  './sessions/restart-notice.js': 'restart note from the local session record',
  './sessions/folder-gone.js': 'folder-moved note from the local session record',
  './org/lead-traffic.js': 'stamps the message in a local in-memory/disk ledger',
  './org/org-store.js': 'main agent digest from the local org store',
  './sessions/status-push.js': 'status lines kept in memory and the local riding store',
  './hints/hint-send.js': 'message hints composed from the local registry and session record',
  './sessions/app-state.js': 'plugin App state kept in memory on this server',
  './task-wait-resume.js': 'wait note from the local task record and its trigger list',
  './org/retired-lead.js': 'retired lead note from the local org store',
  './sessions/held-notices.js': 'held notices kept in memory on this server',
  './org/team-asks.js': 'fire and forget (void ... .then), never awaited before the emit',
  './sessions/personal-ai-lane.js': 'Ask Walnut persona drift repair: one indexed local record read, TTL-bounded rebuild from local config',
  './human-inbox/item-execution.js': 'inbox item boundary check against the local inbox store (inbox item sends only)',
  './sessions/session-stop.js': 'stop fence read from the local session record',
}

/** Calls awaited on the path to SESSION_SEND, each with why it stays local. */
const ALLOWED_AWAITS: Record<string, string> = {
  'import': 'the module loads listed in ALLOWED_MODULES',
  'activeSessionFor': 'engine-switch.ts: in-memory switch state plus the local session store; waits only while a switch of this task runs',
  'getSessionByClaudeId': 'session-tracker.ts: local sessions store',
  'refuseOrgDeliveryWhileOff': 'this file: cached org switch, local stores only while the org is off',
  'isOrgEnabled': 'org-enabled.ts: local config read (only on a cache miss)',
  'getTask': 'task-manager.ts: local task store',
  'holdsForRunningTurn': 'queue-after-turn.ts: the runner\'s in-memory turn state',
  'pendingPlaceNotice': 'place-notice.ts: local task and session records',
  'pendingRestartNotice': 'restart-notice.ts: local session record',
  'pendingFolderMovedNotice': 'folder-gone.ts: local session record',
  'pendingSwitchContext': 'engine-switch-io.ts: local store',
  'noteQueuedMessage': 'lead-traffic.ts: local ledger write',
  'pendingOrgDigest': 'org-store.ts: local org store',
  'pendingAppState': 'app-state.ts: in-memory App state',
  'waitNoteFor': 'task-wait-resume.ts: local task record and trigger list (only for a waiting task)',
  'pendingRetiredLeadNote': 'retired-lead.ts: local org store',
  'pendingHeldNotices': 'held-notices.ts: in-memory notices',
  'prepareQueuedHintedSend': 'hint-send.ts: local hint registry and session record',
  'enqueueMessage': 'this file: the local queue store write',
  'validateInboxMessageBoundary': 'item-execution.ts: local inbox store (inbox item sends only)',
  'sessionStops.fence': 'session-stop.ts: the stop request on the local session record',
  'settledLineUuid': 'session-queue-lines.ts: local queue store',
  'mutateStore': 'session-queue-store.ts: the local queue file under its lock',
  'place.markTold': 'place-notice.ts: local session record write',
  'digest.markTold': 'org-store.ts: local org store write',
  'restart.markTold': 'restart-notice.ts: local session record write',
  'folderMoved.markTold': 'folder-gone.ts: local session record write',
  'switchContext.markTold': 'engine-switch-io.ts: local store write',
  'outputMode.commit': 'hint-send.ts: records the hints told in the local session record',
  'refreshWalnutSessionProfile': 'personal-ai-lane.ts: one indexed local record read, TTL-bounded rebuild from local config',
}

interface Found { modules: Map<string, string[]>; awaits: Map<string, string[]> }

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isSessionSendEmit(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && /\bbus\.emit$/.test(node.expression.getText())
    && node.arguments[0]?.getText() === 'EventNames.SESSION_SEND'
}

/** The source up to SESSION_SEND, and the same-file functions it calls, read as above. */
function readSendPath(): Found {
  const src = fs.readFileSync(FILE, 'utf8')
  const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const localFns = new Map<string, ts.FunctionDeclaration>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) localFns.set(st.name.text, st)
  }
  const entry = localFns.get(ENTRY)
  if (!entry?.body) throw new Error(`${ENTRY} not found in ${FILE}`)

  let emitAt = -1
  const findEmit = (n: ts.Node): void => {
    if (emitAt < 0 && isSessionSendEmit(n)) emitAt = n.getStart(sf)
    else ts.forEachChild(n, findEmit)
  }
  findEmit(entry.body)
  if (emitAt < 0) throw new Error(`${ENTRY} no longer emits EventNames.SESSION_SEND: update this ratchet`)

  const found: Found = { modules: new Map(), awaits: new Map() }
  const add = (m: Map<string, string[]>, key: string, where: string) => m.set(key, [...(m.get(key) ?? []), where])
  const visited = new Set<string>()

  const scan = (body: ts.Node, fnName: string, limit: number): void => {
    const visit = (n: ts.Node): void => {
      if (n.getStart(sf) >= limit) return
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = n.arguments[0]
        add(found.modules, spec && ts.isStringLiteralLike(spec) ? spec.text : `<computed: ${spec?.getText()}>`, `${fnName}:${lineOf(sf, n)}`)
      }
      if (ts.isAwaitExpression(n)) {
        let inner: ts.Expression = n.expression
        while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression
        // `await f(...).catch(...)` / `.then(...)` is the call to f.
        while (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
          && ['catch', 'then', 'finally'].includes(inner.expression.name.text)
          && ts.isCallExpression(inner.expression.expression)) inner = inner.expression.expression
        const callee = ts.isCallExpression(inner)
          ? (inner.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : inner.expression.getText().replace(/\?\./g, '.'))
          : `<not a call: ${inner.getText().slice(0, 60)}>`
        add(found.awaits, callee, `${fnName}:${lineOf(sf, n)}`)
      }
      // A same-file function called on the path is on the path too, all of it.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const fn = localFns.get(n.expression.text)
        if (fn?.body && !visited.has(fn.name!.text)) {
          visited.add(fn.name!.text)
          scan(fn.body, fn.name!.text, Number.POSITIVE_INFINITY)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(body)
  }
  visited.add(ENTRY)
  scan(entry.body, ENTRY, emitAt)
  return found
}

function diff(found: Map<string, string[]>, allowed: Record<string, string>, what: string): string[] {
  const problems: string[] = []
  for (const [key, where] of found) {
    if (!(key in allowed)) {
      problems.push(`NEW ${what} before SESSION_SEND: ${key} (at ${where.join(', ')}). Every send now waits on it. `
        + `If it never leaves this machine, list it with a one-line reason; if it reaches a host, the daemon, the network or a model, move it after the emit.`)
    }
  }
  for (const key of Object.keys(allowed)) {
    if (!found.has(key)) problems.push(`${what} ${key} is no longer on the path: remove its allowlist line`)
  }
  return problems
}

describe('the send path awaits nothing remote before SESSION_SEND', () => {
  const found = readSendPath()

  it('loads only the listed modules before the emit', () => {
    expect(diff(found.modules, ALLOWED_MODULES, 'module import')).toEqual([])
  })

  it('awaits only the listed calls before the emit', () => {
    expect(diff(found.awaits, ALLOWED_AWAITS, 'awaited call')).toEqual([])
  })

  it('every allowlist line gives its reason', () => {
    for (const [k, why] of [...Object.entries(ALLOWED_MODULES), ...Object.entries(ALLOWED_AWAITS)]) {
      expect(why.trim().length, `allowlist entry ${k} needs a reason`).toBeGreaterThan(10)
    }
  })
})
