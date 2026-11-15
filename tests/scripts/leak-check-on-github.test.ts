/**
 * scripts/leak-scan/check-on-github.sh: before a push makes a commit GitHub's main, the Leak gate
 * on main checks it (a hidden refs/leak-check/<sha> ref, a dispatch of leak-gate.yml with
 * `commit`, the "Scan new commits" status it writes). GitHub's ruleset refuses main without that
 * status, so the hook must get it first, refuse a failed scan, and never leave the hidden ref.
 * `gh` is a stub that answers from files; the remote is a local bare repository.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.join(import.meta.dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'leak-scan', 'check-on-github.sh')
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'leak-gate.yml'), 'utf8')

// Answers what the script asks GitHub; logs every call to $GH_STUB/calls.
const GH_STUB = `#!/bin/bash
d=$GH_STUB
printf '%s\\n' "$*" >> "$d/calls"
case "$1 $2" in
  "auth status") exit 0 ;;
  "workflow run") [ -f "$d/dispatch-fails" ] && exit 1; exit 0 ;;
  "run list") echo ""; exit 0 ;;
esac
case "$2" in
  */rules/branches/main) cat "$d/required" ;;
  */contents/.github/workflows/leak-gate.yml*) base64 < "$d/workflow" ;;
  */status) # the next state of the sequence; the last one repeats
    n=$(cat "$d/n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$d/n"
    s=$(sed -n "\${n}p" "$d/states"); [ -n "$s" ] || s=$(tail -1 "$d/states"); echo "$s" ;;
  */check-runs*) echo none ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`

let root: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-'))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'bin', 'gh'), GH_STUB, { mode: 0o755 })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim()

interface Case { required: 'true' | 'false'; states: string[]; workflow?: string; dispatchFails?: boolean; ref?: string }
function run(name: string, c: Case) {
  const dir = path.join(root, name)
  const stub = path.join(dir, 'gh')
  const work = path.join(dir, 'work')
  const bare = path.join(dir, 'remote.git')
  fs.mkdirSync(stub, { recursive: true })
  fs.writeFileSync(path.join(stub, 'required'), c.required + '\n')
  fs.writeFileSync(path.join(stub, 'states'), c.states.join('\n') + '\n')
  fs.writeFileSync(path.join(stub, 'workflow'), c.workflow ?? WORKFLOW)
  fs.writeFileSync(path.join(stub, 'calls'), '')
  if (c.dispatchFails) fs.writeFileSync(path.join(stub, 'dispatch-fails'), '')
  git(root, 'init', '-q', '--bare', bare)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'one')
  const sha = git(work, 'rev-parse', 'HEAD')
  const r = spawnSync('bash', [SCRIPT, 'origin', bare], {
    cwd: work,
    encoding: 'utf8',
    input: `refs/heads/main ${sha} ${c.ref ?? 'refs/heads/main'} ${'0'.repeat(40)}\n`,
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, GH_STUB: stub, WALNUT_LEAK_CHECK_SLUG: 'owner/repo', WALNUT_LEAK_CHECK_POLL: '0', WALNUT_LEAK_CHECK_TIMEOUT: '2' },
  })
  const calls = fs.readFileSync(path.join(stub, 'calls'), 'utf8')
  const left = spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: bare, encoding: 'utf8' }).stdout.trim()
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls, left, sha }
}

describe('the Leak gate checks a commit on GitHub before it becomes main', () => {
  it("main's own Leak gate workflow takes the commit to check and writes the status the ruleset requires", () => {
    expect(WORKFLOW).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}commit:/)
    expect(WORKFLOW).toMatch(/statuses: write/)
    expect(WORKFLOW).toMatch(/-f context='Scan new commits'/)
    expect(WORKFLOW).toMatch(/github\.ref == 'refs\/heads\/main'/)
    // the hook runs it on every push, after the local scans
    const prePush = fs.readFileSync(path.join(REPO, '.husky', 'pre-push'), 'utf8')
    expect(prePush).toContain('bash scripts/leak-scan/check-on-github.sh "$@" || exit 1')
  })

  it('a pass lets the push go on, and the hidden ref is gone afterwards', () => {
    const r = run('pass', { required: 'true', states: ['none', 'pending', 'success'] })
    expect(r.status, r.out).toBe(0)
    expect(r.calls).toContain(`workflow run leak-gate.yml -R owner/repo --ref main -f commit=${r.sha}`)
    expect(r.out).toMatch(/passed "Scan new commits"/)
    expect(r.left).toBe('')
  })

  it('a failed scan refuses the push, also when main does not require the check yet', () => {
    for (const required of ['true', 'false'] as const) {
      const r = run(`fail-${required}`, { required, states: ['none', 'failure'] })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/Push blocked: the Leak gate on GitHub found something/)
      expect(r.left).toBe('')
    }
  })

  it('a commit that already passed is not checked again', () => {
    const r = run('already', { required: 'true', states: ['success'] })
    expect(r.status, r.out).toBe(0)
    expect(r.calls).not.toContain('workflow run')
  })

  it('trouble reaching the check refuses when main requires it, and only says so when it does not yet', () => {
    const req = run('trouble-req', { required: 'true', states: ['none'], dispatchFails: true })
    expect(req.status, req.out).toBe(1)
    expect(req.out).toMatch(/could not start the Leak gate/)
    expect(req.left).toBe('')
    const slow = run('slow-req', { required: 'true', states: ['none', 'pending'] })
    expect(slow.status, slow.out).toBe(1)
    expect(slow.out).toMatch(/no answer from the Leak gate/)
    const notYet = run('trouble-not-yet', { required: 'false', states: ['none'], dispatchFails: true })
    expect(notYet.status, notYet.out).toBe(0)
    expect(notYet.out).toMatch(/does not require the check yet/)
  })

  it("an older main whose Leak gate takes no commit: refused once required, else the push goes on", () => {
    const old = WORKFLOW.replace(/ {4}inputs:\n {6}commit:[\s\S]*?default: ''\n/, '')
    expect(old).not.toMatch(/^ {6}commit:/m)
    expect(run('old-req', { required: 'true', states: ['none'], workflow: old }).status).toBe(1)
    expect(run('old-not-yet', { required: 'false', states: ['none'], workflow: old }).status).toBe(0)
  })

  it('a push of another branch is not checked', () => {
    const r = run('branch', { required: 'true', states: ['none'], ref: 'refs/heads/topic' })
    expect(r.status, r.out).toBe(0)
    expect(r.calls).toBe('')
  })
})
