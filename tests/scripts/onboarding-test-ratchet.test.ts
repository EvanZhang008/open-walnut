/**
 * Ratchet for the fresh-machine onboarding harness (scripts/onboarding-test/).
 *
 * That harness provisions a real machine (a local macOS VM, or an EC2 instance,
 * or a whole mac2.metal host that bills a 24h minimum) and then throws it away.
 * Two classes of mistake in it are expensive rather than merely wrong:
 *
 *   1. A teardown that is not scoped. `terminate-instances` or `release-hosts`
 *      reached from a list this harness did not filter by its own tag would kill
 *      someone else's machine. Every call must name explicit ids, and the ids
 *      must come from a tag-filtered query or from the instance this run created.
 *   2. A probe that kills more than it started. probe.sh runs as the login user
 *      on the test machine and its `--stop` path may only signal PIDs it wrote
 *      down itself, with a `pid > 1` floor so a truncated pids file can never
 *      turn into a broadcast signal.
 *
 * Plus the README's routes as the probe walks them: the one-line installer
 * first, then the checkout on Bun with no Node anywhere, and Node (through nvm)
 * only on the npm route, which is the one route that needs it. The operator's
 * side runs on bun too.
 *
 * Plus the cheap-but-easy-to-lose properties: probe.sh has to stay bash 3.2
 * compatible (a stock macOS install ships bash 3.2 and nothing else, which is the
 * whole point of the mac-vm target), no cloud identifier may be baked into the
 * source (AMIs come from the public SSM parameters, account ids never appear at
 * all), and the operator help has to keep naming the targets and flags.
 *
 * This test performs NO cloud, VM or network action. It reads source text, runs
 * `bash -n` (parse only, no execution), and runs the help path, which prints the
 * comment header and exits before any provisioning library is even sourced.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.join(import.meta.dirname, '..', '..')
const HARNESS = path.join(REPO, 'scripts', 'onboarding-test')

/** Every file of the harness, repo-root-relative, sorted. */
function harnessFiles(exts: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (exts.includes(path.extname(entry.name))) found.push(path.relative(REPO, full))
    }
  }
  walk(HARNESS)
  return found
}

const SHELL_FILES = harnessFiles(['.sh'])
const SOURCE_FILES = harnessFiles(['.sh', '.mjs', '.js', '.ts', '.md'])
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf-8')

// ── helpers, exported so the synthetic controls below can exercise them ────────

export interface ShellFunction { name: string; startLine: number; endLine: number; body: string }

/**
 * Split a shell file into top-level function bodies by counting braces.
 *
 * Brace counting is enough here (verified against all five files: every function
 * closes at depth 0 on its own last line) because the quoted material in this
 * harness — JSON policy documents, SSM parameter blobs, an embedded awk program,
 * a heredoc of JavaScript — happens to be brace-balanced. If that ever stops
 * being true the boundary assertions in this file fail loudly rather than
 * silently mis-attributing a line to the wrong function.
 */
export function splitShellFunctions(src: string): ShellFunction[] {
  const lines = src.split('\n')
  const out: ShellFunction[] = []
  let i = 0
  while (i < lines.length) {
    const header = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/.exec(lines[i])
    if (!header) { i += 1; continue }
    let depth = 0
    let j = i
    do {
      for (const ch of lines[j]) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      j += 1
    } while (depth > 0 && j < lines.length)
    out.push({ name: header[1], startLine: i + 1, endLine: j, body: lines.slice(i, j).join('\n') })
    i = j
  }
  return out
}

/** bash 4+ constructs that a stock macOS /bin/bash (3.2) cannot parse. */
const BASH4_ISMS: Array<{ label: string; re: RegExp }> = [
  { label: 'declare -A (associative arrays)', re: /\bdeclare\s+-A\b/ },
  { label: '${var,,} / ${var^^} (case conversion)', re: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,|\^\^)/ },
  { label: 'mapfile / readarray', re: /\b(mapfile|readarray)\b/ },
  { label: '&>> (append stdout+stderr)', re: /&>>/ },
  { label: '|& (pipe stdout+stderr)', re: /\|&/ },
]

