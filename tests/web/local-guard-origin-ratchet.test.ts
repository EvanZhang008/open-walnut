/**
 * "This Mac only" ratchet: a decision that a request comes from this Mac uses
 * the caller-origin rule (src/web/middleware/request-origin.ts), never the
 * socket alone.
 *
 * Why: the op executor, the plugin runtime and the plugin control relay reach
 * this server over loopback while acting for a caller OFF this Mac (a session
 * on another exec host, a paired phone), and every such self-call names that
 * caller in x-walnut-origin (src/lib/caller-origin.ts). A guard that looks only
 * at the socket (local-trust.ts classifyLocalRequest, or a loopback test on
 * req.socket.remoteAddress) hands that self-call what only this Mac may do. In
 * October 2026 four guards had this shape: the device relay (devices.ts
 * actorOf), the Tailscale installer (devices-tailscale.ts), raw doctor output
 * (diagnostics.ts) and the /ws upgrade (ws/handler.ts).
 *
 * The rule, checked over every .ts file under src/ with the TypeScript parser:
 *  1. a call to classifyLocalRequest() comes AFTER a call to requestOrigin() or
 *     isOnBehalfOfRemote() in the same function. health-access.ts is the model:
 *     the origin decides first; the socket class only answers what is left
 *     (a phone's token, a log line's reason);
 *  2. a function that reads the socket's address (`<x>.socket.remoteAddress`,
 *     `<x>.connection.remoteAddress`, `req.ip`) does not test it for loopback
 *     (an isLoopback* call, a 127.0.0.1 / ::1 literal, a /127.../ regex).
 *     Reading it for a log line or a rate-limit key is fine.
 * Exempt: only the middleware that is supposed to see the raw socket.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** The middleware that classifies the raw socket for everyone else. Do not add to this list. */
const RAW_SOCKET_MIDDLEWARE = [
  'src/web/middleware/auth.ts',
  'src/web/middleware/local-trust.ts',
  'src/web/middleware/request-origin.ts',
]

const ORIGIN_RULE = new Set(['requestOrigin', 'isOnBehalfOfRemote'])
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

interface Finding { file: string; line: number; fn: string; why: string }

interface Scope {
  name: string
  origin: number[]
  classify: Array<{ pos: number; line: number }>
  socketRead: number | null
  loopback: number | null
}

function isFunctionScope(n: ts.Node): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)
}

function scopeName(n: ts.Node): string {
  if (ts.isSourceFile(n)) return '(module)'
  const named = n as ts.Node & { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name)) return named.name.text
  const p = n.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text
  return '(anonymous)'
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

/** `<x>.socket.remoteAddress`, `<x>.connection.remoteAddress`, `req.ip`, `request.ip`. */
function isSocketAddressRead(n: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(n)) return false
  if (n.name.text === 'remoteAddress') {
    const inner = n.expression
    return ts.isPropertyAccessExpression(inner) && (inner.name.text === 'socket' || inner.name.text === 'connection')
  }
  if (n.name.text === 'ip') return ts.isIdentifier(n.expression) && (n.expression.text === 'req' || n.expression.text === 'request')
  return false
}

function isLoopbackTest(n: ts.Node): boolean {
  if (ts.isCallExpression(n)) return /^isLoopback/.test(calleeName(n) ?? '')
  if (ts.isStringLiteralLike(n)) return LOOPBACK_LITERALS.has(n.text)
  if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) return n.getText().includes('127')
  return false
}

