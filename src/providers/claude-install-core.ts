/**
 * Claude Code's native install for host.fix (install-claude-native, and
 * update-claude when the updater fails), shared by both daemon twins.
 *
 * install.sh fetches the ~330MB binary with one plain curl and no resume, so a
 * line too slow to finish inside the cap loses the whole download every time
 * (2026-11-03: 125KB/s, every Install cut off). nativeInstall does its steps:
 * the same files, platform rule and checksums, with the download kept in
 * ~/.claude/downloads/*.part and resumed (`curl -C -`) by every later attempt.
 * When that path cannot be used here, install.sh runs as before.
 *
 * Every process goes through host.fix's own runner (deps.run: its own process
 * group, a deadline, stopped when the daemon stops), so this file starts and
 * signals nothing by itself.
 *
 * How each twin gets it: daemon-standalone.ts imports it; daemon-source.ts
 * inlines `createClaudeInstall.toString()` through the `__CREATE_CLAUDE_INSTALL__`
 * placeholder, like createHostFix, which receives it as `deps.claudeInstall`
 * (and hands it the download half as `deps.download`, claude-download-core.ts).
 * So the factory body references NOTHING at module scope (the type imports
 * below are erased), and constructing it has no side effects.
 */

import type fsType from 'node:fs'
import type { ClaudeReleaseEntry, createClaudeDownload } from './claude-download-core.js'

type Run = { code: number; stdout: string; stderr: string; timedOut: boolean }

/** A step's answer, as host.fix's results carry it. */
export type ClaudeInstallResult = { ok: boolean; error?: string; manualCommand?: string; log?: string }

