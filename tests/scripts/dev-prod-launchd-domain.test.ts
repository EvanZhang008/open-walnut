/**
 * scripts/dev-prod.sh keeps its launchd job in ONE domain for the job's whole
 * life: it bootstraps into $LAUNCHD_DOMAIN, and every later look at the job
 * (loaded? which pid?) names that same domain through `launchctl print
 * <domain>/<label>`. A removal boots the label out of both per-user domains
 * (gui/<uid> and user/<uid>: an earlier deploy may have run from the other kind
 * of session), waits until neither holds it, and returns 1 when one still does.
 *
 * The script used to bootstrap into gui/<uid> but list and remove with the legacy
 * commands, which act in the CALLER's domain (not gui/<uid> from ssh). And a
 * legacy remove is asynchronous: a bootstrap of the same label right after it
 * failed (still loaded) and the deploy fell back to submit.
 *
 * The helpers are extracted and run against a stubbed `launchctl`; nothing here
 * touches launchd.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')
const code = script.split('\n').filter((l) => !/^\s*#/.test(l))

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(script)
  expect(m, `function ${name} in dev-prod.sh`).not.toBeNull()
  return m![0]
}

/** The shell under test: /bin/bash (3.2 on macOS, 5.x on Linux CI), or the
 *  first one WALNUT_TEST_BASH names (colon separated), to run these under
 *  another bash on the same machine. */
const BASH = (process.env.WALNUT_TEST_BASH ?? '').split(':').filter(Boolean)[0] ?? '/bin/bash'

function bash(body: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now()
  // A non-interactive bash reads $BASH_ENV, never a profile; HOME points
  // nowhere so no rc file of the machine's can write to stderr.
  const r = spawnSync(BASH, ['-c', `set -euo pipefail\n${body}`], {
    encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: os.tmpdir(), ...env }, timeout: 20_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 }
}

// A `launchctl print gui/<uid>/<label>` answer, trimmed: the job's pid is the
// top-level line; nested blocks are indented deeper and carry their own pids.
const PRINT_SAMPLE = [
  'gui/501/com.example.walnut-test = {',
  '\tactive count = 1',
  '\tpath = /private/tmp/open-walnut-launchd.X/com.example.walnut-test.plist',
  '\ttype = Interactive',
  '\tstate = running',
  '\tdomain = gui/501 [100026]',
  '\tpid = 43797',
  '\tresource coalition = {',
  '\t\tID = 1234',
  '\t\tpid = 1',
  '\t}',
  '\tspawn type = interactive (4)',
  '}',
].join('\n')

