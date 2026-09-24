/**
 * scripts/cloud/ensure-harness.sh: the step that turns a cloud companion into a
 * real exec host (Claude Code, the default engine's CLI, Bedrock settings, a
 * real $SHELL for the unit, and the config.yaml keys that switch cloud exec on).
 *
 * The REAL script runs against a temp root (WALNUT_HARNESS_ROOT) as the current
 * user, with every command that could touch the machine replaced by a stub that
 * sits first on PATH: curl (both upstream installers and the EC2 metadata
 * service), npm, systemctl, sudo, runuser, dnf, apt-get, timeout, plus a node
 * wrapper whose `--version` is fixed. The stubs record their argv, so a test can
 * assert exactly which installer ran.
 * sudo/runuser exit 97 on purpose: running as the target user must never try
 * to switch users. The one root-path test swaps in an `id` that answers root and
 * a runuser that records and runs its command. No test ever needs root.
 *
 * Invariants pinned here: operator files are never clobbered (settings.json,
 * any config.yaml key, comments), a second run changes nothing, a failed
 * install or a box without credentials stays a relay instead of advertising a
 * broken exec host, and bad arguments are rejected before any change. Runs
 * under macOS /bin/bash 3.2 as well as Linux bash: no GNU-only flags, and
 * `timeout` is a stub (macOS has none).
 */
import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import yaml from 'js-yaml'
import { SESSION_ENGINE_IDS } from '../../src/core/types.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'cloud', 'ensure-harness.sh')
const SETUP_SH = path.join(REPO_ROOT, 'scripts', 'cloud', 'setup.sh')
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const USER = os.userInfo().username

const STUBS: Record<string, string> = {
  curl: `#!/bin/sh
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
# EC2 metadata (IMDSv2): STUB_IMDS=none plays a box off AWS.
case "$url" in
  http://169.254.169.254/latest/api/token)
    echo "imds token" >> "$STUB_LOG"
    [ "\${STUB_IMDS:-role}" = none ] && exit 7
    echo "stub-imds-token"; exit 0 ;;
  http://169.254.169.254/latest/meta-data/iam/security-credentials/)
    echo "imds role" >> "$STUB_LOG"
    echo "WalnutTestRole"; exit 0 ;;
esac
echo "curl $*" >> "$STUB_LOG"
case "$url" in
  https://claude.ai/install.sh)
    [ "\${STUB_CLAUDE_NATIVE:-ok}" = fail ] && exit 22
    cat <<'EOF'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "\${STUB_CLAUDE_VERSION:-2.1.281}" > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
echo "native-installer user=$(id -un) home=$HOME shell=$SHELL" >> "$STUB_LOG"
EOF
    ;;
  https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh)
    cat <<'EOF'
echo "goose-installer configure=$CONFIGURE bin_dir=$GOOSE_BIN_DIR" >> "$STUB_LOG"
mkdir -p "$GOOSE_BIN_DIR"
printf '#!/bin/sh\\necho "1.9.0"\\n' > "$GOOSE_BIN_DIR/goose"
chmod +x "$GOOSE_BIN_DIR/goose"
EOF
    ;;
  *) exit 22 ;;
esac
`,
  npm: `#!/bin/sh
echo "npm $*" >> "$STUB_LOG"
case "$1" in
  prefix) echo "$STUB_NPM_PREFIX"; exit 0 ;;
  install)
    [ "\${STUB_NPM:-ok}" = fail ] && exit 1
    pkg=""
    for a in "$@"; do case "$a" in -*|install) ;; *) pkg="$a" ;; esac; done
    case "$pkg" in
      @anthropic-ai/claude-code) bin=claude; ver="2.1.281 (Claude Code)" ;;
      @openai/codex) bin=codex; ver="codex-cli 0.156.1" ;;
      @google/gemini-cli) bin=gemini; ver="0.61.0" ;;
      opencode-ai) bin=opencode; ver="1.18.32" ;;
      @earendil-works/pi-coding-agent) bin=pi; ver="0.87.1" ;;
      @deepseek-ai/dsh) bin=dsh; ver="0.1.5" ;;
      *) echo "stub npm: unexpected package $pkg" >&2; exit 1 ;;
    esac
    mkdir -p "$STUB_NPM_PREFIX/bin"
    printf '#!/bin/sh\\necho "%s"\\n' "$ver" > "$STUB_NPM_PREFIX/bin/$bin"
    chmod +x "$STUB_NPM_PREFIX/bin/$bin"
    ;;
esac
exit 0
`,
  systemctl: '#!/bin/sh\necho "systemctl $*" >> "$STUB_LOG"\n',
  sudo: '#!/bin/sh\necho "sudo $*" >> "$STUB_LOG"\nexit 97\n',
  runuser: '#!/bin/sh\necho "runuser $*" >> "$STUB_LOG"\nexit 97\n',
  dnf: '#!/bin/sh\necho "dnf $*" >> "$STUB_LOG"\n',
  'apt-get': '#!/bin/sh\necho "apt-get $*" >> "$STUB_LOG"\n',
  // Records what it bounds, then runs it: the Linux images have a real one.
  timeout: '#!/bin/sh\necho "timeout $1 $(basename "$2")" >> "$STUB_LOG.timeout"\nshift\nexec "$@"\n',
}

/**
 * Stubs for the tests that play root: `id` answers root, runuser runs its
 * command, and setsid records that it wrapped it (a session of its own).
 */
const ROOT_STUBS: Record<string, string> = {
  setsid: `#!/bin/sh
[ "$1" = --wait ] && shift
[ "$1" = true ] || echo "setsid $(basename "$1")" >> "$STUB_LOG"
exec "$@"
`,
  id: `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
if [ "$#" -eq 1 ] && [ "$1" = -un ]; then echo root; exit 0; fi
exec /usr/bin/id "$@"
`,
  runuser: `#!/bin/sh
echo "runuser $*" >> "$STUB_LOG"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"
`,
}

interface Sandbox {
  dir: string
  root: string
  home: string
  config: string
  settings: string
  dropin: string
  link: (name: string) => string
  npmPrefix: string
  stubs: string
  log: string
  env: NodeJS.ProcessEnv
}

const sandboxes: string[] = []
afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true })
})

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-harness-'))
  sandboxes.push(dir)
  const root = path.join(dir, 'root')
  const home = path.join(root, 'var', 'lib', 'walnut')
  const stubs = path.join(dir, 'stubs')
  const npmPrefix = path.join(dir, 'npm-global')
  fs.mkdirSync(path.join(home, '.open-walnut'), { recursive: true })
  fs.mkdirSync(stubs)
  fs.mkdirSync(path.join(dir, 'tmp'))
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(stubs, name), body, { mode: 0o755 })
  }
  // node is the one real tool the script needs; wrap it alone so nothing else
  // from node's install dir (a real npm, a real claude) can leak onto PATH.
  // `--version` answers STUB_NODE_VERSION, so the package node floors are
  // judged the same on every machine.
  fs.writeFileSync(path.join(stubs, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = --version ] && [ -n "$STUB_NODE_VERSION" ]; then echo "$STUB_NODE_VERSION"; exit 0; fi',
    `exec '${process.execPath}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  const log = path.join(dir, 'calls.log')
  fs.writeFileSync(log, '')
  return {
    dir,
    root,
    home,
    config: path.join(home, '.open-walnut', 'config.yaml'),
    settings: path.join(home, '.claude', 'settings.json'),
    dropin: path.join(root, 'etc', 'systemd', 'system', 'walnut.service.d', 'harness.conf'),
    link: (name) => path.join(root, 'usr', 'local', 'bin', name),
    npmPrefix,
    stubs,
    log,
    env: {
      // sbin: macOS keeps chown there. Linux's real runuser/systemctl in these
      // dirs are shadowed by the stubs, which come first.
      PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      TMPDIR: path.join(dir, 'tmp'),
      LANG: 'C',
      WALNUT_HARNESS_ROOT: root,
      WALNUT_HARNESS_USER: USER,
      WALNUT_HARNESS_REPO: REPO_ROOT,
      STUB_LOG: log,
      STUB_NPM_PREFIX: npmPrefix,
      STUB_NODE_VERSION: 'v24.1.0',
    },
  }
}

/**
 * Runs the real script. Async on purpose: a blocking spawnSync per run starves the
 * vitest worker's event loop for a whole test, and under machine load its RPC to
 * the main process times out ("Timeout calling onTaskUpdate") though every test passed.
 */
function run(sb: Sandbox | null, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = sb ? { ...sb.env, ...extraEnv } : { PATH: '/usr/bin:/bin', ...extraEnv }
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

const calls = (sb: Sandbox): string[] => fs.readFileSync(sb.log, 'utf-8').split('\n').filter(Boolean)
/** Calls that change something: everything but the read-only probes. */
const changes = (sb: Sandbox): string[] => calls(sb).filter((c) => !c.startsWith('npm prefix') && !c.startsWith('imds '))
const bounded = (sb: Sandbox): string[] => {
  try { return fs.readFileSync(`${sb.log}.timeout`, 'utf-8').split('\n').filter(Boolean) } catch { return [] }
}
const CLAUDE_CURL = 'curl -fsSL --connect-timeout 20 --retry 2 https://claude.ai/install.sh'
/** True for a file, a directory, or a link (even a dangling one). */
const lexists = (p: string): boolean => {
  try { fs.lstatSync(p); return true } catch { return false }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readConfig = (sb: Sandbox): any => yaml.load(fs.readFileSync(sb.config, 'utf-8'))

/** One summary row: `  <item>:   <status>   <detail>`. */
function row(stdout: string, item: string): { status: string; detail: string } | null {
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^  ${escaped}:\\s+(\\S+)\\s*(.*)$`, 'm').exec(stdout)
  return m ? { status: m[1], detail: m[2] } : null
}

