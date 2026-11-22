/**
 * Link ratchet: a feature reaches another host through `link(host)`
 * (src/core/hosts/link.ts), never by building an SSH target and dialling, and
 * never by running ssh itself. The user, 2026-10-31: "each connection is an
 * abstraction ... SSH direct, or via the companion ... as long as they connect".
 * Before the link layer ~25 call sites built their own `{hostname, user, port}`,
 * some without `shell_setup`, and the pool kept whichever target dialled first.
 *
 * Five tiers, all over the TypeScript AST (comments and strings never count):
 *  1. `getDaemonConnection`: only the transports below may call it or take it as
 *     a value (`dependencies.connect ?? getDaemonConnection` is a dial too).
 *  2. `spawn('ssh', ...)` (child_process or pty): only the SSH transports below.
 *  3. Importing `remote-sh.js` (ssh one-shots): only the files below, which are
 *     the SSH transport's own bootstrap (deploy, daemon dir, control master).
 *  4. `ssh` or `scp` handed to a process by any route: the first argument of any
 *     call (`execFile('ssh', ...)`, `run('scp', ...)`, `spawn(opts.bin ?? 'ssh')`),
 *     a constant holding it (`const SSH = 'ssh'`), the value of a `command` / `cmd`
 *     / `bin` / `file` / `program` field, parameter default or assignment, the
 *     first word of an argv array (`['ssh', host]`, `['/usr/bin/env', 'ssh']` too),
 *     or a shell line given to a call that starts with it (`` exec(`ssh ${h} true`) ``,
 *     `spawn('sh', ['-c', 'ssh ...'])`). 2026-11-16: plugin hosts.run returned
 *     `{ command: 'ssh', argv }` and spawned that, which tier 2 never saw, and every
 *     run to a host on the host network (no SSH route) failed.
 *  5. Sending `exec.run` or `exec.script` (a command on a host) yourself: a command
 *     on another host goes through host_exec (host-exec.ts) or, for a plugin's
 *     script, host-script.ts; both dial with link().
 *
 * A new site fails with instructions. Removing one? Take it off the list: the
 * ratchet only tightens. A new route (the companion relay) goes inside link.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(__dirname, '../../..')

/** Files that may call getDaemonConnection, and why. */
const DIAL_ALLOWED: Record<string, string> = {
  'src/core/hosts/link.ts': 'the link layer',
  'src/web/local-daemon-lane.ts': 'the local lane, an injected pool over loopback only',
  'src/core/hosts/host-connect-action.ts': 'a person\'s Connect now starts the dial before it answers, with linkTarget\'s target',
}

/** Files that may spawn ssh, and why. */
const SSH_SPAWN_ALLOWED: Record<string, string> = {
  'src/providers/daemon-connection.ts': 'the SSH route: the tunnel and its probes',
  'src/providers/stream-lane.ts': 'the SSH route: the stream lane beside the tunnel',
  'src/web/terminal/spawn.ts': 'the terminal\'s pty for a host with an SSH route (`ssh -tt`); every other host\'s rides the link (link-pty.ts)',
}

/** Files that may import remote-sh.js (ssh one-shots), and why. */
const REMOTE_SH_ALLOWED: Record<string, string> = {
  'src/providers/daemon-connection.ts': 'the SSH route',
  'src/providers/daemon-file-slot.ts': 'the SSH route: daemon deploy',
  'src/providers/daemon-file-fetch.ts': 'the SSH route: daemon deploy (the host downloads the file itself)',
  'src/providers/remote-daemon-dir.ts': 'the SSH route: daemon dir',
  'src/providers/remote-fold-prewarm.ts': 'the SSH route: prewarm before the daemon answers',
  'src/providers/remote-isolation.ts': 'the SSH route: a test server\'s isolated daemon scripts',
  'src/providers/remote-runtime.ts': 'the SSH route: runtime bootstrap',
  'src/providers/ssh-control-master.ts': 'the SSH route: control master',
  'src/providers/upload-resume.ts': 'the SSH route: chunked deploy upload',
  'src/providers/walnut-file-delta.ts': 'the SSH route: the walnut file sent as a delta',
  'src/core/host-server/install.ts': 'installing a host server over SSH',
}