/** Every socket-only "this Mac" decision in one source file. */
export function findSocketOnlyGuards(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // classifyLocalRequest under any local name (`import { classifyLocalRequest as x }`, a destructured dynamic import).
  const classifyNames = new Set(['classifyLocalRequest'])
  const scopes = new Map<ts.Node, Scope>()
  const scopeFor = (n: ts.Node): Scope => {
    let p: ts.Node = n.parent
    while (p && !isFunctionScope(p) && !ts.isSourceFile(p)) p = p.parent
    let s = scopes.get(p)
    if (!s) { s = { name: scopeName(p), origin: [], classify: [], socketRead: null, loopback: null }; scopes.set(p, s) }
    return s
  }
  const collectAliases = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'classifyLocalRequest') classifyNames.add(n.name.text)
    if (ts.isBindingElement(n) && n.propertyName && ts.isIdentifier(n.propertyName)
      && n.propertyName.text === 'classifyLocalRequest' && ts.isIdentifier(n.name)) classifyNames.add(n.name.text)
    ts.forEachChild(n, collectAliases)
  }
  collectAliases(sf)
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n) ?? ''
      if (ORIGIN_RULE.has(name)) scopeFor(n).origin.push(n.getStart(sf))
      if (classifyNames.has(name)) {
        const pos = n.getStart(sf)
        scopeFor(n).classify.push({ pos, line: sf.getLineAndCharacterOfPosition(pos).line + 1 })
      }
    }
    if (isSocketAddressRead(n)) {
      const s = scopeFor(n)
      s.socketRead ??= sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    }
    if (isLoopbackTest(n)) {
      const s = scopeFor(n)
      s.loopback ??= sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const out: Finding[] = []
  for (const s of scopes.values()) {
    for (const c of s.classify) {
      if (!s.origin.some((o) => o < c.pos)) {
        out.push({ file, line: c.line, fn: s.name, why: 'classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()' })
      }
    }
    if (s.socketRead !== null && s.loopback !== null) {
      out.push({ file, line: s.socketRead, fn: s.name, why: 'tests the socket address for loopback' })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('"this Mac only" decisions use the caller-origin rule', () => {
  it('no guard under src/ decides from the socket alone', () => {
    const findings: Finding[] = []
    for (const full of sourceFiles(path.join(repoRoot, 'src'))) {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/')
      if (RAW_SOCKET_MIDDLEWARE.includes(rel)) continue
      findings.push(...findSocketOnlyGuards(rel, fs.readFileSync(full, 'utf-8')))
    }
    const report = findings.map((f) => `  ${f.file}:${f.line} (${f.fn}): ${f.why}`).join('\n')
    expect(findings, [
      'A "this Mac only" check looks at the socket alone. A loopback self-call made for a caller off',
      'this Mac (x-walnut-origin) passes it. Decide with isLocalOrigin(requestOrigin(req)), or refuse',
      'isOnBehalfOfRemote(req) first (src/web/middleware/health-access.ts):',
      report,
    ].join('\n')).toEqual([])
  })

  it('exempts only the raw-socket middleware, and each of them exists', () => {
    expect(RAW_SOCKET_MIDDLEWARE).toEqual([
      'src/web/middleware/auth.ts',
      'src/web/middleware/local-trust.ts',
      'src/web/middleware/request-origin.ts',
    ])
    for (const rel of RAW_SOCKET_MIDDLEWARE) expect(fs.existsSync(path.join(repoRoot, rel)), rel).toBe(true)
  })
})

describe('the checker itself', () => {
  const flagged = (src: string) => findSocketOnlyGuards('probe.ts', src).map((f) => `${f.fn}: ${f.why}`)

  it('flags the shapes the four guards had before the fix', () => {
    // devices-tailscale.ts requireLocalConsole
    expect(flagged(`
      import { classifyLocalRequest } from '../middleware/local-trust.js'
      function requireLocalConsole(req, res, next) {
        if (classifyLocalRequest(req).trusted) { next(); return }
        res.status(403).json({ error: 'no' })
      }`)).toEqual(['requireLocalConsole: classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()'])
    // diagnostics.ts rawAllowed
    expect(flagged(`
      export function rawAllowed(req, cloudMode) { return !cloudMode && isLoopbackAddress(req.socket.remoteAddress) }`))
      .toEqual(['rawAllowed: tests the socket address for loopback'])
    // ws/handler.ts verifyPrimaryUpgrade (a destructured dynamic import)
    expect(flagged(`
      async function verifyPrimaryUpgrade(url, request) {
        const { classifyLocalRequest, isCrossSiteRefusal } = await import('../middleware/local-trust.js')
        const trust = classifyLocalRequest(request)
        if (trust.trusted) return 'ok'
        return 401
      }`)).toEqual(['verifyPrimaryUpgrade: classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()'])
    // devices.ts actorOf on main before the device round
    expect(flagged(`
      const actorOf = (req) => (!CLOUD_MODE && classifyLocalRequest(req).trusted ? LOCAL_ACTOR : { token: '' })`))
      .toEqual(['actorOf: classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()'])
  })

  it('flags literal loopback compares, req.ip, an aliased import, and an origin check that comes too late', () => {
    expect(flagged(`
      function gate(request) {
        const peer = request.socket.remoteAddress
        return peer === '127.0.0.1' || peer === '::1'
      }`)).toEqual(['gate: tests the socket address for loopback'])
    expect(flagged(`const local = (req) => /^127\\./.test(req.ip)`)).toEqual(['local: tests the socket address for loopback'])
    expect(flagged(`
      import { classifyLocalRequest as fromHere } from './local-trust.js'
      export function isMine(req) { return fromHere(req).trusted }`))
      .toEqual(['isMine: classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()'])
    expect(flagged(`
      function late(req) { return classifyLocalRequest(req).trusted && !isOnBehalfOfRemote(req) }`))
      .toEqual(['late: classifyLocalRequest() decides before requestOrigin() / isOnBehalfOfRemote()'])
    // An origin check in the OUTER function does not cover a decision in a callback.
    expect(flagged(`
      function outer(req) {
        const origin = requestOrigin(req)
        return () => classifyLocalRequest(req).trusted
      }`)).toHaveLength(1)
  })

  it('passes the origin rule, the health-access shape, and reads that decide nothing', () => {
    expect(flagged(`
      function requireLocalConsole(req, res, next) {
        if (isLocalOrigin(requestOrigin(req))) { next(); return }
        res.status(403).end()
      }`)).toEqual([])
    expect(flagged(`
      function requirePhoneOrThisMachine(req, res, next) {
        if (isOnBehalfOfRemote(req)) { refuse(); return }
        if (!CLOUD_MODE && classifyLocalRequest(req).trusted) { next(); return }
      }`)).toEqual([])
    expect(flagged(`
      function requireThisMachine(req, res, next) {
        const origin = requestOrigin(req)
        if (origin === LOCAL_ORIGIN) { next(); return }
        const trust = classifyLocalRequest(req)
        log.warn('refused', { reason: trust.trusted ? 'on-behalf-of' : trust.reason })
      }`)).toEqual([])
    // A rate-limit key and a log line read the socket and decide nothing.
    expect(flagged(`
      function claim(req) {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
        if (isAuthRateLimited(ip)) return 429
      }`)).toEqual([])
    // A loopback test on a URL, not on a socket.
    expect(flagged(`function usable(origin) { return !isLoopbackHostname(new URL(origin).hostname) }`)).toEqual([])
  })
})