/** Every file under root with its content and mtime, to prove a run touched nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`
      else if (entry.isDirectory()) { out[rel] = 'dir'; walk(full) }
      else out[rel] = `${fs.statSync(full).mtimeMs}:${fs.readFileSync(full, 'utf-8')}`
    }
  }
  walk(dir)
  return out
}

describe('argument validation', () => {
  it('accepts every registered engine id and a valid region', async () => {
    for (const engine of SESSION_ENGINE_IDS) {
      const res = await run(null, ['--validate-args', '--engine', engine, '--bedrock-region', 'eu-central-1'])
      expect(res.status, `${engine}: ${res.stderr}`).toBe(0)
    }
  })

  it('keeps its engine list identical to SESSION_ENGINE_IDS (and so does the CDK app)', async () => {
    const m = /^ENGINE_IDS="([^"]+)"$/m.exec(fs.readFileSync(SCRIPT, 'utf-8'))
    expect(m?.[1].split(' ')).toEqual([...SESSION_ENGINE_IDS])
    // infra/ is its own package and cannot import src/core/types.ts.
    const stack = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'lib', 'walnut-cloud-stack.ts'), 'utf-8')
    const cdk = /HARNESS_ENGINE_IDS = \[([^\]]+)\] as const/.exec(stack)
    expect(cdk?.[1].split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...SESSION_ENGINE_IDS])
  })

  it.each([
    [['--engine', 'nope'], /unknown engine 'nope'/],
    [['--engine', 'codex; id'], /unknown engine/],
    [['--engine', 'claude codex'], /unknown engine/],
    [['--bedrock-region', 'us-west-2; id'], /invalid --bedrock-region/],
    [['--bedrock-region', 'US-WEST-2'], /invalid --bedrock-region/],
    [['--bedrock-region'], /needs a value/],
    [['--bogus'], /unknown argument: --bogus/],
  ])('rejects %j with exit 2', async (args, message) => {
    const res = await run(null, ['--validate-args', ...args])
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(message)
  })

  it('rejects a bad engine in a real run before touching anything', async () => {
    const sb = makeSandbox()
    const before = snapshot(sb.root)
    const res = await run(sb, ['--engine', 'nope'])
    expect(res.status).toBe(2)
    expect(snapshot(sb.root)).toEqual(before)
    expect(calls(sb)).toEqual([])
  })
})

describe('--dry-run', () => {
  it('prints the whole plan and changes nothing', async () => {
    const sb = makeSandbox()
    const before = snapshot(sb.root)
    const res = await run(sb, ['--dry-run', '--engine', 'codex'])
    expect(res.status, res.stderr).toBe(0)
    for (const item of ['claude-code', 'engine:codex', 'settings.json', 'systemd drop-in', 'work dir',
      'cloud.exec.enabled', 'cloud.exec.cwd_roots', 'defaults.engine']) {
      expect(row(res.stdout, item)?.status, item).toBe('planned')
    }
    expect(row(res.stdout, 'engine:codex')?.detail).toContain('npm install -g @openai/codex')
    expect(res.stdout).toContain('dry run: nothing was changed')
    expect(snapshot(sb.root)).toEqual(before)
    // Only read-only probes ran: no installer, no systemd.
    expect(changes(sb)).toEqual([])
    expect(calls(sb)).toContain('imds role')
  })
})

describe('a fresh box', () => {
  it('installs Claude Code natively, writes settings + drop-in, seeds cloud exec', async () => {
    const sb = makeSandbox()
    const res = await run(sb, ['--bedrock-region', 'us-east-2'])
    expect(res.status, res.stdout + res.stderr).toBe(0)

    // Claude Code: native installer as the service user, from its home, with a real shell.
    const log = calls(sb)
    expect(log.filter((c) => c.startsWith('curl '))).toEqual([CLAUDE_CURL])
    // Bounded, so a stalled download cannot hold first boot forever.
    expect(bounded(sb)).toContain('timeout 600 bash')
    expect(bounded(sb)).toContain('timeout 30 claude')
    expect(log).toContain(`native-installer user=${USER} home=${sb.home} shell=/bin/bash`)
    expect(log.some((c) => c.startsWith('npm install'))).toBe(false)
    expect(log.some((c) => /^(sudo|runuser) /.test(c))).toBe(false)
    // No /usr/local/bin/claude: a link on root's PATH to a file the service
    // user can rewrite. The service finds ~/.local/bin/claude by itself.
    expect(lexists(sb.link('claude'))).toBe(false)
    expect(row(res.stdout, 'claude-code')).toMatchObject({ status: 'installed' })
    expect(row(res.stdout, 'claude-code')?.detail).toBe(`2.1.281 at ${path.join(sb.home, '.local', 'bin', 'claude')}`)

    // Bedrock through the instance role: region is the parameter, no secrets, no proxy.
    const settings = JSON.parse(fs.readFileSync(sb.settings, 'utf-8'))
    expect(settings.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-2',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    })
    expect(fs.readFileSync(sb.settings, 'utf-8')).not.toMatch(/BASE_URL|BEARER|TOKEN|SECRET|KEY_ID/i)
    expect(fs.statSync(sb.settings).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sb.settings)).mode & 0o777).toBe(0o700)
    expect(row(res.stdout, 'settings.json')?.detail).toContain('instance role WalnutTestRole')

    // The unit gets a real shell; systemd reloaded, the service NOT restarted.
    expect(fs.readFileSync(sb.dropin, 'utf-8').endsWith('[Service]\nEnvironment=SHELL=/bin/bash\n')).toBe(true)
    expect(log.filter((c) => c.startsWith('systemctl'))).toEqual(['systemctl daemon-reload'])

    // Cloud exec on, sandboxed to the work dir, default engine recorded.
    const workDir = path.join(sb.home, 'work')
    expect(fs.statSync(workDir).isDirectory()).toBe(true)
    expect(fs.statSync(workDir).mode & 0o777).toBe(0o750)
    expect(readConfig(sb)).toEqual({
      cloud: { exec: { enabled: true, cwd_roots: [workDir] } },
      defaults: { engine: 'claude' },
    })
    expect(row(res.stdout, 'cloud.exec.enabled')?.status).toBe('seeded')
    expect(row(res.stdout, 'engine-auth')?.detail).toContain('instance role')
    expect(res.stdout).toMatch(/restart:\s+needed/)
  })

  it('is idempotent: a second run changes nothing and installs nothing', async () => {
    const sb = makeSandbox()
    expect((await run(sb, [])).status).toBe(0)
    const before = snapshot(sb.root)
    const callsBefore = calls(sb).length

    const res = await run(sb, [])
    expect(res.status, res.stderr).toBe(0)
    expect(snapshot(sb.root)).toEqual(before)
    const newCalls = calls(sb).slice(callsBefore)
    expect(newCalls.filter((c) => !c.startsWith('npm prefix') && !c.startsWith('imds '))).toEqual([])
    for (const item of ['claude-code', 'settings.json', 'systemd drop-in', 'work dir',
      'cloud.exec.enabled', 'cloud.exec.cwd_roots', 'defaults.engine']) {
      expect(row(res.stdout, item)?.status, item).toBe('present')
    }
    expect(res.stdout).toMatch(/restart:\s+no/)
  })
})

describe('operator state is never clobbered', () => {
  it('keeps settings.json byte for byte, and every existing config key and comment', async () => {
    const sb = makeSandbox()
    fs.mkdirSync(path.dirname(sb.settings), { recursive: true })
    const ownSettings = '{ "model": "opus", "env": { "AWS_PROFILE": "mine" } }\n'
    fs.writeFileSync(sb.settings, ownSettings)
    const ownConfig = [
      '# my companion config',
      'version: 1',
      'defaults:',
      '  priority: backlog # keep this',
      '  engine: gemini',
      'cloud:',
      '  # off until I say so',
      '  exec:',
      '    enabled: false',
      'plugins:',
      '  demo: { enabled: true }',
      '',
    ].join('\n')
    fs.writeFileSync(sb.config, ownConfig)

    const res = await run(sb, ['--engine', 'codex'])
    expect(res.status, res.stdout + res.stderr).toBe(0)

    expect(fs.readFileSync(sb.settings, 'utf-8')).toBe(ownSettings)
    expect(row(res.stdout, 'settings.json')).toMatchObject({ status: 'present' })
    expect(row(res.stdout, 'settings.json')?.detail).toContain('does not set CLAUDE_CODE_USE_BEDROCK')

    // Every existing byte stays; the one new key lands under its block.
    const workDir = path.join(sb.home, 'work')
    expect(fs.readFileSync(sb.config, 'utf-8')).toBe(
      ownConfig.replace('    enabled: false\n', `    enabled: false\n    cwd_roots:\n      - ${workDir}\n`),
    )
    expect(readConfig(sb)).toEqual({
      version: 1,
      defaults: { priority: 'backlog', engine: 'gemini' },
      cloud: { exec: { enabled: false, cwd_roots: [path.join(sb.home, 'work')] } },
      plugins: { demo: { enabled: true } },
    })
    expect(row(res.stdout, 'cloud.exec.enabled')).toMatchObject({ status: 'present', detail: 'kept false' })
    expect(row(res.stdout, 'cloud.exec.cwd_roots')?.status).toBe('seeded')
    expect(row(res.stdout, 'defaults.engine')).toMatchObject({ status: 'present', detail: 'kept "gemini"' })
    expect(res.stdout).toContain('config.yaml keeps its own defaults.engine')

    // --engine still installs the CLI it named.
    expect(calls(sb)).toContain('npm install -g --no-fund --no-audit @openai/codex')
  })

  it('leaves an unparsable config.yaml alone and still finishes', async () => {
    const sb = makeSandbox()
    fs.writeFileSync(sb.config, 'cloud: [unclosed\n')
    const res = await run(sb, [])
    expect(res.status).toBe(0)
    expect(fs.readFileSync(sb.config, 'utf-8')).toBe('cloud: [unclosed\n')
    expect(row(res.stdout, 'config.yaml')?.status).toBe('warned')
    expect(row(res.stdout, 'config.yaml')?.detail).toMatch(/does not parse as YAML/)
  })

  it('does not shadow config.yaml.bak with a fresh file (the server restores it)', async () => {
    const sb = makeSandbox()
    fs.writeFileSync(`${sb.config}.bak`, 'version: 1\nhosts: {}\n')
    const res = await run(sb, [])
    expect(res.status).toBe(0)
    expect(fs.existsSync(sb.config)).toBe(false)
    expect(row(res.stdout, 'config.yaml')?.detail).toMatch(/config\.yaml\.bak has content/)
  })

  it('fills an empty `cloud:` mapping but refuses a scalar one', async () => {
    const sb = makeSandbox()
    fs.writeFileSync(sb.config, 'cloud:\n')
    expect((await run(sb, [])).status).toBe(0)
    expect(readConfig(sb).cloud.exec.enabled).toBe(true)

    const sb2 = makeSandbox()
    fs.writeFileSync(sb2.config, 'cloud: 5\n')
    const res = await run(sb2, [])
    expect(res.status).toBe(0)
    expect(row(res.stdout, 'cloud.exec.enabled')).toMatchObject({ status: 'warned' })
    expect(readConfig(sb2)).toEqual({ cloud: 5, defaults: { engine: 'claude' } })
  })

  it('reports a flow-style mapping instead of rewriting it', async () => {
    const sb = makeSandbox()
    const own = 'cloud: { exec: { enabled: false } }   # one line, mine\n'
    fs.writeFileSync(sb.config, own)
    const res = await run(sb, [])
    expect(res.status).toBe(0)
    expect(row(res.stdout, 'cloud.exec.enabled')).toMatchObject({ status: 'present', detail: 'kept false' })
    expect(row(res.stdout, 'cloud.exec.cwd_roots')?.status).toBe('warned')
    expect(row(res.stdout, 'cloud.exec.cwd_roots')?.detail).toContain('add it by hand')
    expect(fs.readFileSync(sb.config, 'utf-8')).toBe(`${own}defaults:\n  engine: claude\n`)
  })
})

describe('Claude Code install paths', () => {
  it('falls back to npm when the native installer fails', async () => {
    const sb = makeSandbox()
    const res = await run(sb, [], { STUB_CLAUDE_NATIVE: 'fail' })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(calls(sb)).toContain('npm install -g --no-fund --no-audit @anthropic-ai/claude-code')
    // This npm prefix is off the unit's PATH, so it gets a link. Its target is
    // npm's (root-owned on a box), never a file under the service home.
    expect(fs.readlinkSync(sb.link('claude'))).toBe(path.join(sb.npmPrefix, 'bin', 'claude'))
    expect(row(res.stdout, 'claude-code')?.status).toBe('installed')
    expect(row(res.stdout, 'claude-code')?.detail).toContain('/usr/local/bin/claude linked')
  })

  it('upgrades a Claude Code older than the minimum', async () => {
    const sb = makeSandbox()
    const local = path.join(sb.home, '.local', 'bin', 'claude')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, '#!/bin/sh\necho "2.1.100 (Claude Code)"\n', { mode: 0o755 })
    const res = await run(sb, [])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('is 2.1.100, older than 2.1.280')
    expect(calls(sb).filter((c) => c.startsWith('curl '))).toEqual([CLAUDE_CURL])
    expect(row(res.stdout, 'claude-code')?.detail).toContain('2.1.281')
  })

  it('when every install fails: exits 1 and leaves the box a relay (cloud exec not seeded)', async () => {
    const sb = makeSandbox()
    const res = await run(sb, [], { STUB_CLAUDE_NATIVE: 'fail', STUB_NPM: 'fail' })
    expect(res.status).toBe(1)
    expect(row(res.stdout, 'claude-code')?.status).toBe('warned')
    expect(row(res.stdout, 'cloud.exec')?.status).toBe('skipped')
    expect(fs.existsSync(sb.config)).toBe(false)
    // The rest still converges, so the next run only has the install left to do.
    expect(fs.existsSync(sb.dropin)).toBe(true)
  })
})

describe('the default engine', () => {
  it.each([
    ['gemini', '@google/gemini-cli'],
    ['opencode', 'opencode-ai'],
    ['pi', '@earendil-works/pi-coding-agent'],
    ['dsh', '@deepseek-ai/dsh'],
  ])('%s installs its verified npm package and is seeded', async (engine, pkg) => {
    const sb = makeSandbox()
    const res = await run(sb, ['--engine', engine])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(calls(sb)).toContain(`npm install -g --no-fund --no-audit ${pkg}`)
    expect(row(res.stdout, `engine:${engine}`)?.status).toBe('installed')
    expect(row(res.stdout, 'engine-auth')?.detail).toContain('out of scope')
    expect(readConfig(sb).defaults).toEqual({ engine })
  })

  it('reads the engine from the box config when --engine is absent', async () => {
    const sb = makeSandbox()
    fs.writeFileSync(sb.config, 'defaults:\n  engine: codex\n')
    const res = await run(sb, [])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Default engine: codex (from config.yaml)')
    expect(calls(sb)).toContain('npm install -g --no-fund --no-audit @openai/codex')
    expect(row(res.stdout, 'defaults.engine')).toMatchObject({ status: 'present', detail: 'kept "codex"' })
  })

  it('goose uses the official script non-interactively, found through ~/.local/bin (no root link)', async () => {
    const sb = makeSandbox()
    const res = await run(sb, ['--engine', 'goose'])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    const goose = path.join(sb.home, '.local', 'bin', 'goose')
    expect(calls(sb)).toContain(`goose-installer configure=false bin_dir=${path.join(sb.home, '.local', 'bin')}`)
    expect(calls(sb)).toContain(
      'curl -fsSL --connect-timeout 20 --retry 2 https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh',
    )
    expect(row(res.stdout, 'engine:goose')?.detail).toContain(`at ${goose} (found through ~/.local/bin)`)
    // A file the service user can rewrite never gets a link on root's PATH.
    expect(fs.existsSync(sb.link('goose'))).toBe(false)
    expect(readConfig(sb).defaults).toEqual({ engine: 'goose' })
  })

  it('custom installs nothing and is never seeded as the default', async () => {
    const sb = makeSandbox()
    const res = await run(sb, ['--engine', 'custom'])
    expect(res.status).toBe(0)
    expect(row(res.stdout, 'engine:custom')?.status).toBe('skipped')
    expect(readConfig(sb).defaults).toBeUndefined()
    expect(readConfig(sb).cloud.exec.enabled).toBe(true)
  })

  it('a failed engine install warns, keeps claude, and does not seed that engine', async () => {
    const sb = makeSandbox()
    // Claude Code comes from the native installer; npm (the engine path) fails.
    const res = await run(sb, ['--engine', 'codex'], { STUB_NPM: 'fail' })
    expect(res.status).toBe(0)
    expect(row(res.stdout, 'engine:codex')?.status).toBe('warned')
    expect(readConfig(sb).defaults).toBeUndefined()
  })
})

describe('credentials: Bedrock only through a real instance role', () => {
  it('off AWS: installs Claude Code but writes no settings and keeps the box a relay', async () => {
    const sb = makeSandbox()
    const res = await run(sb, [], { STUB_IMDS: 'none' })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(row(res.stdout, 'claude-code')?.status).toBe('installed')
    expect(fs.existsSync(sb.settings)).toBe(false)
    expect(row(res.stdout, 'settings.json')).toMatchObject({ status: 'skipped' })
    expect(row(res.stdout, 'settings.json')?.detail).toContain('no EC2 instance role found')
    expect(row(res.stdout, 'cloud.exec')?.status).toBe('skipped')
    expect(row(res.stdout, 'cloud.exec')?.detail).toContain('no credential')
    expect(row(res.stdout, 'engine-auth')).toMatchObject({ status: 'warned' })
    // The preference is still recorded; only exec waits for a credential.
    expect(readConfig(sb)).toEqual({ defaults: { engine: 'claude' } })
  })

  it('off AWS with a claude login: cloud exec is seeded', async () => {
    const sb = makeSandbox()
    fs.mkdirSync(path.dirname(sb.settings), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(sb.settings), '.credentials.json'), '{}\n')
    const res = await run(sb, [], { STUB_IMDS: 'none' })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(fs.existsSync(sb.settings)).toBe(false)
    expect(readConfig(sb).cloud.exec.enabled).toBe(true)
    expect(row(res.stdout, 'engine-auth')?.detail).toContain('a claude login')
  })

  it('says so when a kept settings.json points at another Bedrock region', async () => {
    const sb = makeSandbox()
    fs.mkdirSync(path.dirname(sb.settings), { recursive: true })
    const own = '{ "env": { "CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "eu-west-1" } }\n'
    fs.writeFileSync(sb.settings, own)
    const res = await run(sb, ['--bedrock-region', 'us-east-2'])
    expect(res.status).toBe(0)
    expect(fs.readFileSync(sb.settings, 'utf-8')).toBe(own)
    expect(row(res.stdout, 'settings.json')?.detail).toContain('Bedrock in eu-west-1, not the requested us-east-2')
    expect(row(res.stdout, 'engine-auth')?.detail).toContain('instance role WalnutTestRole')
  })
})

describe('running as root', () => {
  it('does every write under the service home as the service user, through runuser', async () => {
    const sb = makeSandbox()
    for (const [name, body] of Object.entries(ROOT_STUBS)) {
      fs.writeFileSync(path.join(sb.stubs, name), body, { mode: 0o755 })
    }
    const res = await run(sb, [])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    const viaRunuser = calls(sb).filter((c) => c.startsWith('runuser '))
    const prefix = `runuser -u ${USER} -- env HOME=${sb.home} SHELL=/bin/bash PATH=${sb.home}/.local/bin:`
    expect(viaRunuser.length).toBeGreaterThan(0)
    for (const c of viaRunuser) expect(c.startsWith(prefix), c).toBe(true)
    // Each switch runs in a session of its own (no controlling terminal).
    expect(calls(sb).filter((c) => c === 'setsid runuser')).toHaveLength(viaRunuser.length)
    // The installer, the settings write, the work dir and the config seed.
    expect(viaRunuser.some((c) => c.includes('bash -c set -o pipefail; curl') && c.includes('https://claude.ai/install.sh'))).toBe(true)
    expect(viaRunuser.some((c) => c.includes(' write-settings '))).toBe(true)
    expect(viaRunuser.some((c) => c.includes(' mkdir-work '))).toBe(true)
    expect(viaRunuser.some((c) => c.includes('seed-harness-config.mjs'))).toBe(true)
    expect(calls(sb).some((c) => c.startsWith('sudo '))).toBe(false)
    expect(readConfig(sb).cloud.exec.enabled).toBe(true)
  })
})

describe('edges', () => {
  it('an npm prefix already on the unit PATH needs no link', async () => {
    const sb = makeSandbox()
    const res = await run(sb, ['--engine', 'codex'], { STUB_NPM_PREFIX: path.join(sb.root, 'usr') })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(row(res.stdout, 'engine:codex')?.detail).toContain(`at ${path.join(sb.root, 'usr', 'bin', 'codex')} (on PATH)`)
    expect(fs.existsSync(sb.link('codex'))).toBe(false)
  })

  it('refuses to trust a stale regular /usr/local/bin/claude it will not replace', async () => {
    const sb = makeSandbox()
    const stale = '#!/bin/sh\necho "2.1.100 (Claude Code)"\n'
    fs.mkdirSync(path.dirname(sb.link('claude')), { recursive: true })
    fs.writeFileSync(sb.link('claude'), stale, { mode: 0o755 })
    const res = await run(sb, [])
    expect(res.status).toBe(1)
    expect(fs.readFileSync(sb.link('claude'), 'utf-8')).toBe(stale)
    expect(row(res.stdout, 'claude-code')?.status).toBe('warned')
    expect(row(res.stdout, 'claude-code')?.detail).toContain('shadows any newer install')
    expect(row(res.stdout, 'cloud.exec')?.status).toBe('skipped')
    expect(fs.existsSync(sb.config)).toBe(false)
  })

  it('an old npm-managed claude first on the PATH is upgraded in place by npm', async () => {
    const sb = makeSandbox()
    const usr = path.join(sb.root, 'usr')
    fs.mkdirSync(path.join(usr, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(usr, 'bin', 'claude'), '#!/bin/sh\necho "2.1.100 (Claude Code)"\n', { mode: 0o755 })
    const res = await run(sb, [], { STUB_NPM_PREFIX: usr })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(calls(sb)).toContain('npm install -g --no-fund --no-audit @anthropic-ai/claude-code')
    // The native installer would land in ~/.local/bin, behind the stale copy.
    expect(calls(sb).some((c) => c.startsWith('curl '))).toBe(false)
    expect(row(res.stdout, 'claude-code')?.detail).toBe(`2.1.281 at ${path.join(usr, 'bin', 'claude')}`)
    expect(lexists(sb.link('claude'))).toBe(false)
  })

  it('removes a /usr/local/bin link into the service home and still finds claude there', async () => {
    const sb = makeSandbox()
    const local = path.join(sb.home, '.local', 'bin', 'claude')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, '#!/bin/sh\necho "2.1.290 (Claude Code)"\n', { mode: 0o755 })
    fs.mkdirSync(path.dirname(sb.link('claude')), { recursive: true })
    fs.symlinkSync(local, sb.link('claude'))

    const dry = await run(sb, ['--dry-run'])
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain(`would remove ${sb.link('claude')}`)
    expect(lexists(sb.link('claude'))).toBe(true)

    const res = await run(sb, [])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stdout).toContain(`removed ${sb.link('claude')}`)
    expect(lexists(sb.link('claude'))).toBe(false)
    expect(row(res.stdout, 'claude-code')).toMatchObject({ status: 'present', detail: `2.1.290 at ${local}` })
    expect(calls(sb).some((c) => c.startsWith('curl '))).toBe(false)
  })

  it('judges a /usr/local/bin link by where it resolves: relative and chained links into the home go too', async () => {
    const sb = makeSandbox()
    const local = path.join(sb.home, '.local', 'bin', 'claude')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, '#!/bin/sh\necho "2.1.290 (Claude Code)"\n', { mode: 0o755 })
    fs.mkdirSync(path.dirname(sb.link('claude')), { recursive: true })
    // /usr/local/bin/claude -> ../lib/claude-hop -> (relative) the home's claude.
    const hop = path.join(sb.root, 'usr', 'local', 'lib', 'claude-hop')
    fs.mkdirSync(path.dirname(hop), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(hop), local), hop)
    fs.symlinkSync('../lib/claude-hop', sb.link('claude'))
    const res = await run(sb, [])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stdout).toContain(`removed ${sb.link('claude')}`)
    expect(lexists(sb.link('claude'))).toBe(false)
    expect(row(res.stdout, 'claude-code')).toMatchObject({ status: 'present', detail: `2.1.290 at ${local}` })
  })

  it('an engine whose package needs a newer node is not installed or seeded, and says why', async () => {
    const sb = makeSandbox()
    const res = await run(sb, ['--engine', 'pi'], { STUB_NODE_VERSION: 'v22.12.0' })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(row(res.stdout, 'engine:pi')?.status).toBe('warned')
    expect(row(res.stdout, 'engine:pi')?.detail).toContain(
      '@earendil-works/pi-coding-agent needs node >= 22.19.0 (its engines field) but the box has node 22.12.0',
    )
    expect(calls(sb).some((c) => c.includes('pi-coding-agent'))).toBe(false)
    expect(readConfig(sb).defaults).toBeUndefined()
    expect(readConfig(sb).cloud.exec.enabled).toBe(true)

    // The same node is fine for an engine with a lower floor.
    const sb2 = makeSandbox()
    const ok = await run(sb2, ['--engine', 'gemini'], { STUB_NODE_VERSION: 'v22.12.0' })
    expect(row(ok.stdout, 'engine:gemini')?.status).toBe('installed')
  })

  it('without js-yaml it warns and leaves config.yaml alone', async () => {
    const sb = makeSandbox()
    const res = await run(sb, [], { WALNUT_HARNESS_REPO: path.join(sb.dir, 'no-checkout') })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(row(res.stdout, 'config.yaml')?.status).toBe('warned')
    expect(row(res.stdout, 'config.yaml')?.detail).toContain('js-yaml is not installed')
    expect(fs.existsSync(sb.config)).toBe(false)
  })

  it('a non-claude engine converges too: the second run installs and changes nothing', async () => {
    const sb = makeSandbox()
    const first = await run(sb, ['--engine', 'codex'])
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(fs.readlinkSync(sb.link('codex'))).toBe(path.join(sb.npmPrefix, 'bin', 'codex'))
    const before = snapshot(sb.root)
    const callsBefore = calls(sb).length

    const res = await run(sb, ['--engine', 'codex'])
    expect(res.status, res.stderr).toBe(0)
    expect(snapshot(sb.root)).toEqual(before)
    expect(calls(sb).slice(callsBefore).filter((c) => !c.startsWith('npm prefix') && !c.startsWith('imds '))).toEqual([])
    expect(row(res.stdout, 'engine:codex')?.status).toBe('present')
    expect(res.stdout).toMatch(/restart:\s+no/)
  })

  it('appends to a config.yaml the server wrote, keeping every existing byte', async () => {
    const sb = makeSandbox()
    const own = '# written by hand\nversion: 1\nagent:\n  flow: { a: 1, b: [1,2] }\n  mode: 0022   # odd but mine\n'
    fs.writeFileSync(sb.config, own)
    const res = await run(sb, [])
    expect(res.status, res.stdout + res.stderr).toBe(0)
    const text = fs.readFileSync(sb.config, 'utf-8')
    expect(text.startsWith(own)).toBe(true)
    expect(readConfig(sb)).toMatchObject({ version: 1, agent: { mode: 22 }, cloud: { exec: { enabled: true } }, defaults: { engine: 'claude' } })
  })
})

describe('the code tree must not be writable by the service user', () => {
  /** A code tree of two files and a dir, as a checkout would have them. */
  function makeCodeTree(sb: Sandbox, parent = sb.dir): string {
    const tree = path.join(parent, 'code')
    fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'package.json'), '{}\n', { mode: 0o644 })
    fs.writeFileSync(path.join(tree, 'scripts', 'build.sh'), '#!/bin/sh\n', { mode: 0o755 })
    return tree
  }
  /** Play root, with a service user other than the test user (who owns the tree). */
  function asRootFor(sb: Sandbox, serviceUser: string): NodeJS.ProcessEnv {
    for (const [name, body] of Object.entries(ROOT_STUBS)) {
      fs.writeFileSync(path.join(sb.stubs, name), body, { mode: 0o755 })
    }
    return { WALNUT_HARNESS_USER: serviceUser }
  }
  // Present on macOS and every Linux image; never the test user.
  const OTHER_USER = 'nobody'

  const MARKER = (sb: Sandbox) => path.join(sb.root, 'root', '.walnut-code-tree-exposed')

  it('refuses to run from a tree the service user owns, before changing anything but the record', async () => {
    const sb = makeSandbox()
    const tree = makeCodeTree(sb)
    const before = snapshot(sb.root)
    const res = await run(sb, [], { WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status).toBe(4)
    expect(res.stderr).toContain(`the code tree ${tree} can be changed by ${USER}`)
    expect(res.stderr).toContain('replace it from a fresh clone')
    // The finding is recorded for setup.sh and the deploy (root-only, 0600),
    // and nothing else changed: no take-back, which would erase the evidence.
    const record = fs.readFileSync(MARKER(sb), 'utf-8')
    expect(record).toContain(`ensure-harness.sh: ${tree} was writable by ${USER} (first: ${tree})`)
    expect(fs.statSync(MARKER(sb)).mode & 0o777).toBe(0o600)
    const after = snapshot(sb.root)
    delete after[path.relative(sb.root, MARKER(sb))]
    delete after[path.relative(sb.root, path.dirname(MARKER(sb)))]
    expect(after).toEqual(before)
    expect(fs.statSync(path.join(tree, 'package.json')).uid).toBe(os.userInfo().uid)
    expect(calls(sb).filter((c) => !c.startsWith('npm prefix'))).toEqual([])
  })

  it('a dry run records nothing', async () => {
    const sb = makeSandbox()
    const tree = makeCodeTree(sb)
    const res = await run(sb, ['--dry-run'], { WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status).toBe(4)
    expect(lexists(MARKER(sb))).toBe(false)
  })

  it('refuses a group- or world-writable file even when someone else owns the tree', async () => {
    for (const mode of [0o664, 0o646]) {
      const sb = makeSandbox()
      const tree = makeCodeTree(sb)
      const writable = path.join(tree, 'scripts', 'build.sh')
      fs.chmodSync(writable, mode)
      const res = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
      expect(res.status, res.stdout + res.stderr).toBe(4)
      expect(res.stderr).toContain(`(first: ${writable})`)
    }
  })

  it('refuses a writable directory above the tree (it could swap the tree), but not a sticky one', async () => {
    const sb = makeSandbox()
    const wide = path.join(sb.dir, 'wide')
    fs.mkdirSync(wide)
    const tree = makeCodeTree(sb, wide)
    fs.chmodSync(wide, 0o777)
    const res = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status).toBe(4)
    expect(res.stderr).toContain(`(first: ${wide})`)

    fs.chmodSync(wide, 0o1777)
    const sticky = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
    expect(sticky.status, sticky.stdout + sticky.stderr).toBe(0)
  })

  it('runs from a tree only someone else can write', async () => {
    const sb = makeSandbox()
    const tree = makeCodeTree(sb)
    // A link inside the tree is fine as long as the service user does not own
    // it, and so is one out to a file only someone else can change.
    fs.symlinkSync('package.json', path.join(tree, 'link.json'))
    fs.symlinkSync('/bin/sh', path.join(tree, 'scripts', 'sh'))
    const res = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stdout).toContain('dry run: nothing was changed')
  })

  it('judges a link by what it resolves to: into the service home, even relative or chained', async () => {
    const sb = makeSandbox()
    const tree = makeCodeTree(sb)
    const target = path.join(sb.home, '.local', 'bin', 'tsup')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
    fs.mkdirSync(path.join(tree, 'node_modules', '.bin'), { recursive: true })
    // tsup -> hop (in the tree) -> a relative path out into the home.
    fs.symlinkSync(path.relative(path.join(tree, 'node_modules', '.bin'), target), path.join(tree, 'node_modules', '.bin', 'hop'))
    fs.symlinkSync('hop', path.join(tree, 'node_modules', '.bin', 'tsup'))
    const res = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status, res.stdout + res.stderr).toBe(4)
    expect(res.stderr).toMatch(/node_modules\/\.bin\/(hop|tsup) \(a link into /)
  })

  it('refuses a link out of the tree to a name that does not exist yet', async () => {
    const sb = makeSandbox()
    const tree = makeCodeTree(sb)
    const missing = path.join(sb.dir, 'not-there-yet', 'tsup')
    fs.symlinkSync(missing, path.join(tree, 'scripts', 'tsup'))
    const res = await run(sb, ['--dry-run'], { ...asRootFor(sb, OTHER_USER), WALNUT_HARNESS_CODE_TREE: tree })
    expect(res.status, res.stdout + res.stderr).toBe(4)
    expect(res.stderr).toContain(`${path.join(tree, 'scripts', 'tsup')} (a link to ${missing}, which does not exist)`)
  })
})

