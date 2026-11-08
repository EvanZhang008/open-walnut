// demoGatewaySocketPath (gateway-core.ts) against a stub fs only: the Demo's short terminal dir is used only when it checks out.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { demoGatewaySocketPath, GATEWAY_SOCKET_FILENAME } from '../../src/providers/gateway-core.js'
import { RESTART_MARK_NAME } from '../../src/providers/daemon-restart-mark.js'
import { demoTerminalDir } from '../../src/lib/demo-terminal-dir.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = '/fixture/share/open-walnut-demo'
const GEN = 'gen-1'
const UID = 501
const OWNER = path.join(ROOT, 'data', GEN)
const hash = crypto.createHash('sha256').update(`${ROOT}\0${GEN}`).digest('hex').slice(0, 16)
const DIR = `/tmp/walnut-demo-${UID}-${hash}`

interface Entry { kind: 'dir' | 'file' | 'symlink'; uid: number; mode: number; text?: string }

/** A stub fs holding only `entries`; opening with O_NOFOLLOW refuses a symlink as the real call does. */
function stubFs(entries: Record<string, Entry>, calls: string[] = []) {
  const fds = new Map<number, Entry>()
  const stat = (e: Entry) => ({
    uid: e.uid, mode: (e.kind === 'dir' ? 0o040000 : 0o100000) | e.mode,
    isDirectory: () => e.kind === 'dir', isFile: () => e.kind === 'file', isSymbolicLink: () => e.kind === 'symlink',
  })
  const enoent = (p: string) => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' })
  return {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100 },
    lstatSync: (p: string) => { calls.push('lstat ' + p); const e = entries[p]; if (!e) throw enoent(p); return stat(e) },
    openSync: (p: string, flags: number) => {
      const e = entries[p]
      if (!e) throw enoent(p)
      if (e.kind === 'symlink' && flags & 0x100) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
      const fd = 100 + fds.size
      fds.set(fd, e)
      calls.push('open ' + p)
      return fd
    },
    fstatSync: (fd: number) => stat(fds.get(fd)!),
    readFileSync: (fd: number) => fds.get(fd)!.text ?? '',
    closeSync: (fd: number) => { calls.push('close ' + fd); fds.delete(fd) },
  } as unknown as typeof fs
}

const good = (): Record<string, Entry> => ({
  [DIR]: { kind: 'dir', uid: UID, mode: 0o700 },
  [`${DIR}/.owner`]: { kind: 'file', uid: UID, mode: 0o600, text: OWNER + '\n' },
})
const call = (entries: Record<string, Entry>, over: { root?: string; gen?: string; uid?: number | null } = {}) =>
  demoGatewaySocketPath(over.root ?? ROOT, over.gen ?? GEN, over.uid === undefined ? UID : over.uid, stubFs(entries), path, crypto)

