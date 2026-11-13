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
 * Hook scripts ride files of their own (2026-11-11): the settings JSON had grown
 * to 100 KB of hook scripts. Each hook command of 512 characters or more goes to
 * `<dir>/hooks/<sha256-32>.sh`, and the settings file runs it from there with a
 * line that sources it in the hook's own shell (`. '<file>'`, so it runs exactly
 * as the inline command did). A file that is gone fails the hook loudly: a
 * PreToolUse hook refuses the call (exit 2), any other reports an error. The
 * sweep keeps every hook file a kept settings file or a live session names, and
 * writes back a live session's file a cleaner took; hooks/ is a directory so an
 * older daemon's sweep (after a rollback) never removes one. A spawn template
 * carries the same scripts as `@walnut-hook-file:<hash>` tokens with their texts
 * beside the settings as `--walnut-hook-file <text>` (hook-files.ts, for a daemon
 * with hook-files-v1), because one template string holds at most 120 KB:
 * `inlineArgs` puts them back before a start records its args, so the registry
 * always holds the inline form an older daemon re-spawns.
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
    readFileSync(p: string, enc: 'utf8'): string
    statSync(p: string): { mtimeMs: number; isDirectory?(): boolean }
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
  // A long hook command's text rides a file of its own: hook-files.ts sends them with these
  // (HOOK_FILE_FLAG / HOOK_FILE_TOKEN there; a test pins both), and this split reads its own.
  var HOOK_FLAG = '--walnut-hook-file'
  var HOOK_TOKEN = '@walnut-hook-file:'
  var HOOK_MIN_CHARS = 512
  // A subdir: an older daemon's sweep never removes a directory, so after a rollback the hook
  // files a live CLI runs stay (its sweep knows only top-level names).
  var HOOK_DIR = path.join(deps.dir, 'hooks')
  var SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000
  var TMP_MIN_AGE_MS = 60 * 60 * 1000

  // hook: a hook command's file (its hash); else a content value's file in deps.dir.
  type Item = { flagAt: number; valueAt: number; joined: boolean; to: string; value: string; file: string; hook?: string }

  function hashOf(value: string): string {
    return deps.crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
  }

  /** settings JSON with each hook command fn maps (null: leave it); null when nothing changed or it is no settings. */
  function mapHookCommands(json: string, fn: (command: string, event: string) => string | null): string | null {
    var s: { hooks?: Record<string, unknown> }
    try { s = JSON.parse(json) } catch (e) { return null }
    var hooks = s && typeof s === 'object' ? s.hooks : null
    if (!hooks || typeof hooks !== 'object') return null
    var changed = false
    for (var ev in hooks) {
      var groups = hooks[ev]
      if (!Array.isArray(groups)) continue
      for (var g = 0; g < groups.length; g++) {
        var list = groups[g] && (groups[g] as { hooks?: unknown }).hooks
        if (!Array.isArray(list)) continue
        for (var h = 0; h < list.length; h++) {
          var c = list[h] && (list[h] as { command?: unknown }).command
          if (typeof c !== 'string') continue
          var r = fn(c, ev)
          if (r !== null) { (list[h] as { command: string }).command = r; changed = true }
        }
      }
    }
    return changed ? JSON.stringify(s) : null
  }

  /**
   * args as the CLI took them inline: a hook text sent beside the settings (hook-files-v1) is put
   * back into the command its token stands for, and the pseudo flag goes. What a start records,
   * so an older daemon that takes this registry over (a rollback) re-spawns what it knows.
   */
  function inlineArgs(args: readonly string[]): string[] {
    var texts: Record<string, string> = {}
    var drop: Record<number, true> = {}
    var any = false
    for (var i = 0; i < args.length; i++) {
      var a = String(args[i])
      if (a === HOOK_FLAG && i + 1 < args.length) { texts[hashOf(String(args[i + 1]))] = String(args[i + 1]); drop[i] = true; drop[++i] = true; any = true }
      else if (a.indexOf(HOOK_FLAG + '=') === 0) { var t = a.slice(HOOK_FLAG.length + 1); texts[hashOf(t)] = t; drop[i] = true; any = true }
    }
    if (!any) return args.map(String)
    var out: string[] = []
    for (var j = 0; j < args.length; j++) {
      if (drop[j]) continue
      var v = String(args[j])
      var joined = v.indexOf('--settings=') === 0
      var value = joined ? v.slice(11) : j > 0 && String(args[j - 1]) === '--settings' ? v : null
      if (value !== null && value.indexOf(HOOK_TOKEN) >= 0) {
        var back = mapHookCommands(value, function (cmd) {
          var hash = cmd.indexOf(HOOK_TOKEN) === 0 ? cmd.slice(HOOK_TOKEN.length) : ''
          return hash && Object.prototype.hasOwnProperty.call(texts, hash) ? texts[hash] : null
        })
        if (back !== null) v = joined ? '--settings=' + back : back
      }
      out.push(v)
    }
    return out
  }

  /** The command that runs a hook file in the hook's own shell, as its inline text ran. */
  function hookLoader(file: string, event: string): string {
    var q = "'" + file.split("'").join("'\\''") + "'"
    return '[ -r ' + q + " ] || { echo 'Walnut: a hook file of this session is gone: restart the session' >&2; exit "
      + (event === 'PreToolUse' ? '2' : '1') + '; }; . ' + q
  }

  /** Each content value in (inline) args: where its flag and value are, and its file; a settings value's long hooks too. */
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
        if (name === '--settings') {
          // Each long hook command to a file of its own; the settings run it from there.
          var split = mapHookCommands(value, function (cmd, event) {
            if (cmd.length < HOOK_MIN_CHARS) return null
            var h = hashOf(cmd)
            var file = path.join(HOOK_DIR, h + '.sh')
            out.push({ flagAt: -1, valueAt: -1, joined: false, to: '', value: cmd, file: file, hook: h })
            return hookLoader(file, event)
          })
          if (split !== null) value = split
        }
        out.push({ flagAt: flagAt, valueAt: values[k][0], joined: joined, to: spec[0], value: value, file: path.join(deps.dir, hashOf(value) + spec[1]) })
      }
    }
    return out
  }

  function ensureDir(): void {
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(deps.dir, 0o700) } catch (e) { /* not ours to fix */ }
  }

  function ensureHookDir(): void {
    fs.mkdirSync(HOOK_DIR, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(HOOK_DIR, 0o700) } catch (e) { /* not ours to fix */ }
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
    var inline = inlineArgs(args)
    var items = plan(inline)
    if (items.length === 0) return inline
    try {
      ensureDir()
      // Hook files first: a settings file never names one that is not there yet.
      for (var k = 0; k < items.length; k++) if (items[k].hook) { ensureHookDir(); writeOnce(items[k].file, items[k].value) }
      for (var m = 0; m < items.length; m++) if (!items[m].hook) writeOnce(items[m].file, items[m].value)
    } catch (err) {
      if (deps.log) deps.log('warn', 'cli argv files: could not write; the CLI gets its arguments inline', { error: (err as Error).message, dir: deps.dir })
      return inline
    }
    var out = inline.slice()
    for (var j = 0; j < items.length; j++) {
      var it = items[j]
      if (it.hook) continue
      if (it.joined) out[it.flagAt] = it.to + '=' + it.file
      else { out[it.flagAt] = it.to; out[it.valueAt] = it.file }
    }
    return out
  }

  /** The file names args would use (no writes): what a live session keeps on its command line. */
  function namesIn(args: readonly string[]): string[] {
    return plan(inlineArgs(args)).filter(function (p) { return !p.hook }).map(function (p) { return p.file.slice(p.file.lastIndexOf('/') + 1) })
  }

  /**
   * Remove files that neither a registry session's args nor a live process's
   * command line (lines of `ps -A -ww -o args=`) name, untouched for a day, and
   * half-written temp files after an hour; a hook file stays while a kept settings
   * file or a registry session names it. Null command lines (ps did not answer)
   * sweep nothing: a CLI's file is never proven unused without them.
   */
  function sweep(liveArgs: Array<readonly string[] | undefined | null>, commandLines: readonly string[] | null): number {
    if (!commandLines) return 0
    var names: string[]
    var hookNames: string[]
    // A dir a cleaner took still gets its live sessions' files back below.
    try { names = fs.readdirSync(deps.dir) } catch (e) { names = [] }
    try { hookNames = fs.readdirSync(HOOK_DIR) } catch (e) { hookNames = [] }
    var keep: Record<string, true> = {}
    var keepHook: Record<string, true> = {}
    for (var i = 0; i < liveArgs.length; i++) {
      var a = liveArgs[i]
      if (!a) continue
      var items = plan(inlineArgs(a))
      for (var j = 0; j < items.length; j++) {
        var base = items[j].file.slice(items[j].file.lastIndexOf('/') + 1)
        if (items[j].hook) keepHook[base] = true
        else keep[base] = true
        // A live session's file a cleaner took is written back (its hooks read theirs on every call).
        try {
          if (!fs.existsSync(items[j].file)) { ensureDir(); if (items[j].hook) ensureHookDir(); writeOnce(items[j].file, items[j].value) }
        } catch (e) { /* the next sweep tries again */ }
      }
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
    // A kept settings file keeps the hook files it names (a live CLI's command line names only the
    // settings). By the file's own name, which no escaping of the dir changes.
    var named = /([0-9a-f]{32}\.sh)/g
    for (var s = 0; s < names.length; s++) {
      if (!keep[names[s]] || names[s].slice(-5) !== '.json') continue
      var body: string
      try { body = fs.readFileSync(path.join(deps.dir, names[s]), 'utf8') } catch (e) { continue }
      var hit: RegExpExecArray | null
      named.lastIndex = 0
      while ((hit = named.exec(body)) !== null) keepHook[hit[1]] = true
    }
    var t = now()
    var removed = 0
    function drop(dir: string, f: string, kept: Record<string, true>): void {
      if (kept[f]) return
      var full = path.join(dir, f)
      var st: { mtimeMs: number; isDirectory?: () => boolean }
      try { st = fs.statSync(full) } catch (e) { return }
      if (st.isDirectory && st.isDirectory()) return
      if (t - st.mtimeMs < (f.indexOf('.tmp-') >= 0 ? TMP_MIN_AGE_MS : SWEEP_MIN_AGE_MS)) return
      try { fs.unlinkSync(full); removed++ } catch (e) { /* gone already */ }
    }
    for (var k = 0; k < names.length; k++) drop(deps.dir, names[k], keep)
    for (var n = 0; n < hookNames.length; n++) drop(HOOK_DIR, hookNames[n], keepHook)
    return removed
  }

  // A start's long arguments ride by hash once this host holds them (start-arg-refs-v1; the
  // server side is start-arg-refs.ts, which mirrors these two values; a test pins both).
  // 2026-11-13: after a wake each resumed session's start sent about 140 KB of hook scripts and
  // prompt again, 3.3 MB on one link in 16 minutes, and the relay on the SSH path ended it.
  var REF_TOKEN = '@walnut-arg-ref:'
  var REF_MIN_CHARS = 1024
  var REF_DIR = path.join(deps.dir, 'refs')
  // Each use touches a copy: a hook text every start sends stays; a session's prompt goes 3 days after its last start.
  var REF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
  var REF_SWEEP_EVERY_MS = 60 * 60 * 1000
  var lastRefSweep = 0

  function refFile(h: string): string { return path.join(REF_DIR, h + '.arg') }

  /** args with each `@walnut-arg-ref:<hash>` put back from this host's copy; missing: the hashes it has no copy of. */
  function resolveRefs(args: readonly string[]): { args: string[]; missing: string[] } {
    var out: string[] = []
    var missing: string[] = []
    for (var i = 0; i < args.length; i++) {
      var a = String(args[i])
      if (a.indexOf(REF_TOKEN) !== 0) { out.push(a); continue }
      var h = a.slice(REF_TOKEN.length)
      var text: string | null = null
      if (/^[0-9a-f]{32}$/.test(h)) {
        try { text = fs.readFileSync(refFile(h), 'utf8') } catch (e) { text = null }
        // A copy that does not hash to its name is no copy: it goes, so the full value is kept again.
        if (text !== null && hashOf(text) !== h) { text = null; try { fs.unlinkSync(refFile(h)) } catch (e) { /* gone already */ } }
      }
      if (text === null) { missing.push(h); out.push(a); continue }
      try { var t = new Date(now()); fs.utimesSync(refFile(h), t, t) } catch (e) { /* still readable */ }
      out.push(text)
    }
    return { args: out, missing: missing }
  }

  /** Keep a copy of each long argument of a start, so the next start may name it by hash. */
  function rememberRefs(args: readonly string[]): void {
    try {
      var made = false
      for (var i = 0; i < args.length; i++) {
        var a = String(args[i])
        if (a.length < REF_MIN_CHARS || a.indexOf(REF_TOKEN) === 0) continue
        if (!made) {
          fs.mkdirSync(REF_DIR, { recursive: true, mode: 0o700 })
          try { fs.chmodSync(REF_DIR, 0o700) } catch (e) { /* not ours to fix */ }
          made = true
        }
        writeOnce(refFile(hashOf(a)), a)
      }
    } catch (err) {
      if (deps.log) deps.log('warn', 'cli argv refs: could not keep a copy; the next start sends it in full', { error: (err as Error).message })
    }
    sweepRefs()
  }

  /** At most hourly: drop copies no start named for 3 days, and half-written ones after an hour. */
  function sweepRefs(): void {
    var t = now()
    if (t - lastRefSweep < REF_SWEEP_EVERY_MS) return
    lastRefSweep = t
    var names: string[]
    try { names = fs.readdirSync(REF_DIR) } catch (e) { return }
    for (var i = 0; i < names.length; i++) {
      var full = path.join(REF_DIR, names[i])
      var st: { mtimeMs: number }
      try { st = fs.statSync(full) } catch (e) { continue }
      if (t - st.mtimeMs < (names[i].indexOf('.tmp-') >= 0 ? TMP_MIN_AGE_MS : REF_MAX_AGE_MS)) continue
      try { fs.unlinkSync(full) } catch (e) { /* gone already */ }
    }
  }

  /** Whether a spawn runs Claude Code (its own file, or node with the CLI's script first). */
  function isClaude(command: string, args: readonly string[]): boolean {
    var base = String(command).slice(String(command).lastIndexOf('/') + 1)
    return /claude/i.test(base) || /claude/i.test(String(args[0] || ''))
  }

  return { toFiles: toFiles, inlineArgs: inlineArgs, namesIn: namesIn, sweep: sweep, isClaude: isClaude, resolveRefs: resolveRefs, rememberRefs: rememberRefs, dir: deps.dir }
}

export type CliArgvFiles = ReturnType<typeof createCliArgvFiles>
