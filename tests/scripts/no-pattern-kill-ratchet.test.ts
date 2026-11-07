/**
 * Ratchet: no repo tool or test stops a process by name or pattern, and no Maestro
 * lock is removed without checking its holder.
 *
 * 2026-10-31: a pattern kill matched the command line of every agent session on the
 * Mac and ended them all. A pattern (pkill, killall, a pid list from pgrep, pidof,
 * lsof -t or ps | grep fed to kill) matches whatever process happens to carry the
 * text or hold the port, a shell or an agent included. Tools stop the pid they
 * recorded when they started the process (scripts/lib/recorded-pid.sh). The
 * machine-wide Maestro lock is taken and removed only through
 * scripts/lib/maestro-lock.sh, which removes a lock only for its own holder or as a
 * stale one.
 *
 * Reads every shell, JS/TS and Python file under scripts/, ios-native/, tests/ (test
 * files included) and src/ (the product: its terminal and ephemeral cleanup once
 * found their dtach masters with pgrep -f / pkill -f on the socket path, which also
 * matched any agent shell that named it), enumerated from the tree. Comments are
 * skipped. In JS/TS a string counts as code where it runs: the command of an exec
 * or spawn call, or the script of a `sh -c`. In a test any other string is data (a
 * test sample, a deny list); in a tool or the product, a string that is a shell
 * command line counts too (a script built into a variable and run later), with
 * only commands in command position, so a message that names one is not one, and
 * a printed search (`echo "PID:$(pgrep -f x)"`) followed within a few lines by a
 * command string that signals an interpolated pid (`kill -TERM ${pid}`) is a
 * search-kill.
 *   pkill / killall   either command;
 *   search-kill       a pid list from a search (pgrep, pidof, lsof -t, ps | grep or
 *                     awk, or a shell function whose output is one) that reaches a
 *                     kill: piped to xargs kill, inside kill $(...), or captured
 *                     (a variable, a for or while-read loop, mapfile) and signalled
 *                     within a few lines, unless an exact-pid comparison on the
 *                     killed variable narrows it first.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { findKillViolations, shellLines, type Kind, type KillRule, type KillViolation } from './kill-scan.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'DerivedData', 'build', '.build', 'Pods', 'dist', 'runs'])
const SKIP_DIR_SUFFIXES = ['.xcodeproj', '.xcworkspace', '.app', '.xcresult']
const LOCK_HELPER = 'scripts/lib/maestro-lock.sh'


/**
 * Each entry is pinned to the exact (trimmed) line it allows and needs a reason a
 * reviewer can check; the stale-entry test fails once that line no longer breaks the
 * rule. A file listed here may break only the named rule on the named line.
 */
const ALLOWLIST: Array<{ file: string; rule: KillRule; text: string; reason: string }> = [
  {
    file: 'scripts/dev-prod.sh',
    rule: 'search-kill',
    reason: 'the deploy reaps a production server that never bound its port: each pgrep hit is re-read with ps and signalled only when its full command contains (a substring glob, not an exact match) one of the production launch paths and carries no --ephemeral flag and no other --port',
    text: `stray_pids="$(pgrep -f 'dist/cli\\.js web|dist-bin/walnut-[a-z0-9-]+ web' 2>/dev/null || true)"`,
  },
  {
    file: 'scripts/dev-prod.sh',
    rule: 'search-kill',
    reason: 'the deploy replaces the server on its own port: whatever listens on production\'s port is the server being replaced (a rehearsal first refuses any listener it did not start, rehearsal_refuse_foreign_listeners), and each pid gets its grace period before SIGKILL',
    text: 'existing_pids="$(listener_pids)"',
  },
  {
    file: 'scripts/pw-cleanup.sh',
    rule: 'search-kill',
    reason: 'the browser list is only a pre-filter: reap_browsers signals a browser only when browser_owner finds a WALNUT_PW_RUN token in its environment that this repo\'s Playwright runner recorded in walnut-pw-runs, and that run is gone; every other browser is listed and left alone',
    text: 'done < <(orphan_browsers)',
  },
  {
    file: 'scripts/desktop-update-e2e.mjs',
    rule: 'search-kill',
    reason: 'the relaunched app is picked by exact equality of its executable path (comm) with this run\'s own copy of the app in its private temp dir, never a substring of a command line, and never this process',
    text: "const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'comm='], { encoding: 'utf8' }).split('\\n')",
  },
  {
    file: 'scripts/desktop-smoke.mjs',
    rule: 'search-kill',
    reason: 'stops only processes holding open files inside the private work dir this smoke made for itself (lsof +D on that dir, the cwd excluded), never itself or its parent, after printing each one\'s command',
    text: "out = execFileSync('lsof', ['-t', '-a', '-d', '^cwd', '+D', work], { encoding: 'utf8', timeout: 30_000 })",
  },
  {
    file: 'tests/live/provider-matrix/matrix.live.test.ts',
    rule: 'search-kill',
    reason: 'the provider process is started by the ephemeral server\'s daemon, so the test has no pid of its own; a pgrep hit is signalled only when `lsof -p <pid> | grep -c <journal basename>` finds this session\'s ACP journal file name among its open files, or `lsof -a -p <pid> -d cwd -Fn | grep -c <cwd>` finds this test\'s mkdtemp dir as a substring of its cwd',
    text: "const pids = execSync(`pgrep -f '${processPattern}'`, { encoding: 'utf8' }).trim().split('\\n').filter(Boolean)",
  },
]

