/**
 * Link ratchet: a feature reaches another host through `link(host)`
 * (src/core/hosts/link.ts), never by building an SSH target and dialling, and
 * never by running ssh itself. The user, 2026-10-31: "each connection is an
 * abstraction ... SSH direct, or via the companion ... as long as they connect".
 * Before the link layer ~25 call sites built their own `{hostname, user, port}`,
 * some without `shell_setup`, and the pool kept whichever target dialled first.
 *
 * Three tiers, all over the TypeScript AST (comments and strings never count):
 *  1. `getDaemonConnection`: only the transports below may call it or take it as
 *     a value (`dependencies.connect ?? getDaemonConnection` is a dial too).
 *  2. `spawn('ssh', ...)` (child_process or pty): only the SSH transports below.
 *  3. Importing `remote-sh.js` (ssh one-shots): only the files below, which are
 *     the SSH transport's own bootstrap (deploy, daemon dir, control master).
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
  'src/providers/remote-session-manager.ts': 'a session transport, handed the target link.ts built (linkTarget)',
  'src/web/local-daemon-lane.ts': 'the local lane, an injected pool over loopback only',
  'src/core/hosts/host-connect-action.ts': 'a person\'s Connect now starts the dial before it answers, with linkTarget\'s target',
}

/** Files that may spawn ssh, and why. */
const SSH_SPAWN_ALLOWED: Record<string, string> = {
  'src/providers/daemon-connection.ts': 'the SSH route: the tunnel and its probes',
  'src/providers/stream-lane.ts': 'the SSH route: the stream lane beside the tunnel',
  'src/web/terminal/spawn.ts': 'the terminal, SSH by nature until it rides the link',
}

/** Files that may import remote-sh.js (ssh one-shots), and why. */
const REMOTE_SH_ALLOWED: Record<string, string> = {
  'src/providers/daemon-connection.ts': 'the SSH route',
  'src/providers/daemon-file-slot.ts': 'the SSH route: daemon deploy',
  'src/providers/remote-daemon-dir.ts': 'the SSH route: daemon dir',
  'src/providers/remote-fold-prewarm.ts': 'the SSH route: prewarm before the daemon answers',
  'src/providers/remote-runtime.ts': 'the SSH route: runtime bootstrap',
  'src/providers/ssh-control-master.ts': 'the SSH route: control master',
  'src/providers/upload-resume.ts': 'the SSH route: chunked deploy upload',
  'src/core/host-server/install.ts': 'installing a host server over SSH',
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

interface Hits { dial: number; sshSpawn: number; remoteSh: number }

function scan(file: string): Hits {
  const text = fs.readFileSync(file, 'utf8')
  const hits: Hits = { dial: 0, sshSpawn: 0, remoteSh: 0 }
  if (!/getDaemonConnection|ssh|remote-sh/.test(text)) return hits
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const nameOf = (e: ts.Expression): string | null =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null
  const isRemoteSh = (s: ts.Node | undefined) => !!s && ts.isStringLiteralLike(s) && /(^|\/)remote-sh\.js$/.test(s.text)
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
    }
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

  it('every allowed file still does what it is allowed for (the lists only shrink)', () => {
    const stale = [
      ...Object.keys(DIAL_ALLOWED).filter((f) => !found.get(f)?.dial),
      ...Object.keys(SSH_SPAWN_ALLOWED).filter((f) => !found.get(f)?.sshSpawn),
      ...Object.keys(REMOTE_SH_ALLOWED).filter((f) => !found.get(f)?.remoteSh),
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
    ].join('\n'))
    try {
      expect(scan(tmp)).toEqual({ dial: 2, sshSpawn: 2, remoteSh: 2 })
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    }
  })
})