/** Files that hand ssh or scp to a process (tier 4), and why. A host on the host network has no SSH route. */
const SSH_PROCESS_ALLOWED: Record<string, string> = {
  ...SSH_SPAWN_ALLOWED,
  'src/providers/remote-sh.ts': 'the SSH route: its one-shots',
  'src/providers/transfer-core.ts': 'on a host\'s daemon, the direct copy from a peer over SSH; never offered for a net host (transfer/workspace.ts sshTargetOf)',
  'src/web/terminal/host-shell.ts': 'the terminal\'s scripts (dtach, its lifecycle) on a host with an SSH route; every other host\'s go through runScriptOnHost (resolveTerminalRoute decides)',
  'src/core/hosts/ssh-cert-expiry-alert.ts': 'does an SSH host\'s sign-in work (net hosts are filtered out)',
  'src/providers/ssh-credential-evidence.ts': '`ssh -G`: this machine\'s ssh config, no connection',
  'src/core/hosts/ssh-key-of.ts': '`ssh -G`: this machine\'s ssh config, no connection',
  'src/core/hosts/ssh-resolve.ts': '`ssh -G`: this machine\'s ssh config, no connection',
}

/** Files that send exec.run or exec.script (tier 5), and why. */
const EXEC_RUN_ALLOWED: Record<string, string> = {
  'src/core/hosts/host-exec.ts': 'host_exec: the gate (grant, caps) and the run',
  'src/core/hosts/host-script.ts': 'exec.script: a plugin\'s script (hosts.run), through host_exec\'s dial',
  'src/providers/daemon-net-update-io.ts': 'a daemon update over the host network: the link is the very daemon being replaced',
  'src/providers/local-daemon.ts': 'this machine\'s own daemon, its login session probe over loopback',
  'src/core/standby/remote-apply.ts': 'the standby copy\'s apply on its host, a fixed walnut command the user turned on (standby.host): a background job, since exec.script stops at 10 minutes and a first batch applies longer; one job id per batch, so it never runs twice',
}

const EXEMPT = new Set(['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

interface Hits { dial: number; sshSpawn: number; remoteSh: number; sshProcess: number; execRun: number }

const SSH_BIN_RE = /(^|\/)(ssh|scp)$/
const PROCESS_FIELD_RE = /^(cmd|command|bin|binary|file|program|executable)$/i
/** A shell line that runs ssh or scp first: `ssh host true`, `/usr/bin/scp -q a b:c`. */
const SSH_LINE_RE = /^\s*(\S*\/)?(ssh|scp)\s/
const HOST_COMMANDS = new Set(['exec.run', 'exec.script'])
/** Calls that start a process from an argv or a shell line (a helper named `run` included). */
const PROCESS_CALLS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'run', 'runProgram', 'execa', 'fork'])

