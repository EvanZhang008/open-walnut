/**
 * host.fix's build-dtach, shared by both daemon twins: compile the vendored
 * dtach the server sends into ~/.local/bin/walnut-dtach.
 *
 * Every process goes through host.fix's own runner (deps.run: its own process
 * group, a deadline, stopped when the daemon stops), so this file starts and
 * signals nothing by itself.
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createDtachBuild.toString()` through the `__CREATE_DTACH_BUILD__`
 * placeholder, like createHostFix, which receives it as `deps.dtachBuild`. So
 * the factory body references NOTHING at module scope (the type import below is
 * erased), and constructing it has no side effects.
 */

import type fsType from 'node:fs'

type Run = { code: number; stdout: string; stderr: string; timedOut: boolean }

/** A step's answer, as host.fix's results carry it. */
export type DtachBuildResult = { ok: boolean; error?: string; manualCommand?: string; log?: string; skipped?: boolean; path?: string }

export interface DtachBuildDeps {
  fs?: Pick<typeof fsType, 'mkdtempSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync' | 'rmdirSync'>
  /** Live reference (process.env). */
  env: Record<string, string | undefined>
  os: { platform: () => string; tmpdir: () => string }
  /** host.fix's runner: its own process group, SIGTERM then SIGKILL on the deadline or a cancel. */
  run: (file: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string }) => Promise<Run>
  /** host.fix's log line for one command. */
  transcript: (logs: string[], argv: string[], r: Run) => void
  now: () => number
  /** The first of cc, gcc, clang on PATH (host.fix's, shared with install-compiler). */
  findCompiler: () => string | null
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createDtachBuild(deps: DtachBuildDeps) {
  var DTACH_C = ['attach.c', 'main.c', 'master.c']
  var DTACH_FILES = DTACH_C.concat(['dtach.h', 'config.h'])
  var MAX_SOURCE_B64 = 512 * 1024
  var run = deps.run, transcript = deps.transcript, now = deps.now

  function home(): string { return deps.env.HOME || '/root' }

  function removeDir(dir: string, names: string[]): void {
    if (!deps.fs) return
    for (var i = 0; i < names.length; i++) { try { deps.fs.unlinkSync(dir + '/' + names[i]) } catch { /* not written */ } }
    try { deps.fs.rmdirSync(dir) } catch { /* not empty or gone */ }
  }

  /**
   * The usage banner, not just the word: a spawn error names the walnut-dtach
   * file too. Same check as DTACH_BANNER in src/web/terminal/dtach-probe-script.ts.
   */
  async function isDtach(p: string, deadline: number): Promise<boolean> {
    var r = await run(p, ['--help'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
    return (r.stdout + r.stderr).toLowerCase().indexOf('dtach - version') >= 0
  }

  /** Exactly the vendored file set, each value plain base64 of a sane size. */
  function validSources(raw: unknown): Record<string, string> | null {
    if (!raw || typeof raw !== 'object') return null
    var src = raw as Record<string, unknown>
    var keys = Object.keys(src)
    if (keys.length !== DTACH_FILES.length) return null
    for (var i = 0; i < DTACH_FILES.length; i++) {
      var v = src[DTACH_FILES[i]]
      if (typeof v !== 'string' || !v || v.length > MAX_SOURCE_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(v)) return null
    }
    return src as Record<string, string>
  }

  async function buildDtach(params: Record<string, unknown>, deadline: number, logs: string[]): Promise<DtachBuildResult> {
    var bin = home() + '/.local/bin/walnut-dtach'
    if (await isDtach(bin, deadline)) return { ok: true, skipped: true, path: bin }
    var sources = validSources(params.sources)
    if (!sources) return { ok: false, error: 'bad-sources' }
    var cc = deps.findCompiler()
    if (!cc) return { ok: false, error: 'no-compiler' }
    // A Mac's /usr/bin/cc exists even without the Command Line Tools, and running
    // it then opens an install dialog on that Mac's screen. `xcode-select -p` asks
    // quietly whether they are there.
    if (deps.os.platform() === 'darwin') {
      var clt = await run('/usr/bin/xcode-select', ['-p'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
      if (clt.code !== 0) return { ok: false, error: 'darwin-needs-command-line-tools', manualCommand: 'xcode-select --install' }
    }
    if (!deps.fs) return { ok: false, error: 'internal', log: 'fs unavailable' }
    var dir = deps.fs.mkdtempSync(deps.os.tmpdir().replace(/\/$/, '') + '/walnut-dtach-build-')
    // Built next to its final path, then renamed: a half-written binary never
    // sits where the terminal probe would trust it, and no EXDEV across mounts.
    var partial = bin + '.' + now() + '.partial'
    try {
      for (var i = 0; i < DTACH_FILES.length; i++) {
        deps.fs.writeFileSync(dir + '/' + DTACH_FILES[i], Buffer.from(sources[DTACH_FILES[i]], 'base64'))
      }
      deps.fs.mkdirSync(home() + '/.local/bin', { recursive: true })
      var args = ['-O2', '-I.', '-o', partial].concat(DTACH_C, ['-lutil'])
      var r = await run(cc, args, { timeoutMs: Math.max(1, deadline - now()), cwd: dir })
      transcript(logs, [cc].concat(args), r)
      if (r.timedOut) return { ok: false, error: 'timeout' }
      if (r.code !== 0) return { ok: false, error: 'build-failed' }
      if (!(await isDtach(partial, deadline))) return { ok: false, error: 'verify-failed' }
      deps.fs.renameSync(partial, bin)
      return { ok: true, path: bin }
    } finally {
      try { deps.fs.unlinkSync(partial) } catch { /* renamed or never built */ }
      removeDir(dir, DTACH_FILES)
    }
  }

  return { buildDtach: buildDtach }
}

export type DtachBuild = ReturnType<typeof createDtachBuild>
