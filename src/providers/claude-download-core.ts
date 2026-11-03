/**
 * The download half of Claude Code's resumable native install
 * (claude-install-core.ts), shared by both daemon twins: the release server,
 * small files (latest, a manifest), a manifest's entry, install.sh's platform
 * rule, sha256, and the big download kept in a `.part` and resumed with
 * `curl -C -` across attempts and Installs.
 *
 * Every process goes through host.fix's own runner (deps.run: its own process
 * group, a deadline, stopped when the daemon stops), so this file starts and
 * signals nothing by itself.
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createClaudeDownload.toString()` through the
 * `__CREATE_CLAUDE_DOWNLOAD__` placeholder, like createHostFix, which receives it
 * as `deps.claudeDownload` and hands it to the installer. So the factory body
 * references NOTHING at module scope (the type import below is erased), and
 * constructing it has no side effects.
 */

import type fsType from 'node:fs'

type Run = { code: number; stdout: string; stderr: string; timedOut: boolean }

/** A manifest's entry for one platform: a sha256 and, when it names one, a size. */
export type ClaudeReleaseEntry = { checksum: string; size?: number }
/** A small file fetched: `code` is curl's exit code (22: an HTTP error the server meant). */
export type ClaudeFetched = { ok: boolean; text: string; code: number; timedOut: boolean }

