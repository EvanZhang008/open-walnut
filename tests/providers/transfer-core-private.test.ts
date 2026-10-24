/**
 * fs.writePart `private: true` ('transfer-private-v1'): the transcript stage a
 * Claude to Claude transfer forks from, written by the daemon that owns it.
 *
 * MACHINE SAFETY: nothing here touches a real file or process. The factory gets
 * an in-memory POSIX-like filesystem (FakeFs below: inodes, modes, uids, nlink,
 * umask, symlinks, FIFOs and devices, O_EXCL / O_NOFOLLOW / O_DIRECTORY / O_NONBLOCK),
 * a spawn that throws, and an empty env. No real FIFO is ever made: an open of a
 * fake FIFO or device without O_NONBLOCK fails the test (a real one would block). Every fs call is recorded with its path and mode, so each test also
 * pins WHICH paths a write may touch: chmod only on fds this attempt created,
 * unlink only on its own staging name, never anything outside the attempt dir.
 * `node:fs` is imported for its `constants` only.
 */
import { describe, expect, it } from 'vitest'
import { constants as C } from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'

// ── FakeFs ──────────────────────────────────────────────────────────────────

type Kind = 'dir' | 'file' | 'link' | 'fifo' | 'chr'
interface Inode { dev: number; ino: number; kind: Kind; mode: number; uid: number; nlink: number; data: Buffer; entries: Map<string, number>; target: string }
interface Call { op: string; path: string; mode?: number; flags?: number; label?: string }

function errno(code: string, p: string): NodeJS.ErrnoException {
  const e = new Error(code + ': ' + p) as NodeJS.ErrnoException
  e.code = code
  return e
}

const S_IF: Record<Kind, number> = { dir: C.S_IFDIR, file: C.S_IFREG, link: C.S_IFLNK, fifo: C.S_IFIFO, chr: C.S_IFCHR }
/** The flags every open of an existing name must carry (transfer-core existingFlags). */
const SAFE_OPEN = C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY

class FakeFs {
  readonly dev = 7
  private nextIno = 100
  readonly nodes = new Map<number, Inode>()
  readonly calls: Call[] = []
  umask = 0o022
  uid = 501
  /** Return true to make a mutating call fail before it takes effect (a daemon that died there). */
  crash: ((label: string) => boolean) | null = null
  /** Runs right after a mutating call took effect (another process acting in that window). */
  after: ((label: string) => void) | null = null

  constructor() {
    this.nodes.set(1, { dev: this.dev, ino: 1, kind: 'dir', mode: 0o755, uid: 0, nlink: 2, data: Buffer.alloc(0), entries: new Map(), target: '' })
  }

  private make(kind: Kind, mode: number, uid: number): Inode {
    const n: Inode = { dev: this.dev, ino: this.nextIno++, kind, mode: mode & 0o7777, uid, nlink: kind === 'dir' ? 2 : 1, data: Buffer.alloc(0), entries: new Map(), target: '' }
    this.nodes.set(n.ino, n)
    return n
  }

  /** Resolve a path; intermediate links are followed, the last one only when asked. */
  walk(p: string, followLast: boolean, depth = 0): { parent: Inode | null; name: string; node: Inode | null } {
    if (depth > 8) throw errno('ELOOP', p)
    const parts = path.resolve(p).split('/').filter(Boolean)
    let dir = this.nodes.get(1)!
    if (parts.length === 0) return { parent: null, name: '', node: dir }
    for (let i = 0; i < parts.length; i++) {
      if (dir.kind !== 'dir') throw errno('ENOTDIR', p)
      const ino = dir.entries.get(parts[i])
      let node = ino === undefined ? null : this.nodes.get(ino)!
      if (i === parts.length - 1) {
        if (node && node.kind === 'link' && followLast) return this.walk(node.target, true, depth + 1)
        return { parent: dir, name: parts[i], node }
      }
      if (!node) throw errno('ENOENT', p)
      if (node.kind === 'link') {
        node = this.walk(node.target, true, depth + 1).node
        if (!node) throw errno('ENOENT', p)
      }
      dir = node
    }
    throw errno('ENOENT', p)
  }

  private statOf(n: Inode) {
    return {
      dev: n.dev, ino: n.ino, uid: n.uid, mode: S_IF[n.kind] | n.mode, nlink: n.nlink, size: n.data.length,
      isFile: () => n.kind === 'file', isDirectory: () => n.kind === 'dir', isSymbolicLink: () => n.kind === 'link',
    }
  }

  private mutate(op: string, p: string, extra: Partial<Call> = {}): void {
    const label = op + ':' + path.basename(p)
    this.calls.push({ op, path: p, label, ...extra })
    if (this.crash?.(label)) throw errno('EIO', 'crash at ' + label)
  }

  private writable(dir: Inode, p: string): void {
    if (dir.kind !== 'dir') throw errno('ENOTDIR', p)
    if (dir.uid !== this.uid || (dir.mode & 0o200) === 0) throw errno('EACCES', p)
  }

  private handle(node: Inode, p: string) {
    const fake = this
    return {
      async stat() { fake.calls.push({ op: 'fstat', path: p }); return fake.statOf(node) },
      async chmod(m: number) { fake.mutate('chmod', p, { mode: m }); node.mode = m & 0o7777; fake.after?.('chmod:' + path.basename(p)) },
      async close() { fake.calls.push({ op: 'close', path: p }) },
      async sync() { fake.mutate('sync', p); fake.after?.('sync:' + path.basename(p)) },
      async truncate(n: number) { fake.mutate('truncate', p); node.data = Buffer.concat([node.data, Buffer.alloc(Math.max(0, n - node.data.length))]).subarray(0, n); fake.after?.('truncate:' + path.basename(p)) },
      async writeFile(text: string) { fake.mutate('write', p); node.data = Buffer.from(text); fake.after?.('write:' + path.basename(p)) },
      async readFile(_enc?: string) { fake.calls.push({ op: 'read', path: p }); return node.data.toString('utf8') },
      async write(buf: Buffer, off: number, len: number, pos: number) {
        fake.mutate('write', p)
        const end = pos + len
        const next = Buffer.alloc(Math.max(node.data.length, end))
        node.data.copy(next)
        buf.copy(next, pos, off, off + len)
        node.data = next
        fake.after?.('write:' + path.basename(p))
        return { bytesWritten: len }
      },
      async read(buf: Buffer, off: number, len: number, pos: number) {
        fake.calls.push({ op: 'read', path: p })
        const n = Math.max(0, Math.min(len, node.data.length - pos))
        node.data.copy(buf, off, pos, pos + n)
        return { bytesRead: n }
      },
    }
  }

