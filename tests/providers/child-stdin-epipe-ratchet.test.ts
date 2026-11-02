/**
 * Ratchet: no write stream Walnut writes into can end the process with an
 * 'error' event nobody hears.
 *
 * On bun, a child's stdin is an fs WriteStream. When the child stops reading
 * (it exited, or an interrupt tore its group down) while bytes are still in
 * the pipe, the write fails with EPIPE as an 'error' EVENT on that stream; a
 * try/catch around write() or end() never sees it. With no listener the event
 * becomes an uncaughtException, and both the server (src/web/server.ts) and
 * the daemon (daemon-standalone.ts) exit on one. 2026-11-02: the ACP worker's
 * stdin in acp-daemon.ts had none, an "Interrupt & send" crashed the browser
 * fixture server (its MockDaemon embeds that module), and 87 specs after it
 * failed on ECONNREFUSED. In production that module runs in the local daemon.
 * A file write stream fails the same way (a full disk, a folder that is gone).
 *
 * This file finds, from the source:
 *  - every place that writes data into a child's stdin (`X.stdin.write(...)`,
 *    `X.stdin.end(<data>)`, `.pipe(X.stdin)`, a `const s = X.stdin` alias
 *    written to), and fails on one whose stream has no 'error' listener: in
 *    the scope of the receiver's own assignment for a plain name, in the file
 *    for a property (`entry.proc` is the `proc` its spawn site guarded). An
 *    empty `end()` is not counted: with nothing to flush it never fails (bun 1.4);
 *  - every fs.createWriteStream(...), which must be handed to pipeline() or get
 *    an 'error' listener before the code first awaits or yields after making it
 *    (the event can only arrive once the code gives the loop a turn).
 * The server's own stdout and stderr are guarded too (src/lib/stdio-epipe-guard.ts).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/**
 * The source with comments blanked (newlines kept, so line numbers hold). Strings
 * and template literals are skipped over, so a `'**' + '/*.ts'` glob in a string
 * does not swallow the code after it.
 */