function scan(file: string): Hits {
  const text = fs.readFileSync(file, 'utf8')
  const hits: Hits = { dial: 0, sshSpawn: 0, remoteSh: 0, sshProcess: 0, execRun: 0 }
  if (!/getDaemonConnection|ssh|scp|remote-sh|exec\.run/.test(text)) return hits
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const nameOf = (e: ts.Expression): string | null =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null
  const isRemoteSh = (s: ts.Node | undefined) => !!s && ts.isStringLiteralLike(s) && /(^|\/)remote-sh\.js$/.test(s.text)
  // The value an expression hands on: `x ?? 'ssh'`, `a || 'ssh'`, `c ? 'ssh' : y`, `('ssh')`, `'ssh' as const`.
  const sshValue = (e: ts.Expression | undefined): boolean => {
    if (!e) return false
    if (ts.isStringLiteralLike(e)) return SSH_BIN_RE.test(e.text)
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return sshValue(e.expression)
    if (ts.isConditionalExpression(e)) return sshValue(e.whenTrue) || sshValue(e.whenFalse)
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return sshValue(e.left) || sshValue(e.right)
    }
    return false
  }
  const fieldName = (n: ts.PropertyName | ts.BindingName | ts.Expression): string | null =>
    ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : null
  // An argv: its first word, or the word after `env`.
  const sshArgv = (e: ts.Expression): boolean => {
    if (!ts.isArrayLiteralExpression(e) || !e.elements.length) return false
    const [first, second] = e.elements
    if (sshValue(first as ts.Expression)) return true
    return !!second && ts.isStringLiteralLike(first) && /(^|\/)env$/.test(first.text) && sshValue(second as ts.Expression)
  }
  // A shell line, plain or a template, whose first word is ssh or scp.
  const sshLine = (e: ts.Expression): boolean =>
    (ts.isStringLiteralLike(e) && SSH_LINE_RE.test(e.text)) || (ts.isTemplateExpression(e) && SSH_LINE_RE.test(e.head.text + ' '))
  const lineIn = (e: ts.Expression): boolean => sshLine(e) || (ts.isArrayLiteralExpression(e) && e.elements.some((x) => sshLine(x as ts.Expression)))
  const visit = (n: ts.Node): void => {
    // Types never dial: `ReturnType<typeof getDaemonConnection>` and `import('...').X` are fine.
    if (ts.isTypeNode(n)) return
    // Every use of the name, called or passed on; never its import, its declaration or a `typeof`.
    if (ts.isIdentifier(n) && n.text === 'getDaemonConnection') {
      const p = n.parent
      const declared = ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isFunctionDeclaration(p)
        || (ts.isPropertyAssignment(p) && p.name === n)
      if (!declared) hits.dial++
    }
    if (ts.isCallExpression(n)) {
      const name = nameOf(n.expression)
      if (name === 'spawn' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && /(^|\/)ssh$/.test(n.arguments[0].text)) hits.sshSpawn++
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && isRemoteSh(n.arguments[0])) hits.remoteSh++
      const launches = !!name && PROCESS_CALLS.has(name)
      if (sshValue(n.arguments[0]) || (launches && n.arguments.some((a) => sshArgv(a) || lineIn(a)))) hits.sshProcess++
      if (n.arguments.some((a) => ts.isStringLiteralLike(a) && HOST_COMMANDS.has(a.text))) hits.execRun++
    }
    // A constant holding ssh, whatever its name; a field, a default or an assignment by a process name.
    if (ts.isVariableDeclaration(n) && n.initializer && sshValue(n.initializer)) hits.sshProcess++
    if (ts.isPropertyAssignment(n) || ts.isParameter(n)) {
      const name = fieldName(n.name)
      if (n.initializer && ((name && PROCESS_FIELD_RE.test(name) && sshValue(n.initializer)) || (/^(argv|args)$/.test(name ?? '') && sshArgv(n.initializer)))) hits.sshProcess++
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = fieldName(n.left)
      if (name && PROCESS_FIELD_RE.test(name) && sshValue(n.right)) hits.sshProcess++
    }
    // A host command named by a field: `{ cmd: 'exec.run' }`, `const C = 'exec.script'`.
    if ((ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) && n.initializer && ts.isStringLiteralLike(n.initializer) && HOST_COMMANDS.has(n.initializer.text)) hits.execRun++
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && isRemoteSh(n.moduleSpecifier)) hits.remoteSh++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

