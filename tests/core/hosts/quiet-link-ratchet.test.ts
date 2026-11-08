/**
 * Quiet link ratchet: every place that takes a daemon link and sends on it says what keeps work
 * off a link that died out of sight. 2026-11-04: after a 6-minute sleep of the Mac, its link to a
 * host network machine stayed open on a path that was gone, and a host_exec sent on it 11 s after
 * the wake was lost. Two answers exist:
 *
 *   checks        asks a quiet link before the work goes (host_exec's dial(), hostLinkAnswers),
 *                 so nothing is sent on a link that stopped answering;
 *   wake-recheck  sends without asking: a link that died while this machine slept or changed
 *                 networks is found by the wake recheck (recheckQuietLinks) and the ping loop, and
 *                 the reason says why a send lost before that is acceptable there.
 *
 * Two more say why neither applies: `local` (only this machine's own daemon: a loopback socket
 * survives a sleep) and `no-send` (takes or warms a link and sends nothing on it).
 *
 * Counted over the TypeScript AST, per file: calls of `link()` (src/core/hosts/link.ts), of
 * `dial()` (src/core/hosts/host-exec.ts), and every use of the pool's lookups (LOOKUPS). A new call
 * fails here until its file is listed (or its count raised) with a kind and a reason that still
 * hold. Removing one? Lower the count: the list only shrinks.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(__dirname, '../../..')
const LINK_MODULE = 'src/core/hosts/link.ts'
const DIAL_MODULE = 'src/core/hosts/host-exec.ts'
/** The pool's ways to a connection (src/providers/daemon-connection.ts), dialling or not. */
const LOOKUPS = new Set([
  'getDaemonConnection', 'getDirectDaemonConnection', 'peekDaemonConnection',
  'getConnectedDaemonConnection', 'getPooledSnapshotConnection', 'listConnectedDaemonsByHost',
])

/** The transport and the link layer themselves: they hand links out, they send no work of their own. */
const EXEMPT = new Set(['src/providers/daemon-connection.ts', LINK_MODULE])

