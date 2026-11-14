/**
 * Ratchet: every way content leaves this repository for GitHub runs the leak scan
 * (scripts/leak-scan/scan-git.mjs). A new hook, a new `git push` in committed code, a new
 * `--no-verify`, or a CI leak gate that stops covering pushes or pull requests fails here, and
 * the failure says what to do: make the new path run the scan, then list it with its reason.
 * The behaviour of each path is tested in leak-gate.test.ts; this file pins that none is missed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

const REPO = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')

/** Each hook git runs before content can leave, and the scan it must run. */
const HOOKS: Record<string, RegExp> = {
  'pre-commit': /^bun scripts\/leak-scan\/scan-git\.mjs --staged \|\| exit 1$/m,
  'commit-msg': /^bun scripts\/leak-scan\/scan-git\.mjs --message-file "\$1" \|\| exit 1$/m,
  'pre-push': /^printf '%s\\n' "\$refs" \| bash scripts\/leak-scan\/scan-push\.sh "\$@" \|\| exit 1$/m,
}

/**
 * Every committed line that runs `git push`, by file and count, and why what it sends is
 * scanned. A new one fails until it runs the scan (or sends nothing public) and is listed.
 */
const PUSH_SITES: Record<string, { lines: number; why: string }> = {
  '.github/workflows/release.yml': { lines: 2, why: 'the release tag and version commit, made by CI from main; the Leak gate schedule scans them (GITHUB_TOKEN pushes start no workflow)' },
  '.github/workflows/star-history.yml': { lines: 1, why: 'a generated SVG of public star counts; the Leak gate schedule scans it' },
  'scripts/cloud/setup.sh': { lines: 1, why: "the user's own private data hub on their EC2 box, never GitHub" },
  'scripts/push-gate-sweep.sh': { lines: 1, why: 'deletes gate refs, publishes nothing' },
  'scripts/push-gate.sh': { lines: 6, why: 'a gate ref, pushed only after the pre-push leak scan (the push being gated) or the private scanner passed on it; the other lines are messages' },
  'scripts/release.mjs': { lines: 3, why: 'git push with its hooks (pre-push runs the leak scan); the other lines are messages' },
  'src/providers/git-commit-core.ts': { lines: 2, why: "the app's Push button: a plain git push, so the repository's own pre-push hook runs" },
}

/** Every committed `--no-verify`, by file and count. Each skips hooks, so each must be safe. */
const NO_VERIFY: Record<string, { lines: number; why: string }> = {
  'scripts/push-gate-sweep.sh': { lines: 1, why: 'deleting a gate ref publishes nothing' },
  'scripts/push-gate.sh': { lines: 4, why: 'gate refs, after the leak scan of the same commits already ran (pre-push, or the private scanner just above them)' },
}

