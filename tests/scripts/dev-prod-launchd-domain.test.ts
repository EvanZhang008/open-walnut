/**
 * scripts/dev-prod.sh keeps its launchd job in ONE domain for the job's whole
 * life: it bootstraps into $LAUNCHD_DOMAIN, and every later look at the job
 * (loaded? which pid?) and every removal name that same domain through
 * `launchctl print|bootout <domain>/<label>`.
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

function bash(body: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now()
  // A non-interactive bash reads $BASH_ENV, never a profile; HOME points
  // nowhere so no rc file of the machine's can write to stderr.
  const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${body}`], {
    encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', ...env }, timeout: 20_000,
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
    // Every other launchctl call that names the job names its domain too.
    for (const l of code.filter((x) => /launchctl (print|bootout|bootstrap) /.test(x) && !/^\s*why=/.test(x))) {
      expect(l).toMatch(/launchctl (print|bootout) "\$LAUNCHD_DOMAIN\/\$LAUNCH_LABEL"|launchctl bootstrap "\$LAUNCHD_DOMAIN"/)
    }
    // Picked once, before the first removal, on the launchd path only.
    const pick = script.indexOf('  LAUNCHD_DOMAIN="$(launchd_domain)"\n  remove_launchd_job\n')
    expect(pick).toBeGreaterThan(script.indexOf('  use_launchd=1\n'))
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

  const removeHarness = (loadedPrints: number, waitSecs: number) => [
    'LAUNCH_LABEL=com.example.walnut-test',
    'LAUNCHD_DOMAIN=gui/501',
    `LAUNCHD_BOOTOUT_WAIT_SECS=${waitSecs}`,
    'uname() { echo Darwin; }',
    `LEFT=${loadedPrints}`,
    'BOOTOUTS=0',
    // bootout returns at once; the job stays loaded for LEFT more prints.
    'launchctl() {',
    '  case "$1 $2" in',
    '    "bootout gui/501/com.example.walnut-test") BOOTOUTS=$(( BOOTOUTS + 1 )); return 0 ;;',
    '    "print gui/501/com.example.walnut-test") if (( LEFT > 0 )); then LEFT=$(( LEFT - 1 )); return 0; fi; return 113 ;;',
    '  esac',
    '  echo "UNEXPECTED launchctl $*"; return 1',
    '}',
    fn('launchd_job_exists'),
    fn('remove_launchd_job'),
    'remove_launchd_job',
    'echo "DONE left=$LEFT bootouts=$BOOTOUTS"',
  ].join('\n')

  it('waits after bootout until the job is really gone', () => {
    const r = bash(removeHarness(3, 5))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('DONE left=0 bootouts=1\n')
    expect(r.stderr).toBe('')
  })

  it('gives up after the bounded wait and says so, without failing the deploy', () => {
    const r = bash(removeHarness(1_000_000, 1))
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^DONE left=\d+ bootouts=1\n$/)
    expect(r.stderr).toMatch(/still loaded in gui\/501 1s after bootout/)
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