describe('link ratchet', () => {
  const files = sourceFiles(path.join(repoRoot, 'src')).map((f) => path.relative(repoRoot, f).split(path.sep).join('/'))
    .filter((f) => !EXEMPT.has(f))
  const found = new Map(files.map((f) => [f, scan(path.join(repoRoot, f))]))

  const offenders = (key: keyof Hits, allowed: Record<string, string>) =>
    [...found].filter(([f, h]) => h[key] > 0 && !(f in allowed)).map(([f, h]) => `${f} (${h[key]})`)

  it('only the transports dial a daemon: everything else calls link(host)', () => {
    expect(offenders('dial', DIAL_ALLOWED), 'Call link(host) from src/core/hosts/link.ts instead of getDaemonConnection(host, target): '
      + 'the link builds the target (linkTarget) and picks the route.').toEqual([])
  })

  it('only the SSH route spawns ssh', () => {
    expect(offenders('sshSpawn', SSH_SPAWN_ALLOWED), 'Reach the host through link(host) and a daemon command; '
      + 'running ssh yourself ties the feature to one route.').toEqual([])
  })

  it('only the SSH route runs ssh one-shots (remote-sh.js)', () => {
    expect(offenders('remoteSh', REMOTE_SH_ALLOWED), 'Reach the host through link(host) and a daemon command, not remote-sh.').toEqual([])
  })

  it('only the SSH route hands ssh or scp to a process, by any route', () => {
    expect(offenders('sshProcess', SSH_PROCESS_ALLOWED), 'Reach the host through link(host) and a daemon command (a script: '
      + 'src/core/hosts/host-script.ts runScriptOnHost); an ssh of your own fails for a host on the host network.').toEqual([])
  })

  it('a command on another host goes through host_exec or host-script, never an exec.run of your own', () => {
    expect(offenders('execRun', EXEC_RUN_ALLOWED), 'Run it with src/core/hosts/host-script.ts runScriptOnHost (a script, its '
      + 'stdout and stderr apart) or host-exec.ts execOnHost (a task\'s command under the user\'s grant).').toEqual([])
  })

  it('every allowed file still does what it is allowed for (the lists only shrink)', () => {
    const stale = [
      ...Object.keys(DIAL_ALLOWED).filter((f) => !found.get(f)?.dial),
      ...Object.keys(SSH_SPAWN_ALLOWED).filter((f) => !found.get(f)?.sshSpawn),
      ...Object.keys(REMOTE_SH_ALLOWED).filter((f) => !found.get(f)?.remoteSh),
      ...Object.keys(SSH_PROCESS_ALLOWED).filter((f) => !found.get(f)?.sshProcess),
      ...Object.keys(EXEC_RUN_ALLOWED).filter((f) => !found.get(f)?.execRun),
    ]
    expect(stale, 'Remove these from the allow lists: they no longer need it.').toEqual([])
  })

  it('sees a dial, an ssh spawn and a remote-sh import when they are there', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'link-ratchet-')), 'probe.ts')
    fs.writeFileSync(tmp, [
      "import { x } from '../providers/remote-sh.js'",
      "// getDaemonConnection(host, t) in a comment never counts",
      "const s = 'getDaemonConnection(host, t)'",
      'await dc.getDaemonConnection(host, { hostname: host })',
      'const connect = deps.connect ?? getDaemonConnection',
      "spawn('ssh', args)",
      "pty.spawn('ssh', args)",
      "type C = Awaited<ReturnType<typeof import('../providers/daemon-connection.js').getDaemonConnection>>",
      "await import('./remote-sh.js')",
      "execFile('ssh', ['-G', alias])",
      "run(opts.bin ?? 'scp', args)",
      "function hostRunCommand() { return { command: 'ssh', argv } }",
      "const bin = useSsh ? '/usr/bin/ssh' : 'sh'",
      "if (kind === 'ssh') label = { link: 'ssh' }",
      "await conn.send('exec.run', { command: line })",
      "case 'exec.run': break",
      "const SSH = 'ssh'",
      "const o = { argv: ['ssh', host, cmd] }",
      "execFile('/usr/bin/env', ['ssh', host])",
      "exec(`ssh ${h} true`)",
      "spawn('sh', ['-c', 'ssh devbox uptime'])",
      "o.command = 'scp'",
      "function f(bin = 'ssh') { return bin }",
      "const hint = `Run ssh ${h} yourself`",
      "await conn.send({ cmd: 'exec.script', script })",
    ].join('\n'))
    try {
      // spawn('ssh') counts in tiers 2 and 4; a comparison, a case label, a `link` field and words
      // for a person (not handed to a call) never do.
      expect(scan(tmp)).toEqual({ dial: 2, sshSpawn: 2, remoteSh: 2, sshProcess: 13, execRun: 2 })
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    }
  })
})