  readonly promises = {
    lstat: async (p: string) => {
      this.calls.push({ op: 'lstat', path: p })
      const { node } = this.walk(p, false)
      if (!node) throw errno('ENOENT', p)
      return this.statOf(node)
    },
    mkdir: async (p: string, opts: { mode?: number; recursive?: boolean } = {}) => {
      if (opts.recursive) throw new Error('the private path never makes dirs recursively: ' + p)
      const { parent, name, node } = this.walk(p, false)
      if (node) throw errno('EEXIST', p)
      if (!parent) throw errno('EEXIST', p)
      this.writable(parent, p)
      this.mutate('mkdir', p, { mode: opts.mode })
      const n = this.make('dir', (opts.mode ?? 0o777) & ~this.umask, this.uid)
      parent.entries.set(name, n.ino)
      this.after?.('mkdir:' + path.basename(p))
    },
    open: async (p: string, flags: number, mode?: number) => {
      if (typeof flags !== 'number') throw new Error('the private path opens with numeric flags only: ' + p)
      const nofollow = (flags & C.O_NOFOLLOW) !== 0
      const { parent, name, node } = this.walk(p, !nofollow)
      if (node && node.kind === 'link') throw errno('ELOOP', p)
      if (!node) {
        if ((flags & C.O_CREAT) === 0) throw errno('ENOENT', p)
        if (!parent) throw errno('ENOENT', p)
        this.writable(parent, p)
        this.mutate('create', p, { mode, flags })
        const n = this.make('file', (mode ?? 0o666) & ~this.umask, this.uid)
        parent.entries.set(name, n.ino)
        this.after?.('create:' + path.basename(p))
        return this.handle(n, p)
      }
      if ((flags & C.O_CREAT) && (flags & C.O_EXCL)) throw errno('EEXIST', p)
      if ((flags & C.O_DIRECTORY) && node.kind !== 'dir') throw errno('ENOTDIR', p)
      if ((node.kind === 'fifo' || node.kind === 'chr') && (flags & C.O_NONBLOCK) === 0) {
        // A real open here would wait for a writer (FIFO) or touch a device: fail loudly.
        this.calls.push({ op: 'open-would-block', path: p, flags })
        throw new Error('test: opened a ' + node.kind + ' without O_NONBLOCK: ' + p)
      }
      this.calls.push({ op: 'open', path: p, flags })
      return this.handle(node, p)
    },
    link: async (from: string, to: string) => {
      const src = this.walk(from, false).node
      if (!src || src.kind !== 'file') throw errno('ENOENT', from)
      const dst = this.walk(to, false)
      if (dst.node) throw errno('EEXIST', to)
      this.writable(dst.parent!, to)
      this.mutate('link', to)
      dst.parent!.entries.set(dst.name, src.ino)
      src.nlink++
      this.after?.('link:' + path.basename(to))
    },
    unlink: async (p: string) => {
      const { parent, name, node } = this.walk(p, false)
      if (!node || !parent) throw errno('ENOENT', p)
      if (node.kind === 'dir') throw errno('EISDIR', p)
      this.writable(parent, p)
      this.mutate('unlink', p)
      parent.entries.delete(name)
      node.nlink--
      this.after?.('unlink:' + path.basename(p))
    },
  }

  // ── arrange helpers (not recorded) ──
  dir(p: string, mode = 0o755, uid = this.uid): void {
    const parts = path.resolve(p).split('/').filter(Boolean)
    let cur = this.nodes.get(1)!
    for (const part of parts) {
      let ino = cur.entries.get(part)
      if (ino === undefined) { const n = this.make('dir', mode, uid); cur.entries.set(part, n.ino); ino = n.ino }
      cur = this.nodes.get(ino)!
    }
    cur.mode = mode; cur.uid = uid
  }
  file(p: string, data: string | Buffer, mode = 0o600, uid = this.uid): Inode {
    const { parent, name, node } = this.walk(p, false)
    if (node) { parent!.entries.delete(name); node.nlink-- }
    const n = this.make('file', mode, uid)
    n.data = Buffer.from(data)
    parent!.entries.set(name, n.ino)
    return n
  }
  /** A FIFO or a character device under a name (an in-memory inode only). */
  special(p: string, kind: 'fifo' | 'chr', mode = 0o600, uid = this.uid): Inode {
    const { parent, name, node } = this.walk(p, false)
    if (node) { parent!.entries.delete(name); node.nlink-- }
    const n = this.make(kind, mode, uid)
    parent!.entries.set(name, n.ino)
    return n
  }
  symlink(p: string, target: string): void {
    const { parent, name, node } = this.walk(p, false)
    if (node) { parent!.entries.delete(name); node.nlink-- }
    const n = this.make('link', 0o777, this.uid)
    n.target = target
    parent!.entries.set(name, n.ino)
  }
  hardlink(from: string, to: string): void {
    const src = this.walk(from, false).node!
    const dst = this.walk(to, false)
    dst.parent!.entries.set(dst.name, src.ino)
    src.nlink++
  }
  node(p: string): Inode | null { try { return this.walk(p, false).node } catch { return null } }
  bytes(p: string): Buffer | null { const n = this.node(p); return n && n.kind === 'file' ? Buffer.from(n.data) : null }
  mutations(): Call[] { return this.calls.filter((c) => c.label !== undefined) }
  /** Every open of an existing name (not an O_CREAT|O_EXCL create). */
  opens(): Call[] { return this.calls.filter((c) => c.op === 'open' || c.op === 'open-would-block') }
  /** Reads, writes and every other mutation on one path. */
  touched(p: string): Call[] { return this.calls.filter((c) => c.path === p && (c.op === 'read' || c.label !== undefined)) }
}