describe('demoGatewaySocketPath', () => {
  it('returns the socket in the claimed private terminal dir, the same dir lib/demo-terminal-dir.ts makes', () => {
    const calls: string[] = []
    expect(demoGatewaySocketPath(ROOT, GEN, UID, stubFs(good(), calls), path, crypto)).toBe(`${DIR}/agent-gateway.sock`)
    expect(calls).toEqual([`lstat ${DIR}`, `open ${DIR}/.owner`, 'close 100'])
    if (typeof process.getuid === 'function') {
      const uid = process.getuid()
      const own = demoTerminalDir(ROOT, GEN)
      const entries = { [own]: { kind: 'dir', uid, mode: 0o700 }, [`${own}/.owner`]: { kind: 'file', uid, mode: 0o600, text: OWNER } } as Record<string, Entry>
      expect(demoGatewaySocketPath(ROOT, GEN, uid, stubFs(entries), path, crypto)).toBe(`${own}/agent-gateway.sock`)
    }
  })

  it('a missing, symlinked, non-directory, foreign or non-0700 dir gives null', () => {
    expect(call({})).toBeNull()
    for (const dir of [
      { kind: 'symlink', uid: UID, mode: 0o700 },
      { kind: 'file', uid: UID, mode: 0o700 },
      { kind: 'dir', uid: UID + 1, mode: 0o700 },
      { kind: 'dir', uid: UID, mode: 0o750 },
      { kind: 'dir', uid: UID, mode: 0o755 },
      { kind: 'dir', uid: UID, mode: 0o500 },
    ] as Entry[]) {
      expect(call({ ...good(), [DIR]: dir }), JSON.stringify(dir)).toBeNull()
    }
  })

  it('a missing, symlinked, foreign, non-file or other-generation owner marker gives null and closes what it opened', () => {
    const { [`${DIR}/.owner`]: _marker, ...noMarker } = good()
    expect(call(noMarker)).toBeNull()
    for (const marker of [
      { kind: 'symlink', uid: UID, mode: 0o600, text: OWNER },
      { kind: 'file', uid: UID + 1, mode: 0o600, text: OWNER },
      { kind: 'dir', uid: UID, mode: 0o700 },
      { kind: 'file', uid: UID, mode: 0o600, text: path.join(ROOT, 'data', 'gen-2') },
      { kind: 'file', uid: UID, mode: 0o600, text: '' },
      { kind: 'file', uid: UID, mode: 0o600, text: OWNER + '/../x' },
    ] as Entry[]) {
      const calls: string[] = []
      const r = demoGatewaySocketPath(ROOT, GEN, UID, stubFs({ ...good(), [`${DIR}/.owner`]: marker }, calls), path, crypto)
      expect(r, JSON.stringify(marker)).toBeNull()
      expect(calls.filter((c) => c.startsWith('open')).length).toBe(calls.filter((c) => c.startsWith('close')).length)
    }
  })

  it('never trusts a root or generation outside the Demo shape, and never touches fs then', () => {
    for (const over of [
      { root: 'fixture/open-walnut-demo' }, { root: ROOT + '/' }, { root: '/fixture/share/other' }, { root: '/fixture/x/../open-walnut-demo' },
      { gen: '../g' }, { gen: '' }, { gen: 'a'.repeat(65) }, { uid: -1 }, { uid: 1.5 },
    ]) {
      const calls: string[] = []
      const r = demoGatewaySocketPath(over.root ?? ROOT, over.gen ?? GEN, over.uid ?? UID, stubFs(good(), calls), path, crypto)
      expect(r, JSON.stringify(over)).toBeNull()
      expect(calls).toEqual([])
    }
  })

  it('the path stays under the 103-byte socket limit for any uid', () => {
    for (const uid of [0, 4294967295, null]) {
      const entries: Record<string, Entry> = {}
      const dir = `/tmp/walnut-demo-${uid ?? 'user'}-${hash}`
      entries[dir] = { kind: 'dir', uid: uid ?? 0, mode: 0o700 }
      entries[`${dir}/.owner`] = { kind: 'file', uid: uid ?? 0, mode: 0o600, text: OWNER }
      const sock = demoGatewaySocketPath(ROOT, GEN, uid, stubFs(entries), path, crypto)
      expect(sock).toBe(`${dir}/agent-gateway.sock`)
      expect(Buffer.byteLength(sock!)).toBeLessThanOrEqual(103)
    }
  })

  it('built from its own text, as the source twin inlines it, it answers the same', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`"use strict"; return (${demoGatewaySocketPath.toString()})`)() as typeof demoGatewaySocketPath
    expect(inlined(ROOT, GEN, UID, stubFs(good()), path, crypto)).toBe(`${DIR}/agent-gateway.sock`)
    expect(inlined(ROOT, GEN, UID, stubFs({}), path, crypto)).toBeNull()
  })
})

