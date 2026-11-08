/**
 * Every "remote hosts are off on a test server" gate considers the Demo's hosts
 * (src/providers/demo-remote-host.ts: they get the isolated daemon of
 * src/providers/remote-isolation.ts), and what must stay off in the Demo stays off.
 *
 * The gates are found from the source: every read of WALNUT_EPHEMERAL_REMOTE_HOSTS
 * in src/ (the env that turns remote hosts on for a test server) is listed below by
 * file and enclosing function, with how it treats the Demo. A new read fails here
 * until it is listed, which means deciding what a Demo host gets from it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.join(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function nameOf(node: ts.Node, sf: ts.SourceFile): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.name) return node.name.getText(sf)
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sf)
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sf)
  return null
}

/** `file::function` of every code read of `<x>.WALNUT_EPHEMERAL_REMOTE_HOSTS` (strings and comments do not count). */
function gateReads(): string[] {
  const found: string[] = []
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('WALNUT_EPHEMERAL_REMOTE_HOSTS')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'WALNUT_EPHEMERAL_REMOTE_HOSTS') {
        let at: ts.Node | undefined = node.parent
        let fn: string | null = null
        while (at && !fn) { fn = nameOf(at, sf); at = at.parent }
        found.push(`${path.relative(ROOT, file)}::${fn ?? '(top level)'}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found.sort()
}

/** The text of one function, getter or method in a file. */
function bodyOf(rel: string, name: string): string {
  const file = path.join(ROOT, rel)
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let body: string | null = null
  const visit = (node: ts.Node): void => {
    if (!body && nameOf(node, sf) === name) body = node.getText(sf)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (body === null) throw new Error(`${rel}: ${name} not found`)
  return body
}

/** Each read, and what it does for a Demo host. */
const GATES: Record<string, string> = {
  'src/core/hosts/host-connect-action.ts::remoteHostsOff': 'asks isDemoLiftedHost first: a Demo host is on (live frame, Connect, folder listing) until the Demo\'s stop began',
  'src/providers/remote-isolation.ts::remoteIsolationFor': 'skipped for a Demo (the demo input): its ssh hosts are isolated without the opt-in, and off once its stop began',
  'src/providers/ephemeral-replica-host.ts::ephemeralReplicaHost': 'the replica check\'s own opt-in; the Demo needs no replica check, and its hosts get the default roots',
}

describe('remote-host gates and the Demo', () => {
  it('every read of WALNUT_EPHEMERAL_REMOTE_HOSTS is listed with what it does for a Demo host', () => {
    expect(gateReads()).toEqual(Object.keys(GATES).sort())
  })

  it('the listed gates really consider the Demo', () => {
    const off = bodyOf('src/core/hosts/host-connect-action.ts', 'remoteHostsOff')
    expect(off.indexOf('isDemoLiftedHost(')).toBeGreaterThan(0)
    expect(off.indexOf('isDemoLiftedHost(')).toBeLessThan(off.indexOf('WALNUT_EPHEMERAL_REMOTE_HOSTS'))
    const iso = bodyOf('src/providers/remote-isolation.ts', 'remoteIsolationFor')
    expect(iso.indexOf('demo?.closed')).toBeGreaterThan(0)
    expect(iso).toContain('!demo && env.WALNUT_EPHEMERAL_REMOTE_HOSTS')
    // Every caller of the decision says whether this is a Demo.
    let calls = 0
    for (const file of walk(SRC)) {
      for (const call of fs.readFileSync(file, 'utf8').match(/remoteIsolationFor\(\{[^}]*\}\)/g) ?? []) {
        calls++
        expect(call, path.relative(ROOT, file)).toContain('demo: demoIsolationInput(IS_DEMO)')
      }
    }
    expect(calls).toBeGreaterThanOrEqual(3)
    const dc = 'src/providers/daemon-connection.ts'
    expect(bodyOf(dc, 'ephemeralRemoteRefused')).toContain("this.isolation.mode === 'off'")
    expect(bodyOf(dc, 'isReadOnlyRemote')).toContain("this.isolation.mode !== 'isolated'")
    expect(bodyOf(dc, 'demoLifted')).toContain("this.isolation.mode === 'isolated'")
  })

  it('what stays off in the Demo stays off', () => {
    const dc = 'src/providers/daemon-connection.ts'
    // Boot start setup: never a login or boot service on a user's box from a test server, the Demo included.
    expect(bodyOf(dc, '_bootStart')).toContain('IS_EPHEMERAL')
    // A host network machine is never lifted, and a test server never updates its daemon.
    expect(fs.readFileSync(path.join(ROOT, dc), 'utf8')).toContain('testServer: () => this.isReadOnlyRemote || IS_EPHEMERAL')
    // No host server, and no plugin job on a remote host.
    expect(bodyOf('src/core/host-server/index.ts', 'getHostServerManager')).toContain('IS_DEMO')
    expect(bodyOf('src/core/plugin-jobs/index.ts', 'pluginJobsConnected')).toContain('IS_DEMO')
    expect(fs.readFileSync(path.join(ROOT, 'src/web/routes/host-servers.ts'), 'utf8')).toContain("code: 'demo_host_server_off'")
  })
})
