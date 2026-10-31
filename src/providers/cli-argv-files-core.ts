/**
 * The Claude Code CLI's content arguments ride files, never its command line.
 * Shared by both daemon twins.
 *
 * Why (2026-10-31): a session ran `pkill -f "clone.*playwright"` to stop its own
 * Playwright run, and SIGTERMed every Claude Code CLI on the Mac. `pkill -f`
 * matches the whole command line, and every CLI Walnut started carried about
 * 60 KB of `--settings` JSON there (the hook scripts, which name `git clone` and
 * `playwright-report`), plus the session prompt in `--append-system-prompt`
 * (which tells it where to clone). Any pattern an agent typed could match every
 * session. A command line is also readable by every user of the host (ps).
 *
 * So the spawn writes each content value to a file and passes its path:
 *   --settings <json>              -> --settings <file>
 *   --mcp-config <json>            -> --mcp-config <file>
 *   --append-system-prompt <text>  -> --append-system-prompt-file <file>
 *   --system-prompt <text>         -> --system-prompt-file <file>
 * The CLI reads a path in all four (the -file flags exist since 2.0.5x; Walnut
 * already needs a 2.1 CLI for its session state events). The server keeps
 * building the inline form, and the daemon's registry keeps it (a fork reads the
 * live prompt from there, spawn-prefix.ts), so only what the process runs changes.
 *
 * Files are named by the sha256 of their content, written once (temp file and
 * rename, mode 0600 in a 0700 dir) and never rewritten, so a live CLI's file
 * never changes under it and sessions with the same settings share one file.
 * Claude Code reads the --settings file again whenever its settings change, so a
 * file a live CLI was started with must never go: `sweep` removes only a file no
 * registry session's args and no live process's command line names (the caller
 * passes `ps` output, and sweeps nothing when ps did not answer), untouched for a
 * day (a spawn that reuses a file touches it).
 * A write that fails keeps the inline value: the CLI starts as it always did.
 *
 * How each twin gets it: daemon-standalone.ts imports createCliArgvFiles;
 * daemon-source.ts inlines `createCliArgvFiles.toString()` through
 * `__CREATE_CLI_ARGV_FILES__`. So the factory body references NOTHING at module
 * scope and carries no backticks.
 */

export interface CliArgvFilesDeps {
  fs: {
    mkdirSync(p: string, o?: { recursive?: boolean; mode?: number }): unknown
    chmodSync(p: string, mode: number): void
    existsSync(p: string): boolean
    writeFileSync(p: string, data: string, o?: { mode?: number; encoding?: 'utf8' }): void
    renameSync(a: string, b: string): void
    readdirSync(p: string): string[]
    statSync(p: string): { mtimeMs: number }
    unlinkSync(p: string): void
    utimesSync(p: string, atime: Date, mtime: Date): void
  }
  path: { join(...parts: string[]): string }
  crypto: { createHash(alg: string): { update(s: string, enc?: string): { digest(enc: string): string } } }
  /** Where the files live (the daemon's streams dir + /argv). */
  dir: string
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export function createCliArgvFiles(deps: CliArgvFilesDeps) {
  var fs = deps.fs
  var path = deps.path
  var now = deps.now || function () { return Date.now() }
  // flag -> [flag the CLI reads a path from, file extension, value is JSON]
  var FLAGS: Record<string, [string, string, boolean]> = {
    '--settings': ['--settings', '.json', true],
    '--mcp-config': ['--mcp-config', '.json', true],
    '--append-system-prompt': ['--append-system-prompt-file', '.txt', false],
    '--system-prompt': ['--system-prompt-file', '.txt', false],
    // A path is read only with --print, which every Walnut claude run is.
    '--agents': ['--agents', '.json', true],
  }
  var SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000
  var TMP_MIN_AGE_MS = 60 * 60 * 1000

  type Item = { flagAt: number; valueAt: number; joined: boolean; to: string; value: string; file: string }
  /** Each content value in args: where its flag and value are, and its file. */
  function plan(args: readonly string[]): Item[] {
    var out: Item[] = []
    // With or without the command in front: a path or a script never reads as a flag.
    for (var i = 0; i < args.length; i++) {
      var a = String(args[i])
      var eq = a.indexOf('=')
      var name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
      var spec = Object.prototype.hasOwnProperty.call(FLAGS, name) ? FLAGS[name] : null
      if (!spec) continue
      var joined = name !== a
      var flagAt = i
      var values: Array<[number, string]> = []
      if (joined) values.push([i, a.slice(eq + 1)])
      else if (i + 1 < args.length) {
        values.push([++i, String(args[i])])
        // --mcp-config takes several configs: every following word up to the next flag.
        while (name === '--mcp-config' && i + 1 < args.length && String(args[i + 1]).charAt(0) !== '-') values.push([++i, String(args[i])])
      }
      for (var k = 0; k < values.length; k++) {
        var value = values[k][1]
        // A JSON flag whose value is already a path is left as it is; an empty prompt too.
        if (value === '' || (spec[2] && value.trim().charAt(0) !== '{')) continue
        var hash = deps.crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
        out.push({ flagAt: flagAt, valueAt: values[k][0], joined: joined, to: spec[0], value: value, file: path.join(deps.dir, hash + spec[1]) })
      }
    }
    return out
  }

  function ensureDir(): void {
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(deps.dir, 0o700) } catch (e) { /* not ours to fix */ }
  }