// ── files ──────────────────────────────────────────────────────────────────

const isTestFile = (name: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)

function kindOf(name: string, full: string): Kind | null {
  if (/\.(?:sh|bash|zsh)$/.test(name)) return 'shell'
  if (/\.(?:[cm]?[jt]sx?)$/.test(name)) return 'js'
  if (/\.py$/.test(name)) return 'py'
  if (path.extname(name) !== '') return null
  const fd = fs.openSync(full, 'r')
  try {
    const buf = Buffer.alloc(80)
    const first = buf.subarray(0, fs.readSync(fd, buf, 0, 80, 0)).toString('utf8').split('\n')[0] ?? ''
    if (/^#!.*\b(?:sh|bash|zsh)\b/.test(first)) return 'shell'
    if (/^#!.*\bpython/.test(first)) return 'py'
    if (/^#!.*\b(?:node|bun)\b/.test(first)) return 'js'
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** Every file it guards, repo-relative, symlinks not followed. */
function guardedFiles(): Array<{ file: string; kind: Kind; test: boolean }> {
  const found: Array<{ file: string; kind: Kind; test: boolean }> = []
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || SKIP_DIR_SUFFIXES.some((s) => ent.name.endsWith(s))) continue
        // scripts/local/ is a person's own gitignored folder, not repo content (CI never sees it)
        if (child === 'scripts/local') continue
        walk(child)
      } else if (ent.isFile()) {
        const kind = kindOf(ent.name, path.join(REPO, child))
        if (kind) found.push({ file: child, kind, test: isTestFile(ent.name) })
      }
    }
  }
  walk('scripts')
  walk('ios-native')
  walk('tests')
  walk('src')
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

const allowed = (file: string, v: KillViolation) => ALLOWLIST.some((a) => a.file === file && a.rule === v.rule && a.text === v.text)

describe('findKillViolations', () => {
  it.each<[string, string, KillRule, Kind?, boolean?]>([
    ['pkill -f', 'pkill -f "mock-server.mjs" 2>/dev/null || true', 'pkill'],
    ['pkill by name', '  pkill node; sleep 0.5', 'pkill'],
    ['killall', 'killall -9 Simulator', 'killall'],
    ['killall after a separator', 'make stop && killall bun', 'killall'],
    ['pkill by its path, under sudo', 'sudo /usr/bin/pkill -f walnut', 'pkill'],
    ['pgrep piped to xargs kill', "pgrep -f 'walnut web' | xargs kill -9", 'search-kill'],
    ['kill of a pgrep substitution', 'kill $(pgrep -f mock-server.mjs)', 'search-kill'],
    ['kill of a backtick pgrep', 'kill -TERM `pgrep -f vite`', 'search-kill'],
    ['a pgrep loop that kills', 'for pid in $(pgrep -f "daemon --start"); do\n  echo "$pid"\n  kill -TERM "$pid"\ndone', 'search-kill'],
    ['a captured pgrep list that is killed later', 'pids="$(pgrep -f vite || true)"\nfor p in $pids; do\n  kill -9 "$p"\ndone', 'search-kill'],
    ['pgrep piped into a while-read loop', 'pgrep -f x | while read p; do kill "$p"; done', 'search-kill'],
    ['kill -s TERM in a pgrep loop', 'for p in $(pgrep -f x); do\n  kill -s TERM "$p"\ndone', 'search-kill'],
    ['kill -- in a pgrep loop', 'for p in $(pgrep -f x); do kill -- "$p"; done', 'search-kill'],
    ['kill -n 15 in a pgrep loop', 'for p in $(pgrep -f x); do kill -n 15 "$p"; done', 'search-kill'],
    ['kill -SIGTERM of a captured list', 'pids=$(pgrep -f x)\nkill -SIGTERM $pids', 'search-kill'],
    ['a backslash-continued pgrep into xargs kill', "pgrep -f 'walnut web' \\\n  | xargs kill", 'search-kill'],
    ['ps | grep | awk | xargs kill', "ps aux | grep mock-server | awk '{print $2}' | xargs kill", 'search-kill'],
    ['kill of a ps | grep substitution', "kill -9 $(ps -eo pid,command | grep -F vite | awk '{print $1}')", 'search-kill'],
    ['pidof into kill', 'kill $(pidof bun)', 'search-kill'],
    ['lsof -t on a port into xargs kill', 'lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true', 'search-kill'],
    ['a while-read loop fed by process substitution', 'while read -r pid _; do\n  kill -9 "$pid"\ndone < <(pgrep -fl chromium)', 'search-kill'],
    ['a search function whose output is killed', 'browsers() {\n  ps -eo pid= -o command= | grep chromium\n}\nfor pid in $(browsers); do kill -9 "$pid"; done', 'search-kill'],
    ['a pid copied from the captured list, then killed', 'pids="$(pgrep -f x)"\nfor p in $pids; do\n  target="$p"\n  kill "$target"\ndone', 'search-kill'],
    ['wrapped: bash -c with pkill', "bash -c \"pkill -f vite\"", 'pkill'],
    ['wrapped: sh -c with pkill', "sh -c 'pkill -f vite'", 'pkill'],
    ['wrapped: sh -lc with killall', "sh -lc \"killall x\"", 'killall'],
    ['wrapped: ssh host pkill', "ssh host pkill -f vite", 'pkill'],
    ['wrapped: ssh host with a quoted pkill', "ssh host \"pkill -f vite\"", 'pkill'],
    ['wrapped: ssh with an option and its argument', "ssh -p 22 devhost pkill -f claude", 'pkill'],
    ['wrapped: timeout before pkill', "timeout 5 pkill -f vite", 'pkill'],
    ['wrapped: env before pkill', "env pkill -f vite", 'pkill'],
    ['wrapped: env -i with an assignment before pkill', "env -i PATH=/bin pkill x", 'pkill'],
    ['wrapped: an assignment and timeout before killall', "FOO=1 timeout 5 killall x", 'killall'],
    ['wrapped: nice -n before pkill', "nice -n 10 pkill -f vite", 'pkill'],
    ['wrapped: time before pkill', "time pkill -f vite", 'pkill'],
    ['wrapped: eval of a double-quoted pkill', "eval \"pkill -f vite\"", 'pkill'],
    ['wrapped: eval of a single-quoted pkill', "eval 'pkill x'", 'pkill'],
    ['wrapped: sudo -u root before pkill', "sudo -u root pkill -f x", 'pkill'],
    ['wrapped: an escaped pkill', "\\pkill x", 'pkill'],
    ['wrapped: a quoted pkill name', "'pkill' -f x", 'pkill'],
    ['wrapped: pkill -P', "pkill -P 1234", 'pkill'],
    ['wrapped: killall after ||', "ls || killall x", 'killall'],
    ['wrapped: pkill in a subshell', "(cd /a; pkill -f b)", 'pkill'],
    ['wrapped: pkill in a group', "{ pkill x; }", 'pkill'],
    ['wrapped: xargs pkill', "true | xargs pkill", 'pkill'],
    ['wrapped: pkill in a quoted substitution', "echo \"$(pkill -f x)\"", 'pkill'],
    ['wrapped: pkill in backticks', "echo `pkill -f x`", 'pkill'],
    ['wrapped: pkill after then', "if true; then pkill -f foo; fi", 'pkill'],
    ['wrapped: killall after do', "while true; do killall node; done", 'killall'],
    ['wrapped: a negated pkill', "! pkill -f x", 'pkill'],
    ['wrapped: a heredoc fed to bash', "bash <<EOF\npkill -f x\nEOF", 'pkill'],
    ['wrapped: a quoted heredoc fed to bash -s', "bash -s <<'EOF'\npkill -f x\nEOF", 'pkill'],
    ['wrapped: a substitution in an unquoted heredoc', "cat > /tmp/n.md <<EOF\nsee $(pkill x)\nEOF", 'pkill'],
    ['wrapped: a heredoc piped into sh', "cat <<EOF | sh\npkill x\nEOF", 'pkill'],
    ['wrapped: a quoted command piped into bash', "echo 'pkill x' | bash", 'pkill'],
    ['wrapped: pkill in a parameter default', "echo ${X:-$(pkill x)}", 'pkill'],
    ['ssh from JS argv', "spawnSync('ssh', ['devhost', 'pkill -f claude'])", 'pkill', 'js', true],
    ['timeout from JS argv', "execFileSync('timeout', ['5', 'pkill', '-f', 'x'])", 'pkill', 'js', true],
    ['pkill spawned from JS', "execFileSync('pkill', ['-f', 'mock-server'])", 'pkill', 'js'],
    ['pkill in a JS shell command', 'execSync(`pkill -9 -f ${JSON.stringify(s)} 2>/dev/null; true`)', 'pkill', 'js', true],
    ['pkill through sh -c from a test', "spawnSync('/bin/sh', ['-c', 'pkill -f ' + dir])", 'pkill', 'js', true],
    ['pgrep then process.kill in JS', "const pid = Number(execFileSync('/usr/bin/pgrep', ['-f', exe]).toString())\nprocess.kill(pid, 'SIGTERM')", 'search-kill', 'js'],
    ['a pgrep shell command then process.kill', "const pids = execSync(`pgrep -f '${p}'`).toString().split('\\n')\nfor (const pid of pids) process.kill(Number(pid), 'SIGKILL')", 'search-kill', 'js', true],
    ['a JS shell command with lsof into xargs kill', "spawn('bash', ['-c', `lsof -ti:${PORT} -sTCP:LISTEN | xargs kill -15`])", 'search-kill', 'js'],
    ['a pkill command line kept in a tool string', "const STOP = 'pkill -f mock-server'\nrunLater(STOP)", 'pkill', 'js'],
    ['pkill from python', "subprocess.run(['pkill', '-f', 'server.py'])", 'pkill', 'py'],
    // The product's shapes (src/): commands built as strings and run through a helper.
    ['pkill through execFile with a callback', "execFile('pkill', ['-f', sock], { timeout: 8000 }, cb)", 'pkill', 'js'],
    ['pkill through spawn', "const child = spawn('pkill', ['-f', pattern], { stdio: 'ignore' })", 'pkill', 'js'],
    ['a pkill script kept in a variable, run later', "const script = `pkill -f ${shellQuote(sock)} 2>/dev/null; rm -f ${shellQuote(sock)}; echo DONE`\nawait runShell(host, script)", 'pkill', 'js'],
    ['pgrep piped into kill in a script variable', "const script = `pgrep -f ${q(sock)} | xargs kill -TERM`\nawait runShell(host, script)", 'search-kill', 'js'],
    ['kill of a pgrep substitution in a script variable', "await runShell(host, `kill $(pgrep -f ${q(sock)})`)", 'search-kill', 'js'],
    ['a printed pgrep pid, then a kill script for it', "const probe = `echo \"MASTERPID:$(pgrep -f ${q(sock)} | head -1)\"`\nconst pid = parse(await runShell(host, probe))\nawait runShell(host, `kill -TERM ${pid}`)", 'search-kill', 'js'],
    ['a printed pgrep pid, then kill -s TERM of it', "const probe = `echo \"PID:$(pgrep -f ${q(sock)})\"`\nconst pid = parse(await runShell(host, probe))\nawait runShell(host, `kill -s TERM ${pid}`)", 'search-kill', 'js'],
    ['pgrep -f through bash -c into process.kill', "const out = await run('bash', ['-c', `pgrep -f ${sock} | head -1`])\nprocess.kill(Number(out.stdout), 'SIGTERM')", 'search-kill', 'js'],
    ['pgrep then os.kill in python', "out = subprocess.check_output(['pgrep', '-f', 'x'])\nfor p in out.split():\n    os.kill(int(p), signal.SIGTERM)", 'search-kill', 'py'],
  ])('flags %s', (_label, body, rule, kind = 'shell', test = false) => {
    expect(findKillViolations(`#!/usr/bin/env bash\n${body}\n`, kind, test).map((v) => v.rule)).toContain(rule)
  })

  it.each<[string, string, Kind?, boolean?]>([
    ['a kill of the recorded pid', 'kill "$SERVER_PID" 2>/dev/null || true'],
    ['the recorded-pid helper', 'walnut_pid_stop_recorded "$MOCK_PIDFILE" mock-server.mjs || exit 1\nwalnut_pid_stop_child "$MOCK_PID"'],
    ['a comment that names pkill', '# Never pkill -f here: a pattern matches every command line.'],
    ['a trailing comment that names killall', 'kill "$PID"  # not killall: it would end every bun'],
    ['a JS comment that names pkill', "// never pkill -f; kill the pid we started\nchild.kill('SIGTERM')", 'js'],
    ['pgrep only to ask whether something runs', 'if pgrep -f "$clone/" >/dev/null 2>&1; then continue; fi'],
    ['a pgrep list checked with kill -0 only', 'pids="$(pgrep -f vite)"\nfor p in $pids; do kill -0 "$p" && echo alive; done'],
    ['a pgrep list probed with kill -s 0', 'for p in $(pgrep -f vite); do kill -s 0 "$p" && echo alive; done'],
    ['a port holder that is only reported', 'busy="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"\necho "held by $busy"\nkill "$MOCK_PID"'],
    ['a search list narrowed by an exact pid comparison', 'for pid in $(pgrep -f vite); do\n  [ "$pid" = "$RECORDED" ] || continue\n  kill "$pid"\ndone'],
    ['a port listener narrowed by a recorded owner pid', 'for pid in $(lsof -tiTCP:3457); do\n  grep -qx "$pid" <<<"$owners" || continue\n  kill -TERM "$pid"\ndone'],
    ['ps of one pid', 'start="$(ps -o lstart= -p "$pid" | awk \'{ $1 = $1; print }\')"\nkill "$pid"'],
    ['children of a pid this script started', 'for c in $(pgrep -P "$SERVER_PID"); do kill "$c"; done'],
    ['a JS identifier that contains killAll', 'killAllChildren(); releaseLock(LOCK_FILE)', 'js'],
    ['the bare names in a tool, as types or a deny list', "type Rule = 'pkill' | 'killall'\nif (name === 'pkill') refuse()", 'js'],
    ['pkill as test data in a test file', "const cases = [['pkill -f x', true], ['killall node', true]]\nexpect(guard('pkill -f x')).toBe(true)", 'js', true],
    ['a test that spawns the pid it started and kills it', "const child = spawn('sleep', ['30'])\nprocess.kill(child.pid!, 'SIGTERM')", 'js', true],
    ['which pkill', "which pkill"],
    ['command -v pkill', "command -v pkill"],
    ['man killall', "man killall"],
    ['a message that names pkill', "echo \"never use pkill by pattern\""],
    ['a commit message that names pkill', "git commit -m \"fix: refuse a pkill by pattern\""],
    ['a grep for the names', "grep -rn \"pkill|killall\" src"],
    ['a quoted heredoc that names pkill', "cat > /tmp/n.md <<'EOF'\nNever run `pkill -f \"clone.*playwright\"`: it killed every session.\nEOF"],
    ['a python heredoc that prints pkill', "python3 - <<'EOF'\nprint('pkill -f x')\nEOF"],
    ['an unquoted heredoc that names pkill', "cat > n.md <<EOF\nNever use pkill by pattern.\nEOF"],
    ['a process-group kill by pid', "kill -- -12345"],
    ['a kill of the last background pid', "kill $!"],
    ['a ps grep for the word', "ps -axo pid,command | grep pkill"],
    ['a path that contains the word', "echo ${HOME}/pkill-notes"],
    ['a hash inside quotes is not a comment, and no kill', 'echo "step #2 done"'],
    ['kill and pkill named in a message', 'pid="$(pgrep -f x)"\necho "Refusing to kill server PID $pid; use pkill yourself"'],
    ['a kill script for a pid proved by its record, no search', "const stop = `if [ \"$(walnut_st ${t.pid})\" = ${q(t.start)} ]; then kill -TERM ${t.pid}; fi`\nawait run(stop)", 'js'],
    ['an lsof owner probe that is never signalled from its output', "const probe = `owners=$(lsof -t -- ${q(sock)} | tr \"\\\\n\" \" \"); echo \"OWNERS:$owners\"`\nawait run(probe)", 'js'],
    ['a message in the product that names pkill', "throw new Error('Refusing: pkill -f by pattern matches every command line')", 'js'],
    ['a regex literal holding a quote', "const re = /[\"'`]pgrep\\b/\nconst ok = re.test(x)", 'js'],
  ])('passes %s', (_label, body, kind = 'shell', test = false) => {
    expect(findKillViolations(`#!/usr/bin/env bash\n${body}\n`, kind, test)).toEqual([])
  })
})

describe('no tool or test kills by name or pattern', () => {
  const files = guardedFiles()

  it('finds the files it guards, test files included', () => {
    const names = files.map((f) => f.file)
    expect(files.length).toBeGreaterThan(2000)
    expect(names).toContain('scripts/ios-perf/freeze-probe.sh')
    expect(names).toContain('ios-native/tests/inbox/inbox-e2e.sh')
    expect(names).toContain('scripts/lib/recorded-pid.sh')
    expect(names).toContain('tests/providers/local-daemon.test.ts')
    expect(names).toContain('tests/live/provider-matrix/matrix.live.test.ts')
    expect(names).toContain('src/web/terminal/dtach-lifecycle.ts')
    expect(names).toContain('src/web/terminal/dtach-master.ts')
    expect(names).toContain('src/commands/ephemeral-registry.ts')
    expect(files.find((f) => f.file === 'src/web/terminal/dtach-master.ts')?.test).toBe(false)
    expect(files.find((f) => f.file === 'tests/providers/local-daemon.test.ts')?.test).toBe(true)
  })

  it('every tool and test stops the pid it recorded, never a name or a pattern', () => {
    const offenders: string[] = []
    for (const { file, kind, test } of files) {
      const content = fs.readFileSync(path.join(REPO, file), 'utf8')
      for (const v of findKillViolations(content, kind, test)) {
        if (!allowed(file, v)) offenders.push(`${file}:${v.line} [${v.rule}] ${v.text}`)
      }
    }
    expect(offenders, 'Kill the pid the script recorded when it started the process (scripts/lib/recorded-pid.sh), or allowlist that exact line here with a reason.').toEqual([])
    // It scans the whole tree (about 7,000 files, 15 s on a loaded host by 2026-11-07), so
    // the quick tier's 15 s default timed it out as the tree grew; the scan, not a hang.
  }, 120_000)

  it('the allowlist gives a reason for every entry and has no stale ones', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.file} needs a reason`).toBeGreaterThanOrEqual(40)
      const found = files.find((f) => f.file === entry.file)
      expect(found, `${entry.file} is allowlisted but not a guarded file any more`).toBeTruthy()
      const hits = findKillViolations(fs.readFileSync(path.join(REPO, entry.file), 'utf8'), found!.kind, found!.test)
        .filter((v) => v.rule === entry.rule && v.text === entry.text)
      expect(hits.length, `${entry.file} is allowlisted for ${entry.rule} on \`${entry.text}\`, which no longer breaks it`).toBeGreaterThan(0)
    }
  })
})

