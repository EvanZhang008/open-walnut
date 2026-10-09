/**
 * Ratchet for the remote-host onboarding test (scripts/onboarding-test/remote-host/).
 *
 * The live test there is only worth anything while its container stays the dev
 * box it copies. A fixture that quietly gained gcc, node or a preinstalled Bun, or
 * lost the ~/workplace symlink or the npm-built claude, would keep CI green while
 * proving nothing. These checks pin those invariants as text, plus the runner's
 * safety (loud without Docker, tears down only what it started, no key committed)
 * and the CI wiring (the job exists and blocks through `CI OK`).
 *
 * Nothing here needs Docker or a network. The two runner cases execute run.sh
 * with a PATH that holds nothing (or only a fake `docker` that fails `info`), so
 * it exits at its first check, before any image, container or key exists.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'
import type { HostFixRecord } from '../../src/core/hosts/host-autofix.js'
import { readFixes, wantedFixes } from '../live/remote-host-onboarding-adapters.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const DIR = path.join(REPO, 'scripts', 'onboarding-test', 'remote-host')
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf-8')
const codeLines = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('#'))

const dockerfile = read(DIR, 'Dockerfile')
const dockerCode = codeLines(dockerfile).join('\n')
const runSh = read(DIR, 'run.sh')

/** Every package named by an `apt-get install` in the Dockerfile. */
export function aptPackages(src: string): string[] {
  const joined = codeLines(src).join('\n').replace(/\\\n/g, ' ')
  const out: string[] = []
  for (const m of joined.matchAll(/apt-get install([^&;\n]*)/g)) {
    out.push(...m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-')))
  }
  return out
}

/** A compiler, a JavaScript runtime, or a meta package that pulls one in. */
const BANNED_PACKAGE = /^(gcc|g\+\+|cpp|clang|llvm|tcc|cc|build-essential|nodejs|node|npm|bun)(-[\w.+-]*)?$/

describe('remote-host fixture · the container stays the dev box it copies', () => {
  it('starts from a stock image pinned by digest, with the bump command next to it', () => {
    expect(dockerfile).toMatch(/^FROM \$\{BASE_REGISTRY\}\/(ubuntu:24\.04|debian:bookworm-slim)@sha256:[0-9a-f]{64}$/m)
    expect(dockerfile).toMatch(/^ARG BASE_REGISTRY=docker\.io\/library$/m)
    expect(dockerfile).toContain('docker buildx imagetools inspect')
  })

  // 2026-10-09: Docker Hub answered both attempts with 429 (its anonymous limit
  // counts the hosted runner's shared address). The digest pins the bytes, so a
  // mirror of the library is the same image.
  it('takes the pinned base image from a mirror when Docker Hub refuses it, and only then', () => {
    const registries = /^BASE_REGISTRIES="([^"]+)"$/m.exec(runSh)?.[1].split(' ')
    expect(registries).toEqual(['docker.io/library', 'mirror.gcr.io/library', 'public.ecr.aws/docker/library'])
    expect(runSh).toContain('docker build --build-arg "BASE_REGISTRY=$registry" -t "$IMAGE" "$HERE"')
    const refused = new RegExp(/^BASE_REFUSED_PATTERN='([^']+)'$/m.exec(runSh)![1]!, 'i')
    // The line Docker printed that day, and the shape of a registry that cannot be reached.
    expect(refused.test('#3 ERROR: failed to copy: httpReadSeeker: failed open: unexpected status code https://registry-1.docker.io/v2/library/ubuntu/manifests/sha256:0081: 429 Too Many Requests - Server message: toomanyrequests')).toBe(true)
    expect(refused.test('ERROR: failed to solve: ubuntu:24.04@sha256:0081: failed to resolve source metadata for docker.io/library/ubuntu:24.04@sha256:0081: dial tcp: lookup registry-1.docker.io: no such host')).toBe(true)
    // An apt mirror or a broken RUN line is not the base image: no other registry would help.
    expect(refused.test('E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Could not resolve archive.ubuntu.com')).toBe(false)
    expect(refused.test('ERROR: failed to solve: process "/bin/sh -c apt-get install -y nope" did not complete successfully: exit code: 100')).toBe(false)
    expect(runSh).toMatch(/grep -Eiq "\$BASE_REFUSED_PATTERN" "\$WORK\/docker-build\.log" \|\| break/)
  })

  it('installs exactly what sshd, the Bun installer and the daemon need, without recommends', () => {
    const pkgs = aptPackages(dockerfile)
    for (const need of ['openssh-server', 'curl', 'unzip', 'ca-certificates', 'git', 'bash', 'coreutils', 'procps', 'sudo']) {
      expect(pkgs, `the fixture must install ${need}`).toContain(need)
    }
    expect(dockerCode).toContain('--no-install-recommends')
  })

  it('installs no compiler and no node, npm or bun package', () => {
    const banned = aptPackages(dockerfile).filter((p) => BANNED_PACKAGE.test(p))
    expect(banned, `banned packages in the fixture: ${banned.join(', ')}`).toEqual([])
  })

  it('fails its own build if a compiler or a JavaScript runtime shows up anyway', () => {
    const loop = /for tool in ([^;]+); do/.exec(dockerCode)?.[1].split(/\s+/) ?? []
    for (const tool of ['gcc', 'cc', 'clang', 'node', 'npm', 'bun']) expect(loop).toContain(tool)
    expect(dockerCode).toMatch(/fixture invariant broken: \$tool is installed[^\n]*exit 1/)
  })

  it('has sudo, but alice cannot use it without a password (the autofix step expects needsPassword)', () => {
    expect(dockerCode).not.toMatch(/NOPASSWD|sudoers|-a?G sudo\b|adduser alice sudo|gpasswd/)
    expect(dockerCode).toContain("usermod -p '*' alice")
  })

  it('does not preinstall Bun (Walnut installs it; that is the step under test)', () => {
    expect(dockerCode).not.toMatch(/bun\.sh|oven-sh|\/\.bun\b/)
  })

  it('has alice, /workplace/proj-a and proj-b, a real ~/workspace and ~/workplace -> /workplace', () => {
    expect(dockerCode).toMatch(/useradd [^\n]*\balice\b/)
    expect(dockerCode).toMatch(/mkdir -p [^\n]*\/workplace\/proj-a [^\n]*\/workplace\/proj-b [^\n]*\/home\/alice\/workspace/)
    expect(dockerCode).toContain('ln -s /workplace /home/alice/workplace')
    expect(dockerCode).not.toMatch(/ln -s \S+ \/home\/alice\/workspace\b/)
  })

  it('lays out claude as the npm build: ~/.local/bin/claude links to cli.js', () => {
    const cli = '/home/alice/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
    expect(dockerCode).toContain(`COPY fixture/claude-cli.js ${cli}`)
    expect(dockerCode).toContain('ln -s ../lib/node_modules/@anthropic-ai/claude-code/cli.js /home/alice/.local/bin/claude')
    expect(dockerCode).toContain(`chmod 0755 ${cli}`)
  })

  it('gives the fake claude the npm shebang, and makes it fail loudly if it ever runs', () => {
    const fake = read(DIR, 'fixture', 'claude-cli.js')
    expect(fake.split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(fake).toMatch(/process\.exit\((?!0\))\d+\)/)
  })

  it('marks itself, and the live test refuses any host without the same marker', () => {
    expect(dockerCode).toContain('echo walnut-onboarding-remote-host > /etc/walnut-onboarding-fixture')
    const live = read(REPO, 'tests', 'live', 'remote-host-onboarding.live.test.ts')
    expect(live).toContain('cat /etc/walnut-onboarding-fixture')
    expect(live).toContain("toContain('walnut-onboarding-remote-host')")
  })
})