  function writeOnce(file: string, value: string): void {
    // Already there: its age restarts, so the sweep counts from the last spawn that used it.
    if (fs.existsSync(file)) { try { var t = new Date(now()); fs.utimesSync(file, t, t) } catch (e) { /* still readable */ } return }
    var tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
    fs.writeFileSync(tmp, value, { mode: 0o600, encoding: 'utf8' })
    fs.renameSync(tmp, file)
  }

  /** args with every content value moved to its file (the inline value kept when a write fails). */
  function toFiles(args: readonly string[]): string[] {
    var items = plan(args)
    if (items.length === 0) return args.slice()
    try {
      ensureDir()
      for (var k = 0; k < items.length; k++) writeOnce(items[k].file, items[k].value)
    } catch (err) {
      if (deps.log) deps.log('warn', 'cli argv files: could not write; the CLI gets its arguments inline', { error: (err as Error).message, dir: deps.dir })
      return args.slice()
    }
    var out = args.slice()
    for (var j = 0; j < items.length; j++) {
      var it = items[j]
      if (it.joined) out[it.flagAt] = it.to + '=' + it.file
      else { out[it.flagAt] = it.to; out[it.valueAt] = it.file }
    }
    return out
  }

  /** The file names args would use (no writes): what a live session keeps. */
  function namesIn(args: readonly string[]): string[] {
    return plan(args).map(function (p) { return p.file.slice(p.file.lastIndexOf('/') + 1) })
  }

  /**
   * Remove files that neither a registry session's args nor a live process's
   * command line (lines of `ps -A -ww -o args=`) name, untouched for a day, and
   * half-written temp files after an hour. Null command lines (ps did not
   * answer) sweep nothing: a CLI's file is never proven unused without them.
   */
  function sweep(liveArgs: Array<readonly string[] | undefined | null>, commandLines: readonly string[] | null): number {
    if (!commandLines) return 0
    var names: string[]
    try { names = fs.readdirSync(deps.dir) } catch (e) { return 0 }
    var keep: Record<string, true> = {}
    for (var i = 0; i < liveArgs.length; i++) {
      var a = liveArgs[i]
      if (!a) continue
      var n = namesIn(a)
      for (var j = 0; j < n.length; j++) keep[n[j]] = true
    }
    var prefix = deps.dir + '/'
    for (var c = 0; c < commandLines.length; c++) {
      var line = String(commandLines[c])
      var at = line.indexOf(prefix)
      while (at >= 0) {
        var end = at + prefix.length
        while (end < line.length && line.charAt(end) !== ' ') end++
        keep[line.slice(at + prefix.length, end)] = true
        at = line.indexOf(prefix, end)
      }
    }
    var t = now()
    var removed = 0
    for (var k = 0; k < names.length; k++) {
      var f = names[k]
      if (keep[f]) continue
      var full = path.join(deps.dir, f)
      var age: number
      try { age = t - fs.statSync(full).mtimeMs } catch (e) { continue }
      if (age < (f.indexOf('.tmp-') >= 0 ? TMP_MIN_AGE_MS : SWEEP_MIN_AGE_MS)) continue
      try { fs.unlinkSync(full); removed++ } catch (e) { /* gone already */ }
    }
    return removed
  }

  /** Whether a spawn runs Claude Code (its own file, or node with the CLI's script first). */
  function isClaude(command: string, args: readonly string[]): boolean {
    var base = String(command).slice(String(command).lastIndexOf('/') + 1)
    return /claude/i.test(base) || /claude/i.test(String(args[0] || ''))
  }

  return { toFiles: toFiles, namesIn: namesIn, sweep: sweep, isClaude: isClaude, dir: deps.dir }
}

export type CliArgvFiles = ReturnType<typeof createCliArgvFiles>