export function findBash4Isms(src: string): Array<{ line: number; label: string; text: string }> {
  return src.split('\n').flatMap((line, i) => {
    if (line.trim().startsWith('#')) return []
    return BASH4_ISMS.filter((p) => p.re.test(line)).map((p) => ({ line: i + 1, label: p.label, text: line.trim() }))
  })
}

/** Destructive AWS verbs that must never be reached from an unscoped list. */
const TEARDOWN_VERBS = ['terminate-instances', 'release-hosts']

/**
 * Evidence that a teardown is aimed at something this harness owns.
 *
 * `ONB_TAG_KEY` / `AWS_HOST_NAME_TAG` mean the ids were discovered by a query
 * filtered to this harness's own tag. `INSTANCE_ID` is the instance this run
 * just launched. `--instance-ids "$1"` is the trap teardown: aws_launch pins the
 * id it created onto the cleanup stack, so the id can only be its own.
 */
const SCOPE_MARKERS = ['ONB_TAG_KEY', 'AWS_HOST_NAME_TAG', 'INSTANCE_ID', '--instance-ids "$1"']

export function unscopedTeardowns(src: string): Array<{ where: string; verb: string }> {
  const fns = splitShellFunctions(src)
  const problems: Array<{ where: string; verb: string }> = []
  for (const verb of TEARDOWN_VERBS) {
    src.split('\n').forEach((line, i) => {
      if (!line.includes(verb) || line.trim().startsWith('#')) return
      const owner = fns.find((f) => i + 1 >= f.startLine && i + 1 <= f.endLine)
      // A destructive verb outside any function is top-level code: nothing bounds it.
      if (!owner) { problems.push({ where: `top level (line ${i + 1})`, verb }); return }
      if (!SCOPE_MARKERS.some((m) => owner.body.includes(m))) problems.push({ where: owner.name, verb })
    })
  }
  return problems
}

/**
 * Lines where `kill` is aimed at a process GROUP rather than a process.
 *
 * bash spells a group signal as a pid argument that starts with `-`
 * (`kill -TERM -$pgid`, `kill -- -1234`), which is one character away from the
 * targeted form and reads almost identically. Tokenising is the only honest way
 * to tell them apart: a leading `-0` / `-TERM` is the SIGNAL and is fine, any
 * later argument starting with `-` is a negative pgid and is not.
 */
export function groupKillLines(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  src.split('\n').forEach((raw, i) => {
    if (raw.trim().startsWith('#')) return
    for (const m of raw.matchAll(/\bkill\s+(.*)$/g)) {
      const tokens = m[1].trim().split(/\s+/)
      if (/^(--?\w+|--)$/.test(tokens[0])) tokens.shift()   // the signal, if given
      if (tokens.some((t) => t.startsWith('-'))) out.push({ line: i + 1, text: raw.trim() })
    }
  })
  return out
}

/**
 * Code lines (comments skipped) that name node, nvm or npx on their own:
 * node_modules and node-gyp are other words.
 */
export function nodeLines(src: string): string[] {
  return src.split('\n').filter((l) => !l.trim().startsWith('#') && /(?<![\w-])(node|nvm|npx)(?![\w-])/.test(l)).map((l) => l.trim())
}

/** A 12-digit run of decimals is an AWS account id; ami-xxxxxxxx is a pinned image. */
export function findBakedCloudIds(src: string): Array<{ line: number; hit: string }> {
  const out: Array<{ line: number; hit: string }> = []
  src.split('\n').forEach((line, i) => {
    for (const re of [/\b\d{12}\b/g, /ami-[0-9a-f]{8,}/g]) {
      for (const m of line.matchAll(re)) out.push({ line: i + 1, hit: m[0] })
    }
  })
  return out
}

// ── the harness itself ────────────────────────────────────────────────────────

