/**
 * scripts/dev-prod.sh runs the production server under Walnut.app's session host.
 *
 * 2026-11-04, the user: "why it keep asking me". launchd started the compiled file
 * straight from each deploy's new stage directory, and macOS Local Network privacy
 * keys an unbundled program's choice on its path (and Mach-O UUID), so every deploy
 * asked "Allow walnut-darwin-arm64 to find devices on local networks?" again. Under
 * the host the responsible program is Walnut.app, whose one choice holds for every
 * build.
 *
 * The functions are extracted from the script and run for real under every bash
 * here, with a stub walnut file and a stub host, never the deploy itself.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(script)
  expect(m, `function ${name} in dev-prod.sh`).not.toBeNull()
  return m![0]
}

function bashes(): string[] {
  const found = new Map<string, string>()
  for (const c of ['/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', ...(process.env.WALNUT_TEST_BASH ?? '').split(':').filter(Boolean)]) {
    if (c && fs.existsSync(c) && !found.has(fs.realpathSync(c))) found.set(fs.realpathSync(c), c)
  }
  return [...found.values()]
}

/** A stage with a stub walnut file whose `__session-host-approve` answers `status` and logs its argv. */
function fixture(status: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-host-'))
  const host = path.join(dir, 'Applications', 'Walnut.app', 'Contents', 'MacOS', 'Walnut')
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const file = path.join(dir, 'stage', 'dist-bin', 'walnut-darwin-arm64')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const log = path.join(dir, 'approve.log')
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nprintf 'RT=%s\\n' "$WALNUT_RUNTIME_DIR" >> '${log}'\n[ ${status} -eq 0 ] && echo '${host}'\nexit ${status}\n`, { mode: 0o755 })
  return { dir, host, file, log }
}

function run(bash: string, f: ReturnType<typeof fixture>, extra = ''): { prefix: string[]; argv: string[]; stdout: string } {
  const body = [
    'set -euo pipefail',
    'uname() { echo Darwin; }',
    `PORT=3456; LAUNCH_LABEL=com.example.prod; SERVE_ROOT='${f.dir}'; SERVER_LOG='${f.dir}/server.log'; REHEARSAL=0; PATH="$PATH"`,
    extra,
    fn('set_server_argv'), fn('launchd_job_argv'), fn('session_host_prefix'),
    `set_server_argv '${f.file}'`,
    `session_host_prefix '${f.file}'`,
    'launchd_job_argv',
    'printf "PREFIX:%s\\n" ${host_prefix[@]+"${host_prefix[@]}"}',
    'printf "ARGV:%s\\n" "${launchd_argv[@]}"',
  ].join('\n')
  const r = spawnSync(bash, ['-c', body], { encoding: 'utf8', env: { ...process.env, TMPDIR: f.dir } })
  expect(r.status, r.stderr).toBe(0)
  const lines = r.stdout.split('\n')
  return {
    prefix: lines.filter((l) => l.startsWith('PREFIX:')).map((l) => l.slice(7)).filter(Boolean),
    argv: lines.filter((l) => l.startsWith('ARGV:')).map((l) => l.slice(5)),
    stdout: r.stdout,
  }
}

describe('dev-prod.sh: the server runs under the session host', () => {
  for (const bash of bashes()) {
    it(`puts the host between the env and the file, for exactly the argv it approved (${bash})`, () => {
      const f = fixture(0)
      const { prefix, argv } = run(bash, f)
      expect(prefix).toEqual([f.host, '--session-host', '--'])
      const at = argv.indexOf(f.host)
      expect(at).toBeGreaterThan(argv.indexOf('/usr/bin/env'))
      expect(argv.slice(at)).toEqual([f.host, '--session-host', '--', f.file, 'web', '--port', '3456'])
      // The env assignments (the runtime dir) stay in front of the host, which passes them on.
      expect(argv.slice(0, at).some((a) => a.startsWith('WALNUT_RUNTIME_DIR='))).toBe(true)
      const approved = fs.readFileSync(f.log, 'utf8').split('\n')
      expect(approved.slice(0, 6)).toEqual(['__session-host-approve', '--', f.file, 'web', '--port', '3456'])
      expect(approved).toContain(`RT=${path.join(f.dir, 'stage', 'runtime')}`)
      fs.rmSync(f.dir, { recursive: true, force: true })
    })

    it(`runs the file directly when it cannot approve itself (no app, an old build) (${bash})`, () => {
      const f = fixture(3)
      const { prefix, argv, stdout } = run(bash, f)
      expect(prefix).toEqual([])
      expect(argv.slice(argv.indexOf(f.file))).toEqual([f.file, 'web', '--port', '3456'])
      expect(stdout).toMatch(/runs as its own program/)
      fs.rmSync(f.dir, { recursive: true, force: true })
    })

    it(`a rollback and WALNUT_SESSION_HOST=0 never ask the file (${bash})`, () => {
      for (const extra of ['host_plain=1', 'export WALNUT_SESSION_HOST=0']) {
        const f = fixture(0)
        const { prefix } = run(bash, f, extra)
        expect(prefix).toEqual([])
        expect(fs.existsSync(f.log)).toBe(false)
        fs.rmSync(f.dir, { recursive: true, force: true })
      }
    })
  }

  for (const bash of bashes()) {
    it(`reads a host refusal (exit 125) from launchd, and nothing else as one (${bash})`, () => {
      const probe = (lastExit: string) => spawnSync(bash, ['-c', [
        'set -euo pipefail', 'LAUNCHD_DOMAIN=gui/501; LAUNCH_LABEL=com.example.prod',
        `launchctl() { printf 'gui/501/x = {\n\tstate = running\n\tlast exit code = ${lastExit}\n}\n'; }`,
        fn('session_host_refused'), 'if session_host_refused; then echo REFUSED; else echo FINE; fi',
      ].join('\n')], { encoding: 'utf8' }).stdout.trim()
      expect(probe('125')).toBe('REFUSED')
      expect(probe('0')).toBe('FINE')
      expect(probe('1')).toBe('FINE')
      expect(probe('(never exited)')).toBe('FINE')
    })
  }

  it('a host refusal during readiness relaunches the same build directly, once', () => {
    const loop = script.slice(script.indexOf('host_retry_done=0'), script.indexOf('Server failed its bounded readiness check.'))
    expect(loop).toMatch(/session_host_refused; then\n\s+host_retry_done=1/)
    expect(loop).toMatch(/remove_launchd_job \|\| true\n\s+host_plain=1\n\s+server_log_baseline=[^\n]+\n\s+launch_server "\$SERVER_FILE"\n\s+host_plain=0/)
    // Before the first-output fast fail, so the refusal's own log line is not taken for the server's.
    expect(loop.indexOf('session_host_refused')).toBeLessThan(loop.indexOf('FIRSTLOG_SECS * 2'))
    // The approve's words never land in the server log the fast fail reads.
    expect(fn('session_host_prefix')).not.toMatch(/SERVER_LOG/)
  })

  it('the launchd path asks for the host and the rollback launches plain', () => {
    expect(fn('launch_server')).toMatch(/if \(\( use_launchd \)\); then\n\s*session_host_prefix "\$1"/)
    expect(fn('rollback_to_lkg')).toMatch(/host_plain=1\n\s*launch_server "\$lkg_path"\n\s*host_plain=0/)
  })
})
