/**
 * Ratchet: every ssh this machine runs to a configured host takes its destination from
 * sshDestination and its alias options from sshAliasOptions (src/providers/session-io.ts),
 * so a host found in ~/.ssh/config is dialled by its Host alias everywhere, not only in one
 * path. Reads source text and the TypeScript AST only; nothing runs ssh.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = path.resolve(__dirname, '../..')

/** Files that run ssh to a host from an SshTarget: each must use both helpers. */
const SSH_RUNNERS: Record<string, string> = {
  'src/providers/daemon-connection.ts': 'the session link: tunnel, master, commands, uploads',
  'src/web/terminal/spawn.ts': 'the terminal shell',
  'src/web/terminal/dtach-lifecycle.ts': 'the terminal\'s dtach lifecycle commands',
  'src/web/terminal/dtach-provision.ts': 'the terminal\'s dtach install',
  'src/core/hosts/ssh-cert-expiry-alert.ts': 'the fresh sign-in check',
}

/** Files that run ssh but build no destination of their own, and why. */
const OTHER_SSH_RUNNERS: Record<string, string> = {
  'src/providers/stream-lane.ts': 'runs the args and destination DaemonConnection hands it',
  'src/providers/ssh-credential-evidence.ts': '`ssh -G` on the destination its caller passes',
  'src/providers/transfer-core.ts': 'runs on a remote host, with that host\'s own ssh config',
  'src/core/hosts/ssh-key-of.ts': '`ssh -G` on a host alias, to read which IdentityFile ssh would offer for the setup walkthrough; it never connects',
  'src/core/hosts/ssh-resolve.ts': '`ssh -G` on the bare name typed into Add host, before any target exists: it reads what ~/.ssh/config resolves, so a HostName override would hide the answer; it never connects',
}

/** Files that may write `user@host` inline, and why (none of them picks what ssh dials). */
const INLINE_DEST_ALLOWED: Record<string, string> = {
  'src/core/session-vscode-uri.ts': 'a VS Code Remote-SSH authority, which VS Code dials itself',
  'src/core/sessions/session-extras.ts': 'text naming the target in an error',
  'src/core/hosts/host-status.ts': 'text naming the target in the host status',
  'src/core/diagnostics/render.ts': 'a diagnostics table cell',
  'src/core/hosts/host-warmup.ts': 'error classification text',
  'src/core/plugins/plugin-hosts.ts': 'a plugin\'s host run, from the plugin host shape (no found-host flag)',
}

const EXEMPT = new Set(['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts'])
const SSH_CALLEES = new Set(['spawn', 'execFile', 'execFileSync', 'spawnSync', 'run'])
const INLINE_DEST = /\$\{[^}]*\buser\b[^}]*\}@\$\{[^}]*\bhost(name)?\b[^}]*\}/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const rel = (f: string) => path.relative(repoRoot, f).split(path.sep).join('/')
const files = sourceFiles(path.join(repoRoot, 'src')).map(rel).filter((f) => !EXEMPT.has(f))
const textOf = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8')
const astOf = (f: string) => ts.createSourceFile(f, textOf(f), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

function runsSsh(f: string): boolean {
  const text = textOf(f)
  if (!text.includes("'ssh'")) return false
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const e = n.expression
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ''
      const first = n.arguments[0]
      if (SSH_CALLEES.has(name) && first && ts.isStringLiteralLike(first) && first.text === 'ssh') hit = true
    }
    ts.forEachChild(n, visit)
  }
  visit(astOf(f))
  return hit
}