describe('onboarding harness · shell syntax', () => {
  it('has the shell files the operator entry points expect', () => {
    // remote-host/ is the second-machine test; its own ratchet is
    // tests/scripts/remote-host-onboarding-ratchet.test.ts.
    expect(SHELL_FILES).toEqual([
      'scripts/onboarding-test/lib/aws.sh',
      'scripts/onboarding-test/lib/common.sh',
      'scripts/onboarding-test/lib/tart.sh',
      'scripts/onboarding-test/probe.sh',
      'scripts/onboarding-test/remote-host/entrypoint.sh',
      'scripts/onboarding-test/remote-host/run.sh',
      'scripts/onboarding-test/render-video.sh',
      'scripts/onboarding-test/run.sh',
    ])
  })

  it.each(SHELL_FILES)('%s parses (bash -n, no execution)', (file) => {
    // -n reads and parses; it never runs a command, so this cannot touch a cloud.
    expect(() => execFileSync('bash', ['-n', path.join(REPO, file)], { stdio: 'pipe', timeout: 20_000 })).not.toThrow()
  })
})

describe('onboarding harness · probe.sh stays bash 3.2 safe', () => {
  // A stock macOS install ships bash 3.2 and no package manager to replace it.
  // The mac-vm target exists precisely to run on that machine, so any bash 4
  // construct here fails on the one target the harness was written for.
  it('uses no bash 4+ construct', () => {
    const found = findBash4Isms(read('scripts/onboarding-test/probe.sh'))
    const report = found.map((f) => `probe.sh:${f.line}  ${f.label}  →  ${f.text}`).join('\n')
    expect(found, `bash 4+ construct in probe.sh (macOS ships bash 3.2):\n${report}`).toEqual([])
  })

  it('says so in its own header, so the next editor knows', () => {
    expect(read('scripts/onboarding-test/probe.sh')).toMatch(/bash 3\.2/)
  })
})

describe('onboarding harness · the probe stops only what it started', () => {
  const probe = read('scripts/onboarding-test/probe.sh')
  /** The `--stop` branch: from the STOP test to the exit that closes it. */
  const stopBlock = (() => {
    const start = probe.indexOf('if [ "$STOP" = 1 ]; then')
    expect(start).toBeGreaterThan(-1)
    const end = probe.indexOf('\nfi\n', start)
    expect(end).toBeGreaterThan(start)
    return probe.slice(start, end)
  })()

  it('keeps the pid > 1 floor', () => {
    // Without it, a pids file that ends up holding 0, 1 or -1 turns a targeted
    // stop into "signal the whole process group / every process I own".
    expect(stopBlock).toContain('[ "$pid" -gt 1 ] || continue')
  })

  it('rejects any non-numeric pid before signalling', () => {
    expect(stopBlock).toContain("case \"$pid\" in ''|*[!0-9]*) continue ;; esac")
  })

  it('signals only pids read from its own pids file', () => {
    expect(stopBlock).toMatch(/done < "\$PIDS"/)
    expect(probe).toMatch(/PIDS="\$OUT\/pids"/)
  })

  it('uses only kill -0 and kill -TERM', () => {
    const signals = [...stopBlock.matchAll(/\bkill\s+(-\S+)/g)].map((m) => m[1])
    expect(new Set(signals)).toEqual(new Set(['-0', '-TERM']))
  })

  it.each(SHELL_FILES)('%s contains no broadcast or force kill', (file) => {
    const code = read(file).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    for (const banned of ['kill -9', 'kill -KILL', 'kill -- -', 'pkill', 'killall']) {
      expect(code, `${file} must not use ${banned}`).not.toContain(banned)
    }
    const groups = groupKillLines(code)
    expect(groups, `${file} signals a process group:\n${groups.map((g) => g.text).join('\n')}`).toEqual([])
  })
})