// ── fixture ─────────────────────────────────────────────────────────────────

const HOME = '/h'
const BOUND = '/data/walnut'
const LOCAL_ROOT = '/data/walnut-transfers'
const REMOTE_ROOT = '/h/.open-walnut-transfers'
const XF = 'xf-11111111-2222-4333-8444-555555555555'
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TOKEN = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const CTX = { boundHome: BOUND, origin: null }
const INSTANCE = 'd-4242-0a1b2c3d'
const stampFor = (o: unknown) => JSON.stringify(o)
const GOOD_STAMP = stampFor({ walnutHome: BOUND, instanceId: INSTANCE, daemonPid: 4242 })

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const b64 = (b: Buffer) => b.toString('base64')

/**
 * `stamp` is the raw owner-stamp text the twin reads: absent = this incarnation's
 * stamp naming BOUND (a local daemon); null = no stamp; undefined given = present
 * but not a readable plain file.
 */
function setup(opts: { stamp?: string | null | undefined; umask?: number; root?: boolean; privateDeps?: boolean; instanceId?: string } = {}) {
  const fake = new FakeFs()
  if (opts.umask !== undefined) fake.umask = opts.umask
  fake.dir(HOME, 0o755)
  fake.dir('/data', 0o755)
  fake.dir(BOUND, 0o700)
  if (opts.root !== false) fake.dir(LOCAL_ROOT, 0o700)
  const stamp = 'stamp' in opts ? opts.stamp : GOOD_STAMP
  const instanceId = 'instanceId' in opts ? opts.instanceId : INSTANCE
  const core = () => createTransferCore({
    fs: { promises: fake.promises, constants: C } as unknown as TransferCoreDeps['fs'],
    path, crypto,
    spawn: () => { throw new Error('spawn is not part of a private write') },
    env: {}, home: HOME,
    ...(opts.privateDeps === false ? {} : { getuid: () => fake.uid, ownerStamp: () => stamp, instanceId }),
  })
  return { fake, core }
}

function paths(root = LOCAL_ROOT) {
  const xf = `${root}/${XF}`
  const dir = `${xf}/transcript`
  return { xf, dir, target: `${dir}/${SID}.jsonl`, staging: `${dir}/.${SID}.jsonl.part`, attempt: `${xf}/.attempt`, staged: `${xf}/.staged` }
}

function part(target: string, offset: number, data: Buffer, extra: Record<string, unknown> = {}) {
  return { path: target, offset, data: b64(data), private: true, attempt: TOKEN, ...extra }
}

const BODY = Buffer.from(Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, n: i })).join('\n') + '\n')

async function writeWhole(core: ReturnType<typeof createTransferCore>, target: string, body = BODY, ctx: object = CTX) {
  return core.writePart(part(target, 0, body, { final: true, size: body.length, sha256: sha(body) }), ctx)
}

// ── who may write, and where ────────────────────────────────────────────────