export interface ClaudeDownloadDeps {
  fs?: Pick<typeof fsType, 'statSync' | 'unlinkSync'>
  /** Live reference (process.env). */
  env: Record<string, string | undefined>
  os: { platform: () => string }
  runtime: { resolveOnPath: (cmd: string, pathStr: string) => string | null }
  /** host.fix's runner: its own process group, SIGTERM then SIGKILL on the deadline or a cancel. */
  run: (file: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string }) => Promise<Run>
  /** host.fix's log line for one command. */
  transcript: (logs: string[], argv: string[], r: Run) => void
  now: () => number
  /** The pause between download attempts; answers at once when the fix is cancelled. */
  sleep: (ms: number) => Promise<void>
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createClaudeDownload(deps: ClaudeDownloadDeps) {
  var DOWNLOADS = 'https://downloads.claude.ai/claude-code-releases'
  var SHA_RE = /^[a-fA-F0-9]{64}$/
  /** Attempts in a row that add no byte before the line counts as failing. */
  var MAX_IDLE_TRIES = 5

  type Entry = ClaudeReleaseEntry
  type Fetched = ClaudeFetched

  // host.fix's own, so the deadline, a cancel and the log reach every step here.
  var run = deps.run, transcript = deps.transcript, now = deps.now
  function pathStr(): string { return deps.env.PATH || '' }

  /** The release server; WALNUT_CLAUDE_DOWNLOADS points it elsewhere (tests use file://). */
  function downloadsBase(): string {
    var b = (deps.env.WALNUT_CLAUDE_DOWNLOADS || '').trim()
    return (b || DOWNLOADS).replace(/\/+$/, '')
  }

  /** Bytes in a regular file, -1 when there is none. */
  function sizeOf(p: string): number {
    try {
      var st = deps.fs!.statSync(p)
      return st.isFile() ? st.size : -1
    } catch { return -1 }
  }

  function remove(p: string): void { try { deps.fs!.unlinkSync(p) } catch { /* not there */ } }

  /** host.fix's pause: it answers at once when the fix is cancelled. */
  function pause(ms: number): Promise<void> { return deps.sleep(ms) }

  /** A small file (latest, a manifest) into memory; tried again once unless the server answered. */
  async function fetchText(curl: string, url: string, deadline: number, logs: string[]): Promise<Fetched> {
    var r: Run | null = null
    for (var i = 0; i < 2 && deadline - now() > 0; i++) {
      if (i) await pause(2000)
      r = await run(curl, ['-fsSL', '--connect-timeout', '30', '--max-time', '60', url], { timeoutMs: Math.max(1, Math.min(90000, deadline - now())) })
      // Never the body: a manifest would push everything else out of the 4KB tail.
      logs.push('$ ' + curl + ' -fsSL ' + url + (r.code === 0 ? '' : '\n' + r.stderr + '\n[exit ' + r.code + (r.timedOut ? ', timed out' : '') + ']'))
      // 22: an HTTP error the server meant (404), not the line.
      if (r.code === 0 || r.code === 22 || r.timedOut) break
    }
    return r ? { ok: r.code === 0, text: r.stdout, code: r.code, timedOut: r.timedOut } : { ok: false, text: '', code: -1, timedOut: true }
  }

  /** A manifest's entry for `platform`: a sha256 and, when it names one, a size. */
  function manifestEntry(text: string, platform: string): Entry | null {
    var m: unknown
    try { m = JSON.parse(text) } catch { return null }
    var platforms = m && typeof m === 'object' ? (m as { platforms?: unknown }).platforms : null
    var e = platforms && typeof platforms === 'object' ? (platforms as Record<string, unknown>)[platform] : null
    if (!e || typeof e !== 'object') return null
    var sum = (e as { checksum?: unknown }).checksum
    var size = (e as { size?: unknown }).size
    if (typeof sum !== 'string' || !SHA_RE.test(sum)) return null
    var out: Entry = { checksum: sum.toLowerCase() }
    if (typeof size === 'number' && size > 0 && Math.floor(size) === size) out.size = size
    return out
  }

  /** install.sh's platform rule: uname -m, Rosetta on a Mac, musl on Linux. */
  async function detectPlatform(deadline: number): Promise<string | null> {
    var os = deps.os.platform()
    if (os !== 'darwin' && os !== 'linux') return null
    var uname = deps.runtime.resolveOnPath('uname', pathStr())
    if (!uname) return null
    var m = await run(uname, ['-m'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
    var machine = m.code === 0 ? m.stdout.trim() : ''
    var arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'arm64' || machine === 'aarch64' ? 'arm64' : ''
    if (!arch) return null
    if (os === 'darwin') {
      // An x64 process under Rosetta on an Apple silicon Mac still gets the arm64 build.
      if (arch === 'x64') {
        var sysctl = deps.runtime.resolveOnPath('sysctl', pathStr()) || '/usr/sbin/sysctl'
        var t = await run(sysctl, ['-n', 'sysctl.proc_translated'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })
        if (t.code === 0 && t.stdout.trim() === '1') arch = 'arm64'
      }
      return 'darwin-' + arch
    }
    // Alpine's loader names, else what /bin/ls links against: a glibc host with
    // the musl package beside it is still glibc.
    var musl = sizeOf('/lib/libc.musl-x86_64.so.1') >= 0 || sizeOf('/lib/libc.musl-aarch64.so.1') >= 0
    if (!musl) {
      var ldd = deps.runtime.resolveOnPath('ldd', pathStr())
      var l = ldd ? await run(ldd, ['/bin/ls'], { timeoutMs: Math.max(1, Math.min(5000, deadline - now())) }) : null
      musl = !!l && /musl/i.test(l.stdout + '\n' + l.stderr)
    }
    return 'linux-' + arch + (musl ? '-musl' : '')
  }

  function shaTool(): string[] | null {
    var sum = deps.runtime.resolveOnPath('sha256sum', pathStr())
    if (sum) return [sum]
    var shasum = deps.runtime.resolveOnPath('shasum', pathStr())
    return shasum ? [shasum, '-a', '256'] : null
  }

  async function sha256(file: string, deadline: number, logs: string[]): Promise<string | null> {
    var tool = shaTool()
    if (!tool) return null
    var argv = tool.concat([file])
    var r = await run(argv[0], argv.slice(1), { timeoutMs: Math.max(1, deadline - now()) })
    var m = r.code === 0 ? /^([a-fA-F0-9]{64})\b/.exec(r.stdout.trim()) : null
    if (!m) transcript(logs, argv, r)
    return m ? m[1].toLowerCase() : null
  }

  /**
   * `url` into `part`, resumed from whatever it holds, until it has `size` bytes
   * (or curl calls it done, when the manifest names no size). Answers timeout
   * when `until` passes and failed when the line keeps failing; either way the
   * part stays, so the next attempt goes on from there.
   */
  async function download(curl: string, url: string, part: string, size: number | undefined, until: number, logs: string[]): Promise<'ok' | 'timeout' | 'failed'> {
    var fresh = false
    var idle = 0
    for (;;) {
      var have = sizeOf(part)
      if (size && have > size) {
        remove(part)
        logs.push('removed ' + part + ': larger than the ' + size + ' bytes the manifest names')
        have = -1
      }
      if (size && have === size) return 'ok'
      if (until - now() <= 0) return 'timeout'
      // --max-time: a curl that outlives this daemon still ends by the deadline.
      var args = ['-fsSL', '-C', '-', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '120', '--max-time', String(Math.max(1, Math.ceil((until - now()) / 1000))), '-o', part, url]
      var r = await run(curl, args, { timeoutMs: Math.max(1, until - now()) })
      var got = sizeOf(part)
      transcript(logs, [curl].concat(args), r)
      if (deps.log) deps.log('info', 'host.fix download', { url: url, from: Math.max(0, have), to: Math.max(0, got), size: size, code: r.code })
      if (r.timedOut) return 'timeout'
      if (size && got > size) {
        remove(part)
        logs.push('removed ' + part + ': the server sent more than the ' + size + ' bytes the manifest names')
        return 'failed'
      }
      if (r.code === 0 && (!size || got === size)) return 'ok'
      // A server or proxy that ignores Range: curl will not resume (33; 36 for an
      // offset it cannot use; an HTTP 416), or it forgives a 416 and adds nothing.
      // Once from zero; a second refusal is a failure.
      if (have > 0 && (r.code === 33 || r.code === 36 || (r.code === 22 && /\b416\b/.test(r.stderr)) || (r.code === 0 && got === have))) {
        if (fresh) return 'failed'
        fresh = true
        remove(part)
        logs.push('the server did not resume ' + url + ': starting it again from zero')
        continue
      }
      idle = got > Math.max(0, have) ? 0 : idle + 1
      if (idle >= MAX_IDLE_TRIES) return 'failed'
      // Straight on after a cut that brought bytes; longer while nothing comes.
      await pause(Math.min(idle ? 5000 * idle : 1000, Math.max(0, until - now())))
    }
  }

  return {
    downloadsBase: downloadsBase, sizeOf: sizeOf, remove: remove, fetchText: fetchText, manifestEntry: manifestEntry,
    detectPlatform: detectPlatform, shaTool: shaTool, sha256: sha256, download: download,
  }
}

export type ClaudeDownload = ReturnType<typeof createClaudeDownload>