describe('onboarding harness · every AWS teardown is scoped', () => {
  const aws = read('scripts/onboarding-test/lib/aws.sh')

  it('splits into the functions it is meant to have', () => {
    const names = splitShellFunctions(aws).map((f) => f.name)
    expect(names).toContain('aws_terminate')
    expect(names).toContain('aws_sweep')
    expect(names).toContain('aws_release_hosts')
    // Boundary check: if brace counting ever mis-splits, the last function would
    // swallow the rest of the file and this length check would move.
    expect(names.length).toBeGreaterThanOrEqual(15)
  })

  it('never reaches terminate-instances or release-hosts from an unscoped list', () => {
    const problems = unscopedTeardowns(aws)
    const report = problems.map((p) => `${p.verb} in ${p.where}`).join('\n')
    expect(
      problems,
      `destructive AWS call with nothing tying it to this harness:\n${report}\n\n` +
      `Fix: filter the id list by ${SCOPE_MARKERS[0]} (or the Mac host Name tag), or accept the id from the caller.`,
    ).toEqual([])
  })

  it('names explicit ids on every destructive call (never a bare --filters)', () => {
    for (const line of aws.split('\n')) {
      if (line.trim().startsWith('#')) continue
      if (!TEARDOWN_VERBS.some((v) => line.includes(v))) continue
      expect(line, `unbounded teardown: ${line.trim()}`).toMatch(/--(instance|host)-ids\s+\S/)
      expect(line).not.toMatch(/--filters/)
    }
  })

  it('discovers ids only through a query filtered to this harness', () => {
    for (const fn of splitShellFunctions(aws)) {
      if (!TEARDOWN_VERBS.some((v) => fn.body.includes(v))) continue
      if (!fn.body.includes('describe-')) continue // aws_terminate takes the id from its caller
      const filters = [...fn.body.matchAll(/--filters ([^\n]*)/g)].map((m) => m[1])
      expect(filters.length, `${fn.name} lists resources without a filter`).toBeGreaterThan(0)
      for (const f of filters) {
        expect(f, `${fn.name} filter is not scoped to this harness: ${f}`).toMatch(/\$ONB_TAG_KEY|\$AWS_HOST_NAME_TAG/)
      }
    }
  })

  it('tags every instance and volume it creates, with a TTL the sweep can read', () => {
    expect(aws).toMatch(/ResourceType=instance,Tags=\[[^\]]*Key=\$ONB_TAG_KEY,Value=\$run_id/)
    expect(aws).toMatch(/ResourceType=instance,Tags=\[[^\]]*Key=\$ONB_TTL_TAG_KEY,Value=\$ttl/)
    expect(aws).toMatch(/ResourceType=volume,Tags=\[[^\]]*Key=\$ONB_TAG_KEY/)
    expect(aws).toMatch(/ResourceType=dedicated-host,Tags=\[[^\]]*Key=\$ONB_TAG_KEY/)
  })

  it('opens no ingress and installs no SSH key (SSM is the only way in)', () => {
    const launch = splitShellFunctions(aws).find((f) => f.name === 'aws_launch')!
    for (const banned of ['--key-name', '--security-group', '--associate-public-ip-address']) {
      expect(launch.body, `aws_launch must not pass ${banned}`).not.toContain(banned)
    }
    expect(launch.body).toContain('--metadata-options HttpTokens=required')
  })

  it('keeps the IAM footprint at one managed policy', () => {
    const attached = [...aws.matchAll(/--policy-arn (\S+)/g)].map((m) => m[1])
    expect(attached).toEqual(['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'])
    expect(aws).not.toContain('put-role-policy')      // no inline policy
    expect(aws).not.toContain('AdministratorAccess')
    expect(aws).toMatch(/AWS_ROLE_NAME="walnut-onboarding-test-ssm"/)
  })
})