describe('private writePart: caller and root come from the socket and the instance', () => {
  const p = paths()
  it.each([
    ['no ctx at all', undefined],
    ['a bridge socket', { boundHome: BOUND, origin: 'bridge' }],
    ['a follower socket', { boundHome: BOUND, origin: 'follower' }],
    ['a lane socket', { boundHome: BOUND, origin: 'lane' }],
    ['no binding (leader.configure never ran)', { boundHome: null, origin: null }],
    ['a relative binding', { boundHome: 'data/walnut', origin: null }],
  ])('%s: not_owner, and no fs call at all', async (_name, ctx) => {
    const { fake, core } = setup()
    await expect(core().writePart(part(p.target, 0, BODY, { final: true }), ctx as never)).rejects.toMatchObject({ code: 'not_owner' })
    expect(fake.calls).toEqual([])
  })

  it.each([
    ['without the private deps', { privateDeps: false }],
    ['without its instance id', { instanceId: undefined }],
    ['with an empty instance id', { instanceId: '' }],
  ])('a daemon %s: not_supported, no fs call', async (_name, opts) => {
    const { fake, core } = setup(opts)
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'not_supported' })
    expect(fake.calls).toEqual([])
  })

  it('the owner stamp names the bound Walnut: the root is <boundHome>-transfers', async () => {
    const { fake, core } = setup()
    expect(await writeWhole(core(), p.target)).toEqual({ staged: BODY.length, done: true, sha256: sha(BODY), path: p.target })
    expect(fake.bytes(p.target)?.equals(BODY)).toBe(true)
    expect(fake.mutations().every((c) => c.path.startsWith(LOCAL_ROOT + '/'))).toBe(true)
    // Every open of an existing name never follows a link, never waits, never takes a tty.
    expect(fake.opens().length).toBeGreaterThan(0)
    for (const o of fake.opens()) expect({ path: o.path, safe: (o.flags! & SAFE_OPEN) === SAFE_OPEN }).toEqual({ path: o.path, safe: true })
  })

  it('no stamp (a daemon started over ssh): the root is ~/.open-walnut-transfers, even when a dir named <boundHome>-transfers exists', async () => {
    const { fake, core } = setup({ stamp: null })
    const r = paths(REMOTE_ROOT)
    // The local-looking path is refused: it is not under this instance's root.
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'not_private_path' })
    expect(fake.mutations()).toEqual([])
    fake.dir(REMOTE_ROOT, 0o700)
    expect(await writeWhole(core(), r.target)).toMatchObject({ done: true, path: r.target })
    expect(fake.node(LOCAL_ROOT)!.entries.size).toBe(0)
  })

  // A stamp vouches only for the incarnation it names (daemon-ownership.ts): an old
  // or malformed one is unknown, never read as "no stamp" (which would pick the
  // remote root). The root is missing in every case, so a fallback to "make it"
  // would show as a mkdir: there is no fs call at all.
  it.each([
    ['naming another Walnut', stampFor({ walnutHome: '/data/other', instanceId: INSTANCE })],
    ['left by an earlier daemon (another instanceId)', stampFor({ walnutHome: BOUND, instanceId: 'd-1111-99999999' })],
    ['from before instance ids (none)', stampFor({ walnutHome: BOUND })],
    ['with a null instanceId (the spawner never learned it)', stampFor({ walnutHome: BOUND, instanceId: null })],
    ['with a numeric instanceId', stampFor({ walnutHome: BOUND, instanceId: 4242 })],
    ['with a relative home', stampFor({ walnutHome: 'data/walnut', instanceId: INSTANCE })],
    ['with no home', stampFor({ instanceId: INSTANCE })],
    ['with a non-string home', stampFor({ walnutHome: ['/data/walnut'], instanceId: INSTANCE })],
    ['that is a JSON array', stampFor([BOUND, INSTANCE])],
    ['that is JSON null', 'null'],
    ['that is not JSON', '{"walnutHome": "/data/walnut", "instanceId": "' + INSTANCE + '"'],
    ['that is empty', ''],
    ['that exists but is not a readable plain file', undefined],
  ])('a stamp %s, root missing: topology_unknown, no fs call (no mkdir, no write)', async (_name, stamp) => {
    const { fake, core } = setup({ stamp, root: false })
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'topology_unknown' })
    await expect(writeWhole(core(), paths(REMOTE_ROOT).target)).rejects.toMatchObject({ code: 'topology_unknown' })
    expect(fake.calls).toEqual([])
    expect(fake.node(LOCAL_ROOT)).toBeNull()
    expect(fake.node(REMOTE_ROOT)).toBeNull()
  })

  it('this incarnation\'s stamp with extra fields still vouches (only instanceId and walnutHome are read)', async () => {
    const { core } = setup({ stamp: stampFor({ walnutHome: BOUND + '/', instanceId: INSTANCE, serverPid: 1, claudeCli: null, at: 'x' }) })
    expect(await writeWhole(core(), p.target)).toMatchObject({ done: true, path: p.target })
  })

  it('a `home` field in the command is ignored', async () => {
    const { fake, core } = setup()
    const cmd = { ...part(p.target, 0, BODY, { final: true, size: BODY.length, sha256: sha(BODY) }), home: '/elsewhere' }
    expect(await core().writePart(cmd, CTX)).toMatchObject({ done: true, path: p.target })
    expect(fake.calls.some((c) => c.path.includes('elsewhere'))).toBe(false)
  })

  it.each([
    ['another root', `/data/other-transfers/${XF}/transcript/${SID}.jsonl`],
    ['a short attempt id', `${LOCAL_ROOT}/xf-1234/transcript/${SID}.jsonl`],
    ['a non-uuid file name', `${LOCAL_ROOT}/${XF}/transcript/notes.jsonl`],
    ['a dot-dot escape', `${LOCAL_ROOT}/${XF}/transcript/../../${SID}.jsonl`],
    ['one level too deep', `${LOCAL_ROOT}/${XF}/transcript/x/${SID}.jsonl`],
    ['the wrong middle dir', `${LOCAL_ROOT}/${XF}/workspace/${SID}.jsonl`],
  ])('%s: not_private_path, no fs call', async (_name, target) => {
    const { fake, core } = setup()
    await expect(writeWhole(core(), target)).rejects.toMatchObject({ code: 'not_private_path' })
    expect(fake.calls).toEqual([])
  })

  it('a token that is not 32 hex characters: bad_request', async () => {
    const { core } = setup()
    await expect(core().writePart({ ...part(p.target, 0, BODY), attempt: 'short' }, CTX)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('private absent (or not exactly true) is the generic writePart: no private fs call, ctx unused', async () => {
    const { fake, core } = setup()
    const generic = core()
    // The generic path makes its dir recursively, which this FakeFs refuses on purpose.
    await expect(generic.writePart({ path: p.target, offset: 0, data: b64(BODY) }, CTX)).rejects.toThrow(/recursive|not a function/)
    await expect(generic.writePart({ path: p.target, offset: 0, data: b64(BODY), private: 'true' }, CTX)).rejects.toThrow(/recursive|not a function/)
    expect(fake.calls.some((c) => c.op === 'create' || c.op === 'link' || c.op === 'chmod')).toBe(false)
  })
})

// ── modes ───────────────────────────────────────────────────────────────────

describe('private writePart: exact modes on its own fds, never on the root', () => {
  it.each([0o000, 0o022, 0o077, 0o277])('umask %s: dirs 0700, files 0600; chmod only on fds this attempt created', async (umask) => {
    const { fake, core } = setup({ umask })
    const p = paths()
    fake.node(LOCAL_ROOT)!.mode = 0o755
    expect(await writeWhole(core(), p.target)).toMatchObject({ done: true })
    expect(fake.node(p.xf)!.mode).toBe(0o700)
    expect(fake.node(p.dir)!.mode).toBe(0o700)
    expect(fake.node(p.target)!.mode).toBe(0o600)
    expect(fake.node(p.attempt)!.mode).toBe(0o600)
    expect(fake.node(p.staged)!.mode).toBe(0o600)
    expect(fake.node(LOCAL_ROOT)!.mode).toBe(0o755)
    const dirs = new Set(fake.calls.filter((c) => c.op === 'mkdir').map((c) => c.path))
    const files = new Set(fake.calls.filter((c) => c.op === 'create').map((c) => c.path))
    const chmods = fake.calls.filter((c) => c.op === 'chmod')
    expect(chmods.length).toBe(dirs.size + files.size)
    for (const c of chmods) {
      expect(dirs.has(c.path) || files.has(c.path)).toBe(true)
      expect(c.mode).toBe(dirs.has(c.path) ? 0o700 : 0o600)
    }
  })

  it('a missing root is made like the attempt dir (0700 on its fd, umask 0277); an existing one is never chmodded', async () => {
    const { fake, core } = setup({ umask: 0o277, root: false })
    const p = paths()
    expect(await writeWhole(core(), p.target)).toMatchObject({ done: true })
    expect(fake.node(LOCAL_ROOT)!.mode).toBe(0o700)
    expect(fake.calls.filter((c) => c.op === 'chmod' && c.path === LOCAL_ROOT)).toHaveLength(1)
    const again = setup({ umask: 0o277 })
    await writeWhole(again.core(), p.target)
    expect(again.fake.calls.some((c) => c.op === 'chmod' && c.path === LOCAL_ROOT)).toBe(false)
  })

  it.each([
    ['a symlink', (f: FakeFs) => { f.dir('/data/real', 0o700); f.symlink(LOCAL_ROOT, '/data/real') }],
    ['owned by another uid', (f: FakeFs) => { f.node(LOCAL_ROOT)!.uid = 0 }],
    ['group-writable', (f: FakeFs) => { f.node(LOCAL_ROOT)!.mode = 0o770 }],
    ['other-writable', (f: FakeFs) => { f.node(LOCAL_ROOT)!.mode = 0o707 }],
    ['a file', (f: FakeFs) => { f.file(LOCAL_ROOT, 'x') }],
  ])('a root that is %s: root_unsafe, nothing made, the root untouched', async (_name, arrange) => {
    const { fake, core } = setup()
    arrange(fake)
    await expect(writeWhole(core(), paths().target)).rejects.toMatchObject({ code: 'root_unsafe' })
    expect(fake.mutations()).toEqual([])
  })
})

// ── bytes and retries ───────────────────────────────────────────────────────

describe('private writePart: chunks, retries, gaps', () => {
  const p = paths()
  const a = BODY.subarray(0, 100)
  const b = BODY.subarray(100, 300)
  const c = BODY.subarray(300)
  const fin = (extra: Record<string, unknown> = {}) => part(p.target, 300, c, { final: true, size: BODY.length, sha256: sha(BODY), ...extra })

  it('an empty file: one offset-0 final part', async () => {
    const { fake, core } = setup()
    const empty = Buffer.alloc(0)
    expect(await core().writePart(part(p.target, 0, empty, { final: true, size: 0, sha256: sha(empty) }), CTX))
      .toEqual({ staged: 0, done: true, sha256: sha(empty), path: p.target })
    expect(fake.bytes(p.target)!.length).toBe(0)
  })

  it('several chunks land as the file; a repeated part writes nothing; the staging name is gone after', async () => {
    const { fake, core } = setup()
    const k = core()
    expect(await k.writePart(part(p.target, 0, a), CTX)).toEqual({ staged: 100 })
    expect(await k.writePart(part(p.target, 100, b), CTX)).toEqual({ staged: 300 })
    const writes = fake.calls.filter((x) => x.op === 'write').length
    expect(await k.writePart(part(p.target, 100, b), CTX)).toEqual({ staged: 300 })
    expect(fake.calls.filter((x) => x.op === 'write').length).toBe(writes)
    expect(await k.writePart(fin(), CTX)).toEqual({ staged: BODY.length, done: true, sha256: sha(BODY), path: p.target })
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
    expect(fake.node(p.staging)).toBeNull()
    expect(fake.node(p.target)!.nlink).toBe(1)
  })

  it('a part past the staged end: gap with have; before anything is staged: gap with have 0', async () => {
    const { core } = setup()
    const k = core()
    await expect(k.writePart(part(p.target, 100, b), CTX)).rejects.toMatchObject({ code: 'gap', data: { have: 0 } })
    await k.writePart(part(p.target, 0, a), CTX)
    await expect(k.writePart(fin(), CTX)).rejects.toMatchObject({ code: 'gap', data: { have: 100 } })
    await k.writePart(part(p.target, 100, b), CTX)
    expect(await k.writePart(fin(), CTX)).toMatchObject({ done: true })
  })

  it('a checksum mismatch keeps the staging and links nothing', async () => {
    const { fake, core } = setup()
    await expect(core().writePart(part(p.target, 0, BODY, { final: true, sha256: 'a'.repeat(64) }), CTX))
      .rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect(fake.node(p.target)).toBeNull()
    expect(fake.bytes(p.staging)!.equals(BODY)).toBe(true)
    expect(fake.calls.some((x) => x.op === 'link' || x.op === 'unlink')).toBe(false)
  })

  it('two parts of one attempt sent at once are taken in order', async () => {
    const { fake, core } = setup()
    const k = core()
    const [r1, r2] = await Promise.all([k.writePart(part(p.target, 0, BODY.subarray(0, 300)), CTX), k.writePart(fin(), CTX)])
    expect(r1).toEqual({ staged: 300 })
    expect(r2).toMatchObject({ done: true })
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })
})

// ── ownership: token, recorded dev+ino ──────────────────────────────────────

describe('private writePart: a stage is this attempt\'s only by its token and recorded identity', () => {
  const p = paths()

  it.each([
    ['another attempt\'s token', (f: FakeFs) => { f.dir(p.xf, 0o700); f.dir(p.dir, 0o700); f.file(p.attempt, OTHER + '\n') }],
    ['no .attempt record', (f: FakeFs) => { f.dir(p.xf, 0o700); f.dir(p.dir, 0o700) }],
  ])('an attempt dir with %s: stage_foreign, nothing written', async (_name, arrange) => {
    const { fake, core } = setup()
    arrange(fake)
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'stage_foreign' })
    expect(fake.mutations()).toEqual([])
  })

  it('the same token at offset 0 again (a lost reply) starts the staging over', async () => {
    const { fake, core } = setup()
    const k = core()
    await k.writePart(part(p.target, 0, BODY.subarray(0, 50)), CTX)
    expect(await writeWhole(k, p.target)).toMatchObject({ done: true })
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })

  it('two attempts racing for one dir: exactly one writes, the other is stage_foreign', async () => {
    const { fake, core } = setup()
    const k = core()
    const results = await Promise.allSettled([
      writeWhole(k, p.target),
      k.writePart({ ...part(p.target, 0, BODY, { final: true }), attempt: OTHER }, CTX),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['stage_foreign'])
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })

  it.each([
    ['the staging name becomes a symlink', (f: FakeFs) => { f.file('/data/walnut/elsewhere', 'x'); f.symlink(p.staging, '/data/walnut/elsewhere') }],
    ['the transcript dir becomes a symlink', (f: FakeFs) => { f.dir('/data/walnut/fake-dir', 0o700); f.symlink(p.dir, '/data/walnut/fake-dir') }],
    ['the staging file is replaced by another inode', (f: FakeFs) => { f.file(p.staging, 'swapped', 0o600) }],
    ['the staging mode widens', (f: FakeFs) => { f.node(p.staging)!.mode = 0o644 }],
    ['the attempt dir mode widens', (f: FakeFs) => { f.node(p.xf)!.mode = 0o755 }],
    ['the staging gains a third name', (f: FakeFs) => { f.hardlink(p.staging, '/data/walnut/grab') }],
  ])('between parts, %s: stage_changed, no link, no unlink', async (_name, arrange) => {
    const { fake, core } = setup()
    const k = core()
    await k.writePart(part(p.target, 0, BODY.subarray(0, 100)), CTX)
    arrange(fake)
    const before = fake.calls.length
    await expect(k.writePart(part(p.target, 100, BODY.subarray(100), { final: true, size: BODY.length, sha256: sha(BODY) }), CTX))
      .rejects.toMatchObject({ code: 'stage_changed' })
    expect(fake.calls.slice(before).some((x) => x.op === 'link' || x.op === 'unlink' || x.op === 'write')).toBe(false)
  })

  it('a foreign file already holds the target name: target_exists, it is not replaced, the staging stays', async () => {
    const { fake, core } = setup()
    const k = core()
    await k.writePart(part(p.target, 0, BODY.subarray(0, 100)), CTX)
    fake.file(p.target, 'someone else', 0o600)
    await expect(k.writePart(part(p.target, 100, BODY.subarray(100), { final: true, size: BODY.length, sha256: sha(BODY) }), CTX))
      .rejects.toMatchObject({ code: 'target_exists' })
    expect(fake.bytes(p.target)!.toString()).toBe('someone else')
    expect(fake.node(p.staging)).not.toBeNull()
    expect(fake.calls.some((x) => x.op === 'unlink')).toBe(false)
  })
})

