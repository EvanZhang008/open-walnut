/**
 * Under `set -e` with `pipefail`, a pipe into `head` fails the script at random.
 *
 * `head -1` exits after its first line. When the command feeding it still has more to write
 * than the pipe buffer holds, that command dies of SIGPIPE (exit 141), pipefail makes the whole
 * pipeline 141, and `set -e` ends the step. Whether it happens depends on output size and timing,
 * so the same step passes one run and fails the next (2026-11-16: the Leak gate's "Scan full
 * history" failed with 141 on three main pushes while "Scan new commits" passed in the same run,
 * both on `git rev-list ... | head -1`). `sed -n 1p` prints the same line and reads its input to
 * the end, so the writer never sees a closed pipe.
 *
 * Checked: every workflow `run:` step that turns on errexit and pipefail (`set -euo pipefail`,
 * or `shell: bash`, which GitHub runs as `bash -eo pipefail`), and every tracked shell script that
 * sets both. A pipeline whose failure is handled on the same line (`|| ...`) is fine.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HEAD_PIPE = /\|\s*head(\s|$)/
const STRICT_SET = /\bset\s+-[a-z]*e[a-z]*o\s+pipefail\b|\bset\s+-o\s+errexit\b[\s\S]*\bset\s+-o\s+pipefail\b/

function offenders(text: string, where: string): string[] {
  return text.split('\n').flatMap((line, i) =>
    HEAD_PIPE.test(line) && !/^\s*#/.test(line) && !/\|\|/.test(line) ? [`${where}:${i + 1}: ${line.trim()}`] : [])
}

type Step = { run?: string; shell?: string }
type Job = { steps?: Step[]; defaults?: { run?: { shell?: string } } }
type Workflow = { jobs?: Record<string, Job>; defaults?: { run?: { shell?: string } } }

function strictWorkflowSteps(): { where: string; run: string }[] {
  const dir = path.join(ROOT, '.github/workflows')
  const out: { where: string; run: string }[] = []
  for (const name of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Workflow
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      (job.steps ?? []).forEach((step, n) => {
        if (typeof step.run !== 'string') return
        const shell = step.shell ?? job.defaults?.run?.shell ?? wf.defaults?.run?.shell
        if (shell === 'bash' || STRICT_SET.test(step.run)) out.push({ where: `${name} ${id} step ${n + 1}`, run: step.run })
      })
    }
  }
  return out
}

function strictScripts(): string[] {
  const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  return files.filter((f) => fs.existsSync(path.join(ROOT, f)) && STRICT_SET.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
}

describe('no pipe into head under errexit and pipefail', () => {
  it('finds the strict steps and scripts it checks', () => {
    expect(strictWorkflowSteps().some((s) => s.where.startsWith('leak-gate.yml'))).toBe(true)
    expect(strictScripts()).toContain('scripts/dev-prod.sh')
  })

  it('the rule catches the pipe that failed the Leak gate, and passes its fix', () => {
    expect(offenders('first=$(git rev-list --reverse "$head" | head -1)', 'x')).toHaveLength(1)
    expect(offenders('first=$(git rev-list --reverse "$head" | sed -n 1p)', 'x')).toEqual([])
    expect(offenders('v=$(cmd | head -n 1 || true)', 'x')).toEqual([])
  })

  it('no workflow step pipes into head', () => {
    const found = strictWorkflowSteps().flatMap((s) => offenders(s.run, s.where))
    expect(found, 'use `sed -n 1p` (or `sed -n 1,Np`): it reads to the end, so the writer gets no SIGPIPE').toEqual([])
  })

  it('no strict shell script pipes into head', () => {
    const found = strictScripts().flatMap((f) => offenders(fs.readFileSync(path.join(ROOT, f), 'utf8'), f))
    expect(found, 'use `sed -n 1p` (or `sed -n 1,Np`): it reads to the end, so the writer gets no SIGPIPE').toEqual([])
  })
})