describe('onboarding harness · teardown is registered before it is needed', () => {
  it('common.sh owns the cleanup stack and arms it on EXIT', () => {
    const common = read('scripts/onboarding-test/lib/common.sh')
    expect(common).toContain('trap run_cleanup_stack EXIT')
    expect(common).toMatch(/on_exit_push\(\)/)
    expect(common).toMatch(/run_cleanup_stack\(\)/)
    // Reverse order: the last thing created is the first thing torn down.
    expect(common).toMatch(/ONB_CLEANUP_STACK="\$1"\$'\\n'"\$ONB_CLEANUP_STACK"/)
    // A failing step must not abandon the rest of the stack.
    expect(common).toMatch(/eval "\$line" \|\| warn/)
  })

  it('run.sh sources common.sh, so the trap is armed before any provisioning', () => {
    const run = read('scripts/onboarding-test/run.sh')
    const sourceAt = run.indexOf('. "$HERE/lib/common.sh"')
    expect(sourceAt).toBeGreaterThan(-1)
    for (const lib of ['lib/tart.sh', 'lib/aws.sh']) {
      expect(run.indexOf(`"$HERE/${lib}"`), `${lib} must be sourced after common.sh`).toBeGreaterThan(sourceAt)
    }
  })

  it('registers teardown in the same function that creates the resource', () => {
    const pairs: Array<[string, string, string]> = [
      ['scripts/onboarding-test/lib/aws.sh', 'aws_launch', 'run-instances'],
      ['scripts/onboarding-test/lib/aws.sh', 'aws_port_forward', 'start-session'],
      ['scripts/onboarding-test/lib/tart.sh', 'tart_up', 'tart clone'],
      ['scripts/onboarding-test/lib/tart.sh', 'tart_forward', '-L'],
    ]
    for (const [file, fnName, creates] of pairs) {
      const fn = splitShellFunctions(read(file)).find((f) => f.name === fnName)
      expect(fn, `${file} lost ${fnName}`).toBeDefined()
      expect(fn!.body, `${fnName} should still be the thing that creates ${creates}`).toContain(creates)
      expect(fn!.body, `${fnName} creates a resource without registering its teardown`).toContain('on_exit_push')
    }
  })

  it('honours --keep in every teardown, so a kept machine survives the trap', () => {
    const aws = read('scripts/onboarding-test/lib/aws.sh')
    const tart = read('scripts/onboarding-test/lib/tart.sh')
    expect(splitShellFunctions(aws).find((f) => f.name === 'aws_terminate')!.body).toContain('${KEEP:-0}')
    expect(tart).toMatch(/KEEP:-0.*tart delete/)
    expect(tart).toMatch(/KEEP:-0.*tart stop/)
  })
})