// ── FIFOs and devices under a record, staging or target name ────────────────

describe('private writePart: a FIFO or device under any name is refused without blocking or reading it', () => {
  const p = paths()
  const READ_ONLY = C.O_RDONLY | SAFE_OPEN
  /** The opens of one path, with their exact flags; reads, writes and other mutations on it. */
  const probe = (fake: FakeFs, at: string) => ({
    opens: fake.opens().filter((c) => c.path === at).map((c) => ({ op: c.op, flags: c.flags })),
    touched: fake.touched(at),
  })
  /** An attempt dir as this attempt made it, records included, after its first non-final part. */
  async function staged() {
    const ctx = setup()
    await ctx.core().writePart(part(p.target, 0, BODY.subarray(0, 100)), CTX)
    return ctx
  }

  it.each([
    ['.attempt is a FIFO', 'fifo', (f: FakeFs) => { f.dir(p.xf, 0o700); f.dir(p.dir, 0o700); f.special(p.attempt, 'fifo') }, p.attempt],
    ['.attempt is a character device', 'chr', (f: FakeFs) => { f.dir(p.xf, 0o700); f.dir(p.dir, 0o700); f.special(p.attempt, 'chr') }, p.attempt],
    ['.staged is a FIFO', 'fifo', (f: FakeFs) => { f.dir(p.xf, 0o700); f.dir(p.dir, 0o700); f.file(p.attempt, TOKEN + '\n'); f.special(p.staged, 'fifo') }, p.staged],
  ])('%s: stage_changed, opened once read-only non-blocking, never read', async (_name, _kind, arrange, at) => {
    const { fake, core } = setup()
    arrange(fake)
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'stage_changed' })
    expect(probe(fake, at)).toEqual({ opens: [{ op: 'open', flags: READ_ONLY }], touched: [] })
    expect(fake.mutations()).toEqual([])
  })

  it.each([['fifo' as const], ['chr' as const]])('the staging name becomes a %s between parts: stage_changed, read-only open only, zero reads or writes', async (kind) => {
    const { fake, core } = await staged()
    fake.special(p.staging, kind)
    const before = fake.calls.length
    await expect(core().writePart(part(p.target, 100, BODY.subarray(100), { final: true, size: BODY.length, sha256: sha(BODY) }), CTX))
      .rejects.toMatchObject({ code: 'stage_changed' })
    const after = fake.calls.slice(before)
    expect(after.filter((c) => c.path === p.staging && c.op.startsWith('open')).map((c) => ({ op: c.op, flags: c.flags })))
      .toEqual([{ op: 'open', flags: READ_ONLY }])
    expect(after.filter((c) => c.label !== undefined || (c.op === 'read' && c.path === p.staging))).toEqual([])
    expect(after.some((c) => c.op === 'link' || c.op === 'unlink')).toBe(false)
  })

  it('a FIFO under the target name after the staging name is gone: target_exists, the FIFO is never opened', async () => {
    const { fake, core } = setup()
    await writeWhole(core(), p.target)
    fake.special(p.target, 'fifo')
    const before = fake.calls.length
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'target_exists' })
    const after = fake.calls.slice(before)
    expect(after.filter((c) => c.path === p.target && c.op !== 'lstat')).toEqual([])
    expect(after.filter((c) => c.label !== undefined)).toEqual([])
  })

  it('a FIFO under the target name before the commit: target_exists at the link, the FIFO is never opened', async () => {
    const { fake, core } = await staged()
    fake.special(p.target, 'fifo')
    const before = fake.calls.length
    await expect(core().writePart(part(p.target, 100, BODY.subarray(100), { final: true, size: BODY.length, sha256: sha(BODY) }), CTX))
      .rejects.toMatchObject({ code: 'target_exists' })
    expect(fake.calls.slice(before).filter((c) => c.path === p.target && c.op !== 'lstat' && c.op !== 'link')).toEqual([])
    expect(fake.calls.some((c) => c.op === 'unlink')).toBe(false)
  })

  it('a FIFO in place of the attempt dir: stage_changed from its lstat, nothing opened under it', async () => {
    const { fake, core } = setup()
    fake.special(p.xf, 'fifo', 0o700)
    await expect(writeWhole(core(), p.target)).rejects.toMatchObject({ code: 'stage_changed' })
    expect(fake.opens()).toEqual([])
    expect(fake.mutations()).toEqual([])
  })
})