// ── the Maestro lock ───────────────────────────────────────────────────────

/** Lock removals and lock takes of the Maestro lock, by line. */
function maestroLockUses(content: string): { removals: number[]; takes: number[] } {
  const code = shellLines(content)
  const removals: number[] = []
  const takes: number[] = []
  code.forEach((c, i) => {
    const names = /maestro-ios\.lock|\$\{?(?:WALNUT_MAESTRO_LOCK|LOCK)\b/.test(c)
    if (names && /\brm\b|\brmdir\b/.test(c) && !/\.mutex|\$m\b|"\$m"/.test(c)) removals.push(i)
    if (names && /\bmkdir\b/.test(c) && !/\.mutex/.test(c)) takes.push(i)
  })
  return { removals, takes }
}

/** The body of the shell function enclosing line i, up to i. */
function enclosingFunction(code: string[], i: number): string {
  for (let k = i; k >= 0; k--) if (/^\s*(?:function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*\{/.test(code[k]!)) return code.slice(k, i + 1).join('\n')
  return code.slice(0, i + 1).join('\n')
}

describe('the Maestro lock is removed only for its holder', () => {
  const files = guardedFiles().filter(({ file, kind }) => kind === 'shell' && /maestro-ios\.lock|WALNUT_MAESTRO_LOCK|maestro-lock\.sh/.test(fs.readFileSync(path.join(REPO, file), 'utf8')))

  it('finds the scripts that share it', () => {
    const names = files.map((f) => f.file)
    expect(names).toContain(LOCK_HELPER)
    for (const s of ['voice/voice-quickaction-e2e', 'inbox/inbox-e2e', 'calendar/calendar-e2e', 'tasks/board-e2e']) {
      expect(names).toContain(`ios-native/tests/${s}.sh`)
    }
  })

  it('no script takes or removes it itself: they go through the helper', () => {
    const offenders: string[] = []
    for (const { file } of files) {
      if (file === LOCK_HELPER) continue
      const content = fs.readFileSync(path.join(REPO, file), 'utf8')
      const lines = content.split('\n')
      const { removals, takes } = maestroLockUses(content)
      for (const i of [...removals, ...takes]) offenders.push(`${file}:${i + 1} ${lines[i]!.trim()}`)
      if (/maestro-ios\.lock/.test(shellLines(content).join('\n'))) offenders.push(`${file}: names the lock path in code; source ${LOCK_HELPER}`)
    }
    expect(offenders).toEqual([])
  })

  it('the helper removes the lock only after a holder check, never recursively, and records its pid when it takes it', () => {
    const content = fs.readFileSync(path.join(REPO, LOCK_HELPER), 'utf8')
    const code = shellLines(content)
    const { removals, takes } = maestroLockUses(content)
    expect(removals.length).toBeGreaterThanOrEqual(4)
    for (const i of removals) {
      expect(enclosingFunction(code, i), `${LOCK_HELPER}:${i + 1} removes the lock without a holder check`).toMatch(/walnut_maestro_lock_live|=\s*"\$\$"/)
      // The lock only ever holds its pid file: rm -f <lock>/pid, then rmdir.
      expect(code[i], `${LOCK_HELPER}:${i + 1} removes the lock recursively`).not.toMatch(/\brm\s+-[a-zA-Z]*[rR]/)
    }
    expect(takes.length).toBe(1)
    expect(code[takes[0]! + 1]).toMatch(/"\$\$"\s*>\s*"\$WALNUT_MAESTRO_LOCK\/pid"/)
    // The queue's staleness rule: an empty pid file is a live lock for 60 s.
    expect(content).toMatch(/\[ "\$age" -lt 60 \]/)
  })

  it('the source check catches a bare removal and passes the helper calls', () => {
    expect(maestroLockUses('LOCK=/tmp/maestro-ios.lock\nrelease_lock() { rm -rf "$LOCK"; }\n').removals).toEqual([1])
    expect(maestroLockUses('rmdir /tmp/maestro-ios.lock\n').removals).toEqual([0])
    expect(maestroLockUses('rm -f "$WALNUT_MAESTRO_LOCK/pid"\n').removals).toEqual([0])
    expect(maestroLockUses('while ! mkdir "$LOCK" 2>/dev/null; do\n').takes).toEqual([0])
    expect(maestroLockUses('release_lock() { walnut_maestro_lock_release; }\nrmdir "$WALNUT_MAESTRO_LOCK.mutex"\n')).toEqual({ removals: [], takes: [] })
  })
})