describe('setup.sh wiring', () => {
  const setup = fs.readFileSync(SETUP_SH, 'utf-8')
  const start = setup.indexOf('# >>> harness args')
  const end = setup.indexOf('# <<< harness args')

  /** Runs setup.sh's own argument block (sliced out verbatim) against this checkout. */
  function parseSetupArgs(args: string[]) {
    const block = setup.slice(start, end)
    const script = `set -euo pipefail\nREPO_DIR='${REPO_ROOT}'\n${block}\nprintf '%s\\n' \${HARNESS_ARGS[@]+"\${HARNESS_ARGS[@]}"}\n`
    // stdin closed and a bare HOME: bash reads ~/.bashrc when stdin looks like a
    // remote shell's socket, and a developer's rc file is not what is under test.
    const res = spawnSync(BASH, ['-c', script, 'setup-args', ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30_000,
    })
    return { status: res.status, forwarded: (res.stdout ?? '').split('\n').filter(Boolean), stderr: res.stderr ?? '' }
  }

  it('keeps DOMAIN positional', async () => {
    expect(setup).toMatch(/DOMAIN="\$\{1:\?/)
    expect(start).toBeGreaterThan(setup.indexOf('DOMAIN="${1:?'))
    expect(end).toBeGreaterThan(start)
  })

  it('forwards valid flags in both spellings', async () => {
    const res = parseSetupArgs(['--engine', 'codex', '--bedrock-region=eu-west-1'])
    expect(res.status, res.stderr).toBe(0)
    expect(res.forwarded).toEqual(['--engine', 'codex', '--bedrock-region', 'eu-west-1'])
    expect(res.stderr).toBe('')
  })

  it('drops a value this checkout does not know, flag by flag, and never fails first boot', async () => {
    // A Mac on a newer release may name an engine this checkout has never heard of.
    const res = parseSetupArgs(['--engine', 'future-engine', '--bedrock-region', 'us-east-1'])
    expect(res.status).toBe(0)
    expect(res.forwarded).toEqual(['--bedrock-region', 'us-east-1'])
    expect(res.stderr).toContain("--engine 'future-engine' is not valid for this checkout; ignored")

    const odd = parseSetupArgs(['--bogus', '--bedrock-region', 'US-WEST-2', '--engine'])
    expect(odd.status).toBe(0)
    expect(odd.forwarded).toEqual([])
    expect(odd.stderr).toContain("unknown argument '--bogus' ignored")
    expect(odd.stderr).toContain('--engine has no value; ignored')

    expect(parseSetupArgs([])).toMatchObject({ status: 0, forwarded: [] })
  })

  it('checks the flags before the long build, and runs the harness after it and before the restart', async () => {
    const build = setup.indexOf('\nnpm run build\n')
    const harness = setup.indexOf('bash "$HARNESS_SCRIPT" ${HARNESS_ARGS')
    const restart = setup.indexOf('systemctl restart caddy.service walnut.service')
    expect(build).toBeGreaterThan(-1)
    expect(end).toBeLessThan(build)
    expect(harness).toBeGreaterThan(build)
    expect(harness).toBeLessThan(restart)
  })

  it('never lets a harness failure abort first boot (the box still serves as a relay)', async () => {
    expect(setup).toMatch(/if ! bash "\$HARNESS_SCRIPT" \$\{HARNESS_ARGS/)
  })

  it('keeps the code tree root-owned and read-only to the service user', async () => {
    const check = setup.indexOf('# >>> code-tree exposure')
    const args = setup.indexOf('# >>> harness args')
    const install = setup.indexOf('\nnpm ci\n')
    const normalize = setup.lastIndexOf('chmod -R a+rX,go-w "$REPO_DIR"')
    const build = setup.indexOf('\nnpm run build\n')
    const harness = setup.indexOf('bash "$HARNESS_SCRIPT" ${HARNESS_ARGS')
    // Checked before root runs a line of it (the argument check already runs the
    // harness script), never taken back in place (that erases the evidence),
    // normalized after the build, and only then does root run the harness.
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(args)
    expect(check).toBeLessThan(install)
    expect(setup.slice(0, install)).not.toMatch(/chown -R[^\n]*"\$REPO_DIR"/)
    expect(normalize).toBeGreaterThan(build)
    expect(normalize).toBeLessThan(harness)
    // Never handed to the service user, and git's ownership guard is not bypassed.
    expect(setup).not.toMatch(/chown -R "\$WALNUT_USER:\$WALNUT_USER" "\$REPO_DIR"/)
    expect(setup).not.toMatch(/safe\.directory "\$REPO_DIR"/)
  })
})

/**
 * setup.sh's root-side blocks, sliced out verbatim and run for real against a
 * temp dir. Nothing here runs as root, so "root" and "the service user" are
 * both the test user (ROOT_USER / WALNUT_USER), and as_walnut_in runs its
 * command directly: what is under test is which NAMES root writes through and
 * how, not the kernel's permission checks. Where the Linux images have GNU
 * `mv -T`, macOS gets a shim with the same rename-never-into semantics.
 */
describe('setup.sh root-side blocks, run for real', () => {
  const setup = fs.readFileSync(SETUP_SH, 'utf-8')
  const block = (name: string): string => {
    const start = setup.indexOf(`# >>> ${name}`)
    const end = setup.indexOf(`# <<< ${name}`)
    expect(start, name).toBeGreaterThan(-1)
    expect(end, name).toBeGreaterThan(start)
    return setup.slice(start, end)
  }
  const GROUP = spawnSync('id', ['-gn'], { encoding: 'utf-8' }).stdout.trim()

  function scratch(): { dir: string; bin: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-setup-blocks-'))
    sandboxes.push(dir)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    if (process.platform !== 'linux') {
      fs.writeFileSync(path.join(bin, 'mv'), [
        '#!/bin/sh',
        'case "$1" in -*T*) exec node -e \'require("fs").renameSync(process.argv[1], process.argv[2])\' "$2" "$3" ;; esac',
        'exec /bin/mv "$@"',
        '',
      ].join('\n'), { mode: 0o755 })
      fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    }
    return { dir, bin }
  }

  function runBlock(bin: string, vars: Record<string, string>, body: string, stdin = '') {
    const assigns = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n')
    const script = [
      'set -euo pipefail',
      // The service user and "root" are the same here, so no switch is needed
      // (a test that must tell them apart names them through vars).
      `ROOT_USER='${USER}'; WALNUT_USER='${USER}'; WALNUT_GROUP='${GROUP}'`,
      assigns,
      'as_walnut_in() { "$@"; }; as_walnut() { "$@" </dev/null; }',
      body,
      '',
    ].join('\n')
    const res = spawnSync(BASH, ['-c', script], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: os.tmpdir(), LANG: 'C' },
      input: stdin,
      encoding: 'utf-8',
      timeout: 30_000,
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  describe('code-tree exposure', () => {
    function tree(dir: string): string {
      const t = path.join(dir, 'opt-walnut')
      fs.mkdirSync(path.join(t, 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(t, 'package.json'), '{}\n', { mode: 0o644 })
      fs.chmodSync(t, 0o755)
      return t
    }
    const vars = (dir: string, repo: string) => ({
      REPO_DIR: repo,
      WALNUT_LIB: path.join(dir, 'var-lib-walnut'),
      EXPOSED_MARKER: path.join(dir, 'root', '.walnut-code-tree-exposed'),
    })

    it('passes a tree only root can write, with no record', () => {
      const { dir, bin } = scratch()
      const repo = tree(dir)
      const res = runBlock(bin, vars(dir, repo), block('code-tree exposure'))
      expect(res.status, res.stderr).toBe(0)
      expect(lexists(vars(dir, repo).EXPOSED_MARKER)).toBe(false)
    })

    it('records an exposed tree BEFORE anything takes it back, and refuses to build on it', () => {
      const { dir, bin } = scratch()
      const repo = tree(dir)
      const writable = path.join(repo, 'package.json')
      fs.chmodSync(writable, 0o664)
      const res = runBlock(bin, vars(dir, repo), block('code-tree exposure'))
      expect(res.status).toBe(3)
      expect(res.stderr).toContain('root will not run code from')
      const record = fs.readFileSync(vars(dir, repo).EXPOSED_MARKER, 'utf-8')
      expect(record).toContain(`setup.sh: ${repo} was writable by a non-root user (first: ${writable})`)
      expect(fs.statSync(vars(dir, repo).EXPOSED_MARKER).mode & 0o777).toBe(0o600)
      // The evidence is left exactly as found.
      expect(fs.statSync(writable).mode & 0o777).toBe(0o664)
    })

    it('keeps refusing while the record exists, even once the tree looks clean', () => {
      const { dir, bin } = scratch()
      const repo = tree(dir)
      const marker = vars(dir, repo).EXPOSED_MARKER
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(marker, 'an earlier finding\n', { mode: 0o600 })
      const res = runBlock(bin, vars(dir, repo), block('code-tree exposure'))
      expect(res.status).toBe(3)
      expect(res.stderr).toContain('an earlier finding')
      expect(res.stderr).toContain('Replace it from a fresh clone')
    })

    it('counts a link out of the tree into the service home', () => {
      const { dir, bin } = scratch()
      const repo = tree(dir)
      const home = vars(dir, repo).WALNUT_LIB
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(home, 'bin', 'tsup'), 'x')
      fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true })
      fs.symlinkSync(path.relative(path.join(repo, 'node_modules', '.bin'), path.join(home, 'bin', 'tsup')), path.join(repo, 'node_modules', '.bin', 'tsup'))
      const res = runBlock(bin, vars(dir, repo), block('code-tree exposure'))
      expect(res.status).toBe(3)
      expect(fs.readFileSync(vars(dir, repo).EXPOSED_MARKER, 'utf-8')).toContain('(a link into ')
    })
  })

  describe('/etc/walnut', () => {
    function layout(dir: string) {
      const etc = path.join(dir, 'etc-walnut')
      const victim = path.join(dir, 'victim')
      fs.mkdirSync(etc, { mode: 0o700 })
      fs.mkdirSync(victim)
      fs.writeFileSync(path.join(victim, 'passwd'), 'root:x:0:0\n')
      fs.writeFileSync(path.join(victim, 'token-target'), 'v\n')
      fs.chmodSync(path.join(victim, 'passwd'), 0o644)
      fs.chmodSync(path.join(victim, 'token-target'), 0o644)
      return { etc, victim, vars: { ETC_WALNUT: etc, CLAIM_DIR: path.join(etc, 'claim') } }
    }

    it('replaces links a service user planted in the old layout, and never writes through them', () => {
      const { dir, bin } = scratch()
      const { etc, victim, vars } = layout(dir)
      fs.symlinkSync(path.join(victim, 'passwd'), path.join(etc, 'walnut.env'))
      fs.symlinkSync(path.join(victim, 'token-target'), path.join(etc, 'setup-token'))
      fs.symlinkSync(victim, path.join(etc, 'claim'))
      const res = runBlock(bin, vars, block('etc-walnut'))
      expect(res.status, res.stderr).toBe(0)
      expect(fs.readFileSync(path.join(victim, 'passwd'), 'utf-8')).toBe('root:x:0:0\n')
      expect(fs.readFileSync(path.join(victim, 'token-target'), 'utf-8')).toBe('v\n')
      expect(fs.statSync(path.join(victim, 'passwd')).mode & 0o777).toBe(0o644)
      expect(fs.readdirSync(victim).sort()).toEqual(['passwd', 'token-target'])
      // The names are root's plain files and dirs now.
      expect(fs.lstatSync(path.join(etc, 'walnut.env')).isFile()).toBe(true)
      expect(fs.statSync(path.join(etc, 'walnut.env')).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(path.join(etc, 'walnut.env'), 'utf-8')).toBe('')
      expect(lexists(path.join(etc, 'setup-token'))).toBe(false)
      expect(fs.lstatSync(path.join(etc, 'claim')).isDirectory()).toBe(true)
      expect(fs.statSync(path.join(etc, 'claim')).mode & 0o777).toBe(0o700)
      expect(fs.statSync(etc).mode & 0o777).toBe(0o750)
      expect(fs.readdirSync(etc).filter((n) => n.startsWith('.tmp'))).toEqual([])
    })

    it('hands the pairing code to claim/, drops root\'s copy, and keeps walnut.env content', () => {
      const { dir, bin } = scratch()
      const { etc, vars } = layout(dir)
      fs.writeFileSync(path.join(etc, 'setup-token'), 'a1b2c3d4e5f60718293a4b5c6d7e8f90', { mode: 0o600 })
      fs.writeFileSync(path.join(etc, 'walnut.env'), 'OPENAI_API_KEY=old\nKEEP=me\n', { mode: 0o644 })
      // An aws CLI that answers both SSM lookups.
      fs.writeFileSync(path.join(bin, 'aws'), '#!/bin/sh\ncase "$*" in *openai*) echo sk-new ;; *tavily*) echo tv-1 ;; esac\n', { mode: 0o755 })
      const res = runBlock(bin, vars, block('etc-walnut'))
      expect(res.status, res.stderr).toBe(0)
      expect(fs.readFileSync(path.join(etc, 'claim', 'setup-token'), 'utf-8')).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90')
      expect(fs.statSync(path.join(etc, 'claim', 'setup-token')).mode & 0o777).toBe(0o600)
      expect(lexists(path.join(etc, 'setup-token'))).toBe(false)
      const env = fs.readFileSync(path.join(etc, 'walnut.env'), 'utf-8').split('\n').filter(Boolean).sort()
      expect(env).toEqual(['KEEP=me', 'OPENAI_API_KEY=sk-new', 'TAVILY_API_KEY=tv-1'])
      expect(fs.statSync(path.join(etc, 'walnut.env')).mode & 0o777).toBe(0o600)
    })

    it('removes a hard link planted as walnut.env instead of reading through it', () => {
      const { dir, bin } = scratch()
      const { etc, victim, vars } = layout(dir)
      fs.linkSync(path.join(victim, 'passwd'), path.join(etc, 'walnut.env'))
      const res = runBlock(bin, vars, block('etc-walnut'))
      expect(res.status, res.stderr).toBe(0)
      expect(res.stdout).toContain('removing')
      expect(fs.readFileSync(path.join(etc, 'walnut.env'), 'utf-8')).toBe('')
      expect(fs.readFileSync(path.join(victim, 'passwd'), 'utf-8')).toBe('root:x:0:0\n')
    })

    it('gives the directory to root and only claim/ to the service user', () => {
      // The runs above have one user playing both, so a wrong owner stays green
      // there. Here they have different names, and chown only records its argv.
      const { dir, bin } = scratch()
      const { etc, vars } = layout(dir)
      const chownLog = path.join(dir, 'chown.log')
      fs.writeFileSync(path.join(bin, 'chown'), `#!/bin/sh\necho "$*" >> '${chownLog}'\n`, { mode: 0o755 })
      const res = runBlock(bin, { ...vars, ROOT_USER: 'root-stand-in', WALNUT_USER: 'walnut-stand-in' }, block('etc-walnut'))
      expect(res.status, res.stderr).toBe(0)
      expect(fs.readFileSync(chownLog, 'utf-8').split('\n').filter(Boolean)).toEqual([
        `-h root-stand-in:${GROUP} ${etc}`,
        `-h walnut-stand-in:${GROUP} ${path.join(etc, 'claim')}`,
      ])
      expect(setup).toMatch(/^ROOT_USER=root$/m)
    })

    it('points the unit at the claim dir and at the root-owned env file', () => {
      expect(setup).toContain('Environment=WALNUT_SETUP_TOKEN_FILE=$CLAIM_DIR/setup-token')
      expect(setup).toContain('EnvironmentFile=-$ENV_FILE')
      // No root write, chown or chmod through a name in /etc/walnut outside the block's helpers.
      expect(setup).not.toMatch(/(>>?|touch|chown|chmod)[^\n]*\/etc\/walnut\/(walnut\.env|setup-token)/)
    })
  })

  describe('hub post-receive hook', () => {
    it('is written by the service user through a rename, so a planted link is replaced, not followed', () => {
      const { dir, bin } = scratch()
      const hub = path.join(dir, 'hub.git')
      fs.mkdirSync(path.join(hub, 'hooks'), { recursive: true })
      const victim = path.join(dir, 'victim')
      fs.writeFileSync(victim, 'do not touch\n')
      fs.chmodSync(victim, 0o644)
      fs.symlinkSync(victim, path.join(hub, 'hooks', 'post-receive'))
      const res = runBlock(bin, {
        HUB_REPO: hub, WALNUT_LIB: dir, DATA_HOME: path.join(dir, 'data'), GIT_BIN: '/usr/bin/git', RUNUSER: '/usr/sbin/runuser',
      }, block('hub hook'))
      expect(res.status, res.stderr).toBe(0)
      expect(fs.readFileSync(victim, 'utf-8')).toBe('do not touch\n')
      expect(fs.statSync(victim).mode & 0o777).toBe(0o644)
      const hook = path.join(hub, 'hooks', 'post-receive')
      expect(fs.lstatSync(hook).isFile()).toBe(true)
      expect(fs.statSync(hook).mode & 0o777).toBe(0o755)
      expect(fs.readFileSync(hook, 'utf-8')).toContain(`/usr/bin/git -C "${path.join(dir, 'data')}" pull --ff-only origin main`)
      expect(setup).not.toMatch(/cat > "\$HUB_REPO\/hooks/)
      expect(setup).not.toMatch(/(chown|chmod)[^\n]*\$HUB_REPO\/hooks/)
    })

    it('replaces a planted link to a directory instead of dropping the hook into it', () => {
      const { dir, bin } = scratch()
      const hub = path.join(dir, 'hub.git')
      fs.mkdirSync(path.join(hub, 'hooks'), { recursive: true })
      const victimDir = path.join(dir, 'victim-dir')
      fs.mkdirSync(victimDir)
      fs.symlinkSync(victimDir, path.join(hub, 'hooks', 'post-receive'))
      const res = runBlock(bin, {
        HUB_REPO: hub, WALNUT_LIB: dir, DATA_HOME: path.join(dir, 'data'), GIT_BIN: '/usr/bin/git', RUNUSER: '/usr/sbin/runuser',
      }, block('hub hook'))
      expect(res.status, res.stderr).toBe(0)
      expect(fs.readdirSync(victimDir)).toEqual([])
      expect(fs.lstatSync(path.join(hub, 'hooks', 'post-receive')).isFile()).toBe(true)
    })
  })

  describe('as_walnut', () => {
    // setup.sh's own definitions, not the stand-in the blocks above use: from a
    // root shell it runs git as the service user inside repos that user owns.
    const defs = ((): string => {
      const start = setup.indexOf('setsid --wait true </dev/null')
      const last = setup.indexOf('\nas_walnut() {')
      expect(start).toBeGreaterThan(-1)
      expect(last).toBeGreaterThan(start)
      return setup.slice(start, setup.indexOf('\n', last + 1))
    })()

    it('runs each command as the service user in a session of its own; only as_walnut_in passes stdin', () => {
      const { dir, bin } = scratch()
      const log = path.join(dir, 'calls.log')
      fs.writeFileSync(path.join(bin, 'runuser'), ROOT_STUBS.runuser, { mode: 0o755 })
      // Records --wait too: without it setsid may return before the command ends.
      fs.writeFileSync(path.join(bin, 'setsid'), [
        '#!/bin/sh',
        'if [ "$1" = --wait ]; then shift; w=--wait; else w=no-wait; fi',
        '[ "$1" = true ] || echo "setsid $w $(basename "$1")" >> "$STUB_LOG"',
        'exec "$@"',
        '',
      ].join('\n'), { mode: 0o755 })
      const res = runBlock(bin, { RUNUSER: path.join(bin, 'runuser'), WALNUT_USER: 'walnut-stand-in', WALNUT_LIB: dir }, [
        `export STUB_LOG='${log}'`,
        defs,
        // The exit status survives the pipes that carry stdout and stderr.
        `rc=0; as_walnut_in sh -c 'cat; echo "home=$HOME"; echo to-stderr >&2; exit 7' <<< fed || rc=$?; echo "rc=$rc"`,
        `as_walnut sh -c 'cat; echo done' <<< not-for-it`,
      ].join('\n'))
      expect(res.status, res.stderr).toBe(0)
      expect(res.stdout.split('\n').filter(Boolean)).toEqual(['fed', `home=${dir}`, 'rc=7', 'done'])
      expect(res.stderr).toContain('to-stderr')
      const lines = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean)
      expect(lines.filter((l) => l.startsWith('setsid'))).toEqual(['setsid --wait runuser', 'setsid --wait runuser'])
      expect(lines.filter((l) => l.startsWith('runuser'))).toHaveLength(2)
      for (const l of lines.filter((c) => c.startsWith('runuser'))) {
        expect(l).toMatch(new RegExp(`^runuser -u walnut-stand-in -- env HOME=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sh -c `))
      }
    })
  })
})