// ── the commit window ───────────────────────────────────────────────────────

describe('private writePart: link, nlink 2, guarded unlink, identity after', () => {
  const p = paths()
  const finalPart = () => part(p.target, 0, BODY, { final: true, size: BODY.length, sha256: sha(BODY) })

  /** Commit, then die right before the unlink: the target is published under two names. */
  async function published() {
    const ctx = setup()
    ctx.fake.crash = (label) => label === `unlink:.${SID}.jsonl.part`
    await expect(ctx.core().writePart(finalPart(), CTX)).rejects.toThrow(/crash/)
    ctx.fake.crash = null
    expect(ctx.fake.node(p.target)!.nlink).toBe(2)
    expect(ctx.fake.node(p.staging)!.ino).toBe(ctx.fake.node(p.target)!.ino)
    return { ...ctx, before: ctx.fake.calls.length }
  }
  const since = (fake: FakeFs, before: number) => fake.calls.slice(before)
  const mutationsSince = (fake: FakeFs, before: number) => since(fake, before).filter((c) => c.label !== undefined)

  it('a crash between link and unlink: the final retry only reads, then drops the staging name (no truncate, no write)', async () => {
    const { fake, core, before } = await published()
    expect(await core().writePart(finalPart(), CTX)).toEqual({ staged: BODY.length, done: true, sha256: sha(BODY), path: p.target })
    expect(mutationsSince(fake, before).map((c) => c.label)).toEqual([`unlink:.${SID}.jsonl.part`])
    // The published inode was opened read-only only, never for writing.
    const opened = since(fake, before).filter((c) => c.op === 'open' && c.path === p.staging)
    expect(opened.length).toBeGreaterThan(0)
    for (const o of opened) {
      expect(o.flags! & (C.O_WRONLY | C.O_RDWR)).toBe(0)
      expect(o.flags! & SAFE_OPEN).toBe(SAFE_OPEN)
    }
    expect(fake.node(p.staging)).toBeNull()
    expect(fake.node(p.target)!.nlink).toBe(1)
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })

  it('the same final part sent as its last chunk (offset > 0) also finishes read-only', async () => {
    const { fake, core, before } = await published()
    const tail = BODY.subarray(300)
    expect(await core().writePart(part(p.target, 300, tail, { final: true, size: BODY.length, sha256: sha(BODY) }), CTX)).toMatchObject({ done: true })
    expect(mutationsSince(fake, before).map((c) => c.label)).toEqual([`unlink:.${SID}.jsonl.part`])
  })

  const OTHER_BODY = Buffer.from(BODY.toString().replace('"n":1}', '"n":7}'))
  it.each([
    ['a non-final part at offset 0', () => part(p.target, 0, BODY), 'stage_changed'],
    ['a non-final later part', () => part(p.target, 100, BODY.subarray(100, 200)), 'stage_changed'],
    ['a final part with other bytes of the same size (and their sha)', () => part(p.target, 0, OTHER_BODY, { final: true, size: OTHER_BODY.length, sha256: sha(OTHER_BODY) }), 'checksum_mismatch'],
    ['a final part with the right bytes but another sha', () => part(p.target, 0, BODY, { final: true, size: BODY.length, sha256: 'b'.repeat(64) }), 'checksum_mismatch'],
    ['a final part with no sha', () => part(p.target, 0, BODY, { final: true, size: BODY.length }), 'checksum_mismatch'],
    ['a final part of another size', () => part(p.target, 0, BODY.subarray(0, 200), { final: true, size: 200, sha256: sha(BODY.subarray(0, 200)) }), 'size_mismatch'],
    ['a longer final part', () => part(p.target, 0, Buffer.concat([BODY, Buffer.from('x')]), { final: true }), 'size_mismatch'],
    ['a final part that ends short of the file', () => part(p.target, 100, BODY.subarray(100, 200), { final: true, size: BODY.length, sha256: sha(BODY) }), 'size_mismatch'],
  ])('after publish, %s: %s, and zero writes, truncates, links or unlinks', async (_name, cmd, code) => {
    const { fake, core, before } = await published()
    await expect(core().writePart(cmd(), CTX)).rejects.toMatchObject({ code })
    expect(mutationsSince(fake, before)).toEqual([])
    expect(since(fake, before).filter((c) => c.op === 'open' && (c.flags! & (C.O_WRONLY | C.O_RDWR)) !== 0)).toEqual([])
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
    expect(fake.node(p.target)!.nlink).toBe(2)
    // The right final part still finishes it afterwards.
    expect(await core().writePart(finalPart(), CTX)).toMatchObject({ done: true })
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })

  it('after publish, the retry\'s own unlink fails (died again): still zero writes; the next retry finishes', async () => {
    const { fake, core, before } = await published()
    fake.crash = (label) => label === `unlink:.${SID}.jsonl.part`
    await expect(core().writePart(finalPart(), CTX)).rejects.toThrow(/crash/)
    fake.crash = null
    expect(mutationsSince(fake, before).map((c) => c.label)).toEqual([`unlink:.${SID}.jsonl.part`])
    expect(fake.node(p.target)!.nlink).toBe(2)
    expect(await core().writePart(finalPart(), CTX)).toMatchObject({ done: true })
    expect(mutationsSince(fake, before).map((c) => c.label)).toEqual([`unlink:.${SID}.jsonl.part`, `unlink:.${SID}.jsonl.part`])
    expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
  })

  it('after publish, the staging name swapped for another inode: stage_changed, nothing written or unlinked', async () => {
    const { fake, core, before } = await published()
    fake.file(p.staging, BODY, 0o600)
    await expect(core().writePart(finalPart(), CTX)).rejects.toMatchObject({ code: 'stage_changed' })
    expect(mutationsSince(fake, before)).toEqual([])
  })

  it('nlink 2 where the second name is NOT the target: stage_changed, nothing unlinked', async () => {
    const { fake, core } = setup()
    const k = core()
    await k.writePart(part(p.target, 0, BODY.subarray(0, 100)), CTX)
    fake.hardlink(p.staging, '/data/walnut/other-name')
    await expect(k.writePart(part(p.target, 100, BODY.subarray(100), { final: true, size: BODY.length, sha256: sha(BODY) }), CTX))
      .rejects.toMatchObject({ code: 'stage_changed' })
    expect(fake.calls.some((c) => c.op === 'unlink' || c.op === 'link')).toBe(false)
  })

  it('the staging name swapped right after the link: no unlink, stage_changed', async () => {
    const { fake, core } = setup()
    fake.after = (label) => { if (label === `link:${SID}.jsonl`) fake.file(p.staging, 'swapped in', 0o600) }
    await expect(core().writePart(finalPart(), CTX)).rejects.toMatchObject({ code: 'stage_changed' })
    expect(fake.calls.some((c) => c.op === 'unlink')).toBe(false)
    expect(fake.bytes(p.staging)!.toString()).toBe('swapped in')
  })

  it('a final retry after the unlink: done only for the same inode with the same sha', async () => {
    const { fake, core } = setup()
    await core().writePart(finalPart(), CTX)
    expect(await core().writePart(finalPart(), CTX)).toEqual({ staged: BODY.length, done: true, sha256: sha(BODY), path: p.target })
  })

  it('after the unlink, a different file with the very same bytes under the target name: target_exists (sha never makes a file ours)', async () => {
    const { fake, core } = setup()
    await core().writePart(finalPart(), CTX)
    fake.file(p.target, BODY, 0o600)
    await expect(core().writePart(finalPart(), CTX)).rejects.toMatchObject({ code: 'target_exists' })
    expect(fake.calls.some((c) => c.op === 'unlink' && c.path === p.target)).toBe(false)
  })

  it('after the unlink, a non-final retry does not reopen the stage', async () => {
    const { core } = setup()
    await core().writePart(finalPart(), CTX)
    await expect(core().writePart(part(p.target, 0, BODY.subarray(0, 10)), CTX)).rejects.toMatchObject({ code: 'stage_changed' })
  })
})