describe('ssh destination ratchet', () => {
  it('every file that runs ssh is listed: a new one must use sshDestination and sshAliasOptions', () => {
    const unlisted = files.filter((f) => runsSsh(f) && !(f in SSH_RUNNERS) && !(f in OTHER_SSH_RUNNERS))
    expect(unlisted, 'Build the ssh destination with sshDestination(target) and add sshAliasOptions(target), then list the file in SSH_RUNNERS.').toEqual([])
  })

  it('every listed runner uses both helpers', () => {
    const missing = Object.keys(SSH_RUNNERS).filter((f) => {
      const text = textOf(f)
      return !/\bsshDestination\(/.test(text) || !/\bsshAliasOptions\(/.test(text)
    })
    expect(missing).toEqual([])
  })

  it('no file writes user@host inline for ssh to dial', () => {
    const offenders = files.filter((f) => INLINE_DEST.test(textOf(f)) && !(f in INLINE_DEST_ALLOWED))
    expect(offenders, 'Use sshDestination(target) from src/providers/session-io.ts.').toEqual([])
  })

  it('only the terminal shell (which passes -tt) asks the alias options for a TTY', () => {
    const askers = files.filter((f) => /sshAliasOptions\([^)]*tty:\s*true/.test(textOf(f)))
    expect(askers).toEqual(['src/web/terminal/spawn.ts'])
  })

  it('the allow lists only shrink: each listed file still does what it is listed for', () => {
    expect(Object.keys(SSH_RUNNERS).filter((f) => !runsSsh(f))).toEqual([])
    expect(Object.keys(OTHER_SSH_RUNNERS).filter((f) => !runsSsh(f))).toEqual([])
    expect(Object.keys(INLINE_DEST_ALLOWED).filter((f) => !INLINE_DEST.test(textOf(f)))).toEqual([])
  })

  it('a login never keeps an alias block\'s forwards: ClearAllForwardings has no opt-out', () => {
    expect(files.filter((f) => /\bownForwards\b/.test(textOf(f)))).toEqual([])
  })

  // Each call (or literal) must sit in a function, or one around it, whose text names the safe route.
  function unsafeSites(file: string, isSite: (n: ts.Node) => boolean, safe: RegExp): string[] {
    const sf = astOf(file)
    const bad: string[] = []
    const visit = (n: ts.Node): void => {
      if (isSite(n)) {
        let ok = false
        for (let p: ts.Node | undefined = n.parent; p && !ok; p = p.parent) {
          if (ts.isFunctionLike(p) && 'body' in p && p.body) ok = safe.test(p.body.getText(sf))
        }
        if (!ok) bad.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return bad
  }
  const callOf = (names: RegExp) => (n: ts.Node) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.test(n.expression.text)

  it('every forward DaemonConnection opens goes through forwardSsh (an alias: Walnut\'s own master, no ssh config, or a clear failure)', () => {
    const dc = 'src/providers/daemon-connection.ts'
    expect(unsafeSites(dc, (n) => ts.isStringLiteralLike(n) && /^-[LRD]$/.test(n.text), /\bforwardSsh\(\)/)).toEqual([])
  })

  it('every -O check/cancel/exit DaemonConnection sends reaches the master through masterControl', () => {
    const dc = 'src/providers/daemon-connection.ts'
    expect(unsafeSites(dc, callOf(/^(planControlMaster|cancelRecordedForwards|exitControlMaster|removeStaleMaster|probeControlMaster)$/), /\bmasterControl\(/)).toEqual([])
  })

  it('the stream lane gives an alias its own master, and its alias client is mux-only', () => {
    // Every connection of its own (the stream lane, the bulk channel) takes its options from laneForwardOpts.
    const dc = 'src/providers/daemon-connection.ts'
    expect(unsafeSites(dc, callOf(/^sshLaneForward$/), /\blaneForwardOpts\(\)/)).toEqual([])
    expect(textOf(dc)).toMatch(/private laneForwardOpts\(\)[^\n]*\n\s*return this\.ssh\.sshAlias \? \{ ownMaster: \{ hostname: this\.ssh\.hostname \} \} : \{\}/)
    const lane = textOf('src/providers/stream-lane.ts')
    expect(lane).toMatch(/ownedMuxClientArgs\(owned\.socket\)/)
    expect(lane).toMatch(/exitControlMaster\(socket, ownedMuxClientArgs\(socket\)/)
  })
})