export interface ClaudeInstallDeps {
  fs?: Pick<typeof fsType, 'mkdtempSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync' | 'rmdirSync' | 'statSync' | 'readdirSync' | 'chmodSync'>
  /** Live reference (process.env). */
  env: Record<string, string | undefined>
  os: { platform: () => string; tmpdir: () => string }
  runtime: { resolveOnPath: (cmd: string, pathStr: string) => string | null }
  /** host.fix's runner: its own process group, SIGTERM then SIGKILL on the deadline or a cancel. */
  run: (file: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string }) => Promise<Run>
  /** host.fix's log line for one command. */
  transcript: (logs: string[], argv: string[], r: Run) => void
  now: () => number
  /** The pause between download attempts; answers at once when the fix is cancelled. */
  sleep: (ms: number) => Promise<void>
  /** have >= need, by major.minor.patch. */
  atLeast: (have: string, need: string) => boolean
  /** The official install.sh and the line a human runs instead. */
  installUrl: string
  installLine: string
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
  /** claude-download-core.ts's factory: the twins import or inline it like this one. */
  download: typeof createClaudeDownload
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createClaudeInstall(deps: ClaudeInstallDeps) {
  var INSTALL_URL = deps.installUrl
  var INSTALL_LINE = deps.installLine

  type Result = ClaudeInstallResult

  // host.fix's own, so the deadline, a cancel and the log reach every step here.
  var run = deps.run, transcript = deps.transcript, now = deps.now, atLeast = deps.atLeast
  function home(): string { return deps.env.HOME || '/root' }
  function pathStr(): string { return deps.env.PATH || '' }

  function removeDir(dir: string, names: string[]): void {
    if (!deps.fs) return
    for (var i = 0; i < names.length; i++) { try { deps.fs.unlinkSync(dir + '/' + names[i]) } catch { /* not written */ } }
    try { deps.fs.rmdirSync(dir) } catch { /* not empty or gone */ }
  }

  /**
   * Claude Code installed natively: the installer's own steps, resumable, else
   * the official install.sh. Null when it succeeded, else why not. `minVersion`
   * (the server's floor, '' for none): a kept download of an older release is removed.
   */
  async function install(deadline: number, logs: string[], minVersion: string): Promise<Result | null> {
    var native = await nativeInstall(deadline, logs, minVersion)
    return native !== undefined ? native : runInstallScript(deadline, logs)
  }


  // ── the native installer's steps, resumable (see the file comment) ──

  var VERSION_RE = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/
  /** Kept free at the end of the cap for the checksums, the unpack and `claude install`. */
  var FINISH_MS = 120000
  /** Manifest lookups for releases whose download was kept, newest progress first. */
  var MAX_RELEASE_LOOKUPS = 3

  type Entry = ClaudeReleaseEntry
  type Release = { version: string; plain: Entry; zst?: Entry }

  // The download half (claude-download-core.ts), on host.fix's runner like every step here.
  var dl = deps.download({ fs: deps.fs, env: deps.env, os: deps.os, runtime: deps.runtime, run: run, transcript: transcript, now: now, sleep: deps.sleep, log: deps.log })
  var downloadsBase = dl.downloadsBase, sizeOf = dl.sizeOf, remove = dl.remove, fetchText = dl.fetchText, manifestEntry = dl.manifestEntry
  var detectPlatform = dl.detectPlatform, shaTool = dl.shaTool, sha256 = dl.sha256, download = dl.download

  /**
   * `<base>/<version>`'s manifests. `gone`: the server answered and has nothing
   * usable for us; neither: the line failed on the way.
   */
  async function lookupRelease(curl: string, base: string, version: string, platform: string, deadline: number, logs: string[]): Promise<{ rel: Release | null; gone: boolean }> {
    var m = await fetchText(curl, base + '/' + version + '/manifest.json', deadline, logs)
    var plain = m.ok ? manifestEntry(m.text, platform) : null
    if (!plain) {
      if (m.ok) logs.push('no ' + platform + ' entry in the ' + version + ' manifest')
      return { rel: null, gone: m.ok || (m.code === 22 && !m.timedOut) }
    }
    var rel: Release = { version: version, plain: plain }
    // The compressed build is about a third of the size. Like install.sh, only
    // with zstd here and a size to hold the unpacked file to.
    if (plain.size && deps.runtime.resolveOnPath('zstd', pathStr())) {
      var z = await fetchText(curl, base + '/' + version + '/manifest.zst.json', deadline, logs)
      var zst = z.ok ? manifestEntry(z.text, platform) : null
      if (zst) rel.zst = zst
    }
    return { rel: rel, gone: false }
  }

  /** Downloads earlier attempts kept for this platform. */
  function keptParts(dir: string, platform: string): Array<{ version: string; path: string; bytes: number }> {
    var names: string[]
    try { names = deps.fs!.readdirSync(dir) as unknown as string[] } catch { return [] }
    var tails = ['-' + platform + '.zst.part', '-' + platform + '.part']
    var out: Array<{ version: string; path: string; bytes: number }> = []
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i])
      if (n.indexOf('claude-') !== 0) continue
      for (var t = 0; t < tails.length; t++) {
        var tl = tails[t]
        if (n.length <= 7 + tl.length || n.slice(n.length - tl.length) !== tl) continue
        var v = n.slice(7, n.length - tl.length)
        if (VERSION_RE.test(v)) out.push({ version: v, path: dir + '/' + n, bytes: Math.max(0, sizeOf(dir + '/' + n)) })
        break
      }
    }
    return out
  }

  /**
   * The release with the most bytes kept while its manifest is still served
   * (latest may have moved on since), else latest. Removed: parts of a release
   * below the floor (never resumed: it would install a Claude Code the server
   * refuses), parts of one the server no longer has and, once one is chosen, those
   * behind it; a part whose manifest the line failed to bring stays. 'line':
   * latest's own manifest did not come.
   */
  async function chooseRelease(curl: string, base: string, dir: string, platform: string, latest: string, minVersion: string, deadline: number, logs: string[]): Promise<Release | 'line' | null> {
    var parts = keptParts(dir, platform)
    var bytes: Record<string, number> = {}
    for (var i = 0; i < parts.length; i++) bytes[parts[i].version] = (bytes[parts[i].version] || 0) + parts[i].bytes
    var order = Object.keys(bytes).filter(function (v) { return v !== latest }).sort(function (a, b) { return bytes[b] - bytes[a] })
    var at = 0
    while (at < order.length && bytes[order[at]] > (bytes[latest] || 0)) at++
    order.splice(at, 0, latest)
    var chosen: Release | null = null
    var chosenAt = -1
    var latestOnLine = false
    var drop: Record<string, boolean> = {}
    for (var f = 0; f < order.length; f++) if (order[f] !== latest && minVersion && !atLeast(order[f], minVersion)) drop[order[f]] = true
    var lookups = 0
    for (var j = 0; j < order.length && !chosen; j++) {
      var v = order[j]
      if (drop[v]) continue
      if (v !== latest && lookups >= MAX_RELEASE_LOOKUPS) continue
      lookups++
      var found = await lookupRelease(curl, base, v, platform, deadline, logs)
      if (found.rel) { chosen = found.rel; chosenAt = j } else if (found.gone) drop[v] = true
      else if (v === latest) latestOnLine = true
    }
    if (chosen) for (var k = chosenAt + 1; k < order.length; k++) drop[order[k]] = true
    for (var p = 0; p < parts.length; p++) {
      if (!drop[parts[p].version]) continue
      remove(parts[p].path)
      logs.push('removed ' + parts[p].path + ': release ' + parts[p].version + ' is not the one being installed')
    }
    if (chosen && chosen.version !== latest) logs.push('resuming the kept download of ' + chosen.version + ' (latest is ' + latest + ')')
    return chosen || (latestOnLine ? 'line' : null)
  }

  /** rename, else a copy when the two sit on different filesystems. */
  async function move(from: string, to: string, deadline: number, logs: string[]): Promise<void> {
    try {
      deps.fs!.renameSync(from, to)
      return
    } catch (e) {
      if (!e || (e as { code?: unknown }).code !== 'EXDEV') throw e
    }
    var cp = deps.runtime.resolveOnPath('cp', pathStr()) || '/bin/cp'
    var r = await run(cp, [from, to], { timeoutMs: Math.max(1, deadline - now()) })
    if (r.code !== 0) {
      transcript(logs, [cp, from, to], r)
      throw new Error('could not copy ' + from + ' to ' + to)
    }
  }

  /**
   * undefined: no curl or sha256 tool, an unknown platform, no manifest or no
   * entry for it: install.sh runs instead. null: installed. Else why not; a line
   * failing on `latest` or a manifest is download-failed, since install.sh would
   * cross the same line with no resume.
   */
  async function nativeInstall(deadline: number, logs: string[], minVersion: string): Promise<Result | null | undefined> {
    var f = deps.fs
    if (!f || typeof f.statSync !== 'function' || typeof f.readdirSync !== 'function' || typeof f.chmodSync !== 'function') return undefined
    var curl = deps.runtime.resolveOnPath('curl', pathStr())
    if (!curl || !shaTool()) return undefined
    var platform = await detectPlatform(deadline)
    if (!platform) return undefined
    var base = downloadsBase()
    var latest = await fetchText(curl, base + '/latest', deadline, logs)
    if (!latest.ok && (latest.code !== 22 || latest.timedOut)) return lineFailed(deadline)
    var version = latest.ok ? latest.text.trim() : ''
    if (!VERSION_RE.test(version)) {
      if (latest.ok) logs.push('not a version from ' + base + '/latest')
      return undefined
    }
    var dir = home() + '/.claude/downloads'
    try { f.mkdirSync(dir, { recursive: true }) } catch { return undefined }
    var rel = await chooseRelease(curl, base, dir, platform, version, minVersion, deadline, logs)
    if (rel === 'line') return lineFailed(deadline)
    return rel ? installRelease(curl, base, dir, platform, rel, deadline, logs) : undefined
  }

  function lineFailed(deadline: number): Result {
    return { ok: false, error: deadline - now() <= 0 ? 'timeout' : 'download-failed', manualCommand: INSTALL_LINE }
  }

  async function installRelease(curl: string, base: string, dir: string, platform: string, rel: Release, deadline: number, logs: string[]): Promise<Result | null> {
    var f = deps.fs!
    var v = rel.version
    var stem = dir + '/claude-' + v + '-' + platform
    var part = stem + '.part'
    var zpart = stem + '.zst.part'
    var url = base + '/' + v + '/' + platform + '/claude'
    // The native installer's own versions directory: `claude install <v>` finds
    // the binary there and only links it. Without it there, `claude install`
    // downloads the whole binary again, with no resume (checked against 2.1.312
    // on 2026-11-03).
    var dataHome = deps.env.XDG_DATA_HOME ? deps.env.XDG_DATA_HOME.replace(/\/+$/, '') : home() + '/.local/share'
    var versions = dataHome + '/claude/versions'
    var target = versions + '/' + v
    var staged = target + '.walnut-' + now() + '.tmp'
    var until = deadline - FINISH_MS
    var timeout: Result = { ok: false, error: 'timeout', manualCommand: INSTALL_LINE }
    var failed: Result = { ok: false, error: 'download-failed', manualCommand: INSTALL_LINE }
    var placeFailed = function (why: string): Result {
      return { ok: false, error: 'installer-failed', manualCommand: INSTALL_LINE, log: 'could not place ' + target + ': ' + why }
    }
    try {
      // An earlier attempt verified and placed it, then `claude install` failed.
      var placed = !!rel.plain.size && sizeOf(target) === rel.plain.size && (await sha256(target, deadline, logs)) === rel.plain.checksum
      if (!placed) {
        try { f.mkdirSync(versions, { recursive: true }) } catch (e) { return placeFailed(String((e as Error).message || e)) }
        var ready = false
        var zstd = rel.zst ? deps.runtime.resolveOnPath('zstd', pathStr()) : null
        // A plain download already under way is not dropped for the compressed one.
        if (rel.zst && zstd && !(sizeOf(part) > 0 && sizeOf(zpart) <= 0)) {
          var z = await download(curl, url + '.zst', zpart, rel.zst.size, until, logs)
          if (z === 'timeout') return timeout
          // Bytes came and then the line failed: keep them for the next attempt.
          // Nothing came at all: the .zst URL is the trouble, so the plain one.
          if (z === 'failed' && sizeOf(zpart) > 0) return failed
          if (z === 'ok') {
            // null: the sha256 tool itself failed, which says nothing about the bytes.
            var zsum = await sha256(zpart, deadline, logs)
            if (zsum === null) return failed
            var good = zsum === rel.zst.checksum
            if (good) {
              var unpack = ['-d', '-q', '-f', '-o', stem, zpart]
              var d = await run(zstd, unpack, { timeoutMs: Math.max(1, deadline - now()) })
              if (d.code !== 0) transcript(logs, [zstd].concat(unpack), d)
              if (d.timedOut) return timeout
              var usum = d.code === 0 && sizeOf(stem) === rel.plain.size ? await sha256(stem, deadline, logs) : ''
              if (usum === null) return failed
              good = usum === rel.plain.checksum
            }
            if (good) {
              // zstd wrote this file and nothing else holds it: a rename is enough.
              try { await move(stem, staged, deadline, logs) } catch (e) { return placeFailed(String((e as Error).message || e)) }
              ready = true
            } else {
              remove(zpart)
              remove(stem)
              logs.push('the compressed download did not verify: removed it, fetching the plain binary')
            }
          }
        }
        if (!ready) {
          var got = await download(curl, url, part, rel.plain.size, until, logs)
          if (got === 'timeout') return timeout
          if (got === 'failed') return failed
          // A checked COPY, never the part itself: a curl that outlived an earlier
          // daemon may still hold the part open and append to it. The part stays
          // until the copy is in place, so a failure here loses no download.
          var cp = deps.runtime.resolveOnPath('cp', pathStr()) || '/bin/cp'
          var c = await run(cp, [part, staged], { timeoutMs: Math.max(1, deadline - now()) })
          if (c.timedOut) return timeout
          if (c.code !== 0) {
            transcript(logs, [cp, part, staged], c)
            return placeFailed('the copy failed')
          }
          var sum = await sha256(staged, deadline, logs)
          if (sum === null) return failed
          if (sum !== rel.plain.checksum) {
            remove(part)
            logs.push('checksum mismatch: removed ' + part + ', the next attempt downloads it again')
            return failed
          }
        }
        try {
          f.chmodSync(staged, 0o755)
          f.renameSync(staged, target)
        } catch (e) { return placeFailed(String((e as Error).message || e)) }
      }
      // The verified binary is in place: what was downloaded is done with.
      remove(part)
      remove(zpart)
      var inst = await run(target, ['install', v], { timeoutMs: Math.max(1, deadline - now()), env: { HOME: home() }, cwd: home() })
      transcript(logs, [target, 'install', v], inst)
      if (inst.timedOut) return timeout
      if (inst.code !== 0) return { ok: false, error: 'installer-failed', manualCommand: INSTALL_LINE }
      return null
    } finally {
      // Never an unpacked or half-placed binary left behind.
      remove(stem)
      remove(staged)
    }
  }

  /** The official install.sh, downloaded then run, as before nativeInstall. */
  async function runInstallScript(deadline: number, logs: string[]): Promise<Result | null> {
    var curl = deps.runtime.resolveOnPath('curl', pathStr())
    var wget = curl ? null : deps.runtime.resolveOnPath('wget', pathStr())
    if (!curl && !wget) return { ok: false, error: 'no-downloader', manualCommand: INSTALL_LINE }
    var bash = deps.runtime.resolveOnPath('bash', pathStr())
    if (!bash) return { ok: false, error: 'no-bash', manualCommand: INSTALL_LINE }
    if (!deps.fs) return { ok: false, error: 'internal', log: 'fs unavailable' }
    var dir = deps.fs.mkdtempSync(deps.os.tmpdir().replace(/\/$/, '') + '/walnut-claude-install-')
    var script = dir + '/install.sh'
    try {
      // Download, then run: the same installer as `curl ... | bash`, but a failed
      // download reads as a download failure instead of an empty bash run.
      var dlArgs = curl ? ['-fsSL', '-o', script, INSTALL_URL] : ['-q', '-O', script, INSTALL_URL]
      var dl = await run((curl || wget) as string, dlArgs, { timeoutMs: Math.max(1, Math.min(120000, deadline - now())) })
      transcript(logs, [(curl || wget) as string].concat(dlArgs), dl)
      if (dl.timedOut) return { ok: false, error: 'timeout', manualCommand: INSTALL_LINE }
      if (dl.code !== 0) return { ok: false, error: 'download-failed', manualCommand: INSTALL_LINE }
      var inst = await run(bash, [script], { timeoutMs: Math.max(1, deadline - now()), env: { HOME: home() }, cwd: home() })
      transcript(logs, [bash, script], inst)
      if (inst.timedOut) return { ok: false, error: 'timeout', manualCommand: INSTALL_LINE }
      if (inst.code !== 0) return { ok: false, error: 'installer-failed', manualCommand: INSTALL_LINE }
    } finally {
      removeDir(dir, ['install.sh'])
    }
    return null
  }

  return {
    install: install,
    /** Exposed for the deploy-time smoke of the source twin's text. */
    manifestEntry: manifestEntry,
  }
}

export type ClaudeInstall = ReturnType<typeof createClaudeInstall>