describe('onboarding harness · no cloud identifier is baked in', () => {
  it.each(SOURCE_FILES)('%s carries no account id and no pinned AMI', (file) => {
    const found = findBakedCloudIds(read(file))
    const report = found.map((f) => `${file}:${f.line}  ${f.hit}`).join('\n')
    expect(
      found,
      `hardcoded cloud identifier (12-digit account id or AMI id):\n${report}\n\n` +
      'AMIs must be resolved at run time from the public SSM parameters, and no account id belongs in a public repo.',
    ).toEqual([])
  })

  it('resolves every image through the public SSM parameter path', () => {
    const ami = splitShellFunctions(read('scripts/onboarding-test/lib/aws.sh')).find((f) => f.name === 'aws_ami')!
    expect(ami.body).toContain('ssm get-parameter')
    // Each supported --os maps to a /aws/service/... public parameter, nothing else.
    const params = [...ami.body.matchAll(/p=(\S+)/g)].map((m) => m[1])
    expect(params.length).toBeGreaterThanOrEqual(5)
    for (const p of params) expect(p, `${p} is not a public SSM parameter path`).toMatch(/^\/aws\/service\//)
  })

  it('prints no caller identity (the ARN carries the account id into recordings)', () => {
    const aws = read('scripts/onboarding-test/lib/aws.sh')
    // get-caller-identity is checked, and its output goes to /dev/null.
    expect(aws).toMatch(/sts get-caller-identity[^\n]*>\/dev\/null/)
  })
})

describe('onboarding harness · the probe walks the README routes, bun only until npm', () => {
  const probe = read('scripts/onboarding-test/probe.sh')
  const npmAt = probe.indexOf('# ── npm path')
  const beforeNpm = probe.slice(0, npmAt)
  const npmRoute = probe.slice(npmAt)

  it('walks all three routes by default, the installer first and npm last', () => {
    expect(probe).toMatch(/^PATHS="installer,readme,npm"$/m)
    const order = ['step_begin "system"', 'step_begin "installer:install"', 'step_begin "prereq:git"', 'step_begin "prereq:bun"', 'step_begin "readme:git-clone"', 'step_begin "prereq:npm"', 'step_begin "npm:install-global"']
    const at = order.map((needle) => probe.indexOf(needle))
    expect(at.every((i) => i > 0), `missing step: ${order.filter((_, i) => at[i] < 0).join(', ')}`).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(npmAt).toBeGreaterThan(probe.indexOf('step_begin "readme:git-clone"'))
  })

  it('the installer route is the README one-liner, then walnut web', () => {
    const url = /^INSTALLER_URL="([^"]+)"$/m.exec(probe)?.[1]
    expect(url).toBe('https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh')
    expect(read('README.md')).toContain(`curl -fsSL ${url} | sh`)
    expect(probe).toContain(`run_logged bash -c 'set -o pipefail; curl -fsSL "$1" | sh' bash "$INSTALLER_URL"`)
    expect(probe).toContain('"$WALNUT_CMD" web --port "$INSTALLER_PORT"')
  })

  it('the checkout route installs Bun the README way, then bun install and bun run start', () => {
    expect(beforeNpm).toContain("run_logged bash -c 'curl -fsSL https://bun.sh/install | bash'")
    expect(beforeNpm).toContain('(cd "$README_DIR" && run_logged bun install)')
    expect(beforeNpm).toContain(`sh -c 'cd "$1" && exec bun run start' sh "$README_DIR"`)
  })

  it('needs no Node before the npm route: only the inventory of what the machine has names it', () => {
    expect(nodeLines(beforeNpm)).toEqual(['for t in git curl bun node npm brew claude walnut open-walnut; do'])
    for (const gone of ['unofficial-builds', 'check-native-toolchain', 'glibc-217', 'nvm install 22', 'prereq:node22']) {
      expect(probe, `the probe still carries ${gone}`).not.toContain(gone)
    }
  })

  it('reads the health answer with sed, since a machine on the installer route has no JavaScript runtime', () => {
    const health = splitShellFunctions(probe).find((f) => f.name === 'health_note')!
    expect(health.body).toContain('json_field "$h" hasReadyProvider')
    expect(health.body).not.toMatch(/\b(node|bun)\b/)
  })

  it('the npm route brings its own Node, with nvm, only when there is no working npm', () => {
    expect(npmRoute).toContain('if have npm && [ "$(node_major)" -ge 18 ] 2>/dev/null; then')
    expect(npmRoute).toContain('nvm install --lts')
    expect(npmRoute).toContain('run_logged npm install -g "$PKG"')
    // npm's own bin, not whatever the installer route linked into ~/.local/bin.
    expect(npmRoute).toContain('NPM_WALNUT="$(npm prefix -g 2>/dev/null)/bin/open-walnut"')
  })
})