export function code(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j++
        else if (ch !== '`' && src[j] === '\n') break
        j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** `code(src)` with string and template contents blanked too: what the scans search for code in. */
export function bare(src: string): string {
  return code(src).replace(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g, (_m, q: string, body: string) => q + body.replace(/[^\n]/g, ' ') + q)
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ID = '[A-Za-z_$][\\w$]*'
const RECEIVER = `${ID}(?:\\s*[!?]*\\.${ID})*`
const ON_ERROR = `\\s*[!?]*\\.(?:on|once|addListener|prependListener)\\(\\s*['"]error['"]`

export interface StdinWrite { receiver: string; index: number; line: number; text: string }

function lineAt(c: string, i: number): { line: number; text: string } {
  const line = c.slice(0, i).split('\n').length
  return { line, text: c.split('\n')[line - 1]!.trim() }
}

/** Every place `src` writes data into a child's stdin. */
export function stdinWrites(src: string): StdinWrite[] {
  const c = bare(src)
  const out: StdinWrite[] = []
  const push = (receiver: string, index: number) => {
    const r = receiver.replace(/\s+/g, '').replace(/[!?]/g, '')
    if (r === 'process' || r.endsWith('.process')) return
    out.push({ receiver: r, index, ...lineAt(c, index) })
  }
  // X.stdin.write(...) / X.stdin.end(<data>); an empty end() flushes nothing.
  for (const m of c.matchAll(new RegExp(`(?<![\\w$.])(${RECEIVER})\\s*[!?]*\\.stdin\\s*[!?]*\\.\\s*(write|end)\\(\\s*(\\S)`, 'g'))) {
    if (m[2] === 'end' && m[3] === ')') continue
    push(m[1]!, m.index!)
  }
  // something.pipe(X.stdin)
  for (const m of c.matchAll(new RegExp(`\\.pipe\\(\\s*(${RECEIVER})\\s*[!?]*\\.stdin\\s*!?\\s*\\)`, 'g'))) push(m[1]!, m.index!)
  // const s = X.stdin; s.write(...) / s.end(<data>)
  for (const a of c.matchAll(new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*(${RECEIVER})\\s*[!?]*\\.stdin\\b(?!\\s*[!?]*\\.)`, 'g'))) {
    for (const m of c.matchAll(new RegExp(`(?<![\\w$.])${esc(a[1]!)}\\s*[!?]*\\.(write|end)\\(\\s*(\\S)`, 'g'))) {
      if (m[1] === 'end' && m[2] === ')') continue
      out.push({ receiver: `${a[1]} (= ${a[2]!.replace(/\s+/g, '')}.stdin)`, index: m.index!, ...lineAt(c, m.index!) })
    }
  }
  return out
}

/**
 * The stretch of `c` in which the plain name `name` at `at` keeps meaning the same
 * child: from its last assignment before `at` to its next one after it.
 */
function assignmentScope(c: string, name: string, at: number): [number, number] {
  const assigns = [...c.matchAll(new RegExp(`(?:(?:const|let|var)\\s+${esc(name)}\\b|(?<![\\w$.])${esc(name)}\\s*=(?!=))`, 'g'))].map((m) => m.index!)
  const before = assigns.filter((i) => i < at)
  const after = assigns.filter((i) => i > at)
  return [before.length ? before[before.length - 1]! : 0, after.length ? after[0]! : c.length]
}

/** The body of `function name(...) { ... }` in `c`, by brace matching; null when there is none. */
function functionBody(c: string, name: string): string | null {
  const m = new RegExp(`function\\s+${esc(name)}\\s*\\(`).exec(c)
  if (!m) return null
  const open = c.indexOf('{', m.index)
  if (open < 0) return null
  const b = bare(c)
  let depth = 0
  for (let i = open; i < b.length; i++) {
    if (b[i] === '{') depth++
    else if (b[i] === '}' && --depth === 0) return c.slice(open, i + 1)
  }
  return null
}

/** Whether `src` listens for 'error' on the stdin that `w` writes to. */
export function hasStdinErrorListener(src: string, w: StdinWrite): boolean {
  const c = code(src)
  const alias = /^(\S+) \(= (.+)\.stdin\)$/.exec(w.receiver)
  if (alias) {
    const [from, to] = assignmentScope(c, alias[1]!, w.index)
    return new RegExp(`(?<![\\w$.])${esc(alias[1]!)}${ON_ERROR}`).test(c.slice(from, to))
  }
  const listens = (name: string, text: string) => {
    const r = esc(name).replace(/\\\./g, '\\s*[!?]*\\.')
    const direct = new RegExp(`(?<![\\w$])${r}\\s*[!?]*\\.stdin${ON_ERROR}`)
    // for (const s of [child.stdout, child.stdin, ...]) s.on('error', ...)
    const loop = new RegExp(`of\\s*\\[[^\\]]*(?<![\\w$])${r}\\s*[!?]*\\.stdin\\b[^\\]]*\\]\\s*\\)\\s*(?:\\{\\s*)?(${ID})${ON_ERROR}`)
    return direct.test(text) || loop.test(text)
  }
  if (!w.receiver.includes('.')) {
    // A plain name: the listener must be on the same child (daemon-connection.ts
    // spawns four `proc`s), so only its own assignment's scope counts, or the
    // local spawn helper that assignment calls, when that helper guards its child
    // (oneshot-core.ts: `var child = spawnChild(spec)`).
    const [from, to] = assignmentScope(c, w.receiver, w.index)
    if (listens(w.receiver, c.slice(from, to))) return true
    const rhs = /=\s*([^;\n]*)/.exec(c.slice(from, to))?.[1] ?? ''
    return [...rhs.matchAll(new RegExp(`(?<![\\w$.])(${ID})\\(`, 'g'))].some((m) => {
      const body = functionBody(c, m[1]!)
      return body !== null && /\.stdin\s*[!?]*\.(?:on|once)\(\s*['"]error['"]/.test(body)
    })
  }
  // A property (`entry.proc`, `run.child`): the child its spawn site stored there,
  // usually under the property's own name.
  return listens(w.receiver, c) || listens(w.receiver.split('.').pop()!, c)
}

export interface FileStream { name: string | null; index: number; line: number; text: string }

/** Every fs.createWriteStream(...) in `src` that is not an argument of pipeline(). */
export function fileStreams(src: string): FileStream[] {
  const c = bare(src)
  const out: FileStream[] = []
  for (const m of c.matchAll(/(?<![\w$])createWriteStream\(/g)) {
    const stmt = c.slice(Math.max(c.lastIndexOf(';', m.index!), c.lastIndexOf('\n', m.index!)) + 1, m.index!)
    if (/\bpipeline\(/.test(stmt)) continue
    const assigned = new RegExp(`(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*[^;\\n]*$`).exec(stmt)
    out.push({ name: assigned ? assigned[1]! : null, index: m.index!, ...lineAt(c, m.index!) })
  }
  return out
}

/** Whether the stream gets a listener (or goes into pipeline) before the code first awaits or yields. */
export function fileStreamHeard(src: string, s: FileStream): boolean {
  if (!s.name) return false
  const c = code(src)
  const rest = c.slice(s.index)
  const heard = new RegExp(`(?<![\\w$.])${esc(s.name)}${ON_ERROR}|\\bpipeline\\([^;]*(?<![\\w$.])${esc(s.name)}\\b`).exec(rest)
  if (!heard) return false
  // `await pipeline(..., w)` hands it over in the same breath as the await.
  return !/\b(?:await|yield)\b/.test(rest.slice(0, heard.index).replace(/\bawait\s*$/, ''))
}

describe('the ratchet reads the source the way it should', () => {
  it('finds writes, pipes and aliases, and skips process.stdin, an empty end(), comments and strings', () => {
    const src = [
      'child.stdin.write(x)',
      'entry.proc.stdin!.write(JSON.stringify(m))',
      'proc.stdin?.end(input)',
      'child.stdin.end()',
      'process.stdin.write("no")',
      'req.pipe(gunzip).pipe(child.stdin)',
      'const stdin = p.stdin; stdin.end(src)',
      '// child.stdin.write(commented)',
      '/* other.stdin.write(also a comment) */',
      "const glob = '**/*.ts'; const s = 'a.stdin.write(in a string)'",
      'last.stdin.write(after the glob string)',
    ].join('\n')
    expect(stdinWrites(src).map((w) => w.receiver)).toEqual(['child', 'entry.proc', 'proc', 'last', 'child', 'stdin (= p.stdin)'])
  })

  it('accepts a listener on the same child only', () => {
    const guarded = (src: string) => stdinWrites(src).every((w) => hasStdinErrorListener(src, w))
    expect(guarded('child.stdin.write(x)')).toBe(false)
    expect(guarded("child.stdin.on('error', () => {})\nchild.stdin.write(x)")).toBe(true)
    expect(guarded("child.stdin?.once('error', f); child.stdin?.end(x)")).toBe(true)
    expect(guarded("proc.stdin?.on('error', log)\nentry.proc.stdin!.write(x)")).toBe(true)
    expect(guarded("for (const stream of [child.stdout, child.stdin]) stream.on('error', () => {})\nchild.stdin.write(x)")).toBe(true)
    expect(guarded("const s = p.stdin; s.on('error', () => {}); s.end(x)")).toBe(true)
    expect(guarded('const s = p.stdin; s.end(x)')).toBe(false)
    expect(guarded("other.stdin.on('error', f)\nchild.stdin.write(x)")).toBe(false)
    // Two children under one name: the guarded first one does not cover the second.
    expect(guarded([
      "function a() { const proc = spawn('a'); proc.stdin.on('error', f); proc.stdin.end(x) }",
      "function b() { const proc = spawn('b'); proc.stdin.end(y) }",
    ].join('\n'))).toBe(false)
    expect(guarded([
      "function a() { const proc = spawn('a'); proc.stdin.on('error', f); proc.stdin.end(x) }",
      "function b() { const proc = spawn('b'); proc.stdin!.on('error', f); proc.stdin.end(y) }",
    ].join('\n'))).toBe(true)
    // A child made by a local helper that guards it (oneshot-core.ts spawnChild).
    const helper = "function spawnChild(s) { var c = deps.spawn(s); if (c.stdin) c.stdin.on('error', function () {}); return c }"
    expect(guarded(`${helper}\nfunction run(s) { var child = pooled ? pooled.child : spawnChild(s); child.stdin.write(input) }`)).toBe(true)
    expect(guarded("function spawnChild(s) { return deps.spawn(s) }\nfunction run(s) { var child = spawnChild(s); child.stdin.write(input) }")).toBe(false)
  })

  it('wants a file stream heard before the first await, or handed to pipeline()', () => {
    const heard = (src: string) => fileStreams(src).every((s) => fileStreamHeard(src, s))
    expect(heard("await pipeline(a, fs.createWriteStream(p))")).toBe(true)
    expect(heard("const out = fs.createWriteStream(p)\nout.on('error', reject)")).toBe(true)
    expect(heard("const out = opts.dst ? fs.createWriteStream(opts.dst) : null\nout?.on('error', f)")).toBe(true)
    expect(heard("const w = createWriteStream(p)\nawait pipeline(src, w)")).toBe(true)
    expect(heard('const out = fs.createWriteStream(p)\nsrc.pipe(out)')).toBe(false)
    expect(heard("const w = createWriteStream(p)\nawait reader.read()\nw.on('error', f)")).toBe(false)
    expect(heard('src.pipe(fs.createWriteStream(p))')).toBe(false)
  })
})

const files = sourceFiles('src').filter((f) => !f.endsWith('.orig'))
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

describe("every child's stdin Walnut writes into has an error listener", () => {
  const sites = files.flatMap((f) => {
    const src = read(f)
    return stdinWrites(src).map((w) => ({ file: f, ...w, guarded: hasStdinErrorListener(src, w) }))
  })

  it('still finds the writes it was written against', () => {
    // A rewrite of the patterns that silently matched nothing would pass forever.
    expect(sites.length).toBeGreaterThanOrEqual(20)
    const known = ['src/providers/acp-daemon.ts', 'src/providers/oneshot-core.ts', 'src/core/stt/daemon-source.ts', 'src/web/routes/git-http.ts', 'src/providers/daemon-connection.ts']
    for (const f of known) expect(sites.some((s) => s.file === f), `${f} writes to a child's stdin`).toBe(true)
  })

  it('has no stdin write without a listener', () => {
    const unguarded = sites.filter((s) => !s.guarded).map((s) => `${s.file}:${s.line}  ${s.text}`)
    expect(unguarded, "a child's stdin is written with no 'error' listener: an EPIPE there (the child stopped reading) " +
      "is an uncaughtException that ends the server or the daemon. Add `<child>.stdin.on('error', ...)` at the spawn " +
      "(log or ignore EPIPE: the child's exit reports what happened)").toEqual([])
  })
})

describe('every file write stream is heard', () => {
  const streams = files.flatMap((f) => {
    const src = read(f)
    return fileStreams(src).map((s) => ({ file: f, ...s, heard: fileStreamHeard(src, s) }))
  })

  it('still finds the streams it was written against', () => {
    expect(streams.length).toBeGreaterThanOrEqual(4)
    for (const f of ['src/core/stt/setup.ts', 'src/core/protected-reader.ts']) expect(streams.some((s) => s.file === f)).toBe(true)
  })

  it('has no file write stream that can fail unheard', () => {
    const unheard = streams.filter((s) => !s.heard).map((s) => `${s.file}:${s.line}  ${s.text}`)
    expect(unheard, "a write stream gets no 'error' listener before the code awaits or yields (or never): a full disk " +
      "or a missing folder is then an uncaughtException. Listen right after createWriteStream, or hand it to pipeline()").toEqual([])
  })
})

describe('the server hears its own stdout and stderr', () => {
  it("installExitDiagnostics calls guardProcessStdio (a piping parent's reader can go too)", () => {
    const server = code(read('src/web/server.ts'))
    const install = server.slice(server.indexOf('function installExitDiagnostics('))
    expect(install.slice(0, install.indexOf('\n}\n')), 'installExitDiagnostics must call guardProcessStdio (src/lib/stdio-epipe-guard.ts)')
      .toMatch(/guardProcessStdio\(/)
  })
})