describe('remote-host fixture · ssh is key-only and no key is committed', () => {
  it('sshd allows public keys only, from a root-owned per-user file', () => {
    const conf = read(DIR, 'sshd-onboarding.conf')
    for (const line of ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin no', 'AuthorizedKeysFile /etc/ssh/authorized_keys/%u']) {
      expect(conf).toMatch(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\/%]/g, '\\$&')}$`, 'm'))
    }
    expect(dockerCode).toContain('COPY sshd-onboarding.conf /etc/ssh/sshd_config.d/')
  })

  it('takes the public key from the runner at start, never from the image', () => {
    const entry = read(DIR, 'entrypoint.sh')
    expect(entry).toContain('"$WALNUT_ONBOARDING_AUTHORIZED_KEY" > /etc/ssh/authorized_keys/alice')
    expect(entry).toContain('ssh-keygen -A')
    expect(dockerCode).not.toMatch(/authorized_keys/)
    expect(dockerCode).not.toMatch(/ARG\s+\S*KEY/i)
  })

  it('commits no key material anywhere in the fixture', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(DIR)
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf-8')
      expect(text, `${f} carries a private key`).not.toMatch(/PRIVATE KEY-----/)
      expect(text, `${f} carries a public key`).not.toMatch(/\bssh-(ed25519|rsa|dss) AAAA/)
      expect(text, `${f} carries a public key`).not.toMatch(/\becdsa-sha2-nistp\d+ AAAA/)
    }
  })
})

describe('remote-host runner · loud without Docker, scoped teardown', () => {
  const runWithPath = (pathDir: string) => spawnSync('/bin/bash', [path.join(DIR, 'run.sh')], {
    env: { PATH: pathDir }, encoding: 'utf-8', timeout: 20_000,
  })

  it('exits 1 with a clear message when docker is not on PATH', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ratchet-empty-'))
    try {
      const r = runWithPath(empty)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('docker is not installed or not on PATH')
      expect(r.stderr).toContain("job 'remote-host'")
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('exits 1 when the docker daemon is down, having asked docker nothing but `info`', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ratchet-docker-'))
    try {
      const calls = path.join(fake, 'calls')
      fs.writeFileSync(path.join(fake, 'docker'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`, { mode: 0o755 })
      const r = runWithPath(fake)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('its daemon is not running')
      expect(fs.readFileSync(calls, 'utf-8').trim().split('\n')).toEqual(['info'])
    } finally {
      fs.rmSync(fake, { recursive: true, force: true })
    }
  })

  it('checks Docker before it creates anything', () => {
    const check = runSh.indexOf('command -v docker')
    for (const creates of ['mktemp', 'docker build', 'docker run', 'ssh-keygen -q']) {
      expect(runSh.indexOf(creates), `${creates} must come after the Docker check`).toBeGreaterThan(check)
    }
  })

  it('removes only the container and temp dir it created, on EXIT', () => {
    expect(runSh).toContain('trap cleanup EXIT')
    expect(runSh).toContain('docker rm -f "$CONTAINER_ID"')
    expect(runSh).toMatch(/case "\$WORK" in\s*\n\s*\/tmp\/walnut-rh\.\*\) \[ "\$KEEP" = 1 \] \|\| rm -rf "\$WORK"/)
    const code = codeLines(runSh).join('\n')
    for (const banned of [/docker (system|container|image|volume) prune/, /docker ps -q/, /docker rm -f \$\(/, /xargs[^\n]*docker/]) {
      expect(code, `unscoped docker teardown: ${banned}`).not.toMatch(banned)
    }
  })

  it('binds sshd to loopback on a Docker-chosen port and keeps ssh away from real known_hosts', () => {
    expect(runSh).toContain('-p 127.0.0.1::22')
    for (const opt of ['UserKnownHostsFile /dev/null', 'IdentitiesOnly yes', 'IdentityAgent none', 'HostName 127.0.0.1', 'User alice']) {
      expect(runSh).toContain(opt)
    }
  })

  it('hands the live test its two variables and runs that file under the live config', () => {
    expect(runSh).toContain('export WALNUT_REMOTE_ONBOARDING_SSH_CONFIG=')
    expect(runSh).toContain('export WALNUT_REMOTE_ONBOARDING_HOST=')
    expect(runSh).toContain('--config vitest.live.config.ts tests/live/remote-host-onboarding.live.test.ts')
    expect(fs.existsSync(path.join(REPO, 'tests', 'live', 'remote-host-onboarding.live.test.ts'))).toBe(true)
  })

  it('labels a failed image pull or apt fetch as NETWORK, and keeps the build log', () => {
    expect(runSh).toContain('> "$WORK/docker-build.log" 2>&1')
    expect(runSh).toMatch(/die "NETWORK: docker build could not fetch/)
    for (const sign of ['Could not resolve', 'toomanyrequests', 'Failed to fetch']) expect(runSh).toContain(sign)
  })

  it('stays bash 3.2 safe (it also runs from a stock macOS shell)', () => {
    const code = codeLines(runSh).join('\n')
    for (const re of [/\bdeclare\s+-A\b/, /\b(mapfile|readarray)\b/, /\$\{[A-Za-z_]\w*(,,|\^\^)/, /&>>/, /\|&/]) {
      expect(code).not.toMatch(re)
    }
  })
})