describe('demo gateway socket wiring in both twins', () => {
  const standalone = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
  const source = getDaemonSource()

  it('only a Demo daemon asks for the short path; every other daemon keeps <daemon dir>/agent-gateway.sock', () => {
    expect(standalone).toMatch(/const GATEWAY_SOCK_PATH = \(demoQuiesce\.isDemo\n\s+\? demoGatewaySocketPath\([^\n]*\)\n\s+: null\) \|\| path\.join\(DAEMON_DIR, GATEWAY_SOCKET_FILENAME\)/)
    expect(source).toMatch(/var GATEWAY_SOCK_PATH = \(demoQuiesce\.isDemo\n\s+\? \(function demoGatewaySocketPath\(/)
    expect(source).toMatch(/: null\) \|\| path\.join\(DAEMON_DIR, 'agent-gateway\.sock'\);/)
    expect(source).not.toContain('__DEMO_GATEWAY_SOCKET_PATH__')
    // One definition each: nothing else picks the socket path.
    expect([...standalone.matchAll(/GATEWAY_SOCK_PATH =/g)]).toHaveLength(1)
    expect([...source.matchAll(/GATEWAY_SOCK_PATH =/g)]).toHaveLength(1)
  })
})

// Execute the twins' path definitions against stub fs, without opening sockets.
describe('gateway socket, shim dir and restart mark share one dir in both twins', () => {
  const standalone = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
  const source = getDaemonSource()
  const twins = [{ name: 'standalone', text: standalone }, { name: 'source', text: source }]
  const DAEMON = '/fixture/share/open-walnut-demo/d/gen-1'

  const sockDef = /^(?:const|var) GATEWAY_SOCK_PATH = [\s\S]*?^(?:const|var) GATEWAY_SHIM_PATH = [^\n]*$/m
  const markDef = /^const RESTART_MARK_FILE = [^\n]*$/m

  /** Runs the twin's definition lines with stub inputs; nothing touches the real fs or a socket. */
  function paths(text: string, opts: { demo: boolean; entries: Record<string, Entry>; daemonDir?: string }) {
    const block = text.match(sockDef)?.[0]
    const mark = text.match(markDef)?.[0]
    if (!block || !mark) throw new Error('definition lines not found')
    const fakeProcess = { env: { WALNUT_DEMO_ROOT: ROOT, WALNUT_DEMO_GENERATION: GEN }, getuid: () => UID }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'demoQuiesce', 'demoGatewaySocketPath', 'process', 'fs', 'path', 'crypto', 'DAEMON_DIR', 'GATEWAY_SOCKET_FILENAME', 'RESTART_MARK_NAME',
      `"use strict"; ${block}\n${mark}\nreturn { sock: GATEWAY_SOCK_PATH, shimDir: GATEWAY_SHIM_DIR, shim: GATEWAY_SHIM_PATH, mark: RESTART_MARK_FILE }`,
    ) as (...args: unknown[]) => { sock: string; shimDir: string; shim: string; mark: string }
    return run({ isDemo: opts.demo }, demoGatewaySocketPath, fakeProcess, stubFs(opts.entries), path, crypto, opts.daemonDir ?? DAEMON, GATEWAY_SOCKET_FILENAME, RESTART_MARK_NAME)
  }

  it.each(twins)('$name: one definition each, in order (demoQuiesce, socket, shim, restart mark)', ({ text }) => {
    for (const name of ['GATEWAY_SOCK_PATH', 'GATEWAY_SHIM_DIR', 'GATEWAY_SHIM_PATH', 'RESTART_MARK_FILE']) {
      expect([...text.matchAll(new RegExp(`^(?:const|var) ${name} =`, 'gm'))], name).toHaveLength(1)
    }
    expect(text).toMatch(/^(?:const|var) GATEWAY_SHIM_DIR = path\.join\(path\.dirname\(GATEWAY_SOCK_PATH\), 'bin'\);?$/m)
    expect(text).toMatch(/^const RESTART_MARK_FILE = path\.join\(path\.dirname\(GATEWAY_SOCK_PATH\), (?:RESTART_MARK_NAME|'restarting')\);?$/m)
    const at = (re: RegExp) => text.search(re)
    const quiesce = at(/^const demoQuiesce = /m)
    const sock = at(/^(?:const|var) GATEWAY_SOCK_PATH = /m)
    const shim = at(/^(?:const|var) GATEWAY_SHIM_DIR = /m)
    const restart = at(/^const RESTART_MARK_FILE = /m)
    expect(quiesce).toBeGreaterThan(-1)
    expect(quiesce).toBeLessThan(sock)
    expect(sock).toBeLessThan(shim)
    expect(shim).toBeLessThan(restart)
    // No code line before the definitions names them (a top-level read there would be a TDZ throw).
    const before = text.slice(0, sock).split('\n').map((l) => l.trim())
      .filter((l) => /\bGATEWAY_(?:SOCK_PATH|SHIM_DIR|SHIM_PATH)\b/.test(l) && !l.startsWith('//') && !l.startsWith('*'))
    expect(before).toEqual([])
  })

  it.each(twins)('$name: a Demo daemon puts all three in its short terminal dir', ({ text }) => {
    const p = paths(text, { demo: true, entries: good() })
    expect(p.sock).toBe(`${DIR}/agent-gateway.sock`)
    expect(p.shimDir).toBe(`${DIR}/bin`)
    expect(p.shim).toBe(`${DIR}/bin/walnut`)
    expect(p.mark).toBe(`${DIR}/restarting`)
    // What the MCP mount and `walnut` derive from the socket is what the daemon writes.
    expect(path.join(path.dirname(p.sock), 'bin', 'walnut')).toBe(p.shim)
    expect(path.join(path.dirname(p.sock), RESTART_MARK_NAME)).toBe(p.mark)
  })

  it.each(twins)('$name: a Demo whose short dir does not check out, and every ordinary daemon, keep the daemon dir', ({ text }) => {
    for (const p of [
      paths(text, { demo: true, entries: {} }),
      paths(text, { demo: false, entries: good() }),
    ]) {
      expect(p).toEqual({ sock: `${DAEMON}/agent-gateway.sock`, shimDir: `${DAEMON}/bin`, shim: `${DAEMON}/bin/walnut`, mark: `${DAEMON}/restarting` })
    }
    const prod = paths(text, { demo: false, entries: good(), daemonDir: '/tmp/open-walnut' })
    expect(prod).toEqual({ sock: '/tmp/open-walnut/agent-gateway.sock', shimDir: '/tmp/open-walnut/bin', shim: '/tmp/open-walnut/bin/walnut', mark: '/tmp/open-walnut/restarting' })
  })

  it('an ordinary daemon never even looks at the Demo dir', () => {
    for (const { text } of twins) {
      const calls: string[] = []
      const block = text.match(sockDef)![0]
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const sock = new Function('demoQuiesce', 'demoGatewaySocketPath', 'process', 'fs', 'path', 'crypto', 'DAEMON_DIR', 'GATEWAY_SOCKET_FILENAME',
        `"use strict"; ${block}\nreturn GATEWAY_SOCK_PATH`)({ isDemo: false }, demoGatewaySocketPath, { env: {}, getuid: () => UID }, stubFs(good(), calls), path, crypto, DAEMON, GATEWAY_SOCKET_FILENAME)
      expect(sock).toBe(`${DAEMON}/agent-gateway.sock`)
      expect(calls).toEqual([])
    }
  })
})
