/**
 * Ratchet: every source file that puts `--model` into a claude argv is listed here with how a
 * spawn that names no model is kept on Claude (src/core/sessions/unnamed-model-guard.ts).
 *
 * Why: with no `--model` the CLI takes its own settings default, and on 2026-11-07 the Mac's
 * was gpt-6.1-sol, so task sessions nobody pointed at Sol ran on it. A new spawn path that may
 * leave `--model` out must say how it avoids that, or this test fails.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SRC = path.join(ROOT, 'src')

type Member =
  | { kind: 'guarded'; marker: string }
  | { kind: 'always-named'; why: string }
  | { kind: 'not-a-spawn'; why: string }
  | { kind: 'exempt'; why: string }

const MEMBERS: Record<string, Member> = {
  // Every task, ask and worker session the server starts or resumes.
  'src/providers/claude-code-session.ts': { kind: 'guarded', marker: 'guardUnnamedModel(' },
  // A host's own start (an ask or a routine run while the Mac is away): the Mac's template
  // carries the guard's answer as autoModel (spawn-template.ts hostAutoModel).
  'src/providers/host-start-core.ts': { kind: 'guarded', marker: 't.autoModel' },
  'src/providers/inline-subagent.ts': { kind: 'always-named', why: 'an inline subagent always passes the model its caller picked' },
  'src/providers/micro-claude-warm.ts': { kind: 'always-named', why: 'the warm pool spec always names its model' },
  'src/core/sessions/spawn-prefix.ts': { kind: 'not-a-spawn', why: 'reads --model back out of a stored argv' },
  'src/providers/daemon-cron-supervision.ts': { kind: 'not-a-spawn', why: 'a list of value-taking flags for argv parsing' },
  'src/core/sessions/unnamed-model-guard.ts': { kind: 'not-a-spawn', why: 'the guard itself' },
  'src/model/providers/adapter-claude-cli.ts': {
    kind: 'exempt',
    why: 'Walnut\'s own text-only model calls, not a session: it passes the configured model when it is a CLI value and runs no tools',
  },
  'src/providers/daemon-standalone.ts': {
    kind: 'exempt',
    why: 'bridge resume: with a spawn record it replays the server\'s argv, which carries the guard\'s --model; the bare fallback is for a session whose record is gone',
  },
  'src/providers/daemon-source.ts': { kind: 'exempt', why: 'twin of daemon-standalone.ts (bridge resume)' },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const MODEL_ARG = /['"]--model['"]\s*[,)]/

describe('unnamed model guard ratchet', () => {
  const found = walk(SRC)
    .filter((f) => MODEL_ARG.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort()

  it('every file that passes --model is listed with how an unnamed model stays on Claude', () => {
    const unlisted = found.filter((f) => !(f in MEMBERS))
    expect(unlisted, 'add each to MEMBERS: guard it (unnamed-model-guard.ts) or say why it needs none').toEqual([])
  })

  it('no listed file is stale', () => {
    expect(Object.keys(MEMBERS).filter((f) => !found.includes(f)).sort()).toEqual([])
  })

  it('every guarded file still calls the guard', () => {
    for (const [file, m] of Object.entries(MEMBERS)) {
      if (m.kind !== 'guarded') continue
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(m.marker), `${file} lost ${m.marker}`).toBe(true)
    }
    // The host template is filled from the guard's answer.
    expect(fs.readFileSync(path.join(SRC, 'providers/spawn-template.ts'), 'utf8')).toMatch(/autoModel: await hostAutoModel\(o\.hostKey, o\.cwd\)/)
    expect(fs.readFileSync(path.join(SRC, 'providers/spawn-template.ts'), 'utf8')).toMatch(/autoModel: await hostAutoModel\(o\.hostKey, undefined\)/)
  })
})