describe('remote-host live test · gated and aimed at the real transport', () => {
  const live = read(REPO, 'tests', 'live', 'remote-host-onboarding.live.test.ts')

  it('only the live config picks it up, and it skips without the runner env', () => {
    expect(live).toMatch(/const describeIf = SSH_ALIAS \? describe : describe\.skip/)
    expect(live).toContain('process.env.WALNUT_REMOTE_ONBOARDING_HOST')
  })

  it('labels a download failure at install-runtime as NETWORK, only with evidence', () => {
    expect(live).toContain('throw new Error(`NETWORK: ${cause}')
    // Evidence comes from the box itself, not only from Walnut's (thin) error text.
    // Any HTTP answer is a live network, so no `curl -f`; only a transport failure counts.
    expect(live).toContain('curl -sS -o /dev/null --max-time 20 "$u"')
    expect(live).toContain("unreachableFromBox(['https://bun.sh/install', 'https://github.com'])")
    expect(live).toContain("unreachableFromBox(['https://claude.ai/install.sh', 'https://storage.googleapis.com'])")
    expect(live).toContain('throw new Error(`NETWORK: the native Claude Code installer could not download')
    // Bun present on the box means install-runtime worked: never blame the network then.
    expect(live).toMatch(/if \(\/\^BUN_OK\$\/m\.test\(\w+\)\) return null/)
  })

  it('runs a to e with autofix OFF, set before any product module loads', () => {
    expect(live).toContain("if (SSH_ALIAS) process.env.WALNUT_HOST_AUTOFIX = '0'")
    // Every product import is dynamic (type imports aside), so nothing reads the env first.
    for (const file of [live, read(REPO, 'tests', 'live', 'remote-host-onboarding-adapters.ts')]) {
      expect(file).not.toMatch(/^import (?!type )[^\n]*'\.\.\/\.\.\/src\//m)
    }
  })

  it('turns autofix on only in the opt-in step f', () => {
    expect(live).toContain("const AUTOFIX_STEP = process.env.WALNUT_REMOTE_ONBOARDING_AUTOFIX === '1'")
    expect(live.match(/process\.env\.WALNUT_HOST_AUTOFIX = '1'/g)).toHaveLength(1)
    const reconnect = live.slice(live.indexOf('async function reconnectWithAutofix'), live.indexOf('// ── The journey'))
    expect(reconnect).toContain("process.env.WALNUT_HOST_AUTOFIX = '1'")
    expect(reconnect).toContain('hr.wireHostReadiness({ onConnected: dc.addOnDaemonHostConnected')
    const stepF = live.slice(live.indexOf("it('f. (opt-in)"))
    expect(stepF).toMatch(/if \(!AUTOFIX_STEP\) \{[^}]*ctx\.skip\(\)/)
    expect(stepF).toContain(".toMatchObject({ ok: false, needsPassword: true })")
    expect(stepF).toContain("toMatchObject({ found: true, kind: 'native' })")
  })

  it('takes the prebuilt branch from the server\'s own lookup, and logs which branch ran', () => {
    const adapters = read(REPO, 'tests', 'live', 'remote-host-onboarding-adapters.ts')
    expect(adapters).toContain("findPrebuiltDtach('Linux', unameMachine)")
    expect(live).toContain('prebuilt = await serverPrebuiltDtach(arch)')
    for (const step of ['c', 'd', 'f']) expect(live).toContain(`log(\`${step}. branch: \${prebuilt ? 'prebuilt' : 'no_compiler'}\`)`)
    // A walnut-dtach left by an earlier run would fake the prebuilt branch.
    expect(live).toContain('echo has=walnut-dtach')
    const stepD = live.slice(live.indexOf("it('d. "), live.indexOf("it('e. "))
    expect(stepD).toContain('path: `${remoteHome}/.local/bin/walnut-dtach`')
  })

  it('waits for the gcc fix only while dtach is missing, read from the real fix records', () => {
    expect(wantedFixes(false)).toEqual(['install-claude-native', 'install-compiler'])
    expect(wantedFixes(true)).toEqual(['install-claude-native'])
    const record: HostFixRecord = { action: 'install-compiler', ok: false, needsPassword: true, finishedAt: 1, text: 'Could not install gcc automatically' }
    expect(readFixes({ fixes: [record] })).toEqual([expect.objectContaining({ id: 'install-compiler', ok: false, needsPassword: true })])
    const stepF = live.slice(live.indexOf("it('f. (opt-in)"))
    expect(stepF).toContain('const wanted = wantedFixes(Boolean(prebuilt))')
    expect(stepF).toContain('reconnectWithAutofix(wanted)')
    expect(stepF).toContain('expect(fixes.map((f) => f.id), JSON.stringify(fixes)).toEqual(wanted)')
    expect(stepF).toMatch(/if \(prebuilt\) \{\s*expect\(compilerFix[^\n]*\.toBeUndefined\(\)/)
  })

  it('drives the pooled ssh DaemonConnection, never a direct WebSocket shortcut', () => {
    expect(live).toContain('getDaemonConnection(HOST_KEY, SSH_TARGET)')
    expect(live).not.toMatch(/connectDirect|getDirectDaemonConnection|ws:\/\//)
  })
})

describe('CI · the remote-host job exists and blocks', () => {
  const ci = yaml.load(read(REPO, '.github', 'workflows', 'ci.yml')) as {
    jobs: Record<string, { 'runs-on'?: string; needs?: string | string[]; 'timeout-minutes'?: number; steps?: Array<{ run?: string }> }>
  }
  const job = ci.jobs['remote-host']

  it('runs the runner on the pinned Ubuntu image after build', () => {
    expect(job, 'ci.yml lost the remote-host job').toBeDefined()
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect([job.needs].flat()).toContain('build')
    expect(job.steps?.some((s) => s.run?.includes('scripts/onboarding-test/remote-host/run.sh'))).toBe(true)
  })

  it('retries run.sh once, caps each attempt, and keeps both attempts\' logs', () => {
    const step = job.steps?.find((st) => st.run?.includes('scripts/onboarding-test/remote-host/run.sh')) as
      { run: string; shell?: string; 'timeout-minutes'?: number }
    expect(step.run).toContain('for attempt in 1 2; do')
    // GitHub runs `shell: bash` as `bash -eo pipefail`: without +e attempt 1 ends the loop.
    expect(step.run).toMatch(/^set \+e$/m)
    const cap = /timeout --kill-after=\S+ (\d+)m bash scripts\/onboarding-test\/remote-host\/run\.sh 2>&1 \| tee "\$log"/.exec(step.run)
    expect(cap, 'each attempt must be capped by timeout').not.toBeNull()
    // Two capped attempts fit the step, and the step plus ~4 min of setup fits the job,
    // so one hang can never use the budget twice.
    const attempt = Number(cap![1])
    expect(2 * attempt).toBeLessThanOrEqual(step['timeout-minutes'] ?? 0)
    expect((step['timeout-minutes'] ?? 0) + 4).toBeLessThanOrEqual(job['timeout-minutes'] ?? 0)
    expect((step as { env?: Record<string, string> }).env?.WALNUT_REMOTE_ONBOARDING_AUTOFIX, 'CI runs the autofix step').toBe('1')
    expect(step.run).toContain('status=${PIPESTATUS[0]}')
    expect(step.run).toContain('"$GITHUB_STEP_SUMMARY"')
    const upload = job.steps?.find((st) => (st as { uses?: string }).uses?.startsWith('actions/upload-artifact')) as
      { if?: string; with?: { path?: string } } | undefined
    expect(upload?.if, 'logs must be kept when the retry passes too').toBe('always()')
    expect(upload?.with?.path).toBe('/tmp/remote-host-logs/')
  })

  it('is a need of CI OK, and CI OK fails when it does not succeed', () => {
    const gate = ci.jobs['ci-ok']
    expect([gate.needs].flat()).toContain('remote-host')
    const script = (gate.steps ?? []).map((s) => s.run ?? '').join('\n')
    expect(script).toContain('[ "${{ needs.remote-host.result }}" = "success" ] ||')
  })

  it('is documented next to the other onboarding targets', () => {
    const readme = read(REPO, 'scripts', 'onboarding-test', 'README.md')
    expect(readme).toContain('## The second machine: remote host')
    expect(readme).toMatch(/^\| `remote-host` \|/m)
    expect(readme).toContain('WALNUT_REMOTE_ONBOARDING_AUTOFIX=1')
    expect(readme).toContain('WALNUT_HOST_AUTOFIX=0')
  })
})

describe('remote-host ratchet · the detectors actually catch things', () => {
  it('reads packages across line continuations and flags compilers and runtimes', () => {
    const src = 'RUN apt-get update \\\n && apt-get install -y --no-install-recommends \\\n      curl gcc-13 nodejs \\\n && true'
    expect(aptPackages(src)).toEqual(['curl', 'gcc-13', 'nodejs'])
    expect(aptPackages(src).filter((p) => BANNED_PACKAGE.test(p))).toEqual(['gcc-13', 'nodejs'])
    for (const ok of ['openssh-server', 'ca-certificates', 'procps', 'coreutils']) {
      expect(BANNED_PACKAGE.test(ok), ok).toBe(false)
    }
    for (const bad of ['build-essential', 'clang-18', 'npm', 'g++', 'cpp']) expect(BANNED_PACKAGE.test(bad), bad).toBe(true)
  })

  it('ignores packages named only in comments', () => {
    expect(aptPackages('# apt-get install gcc\nRUN apt-get install -y curl')).toEqual(['curl'])
  })
})