describe('dev-prod.sh launchd domain', () => {
  it('never uses the caller-domain legacy list, and removes only through the paired fallback', () => {
    expect(code.filter((l) => /launchctl list\b/.test(l))).toEqual([])
    // The one legacy remove takes back a legacy submit that did not land in
    // $LAUNCHD_DOMAIN, in the domain that submit went to. The echo is advice.
    const removes = code.filter((l) => /launchctl remove\b/.test(l) && !/^\s*echo /.test(l))
    expect(removes).toEqual(['      launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true'])
    const at = script.indexOf(removes[0])
    expect(script.lastIndexOf('elif ! launchd_job_exists; then', at)).toBeGreaterThan(script.lastIndexOf('launch_server() {', at))
    // Every other launchctl call that names the job names its domain too: the
    // job's own, or (only to take it away) each per-user domain in turn.
    const removal = fn('launchd_label_loaded_in') + fn('remove_launchd_job')
    for (const l of code.filter((x) => /launchctl (print|bootout|bootstrap) /.test(x) && !/^\s*why=/.test(x) && !/^\s*echo /.test(x) && !/ \|\| echo /.test(x))) {
      if (/"\$d\/\$LAUNCH_LABEL"/.test(l)) {
        expect(removal).toContain(l)
        continue
      }
      expect(l).toMatch(/launchctl (print|bootout) "\$LAUNCHD_DOMAIN\/\$LAUNCH_LABEL"|launchctl bootstrap "\$LAUNCHD_DOMAIN"/)
    }
    // Picked once, before the first removal, on the launchd path only.
    const launchdPath = script.indexOf('  use_launchd=1\n')
    const pick = script.indexOf('  LAUNCHD_DOMAIN="$(launchd_domain)"\n', launchdPath)
    expect(pick).toBeGreaterThan(launchdPath)
    expect(script.indexOf('remove_launchd_job', launchdPath)).toBeGreaterThan(pick)
  })

  it('never lets a removal that failed abort the deploy (set -e): every call site decides', () => {
    // The definition aside, each call is in an `if !` or has an `||`.
    const calls = code.filter((l) => /\bremove_launchd_job\b/.test(l) && !/^remove_launchd_job\(\) \{/.test(l))
    expect(calls.length).toBe(5)
    for (const l of calls) expect(l).toMatch(/if ! remove_launchd_job; then|remove_launchd_job \|\| /)
    // The first, after the old job got its SIGTERM, starts the new server with nohup.
    const first = script.slice(script.indexOf('  if ! remove_launchd_job; then'))
    expect(first.slice(0, first.indexOf('\n  fi\n'))).toMatch(/use_launchd=0/)
  })

  it('stop_new_server turns a stuck job into a nohup rollback instead of failing', () => {
    const r = bash([
      'use_launchd=1', 'pid=""',
      'remove_launchd_job() { return 1; }',
      fn('stop_new_server'),
      'stop_new_server',
      'echo "rc=$? use_launchd=$use_launchd"',
    ].join('\n'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('rc=0 use_launchd=0\n')
  })

  it.each([
    ['Aqua', 'gui/'],
    ['Background', 'user/'],
    ['', 'user/'],
  ])('a %s session uses the %s<uid> domain', (manager, prefix) => {
    const r = bash([
      `launchctl() { if [[ "$1" == managername ]]; then [[ -n "${manager}" ]] && echo "${manager}"; return 0; fi; return 1; }`,
      'id() { echo 501; }',
      'uname() { echo Darwin; }',
      fn('launchd_domain'),
      'launchd_domain',
    ].join('\n'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`${prefix}501`)
  })

  it('reads the top-level pid, and nothing for a loaded job with no process', () => {
    const withPid = bash(`${fn('launchd_print_pid')}\nprintf '%s\\n' "$SAMPLE" | launchd_print_pid`, { SAMPLE: PRINT_SAMPLE })
    expect(withPid.stdout).toBe('43797\n')
    const noPid = bash(`${fn('launchd_print_pid')}\nprintf '%s\\n' "$SAMPLE" | launchd_print_pid; echo "rc=$?"`, {
      SAMPLE: PRINT_SAMPLE.split('\n').filter((l) => l !== '\tpid = 43797').join('\n'),
    })
    expect(noPid.stdout).toBe('rc=0\n')
  })

  /**
   * remove_launchd_job against a stub: the job stays loaded in each domain for
   * that many more prints, and each print takes `printSecs`.
   */
  const removeHarness = (gui: number, user: number, waitSecs: number, printSecs = 0) => [
    'LAUNCH_LABEL=com.example.walnut-test',
    'LAUNCHD_DOMAIN=gui/501',
    `LAUNCHD_BOOTOUT_WAIT_SECS=${waitSecs}`,
    'uname() { echo Darwin; }',
    'id() { echo 501; }',
    // The loaded-in check runs in a command substitution (a subshell), so the
    // stub keeps its counters in files.
    'S="$(mktemp -d)"; trap \'rm -rf "$S"\' EXIT',
    `echo ${gui} > "$S/gui"; echo ${user} > "$S/user"`,
    'BOOTOUTS=""',
    // bootout returns at once; the job stays loaded for that many more prints per domain.
    `loaded() { local n; ${printSecs > 0 ? `sleep ${printSecs}; ` : ''}n="$(cat "$S/$1")"; if (( n > 0 )); then echo $(( n - 1 )) > "$S/$1"; return 0; fi; return 113; }`,
    'launchctl() {',
    '  case "$1 $2" in',
    '    "bootout gui/501/com.example.walnut-test"|"bootout user/501/com.example.walnut-test") BOOTOUTS="$BOOTOUTS ${2%%/com.*}"; return 0 ;;',
    '    "print gui/501/com.example.walnut-test") loaded gui ;;',
    '    "print user/501/com.example.walnut-test") loaded user ;;',
    '    *) echo "UNEXPECTED launchctl $*"; return 1 ;;',
    '  esac',
    '}',
    fn('launchd_label_domains'),
    fn('launchd_label_loaded_in'),
    fn('remove_launchd_job'),
    'if remove_launchd_job; then rc=0; else rc=$?; fi',
    'echo "DONE rc=$rc bootouts=$BOOTOUTS"',
  ].join('\n')

  it('boots the label out of both per-user domains and waits until it is really gone', () => {
    const r = bash(removeHarness(3, 0, 5))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DONE rc=0 bootouts= gui/501 user/501\n')
    expect(r.stderr).toBe('')
  })

  it('takes away a job an earlier deploy loaded from the other kind of session', () => {
    // This deploy runs from a GUI login (gui/501); the old job came from ssh.
    const r = bash(removeHarness(0, 2, 5))
    expect(r.stdout).toBe('DONE rc=0 bootouts= gui/501 user/501\n')
    expect(r.stderr).toBe('')
  })

  it('gives up after the bounded wait, says where the job still is, and returns 1', () => {
    const r = bash(removeHarness(1_000_000, 1_000_000, 1))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DONE rc=1 bootouts= gui/501 user/501\n')
    expect(r.stderr).toMatch(/still loaded in gui\/501 user\/501 1s after bootout/)
    expect(r.ms).toBeLessThan(8_000)
  })

  it('bounds the wait by the clock, not by rounds, when every print is slow', () => {
    // Two prints of 1 s per round: counting rounds (5 per second of the wait)
    // made a 2 s wait take 10 rounds, 22 s.
    const r = bash(removeHarness(1_000_000, 1_000_000, 2, 1))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DONE rc=1 bootouts= gui/501 user/501\n')
    expect(r.stderr).toMatch(/still loaded in gui\/501 user\/501 2s after bootout/)
    expect(r.ms).toBeLessThan(8_000)
  })

  it('keeps the bootstrap error: on stderr, in the server log, and outside the first-output baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-domain-'))
    try {
      const log = path.join(dir, 'server.log')
      fs.writeFileSync(log, 'earlier server output\n')
      const r = bash([
        'LAUNCH_LABEL=com.example.walnut-test',
        'LAUNCHD_DOMAIN=gui/501',
        `SERVER_LOG='${log}'`,
        `TMPDIR='${dir}'`,
        'server_log_baseline=22',
        'uname() { echo Darwin; }',
        'plutil() { return 0; }',
        'launchctl() {',
        '  if [[ "$1" == bootstrap && "$2" == gui/501 ]]; then',
        '    echo "Bootstrap failed: 5: Input/output error" >&2',
        '    echo "Try re-running the command as root for richer errors." >&2',
        '    return 5',
        '  fi',
        '  echo "UNEXPECTED launchctl $*"; return 1',
        '}',
        'write_launchd_plist() { echo "<plist/>" > "$1"; }',
        fn('bootstrap_interactive_job'),
        'if bootstrap_interactive_job; then echo LOADED; else echo FELL_BACK; fi',
        'echo "baseline=$server_log_baseline"',
      ].join('\n'))
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/^FELL_BACK\n/)
      expect(r.stderr).toMatch(/launchctl bootstrap gui\/501: Bootstrap failed: 5: Input\/output error Try re-running/)
      const logText = fs.readFileSync(log, 'utf8')
      expect(logText).toMatch(/dev-prod\.sh: Interactive load of com\.example\.walnut-test failed, using launchctl submit: launchctl bootstrap gui\/501: Bootstrap failed: 5/)
      expect(r.stdout).toContain(`baseline=${Buffer.byteLength(logText)}`)
      // The private plist dir is gone either way.
      expect(fs.readdirSync(dir).filter((n) => n.startsWith('open-walnut-launchd.'))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