// ── every interruption point, in record order ───────────────────────────────

describe('private writePart: a daemon that dies at any step, then a retry with the same token', () => {
  const p = paths()
  const finalPart = () => part(p.target, 0, BODY, { final: true, size: BODY.length, sha256: sha(BODY) })
  const STAGING = `.${SID}.jsonl.part`
  // The record order a clean single-part write makes (root already there).
  const ORDER = [
    `mkdir:${XF}`, `chmod:${XF}`, 'mkdir:transcript', 'chmod:transcript',
    'create:.attempt', 'chmod:.attempt', 'write:.attempt', 'sync:.attempt',
    `create:${STAGING}`, `chmod:${STAGING}`,
    'create:.staged', 'chmod:.staged', 'write:.staged', 'sync:.staged',
    `truncate:${STAGING}`, `write:${STAGING}`, `sync:${STAGING}`,
    `link:${SID}.jsonl`, `unlink:${STAGING}`,
  ]
  // What the retry answers when the daemon died right before that step.
  const RETRY: Record<string, string> = {
    [`mkdir:${XF}`]: 'done',
    [`chmod:${XF}`]: 'stage_changed', // the dir exists, its transcript dir does not
    'mkdir:transcript': 'stage_changed',
    'chmod:transcript': 'stage_foreign', // no .attempt: the dir proves nothing
    'create:.attempt': 'stage_foreign',
    'chmod:.attempt': 'stage_foreign', // .attempt is empty
    'write:.attempt': 'stage_foreign',
    'sync:.attempt': 'done',
    [`create:${STAGING}`]: 'done',
    [`chmod:${STAGING}`]: 'stage_incomplete', // a staging file nobody recorded
    'create:.staged': 'stage_incomplete',
    'chmod:.staged': 'stage_changed', // .staged is empty
    'write:.staged': 'stage_changed',
    'sync:.staged': 'done',
    [`truncate:${STAGING}`]: 'done',
    [`write:${STAGING}`]: 'done',
    [`sync:${STAGING}`]: 'done',
    [`link:${SID}.jsonl`]: 'done',
    [`unlink:${STAGING}`]: 'done', // nlink 2, both names this attempt's
  }

  it('the record order is the documented one', async () => {
    const { fake, core } = setup()
    await core().writePart(finalPart(), CTX)
    expect(fake.mutations().map((c) => c.label)).toEqual(ORDER)
  })

  it.each(ORDER.map((label) => [label]))('dies before %s', async (label) => {
    const { fake, core } = setup()
    fake.crash = (l) => l === label
    await expect(core().writePart(finalPart(), CTX)).rejects.toThrow(/crash/)
    fake.crash = null
    const before = fake.calls.length
    const outcome = await core().writePart(finalPart(), CTX).then(() => 'done', (e) => e.code)
    expect(outcome).toBe(RETRY[label])
    const after = fake.calls.slice(before)
    // Never a delete beyond this attempt's own staging name, never a write outside its dir.
    expect(after.filter((c) => c.op === 'unlink').every((c) => c.path === p.staging)).toBe(true)
    expect(fake.mutations().every((c) => c.path.startsWith(p.xf))).toBe(true)
    if (outcome === 'done') expect(fake.bytes(p.target)!.equals(BODY)).toBe(true)
    else expect(fake.node(p.target)).toBeNull()
  })
})
