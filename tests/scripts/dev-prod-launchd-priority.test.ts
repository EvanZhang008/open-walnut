/**
 * scripts/dev-prod.sh loads the production server as a launchd job with
 * ProcessType Interactive, not with a bare `launchctl submit`.
 *
 * A submitted job is launchd's Standard type, which macOS schedules in the
 * utility band (base priority 20), the band all the agent work on a busy Mac
 * runs in; measured 2026-10-02 the server then got 1 to 30% of one core through
 * 5 to 25 s freezes. An Interactive job gets base priority 31, like an app.
 *
 * Static ordering checks, plus the plist writer run for real (extracted from the
 * script, never the deploy itself, which would target :3456): every argument
 * must come back byte-for-byte, quotes and ampersands included, because the
 * job's command line carries the caller's whole PATH.
 *
 * The writer runs under every bash this machine has. Bash 5.2 made an
 * unquoted `&` in a `${s//pat/rep}` replacement stand for the matched text
 * (patsub_replacement), so the old escaper turned `<` into `<lt;` there: the
 * Linux CI runner (bash 5.2) went red while macOS's /bin/bash 3.2 stayed green.
 * WALNUT_TEST_BASH adds more shells (colon separated) to the list.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(script)
  expect(m, `function ${name} in dev-prod.sh`).not.toBeNull()
  return m![0]
}

/** Every distinct bash here: the system one, Homebrew's, PATH's, and any named in WALNUT_TEST_BASH. */
function bashes(): string[] {
  const found = new Map<string, string>()
  const fromPath = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  const extra = (process.env.WALNUT_TEST_BASH ?? '').split(':').filter(Boolean)
  for (const candidate of ['/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', fromPath, ...extra]) {
    if (!candidate || !fs.existsSync(candidate)) continue
    const real = fs.realpathSync(candidate)
    if (!found.has(real)) found.set(real, candidate)
  }
  return [...found.values()]
}

function bashVersion(bash: string): string {
  return execFileSync(bash, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' })
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

describe('dev-prod.sh launchd priority', () => {
  it('tries the Interactive plist before falling back to launchctl submit', () => {
    const submit = fn('submit_launchd_job')
    const tryInteractive = submit.indexOf('bootstrap_interactive_job && return 0')
    const fallback = submit.indexOf('launchctl submit')
    expect(tryInteractive).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(tryInteractive)
    const boot = fn('bootstrap_interactive_job')
    // Into the one domain every later print/bootout names (dev-prod-launchd-domain.test.ts).
    expect(boot).toMatch(/launchctl bootstrap "\$LAUNCHD_DOMAIN" "\$plist"/)
    expect(boot).toMatch(/WALNUT_DEVPROD_PROCESS_TYPE:-Interactive/)
    expect(boot).toMatch(/rm -rf "\$plist_dir"/) // the plist never outlives the load
    expect(fn('write_launchd_plist')).toMatch(/<key>ProcessType<\/key><string>Interactive<\/string>/)
    expect(fn('write_launchd_plist')).toMatch(/<key>KeepAlive<\/key><true\/>/)
  })

  it('quotes every pattern-substitution replacement that holds an ampersand', () => {
    // The static half of the bash 5.2 rule, so a Mac with only bash 3.2 still
    // catches a new `${x//a/&b}`: a replacement with `&` must be one quoted variable.
    const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const bad: string[] = []
    for (const m of code.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*\/\/?((?:\\.|[^/}])*)\/((?:\\.|"[^"]*"|[^}])*)\}/g)) {
      const rep = m[2]
      if (rep.includes('&') && !/^"\$[A-Za-z_][A-Za-z0-9_]*"$/.test(rep)) bad.push(m[0])
    }
    expect(bad).toEqual([])
    // And never inside a double-quoted expansion: bash 3.2 keeps those inner
    // quotes as literal characters.
    expect(code).not.toMatch(/"\$\{[A-Za-z_][A-Za-z0-9_]*\/\/?[^}]*\/"\$/)
    expect(fn('xml_escape')).toContain('local s="$1" amp=\'&amp;\'')
  })

  it.each(bashes().map((b) => [b, bashVersion(b)]))('escapes XML the same under %s (bash %s)', (bash) => {
    const harness = [
      fn('xml_escape'),
      // 5.2 has the shopt on by default; turn it on wherever it exists so an
      // older bash that knows it (5.2 built with it off) is held to it too.
      'shopt -s patsub_replacement 2>/dev/null || true',
      `xml_escape 'a&b <c> "d" &amp; &lt;'`,
    ].join('\n')
    const out = execFileSync(bash, ['-c', harness], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(out).toBe('a&amp;b &lt;c&gt; &quot;d&quot; &amp;amp; &amp;lt;')
  })

  it.each(bashes())('writes a plist whose arguments survive exactly under %s', (bash) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-plist-'))
    try {
      const out = path.join(dir, 'job.plist')
      const harness = [
        'set -euo pipefail',
        fn('xml_escape'), fn('launchd_job_argv'), fn('write_launchd_plist'),
        'LAUNCH_LABEL=com.example.test-job',
        `REPO_ROOT='/repo with space/a&b'`,
        `PATH='/bin:/usr/bin:/odd/"quoted"/<dir>&x'`,
        'NODE_BIN=/usr/local/bin/node',
        'PORT=3456',
        `SERVER_LOG='/tmp/log & more.log'`,
        'launchd_job_argv /stage/dist/cli.js',
        `write_launchd_plist '${out}'`,
        `printf '%s\\n' "\${launchd_argv[@]}"`,
      ].join('\n')
      const expected = execFileSync(bash, ['-c', harness], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
        .split('\n').slice(0, -1)
      const xml = fs.readFileSync(out, 'utf8')
      const args = /<key>ProgramArguments<\/key><array>\n([\s\S]*?)<\/array>/.exec(xml)![1]
        .split('\n').filter(Boolean).map((l) => unescapeXml(/^<string>([\s\S]*)<\/string>$/.exec(l)![1]))
      expect(args).toEqual(expected)
      expect(args).toContain(`PATH=/bin:/usr/bin:/odd/"quoted"/<dir>&x`)
      expect(args.slice(-4)).toEqual(['/stage/dist/cli.js', 'web', '--port', '3456'])
      expect(xml).toContain('<key>StandardOutPath</key><string>/tmp/log &amp; more.log</string>')
      // The clamp request rides in the plist only: the argv is shared with the
      // submit fallback, which stays in the utility band and must not claim otherwise.
      expect(xml).toContain('<key>EnvironmentVariables</key><dict><key>WALNUT_DAEMON_QOS_CLAMP</key><string>1</string></dict>')
      expect(expected.join(' ')).not.toContain('WALNUT_DAEMON_QOS_CLAMP')
      if (process.platform === 'darwin') {
        execFileSync('plutil', ['-lint', '-s', out])
        const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', out], { encoding: 'utf8' }))
        expect(json.ProgramArguments).toEqual(expected)
        expect(json.ProcessType).toBe('Interactive')
        expect(json.EnvironmentVariables).toEqual({ WALNUT_DAEMON_QOS_CLAMP: '1' })
        expect(json.KeepAlive).toBe(true)
        expect(json.Label).toBe('com.example.test-job')
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