const SCOPE = ['scripts', 'src', 'bin', 'desktop', 'desktop-windows', 'infra', '.github', '.husky', 'package.json', 'ios-native/scripts']
const PUSH_RE = [/\bgit\b(?:\s+(?:-[cC]\s+\S+|--?[a-z-]+(?:=\S+)?))*\s+push\b/, /\bgit\b[^\n]{0,40}?\[\s*['"]push['"]/, /\bargs\s*=\s*\[\s*['"]push['"]/]

function census() {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...SCOPE], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter((f) => f && !f.startsWith('.husky/_') && !f.startsWith('scripts/local/') && !f.endsWith('.md'))  // code, not its docs
  const push: Record<string, number> = {}
  const noVerify: Record<string, number> = {}
  for (const f of files) {
    const p = path.join(REPO, f)
    if (!fs.existsSync(p) || !fs.statSync(p).isFile() || fs.statSync(p).size > 2_000_000) continue
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      if (/^\s*(#|\/\/|\*)/.test(l)) continue
      if (PUSH_RE.some((r) => r.test(l))) push[f] = (push[f] ?? 0) + 1
      if (l.includes('--no-verify')) noVerify[f] = (noVerify[f] ?? 0) + 1
    }
  }
  return { push, noVerify }
}

describe('every path to GitHub runs the leak scan', () => {
  it('each hook git runs before content leaves runs it, and a new hook must be listed here', () => {
    const hooks = fs.readdirSync(path.join(REPO, '.husky')).filter((f) => !f.startsWith('_') && !f.startsWith('.'))
    expect(hooks.sort(), 'a new .husky hook: decide whether it runs before content leaves, make it scan, list it in HOOKS').toEqual(Object.keys(HOOKS).sort())
    for (const [h, re] of Object.entries(HOOKS)) expect(read(`.husky/${h}`), h).toMatch(re)
    // the push scan comes before every slower step, and nothing in the hooks offers a skip
    const prePush = read('.husky/pre-push')
    expect(prePush.indexOf('scan-push.sh')).toBeLessThan(prePush.indexOf('bun run --silent lint'))
    for (const h of Object.keys(HOOKS)) expect(read(`.husky/${h}`), h).not.toMatch(/--no-verify|bypass/i)
  })

  it('every `git push` in committed code is listed with why what it sends is scanned', () => {
    const { push } = census()
    const listed = Object.fromEntries(Object.entries(PUSH_SITES).map(([f, v]) => [f, v.lines]))
    expect(push, 'a new git push: make it go through the pre-push hook (no --no-verify) or scan-push.sh, then list it in PUSH_SITES').toEqual(listed)
  })

  it('every committed --no-verify is listed with why skipping the hooks there publishes nothing unscanned', () => {
    const { noVerify } = census()
    const listed = Object.fromEntries(Object.entries(NO_VERIFY).map(([f, v]) => [f, v.lines]))
    expect(noVerify, 'a new --no-verify skips the leak scan: remove it, or prove the content was scanned and list it in NO_VERIFY').toEqual(listed)
  })

  it('the scanner offers no skip: only its documented options exist', () => {
    const src = read('scripts/leak-scan/scan-git.mjs')
    const opts = [...src.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]).sort()
    expect(opts).toEqual(['--fingerprints', '--history', '--message-file', '--range', '--redact', '--repo', '--rules', '--rules-env', '--staged', '--strict', '--text'])
  })

  it('the private push scanner path in the pre-push hook still runs after the committed scan', () => {
    const prePush = read('.husky/pre-push')
    expect(prePush.indexOf('scan-push.sh')).toBeLessThan(prePush.indexOf('"$scanner" "$@"'))
  })
})

interface Step { uses?: string; run?: string; name?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { steps?: Step[]; strategy?: { matrix?: { part?: string[] } } }
interface Workflow { name?: string; on: Record<string, unknown>; jobs: Record<string, Job> }

describe('the Leak gate workflow scans every push and pull request, new commits and the full history', () => {
  const wf = parseYaml(read('.github/workflows/leak-gate.yml')) as Workflow
  const job = wf.jobs.scan
  const steps = job.steps ?? []
  const scan = steps.find((s) => s.name === 'Scan')!

  it('runs on every push (no branch filter), every pull request, a schedule and by hand', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch'])
    expect(wf.on.push).toBeNull()
    expect(wf.on.pull_request).toBeNull()
  })

  it('scans the new commits and the whole history, redacted, with the full clone', () => {
    expect(job.strategy?.matrix?.part).toEqual(['new commits', 'full history'])
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with?.['fetch-depth']).toBe(0)
    expect(scan.run).toMatch(/judge\/scripts\/leak-scan\/scan-git\.mjs" --repo \. --history "\$HEAD_SHA" --redact "\$\{rules\[@\]\}"/)
    expect(scan.run).toMatch(/judge\/scripts\/leak-scan\/scan-git\.mjs" --repo \. --range "\$BASE\.\.\$HEAD_SHA" --redact "\$\{rules\[@\]\}"/)
    // judged by the base commit's scanner, never the pushed one
    const judge = steps.find((s) => (s.name ?? '').startsWith('The scanner that judges'))!
    expect(judge.run).toMatch(/git archive "\$from" scripts\/leak-scan/)
    expect(judge.run).toMatch(/from=\$BASE/)
    expect(scan.run).not.toMatch(/\|\|\s*true|continue-on-error/)
  })

  it('upstream, the private rules are required and make the scan strict; gitleaks is pinned by checksum', () => {
    // the secret only for runs of main: another branch's workflow file is its pusher's to edit
    expect(scan.env?.LEAK_SCAN_RULES).toBe("${{ (github.ref == 'refs/heads/main' && github.event_name != 'pull_request') && secrets.LEAK_SCAN_RULES || '' }}")
    expect(scan.run).toMatch(/export WALNUT_LEAK_STRICT=1/)
    expect(scan.run).toMatch(/UPSTREAM" = true \]; then echo "::error::The LEAK_SCAN_RULES secret is not set/)
    const gl = steps.find((s) => (s.name ?? '').startsWith('Install gitleaks'))!
    expect(gl.run).toMatch(/sha256sum -c -/)
    // only the scan step sees the secret
    for (const s of steps) expect(JSON.stringify(s.env ?? {}).includes('secrets.'), s.name).toBe(s === scan)
  })
})