type Kind = 'checks' | 'wake-recheck' | 'local' | 'no-send'
const SENDERS: Record<string, { calls: number; kind: Kind; why: string }> = {
  // Asks a quiet link first.
  'src/core/hosts/host-exec.ts': { calls: 4, kind: 'checks', why: 'dial() itself: every run, read and list here follows its quiet check' },
  'src/core/hosts/host-exec-jobs.ts': { calls: 3, kind: 'checks', why: 'job reads and kills go through dial()' },
  'src/core/hosts/host-http.ts': { calls: 1, kind: 'checks', why: 'the request goes through dial()' },
  'src/core/hosts/host-mcp.ts': { calls: 3, kind: 'checks', why: 'every MCP list and call goes through dial()' },
  'src/core/session-service-preview.ts': { calls: 1, kind: 'checks', why: 'hostLinkAnswers asks the link before a port forward is opened on it' },
  'src/core/session-vscode-embed.ts': { calls: 1, kind: 'checks', why: 'hostLinkAnswers asks the link before code-server is set up on it' },

  // Sends without asking; the wake recheck and the ping loop find a dead link.
  'src/core/agents/host-engines.ts': { calls: 2, kind: 'wake-recheck', why: 'a read under its own 4 s deadline; a lost one answers from its cache' },
  'src/core/daemon-file-reader.ts': { calls: 21, kind: 'wake-recheck', why: 'file reads (bound by their routes, boundHostRead), writes, usage page reads and a resume\'s stream evidence reads (their own timeouts), whose loss fails to the caller or reads as not known' },
  'src/core/diagnostics/host-probes.ts': { calls: 4, kind: 'wake-recheck', why: 'doctor reads under the caller\'s deadline; a lost one is a warning line' },
  'src/core/hosts/fleet.ts': { calls: 3, kind: 'wake-recheck', why: 'vitals and facts reads with their own timeouts; a lost one keeps the last card' },
  'src/core/hosts/host-daemon-update.ts': { calls: 1, kind: 'wake-recheck', why: 'an update a session asks for; the updater times each of its steps' },
  'src/core/hosts/host-readiness.ts': { calls: 2, kind: 'wake-recheck', why: 'preflight and fixes on a connected link; a lost send fails as a transport error' },
  'src/core/hosts/named-paths.ts': { calls: 4, kind: 'wake-recheck', why: 'placement\'s file reads only on a link already open, under a 4 s deadline; a lost one reads as cannot be asked' },
  'src/core/hosts/placement.ts': { calls: 2, kind: 'wake-recheck', why: 'a load read under a 4 s deadline; a lost one means no load figure' },
  'src/core/human-inbox/item-status.ts': { calls: 1, kind: 'wake-recheck', why: 'a session state read under 1.5 s; a lost one answers unavailable' },
  'src/core/net/net-mac.ts': { calls: 5, kind: 'wake-recheck', why: 'best-effort host network config pushes and status reads; a lost push is logged' },
  'src/core/net/net-seen.ts': { calls: 2, kind: 'wake-recheck', why: 'status reads under 10 s; a lost one reads as no answer' },
  'src/core/offline-handover.ts': { calls: 1, kind: 'wake-recheck', why: 'a copy pushed after a drain, fire and forget; a lost one only delays it' },
  'src/core/remote-image-mirror.ts': { calls: 1, kind: 'wake-recheck', why: 'image reads under boundHostRead; a lost read answers degraded' },
  'src/core/routines/run-start-deps.ts': { calls: 4, kind: 'wake-recheck', why: 'cancels a start nobody confirmed; a lost cancel answers unknown and the retry goes on' },
  'src/core/routines/trigger-daemon.ts': { calls: 2, kind: 'wake-recheck', why: 'the link for trigger tests, claims and acks; a lost ack costs one replay' },
  'src/core/secrets/fleet-secrets.ts': { calls: 1, kind: 'wake-recheck', why: 'a lost put is kept as maybe there and sent again when the host next connects' },
  'src/core/session-changes.ts': { calls: 2, kind: 'wake-recheck', why: 'change reads; the routes bound them (boundHostRead)' },
  'src/core/session-commit.ts': { calls: 2, kind: 'wake-recheck', why: 'a commit job a person starts; a lost start fails the job where they see it' },
  'src/core/session-git-diff.ts': { calls: 1, kind: 'wake-recheck', why: 'a diff read; its routes bound it (boundHostRead)' },
  'src/core/session-git-status.ts': { calls: 2, kind: 'wake-recheck', why: 'a status read under 15 s; a lost one only errors the status pill' },
  'src/core/session-health-monitor.ts': { calls: 2, kind: 'wake-recheck', why: 'snapshot pulls with a timeout; the next tick pulls again' },
  'src/core/session-reconcile.ts': { calls: 2, kind: 'wake-recheck', why: 'state reads under 3 s, falling back to the local manager' },
  'src/core/session-vscode-uri.ts': { calls: 1, kind: 'wake-recheck', why: 'path reads under 5 s; a lost one falls back to the stored cwd' },
  'src/core/sessions/auto-recover-env.ts': { calls: 5, kind: 'wake-recheck', why: 'state reads on pooled links; the recovery queue tries again' },
  'src/core/sessions/ensure-cwd.ts': { calls: 1, kind: 'wake-recheck', why: 'an idempotent mkdir under boundHostRead; a lost one answers try again' },
  'src/core/sessions/external-session-import.ts': { calls: 12, kind: 'wake-recheck', why: 'a background scan; a lost read skips the host until a later round' },
  'src/core/sessions/owner-stop.ts': { calls: 2, kind: 'wake-recheck', why: 'an idempotent stop; a lost one answers unknown and the next sweep sends it again' },
  'src/core/sessions/replaced-session.ts': { calls: 2, kind: 'wake-recheck', why: 'a getState read of the replaced session under its own timeout; no answer reads as not known' },
  'src/core/sessions/session-extras.ts': { calls: 1, kind: 'wake-recheck', why: 'the folder picker\'s listing under boundHostRead; a lost read answers degraded' },
  'src/core/sessions/session-lifecycle.ts': { calls: 2, kind: 'wake-recheck', why: 'a recheck a person opens reads one snapshot; a lost one says it could not check' },
  'src/core/sessions/session-rewind.ts': { calls: 2, kind: 'wake-recheck', why: 'a rewind probe; a lost one reads as none and the caller reads its own copy' },
  'src/core/sessions/session-stop.ts': { calls: 1, kind: 'wake-recheck', why: 'a stop is stored and sent again, on a schedule and when the host reconnects' },
  'src/core/sessions/session-supervision.ts': { calls: 2, kind: 'wake-recheck', why: 'a lost set answers check again; a lost read serves the last known value' },
  'src/core/sessions/task-dir-place.ts': { calls: 5, kind: 'wake-recheck', why: 'an idempotent mkdir, under boundHostRead on another host' },
  'src/core/sessions/task-start.ts': { calls: 5, kind: 'wake-recheck', why: 'cancels a start nobody confirmed (a failure asks the caller to retry after the reconnect), and asks the pool whether a lost host\'s link is up before a move' },
  'src/core/task-dir-sweep.ts': { calls: 2, kind: 'wake-recheck', why: 'a six-hourly sweep the host checks dir by dir; a miss waits a round' },
  'src/core/transfer/daemon-transfer-client.ts': { calls: 2, kind: 'wake-recheck', why: 'a copy resumes from what the receiver has and retries each part' },
  'src/core/turn-snapshots/service.ts': { calls: 2, kind: 'wake-recheck', why: 'turn reads and a restore a person asks for; a lost one is a 504 they retry' },
  'src/core/turn-snapshots/settings-push.ts': { calls: 2, kind: 'wake-recheck', why: 'settings pushes, sent again on the next connect and on every change' },
  'src/core/usage/collection.ts': { calls: 1, kind: 'wake-recheck', why: 'a periodic usage scan; a lost one leaves the host unverified until the next pass' },
  'src/core/usage/session-budget.ts': { calls: 3, kind: 'wake-recheck', why: 'budget reads and sets; a lost set answers refresh first, a revision guards a resend' },
  'src/core/workspaces/daemon-client.ts': { calls: 2, kind: 'wake-recheck', why: 'workspace jobs a person starts; a lost one is a host-timeout they retry' },
  'src/providers/acp-session.ts': { calls: 2, kind: 'wake-recheck', why: 'ACP sends carry a command id the daemon dedupes; the journal is followed again after a reconnect' },
  'src/providers/cwd-check.ts': { calls: 1, kind: 'wake-recheck', why: 'a path probe under 5 s before a spawn, which goes on without an answer' },
  'src/providers/remote-session-manager.ts': { calls: 2, kind: 'wake-recheck', why: 'session start, send and stop; an unanswered send is asked again with dedupe, so it lands once' },
  'src/web/routes/files.ts': { calls: 1, kind: 'wake-recheck', why: 'file reads under boundHostRead; a lost read answers degraded' },
  'src/web/routes/media-v1.ts': { calls: 1, kind: 'wake-recheck', why: 'image reads under boundHostRead; a miss answers none' },
  'src/web/routes/replicas-status.ts': { calls: 2, kind: 'wake-recheck', why: 'a log tail read; a dead link answers 504 after 10 s' },
  'src/web/routes/slash-commands.ts': { calls: 1, kind: 'wake-recheck', why: 'command list reads under boundHostRead, with a stale cache on a miss' },

  // Only this machine's own daemon.
  'src/core/feature-nodes/feature-service.ts': { calls: 1, kind: 'local', why: 'feature request frames over loopback' },
  'src/core/hosts/host-fixture.ts': { calls: 2, kind: 'local', why: 'a test fixture daemon on a loopback URL' },
  'src/core/hosts/local-readiness.ts': { calls: 2, kind: 'local', why: 'this machine\'s own preflight and fixes' },
  'src/core/hosts/net-link.ts': { calls: 2, kind: 'local', why: 'walnut-net\'s forward and status, in this machine\'s daemon' },
  'src/core/projection-cache.ts': { calls: 4, kind: 'local', why: 'the phone feed relayed by this machine\'s daemon; a lost push is resent by its sweep' },
  'src/providers/engine-model-probe.ts': { calls: 1, kind: 'local', why: 'a model catalog read over loopback' },
  'src/providers/oneshot-client.ts': { calls: 2, kind: 'local', why: 'one-shot claude children run by this machine\'s daemon' },
  'src/web/routes/events-v1.ts': { calls: 4, kind: 'local', why: 'the phone feed relayed by this machine\'s daemon' },
  'src/web/routes/hosts-net.ts': { calls: 1, kind: 'local', why: 'walnut-net status, in this machine\'s daemon' },
  'src/web/routes/system.ts': { calls: 2, kind: 'local', why: 'the desktop app\'s status and restart' },

  // Sends nothing on the link it takes.
  'src/core/hosts/host-connect-action.ts': { calls: 2, kind: 'no-send', why: 'Connect now only dials (and wires the wake recheck)' },
  'src/core/sessions/engine-switch.ts': { calls: 3, kind: 'no-send', why: 'asks the pool whether the old host\'s link is up (a move from a host that is gone)' },
  'src/core/sessions/host-lost.ts': { calls: 3, kind: 'no-send', why: 'asks the pool whether a link is up, and dials one under its own deadline to see whether the host answers; no work rides it' },
  'src/core/plugin-jobs/index.ts': { calls: 2, kind: 'no-send', why: 'only dials: the job set rides the connect' },
  'src/core/routines/clock-placement.ts': { calls: 2, kind: 'no-send', why: 'asks the pool whether a link is up' },
  'src/core/session-snapshot-apply.ts': { calls: 2, kind: 'no-send', why: 'reads when a pooled link\'s daemon started' },
  'src/providers/claude-code-session.ts': { calls: 2, kind: 'no-send', why: 'reads a capability flag of a pooled link' },
  'src/web/local-daemon-lane.ts': { calls: 2, kind: 'no-send', why: 'keeps the loopback link dialled' },
  'src/web/server.ts': { calls: 1, kind: 'no-send', why: 'the host warmup dials to fill the pool' },
}