describe('onboarding harness · the operator side runs on bun', () => {
  const common = read('scripts/onboarding-test/lib/common.sh')
  const aws = read('scripts/onboarding-test/lib/aws.sh')
  const run = read('scripts/onboarding-test/run.sh')

  it('finds bun in the places dev-prod.sh looks, and names bun when there is none', () => {
    const need = splitShellFunctions(common).find((f) => f.name === 'need_bun')!
    for (const where of ['${WALNUT_BUN:-}', 'command -v bun', '$HOME/.bun/bin/bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
      expect(need.body).toContain(where)
    }
    expect(need.body).toMatch(/die "missing tool: bun/)
  })

  it('renders the summary with `bun run -` (a bare `bun -` is `bun add`)', () => {
    const summary = splitShellFunctions(common).find((f) => f.name === 'summarize_steps')!
    expect(summary.body).toContain('"$ONB_BUN" run - "$steps" <<\'JS\'')
    expect(summary.body).not.toMatch(/\bbun -\s/)
  })

  it('quotes SSM commands as JSON with bun, and checks for bun with the other AWS tools', () => {
    expect(aws).toContain(`"$ONB_BUN" -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]]}))' "$cmd"`)
    expect(splitShellFunctions(aws).find((f) => f.name === 'aws_require')!.body).toContain('need_bun')
  })

  it('checks for bun before it provisions anything, and captures every route with it', () => {
    expect(run.indexOf('need_bun')).toBeGreaterThan(-1)
    expect(run.indexOf('need_bun')).toBeLessThan(run.indexOf('# ── provision'))
    for (const name of ['installer', 'readme', 'npm']) {
      expect(run).toMatch(new RegExp(`"\\$ONB_BUN" "\\$HERE/capture\\.mjs" [^\\n]*--name ${name} `))
    }
    expect(read('scripts/onboarding-test/capture.mjs').split('\n')[0]).toBe('#!/usr/bin/env bun')
  })

  it.each(['scripts/onboarding-test/run.sh', 'scripts/onboarding-test/lib/common.sh', 'scripts/onboarding-test/lib/aws.sh', 'scripts/onboarding-test/lib/tart.sh', 'scripts/onboarding-test/render-video.sh'])(
    '%s runs nothing on node', (file) => {
      expect(nodeLines(read(file))).toEqual([])
    },
  )
})

describe('onboarding harness · operator help', () => {
  /**
   * Safe to execute: the help path prints the comment header and exits before
   * lib/aws.sh or lib/tart.sh is sourced, so nothing is provisioned and no AWS
   * or Tart command runs.
   *
   * Both spellings are pinned. A bare `run.sh --help` used to be parsed as the
   * TARGET and exit 1, which is the version of help a person reaches for first.
   */
  const runHelp = (args: string[]) => {
    try {
      const stdout = execFileSync('bash', [path.join(HARNESS, 'run.sh'), ...args], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
      })
      return { status: 0, out: stdout }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }
  const helpRun = runHelp(['mac-vm', '--help'])
  const help = helpRun.out

  it('exits 0 and prints the header', () => {
    expect(helpRun.status, `run.sh mac-vm --help printed:\n${help}`).toBe(0)
    expect(help).toContain('Fresh-machine onboarding test for Open Walnut')
  })

  it.each([['--help'], ['-h'], []])('answers %s with the same header, not a usage error', (...args) => {
    const bare = runHelp(args)
    expect(bare.status, `run.sh ${args.join(' ')} printed:\n${bare.out}`).toBe(0)
    expect(bare.out).toContain('Fresh-machine onboarding test for Open Walnut')
  })

  it.each(['mac-vm', 'linux', 'mac-ec2', 'sweep', '--record', '--keep'])('mentions %s', (needle) => {
    expect(help).toContain(needle)
  })

  it('explains what each target costs the operator', () => {
    expect(help).toMatch(/Free/i)               // mac-vm
    expect(help).toMatch(/24h min/i)            // mac-ec2 dedicated host
    expect(help).toMatch(/SSM/)                 // linux reachability
  })

  it('parses every flag its own help advertises', () => {
    const run = read('scripts/onboarding-test/run.sh')
    const parser = run.slice(run.indexOf('while [ $# -gt 0 ]; do'), run.indexOf('export KEEP'))
    for (const flag of new Set([...help.matchAll(/(?<![\w-])(--[a-z][a-z-]+)/g)].map((m) => m[1]))) {
      expect(parser, `help advertises ${flag} but run.sh does not parse it`).toContain(`${flag})`)
    }
  })

  it('points an unknown target at --help instead of guessing', () => {
    const unknown = runHelp(['not-a-target'])
    expect(unknown.status, 'an unknown target must fail, not provision something').toBe(1)
    for (const needle of ['mac-vm', 'linux', 'mac-ec2', 'status', 'sweep', 'release-host', '--help']) {
      expect(unknown.out).toContain(needle)
    }
  })
})

// ── synthetic controls: a ratchet that cannot fail reads as coverage ──────────

describe('onboarding harness ratchet · the detectors actually catch things', () => {
  it('catches each bash 4-ism, and clears the 3.2 spelling of the same idea', () => {
    const bad = [
      'declare -A seen',
      'lower="${OS,,}"',
      'mapfile -t rows < list',
      'cmd &>> out.log',
      'cmd |& tee out.log',
      '# a comment about declare -A is fine',
    ].join('\n')
    expect(findBash4Isms(bad).map((f) => f.line)).toEqual([1, 2, 3, 4, 5])

    const fine = [
      'lower=$(printf %s "$OS" | tr "[:upper:]" "[:lower:]")',
      'while IFS= read -r row; do rows="$rows $row"; done < list',
      'cmd >> out.log 2>&1',
      'if [ "$IS_MAC" = 1 ]; then :; fi',
    ].join('\n')
    expect(findBash4Isms(fine)).toEqual([])
  })

  it('flags an unscoped terminate and clears a tag-scoped one', () => {
    const unscoped = [
      'reap_everything() {',
      '  ids=$(awsq ec2 describe-instances --query "Reservations[].Instances[].InstanceId")',
      '  awsq ec2 terminate-instances --instance-ids $ids',
      '}',
    ].join('\n')
    expect(unscopedTeardowns(unscoped)).toEqual([{ where: 'reap_everything', verb: 'terminate-instances' }])

    const scoped = unscoped.replace('--query', '--filters "Name=tag-key,Values=$ONB_TAG_KEY" --query')
    expect(unscopedTeardowns(scoped)).toEqual([])

    const topLevel = 'awsq ec2 release-hosts --host-ids $everything'
    expect(unscopedTeardowns(topLevel)).toEqual([{ where: 'top level (line 1)', verb: 'release-hosts' }])
  })

  it('tells a signal apart from a negative pgid', () => {
    expect(groupKillLines('kill -0 "$pid"\nkill -TERM "$pid"\nkill $FWD_PID 2>/dev/null || true')).toEqual([])
    const bad = ['kill -TERM -$pgid', 'kill -- -1234', 'kill -9 -"$PGID"'].join('\n')
    expect(groupKillLines(bad).map((g) => g.line)).toEqual([1, 2, 3])
  })

  it('finds node, nvm and npx used as words, and skips comments, node_modules and node-gyp', () => {
    const src = ['node -e "1"', '# node is not here', 'du -sh "$DIR/node_modules"', "grep -q 'node-gyp' log", '. "$NVM_DIR/nvm.sh" && nvm use', 'npx tsx x.ts', 'bun run start'].join('\n')
    expect(nodeLines(src)).toEqual(['node -e "1"', '. "$NVM_DIR/nvm.sh" && nvm use', 'npx tsx x.ts'])
  })

  it('flags a baked account id or AMI, and clears an SSM parameter path', () => {
    expect(findBakedCloudIds('arn:aws:iam::123456789012:role/x').map((f) => f.hit)).toEqual(['123456789012'])
    expect(findBakedCloudIds('--image-id ami-0abcdef1234567').map((f) => f.hit)).toEqual(['ami-0abcdef1234567'])
    expect(findBakedCloudIds('p=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64')).toEqual([])
    expect(findBakedCloudIds('--ttl-hours 3 --cols 120 --rows 36')).toEqual([])
  })

  it('splits functions at the right boundaries even with braces inside strings', () => {
    const src = [
      'outer() {',
      '  local trust=\'{"Version":"2012-10-17","Statement":[{"Effect":"Allow"}]}\'',
      '  awsq iam create-role --assume-role-policy-document "$trust"',
      '}',
      'after() { echo "${HOME:-/tmp}"; }',
    ].join('\n')
    const fns = splitShellFunctions(src)
    expect(fns.map((f) => [f.name, f.startLine, f.endLine])).toEqual([['outer', 1, 4], ['after', 5, 5]])
  })
})