/** A file listed `checks` must hold the check it names. */
const CHECK_CALLS = /\b(dial|hostLinkAnswers|recheckQuiet)\(/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Link takings in `text` (the file at repo path `rel`): link(), dial() and the pool's lookups. */
function scan(rel: string, text: string): number {
  if (!/\blink\(|\bdial\(|Connection\b|DaemonsByHost/.test(text)) return 0
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const resolves = (spec: string, target: string) =>
    spec.startsWith('.') && path.posix.join(path.posix.dirname(rel), spec).replace(/\.js$/, '.ts') === target
  let linkModule = false
  let dialModule = rel === DIAL_MODULE
  const imports = (n: ts.Node): void => {
    const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)
      ? n.moduleSpecifier.text
      : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
        ? n.arguments[0].text : null
    if (spec !== null) {
      if (resolves(spec, LINK_MODULE)) linkModule = true
      if (resolves(spec, DIAL_MODULE)) dialModule = true
    }
    ts.forEachChild(n, imports)
  }
  imports(sf)
  let n = 0
  const visit = (node: ts.Node): void => {
    // Types never take a link: `ReturnType<typeof getDaemonConnection>` is fine.
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node) && LOOKUPS.has(node.text)) {
      const p = node.parent
      const declared = ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isFunctionDeclaration(p)
        || (ts.isPropertyAssignment(p) && p.name === node)
      if (!declared) n++
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
      if (name === 'link' && linkModule) n++
      if (name === 'dial' && dialModule && ts.isIdentifier(callee)) n++
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

describe('quiet link ratchet', () => {
  const found = new Map<string, number>()
  for (const abs of sourceFiles(path.join(repoRoot, 'src'))) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
    if (EXEMPT.has(rel)) continue
    const n = scan(rel, fs.readFileSync(abs, 'utf8'))
    if (n > 0) found.set(rel, n)
  }

  it('every place that takes a daemon link is listed with what keeps work off a link that died out of sight', () => {
    const unlisted = [...found].filter(([f, n]) => SENDERS[f]?.calls !== n)
      .map(([f, n]) => `${f}: ${n} link call(s), listed ${SENDERS[f]?.calls ?? 'nowhere'}`)
    expect(unlisted, 'A new call that takes a daemon link: send work through dial() (src/core/hosts/host-exec.ts) '
      + 'or ask hostLinkAnswers first, or list the file in SENDERS with kind wake-recheck and why a send lost '
      + 'on a dead link before the wake recheck finds it is acceptable there.').toEqual([])
  })

  it('every listed file still takes a link (the list only shrinks)', () => {
    expect(Object.keys(SENDERS).filter((f) => !found.has(f)), 'Take these off SENDERS.').toEqual([])
  })

  it('a file listed as checking holds its check', () => {
    const missing = Object.entries(SENDERS).filter(([f, e]) => e.kind === 'checks'
      && !CHECK_CALLS.test(fs.readFileSync(path.join(repoRoot, f), 'utf8'))).map(([f]) => f)
    expect(missing).toEqual([])
  })

  it('sees link(), dial() and the lookups when they are there, and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-link-ratchet-'))
    try {
      const text = [
        "import { link } from './link.js'",
        "import { dial } from './host-exec.js'",
        "import { getConnectedDaemonConnection } from '../../providers/daemon-connection.js'",
        '// link(host) and dial(host) in a comment never count',
        "const s = 'getDaemonConnection(host, t)'",
        'await link(host)',
        "await (await import('./link.js')).link(host)",
        'await dial(host, 5_000)',
        'getConnectedDaemonConnection(host)?.send("exec.run", {})',
        'getPooledSnapshotConnection(host)',
        'const pick = dc.listConnectedDaemonsByHost',
        'type C = ReturnType<typeof getConnectedDaemonConnection>',
        'w.dial(x)',
      ].join('\n')
      fs.writeFileSync(path.join(dir, 'probe.ts'), text)
      expect(scan('src/core/hosts/probe.ts', text)).toBe(6)
      // The same calls in a file that imports neither module: only the lookups count.
      expect(scan('src/core/other/probe.ts', text.replace(/'\.\/(link|host-exec)\.js'/g, "'./elsewhere.js'"))).toBe(3)
      // A file that holds only a lookup is still read.
      expect(scan('src/core/other/probe.ts', 'getPooledSnapshotConnection(host)')).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
