/**
 * Ratchet for what a deploy restarts production for (scripts/lib/deploy-queue.sh dq_change_kind).
 * Every restart drops every open window's socket and every host's link for seconds (2026-11-26:
 * 104 restarts in a day, each one also a newdev disconnect). A change to tests or docs restarts
 * nothing, a change to the web app alone is swapped under the running server, and anything else
 * restarts. Each top-level entry of the repo is classified here on purpose: a new one fails until
 * someone says which it is, so it never restarts production for nothing, nor skips a restart it needs.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitChildEnv } from '../../src/lib/git-env.js'

const ROOT = path.join(import.meta.dirname, '..', '..')

// none: production runs nothing from it. web: the web app (swapped, no restart). full: a restart.
const EXPECTED: Record<string, 'none' | 'web' | 'full'> = {
  tests: 'none', docs: 'none', 'ios-native': 'none', '.github': 'none', site: 'none', infra: 'none',
  web: 'web',
  // Runs in production or goes into its build. Entries nobody checked are here too: a restart is the
  // safe answer until someone shows production never reads them.
  src: 'full', scripts: 'full', packages: 'full', patches: 'full', bin: 'full', native: 'full', skills: 'full',
  vendor: 'full', 'package.json': 'full', 'bun.lock': 'full', 'bunfig.toml': 'full', 'tsconfig.json': 'full',
  'tsup.config.ts': 'full', '.claude': 'full', 'plugin-store': 'full', examples: 'full', desktop: 'full',
  'desktop-windows': 'full', ios: 'full', '.husky': 'full', '.gitignore': 'full', '.dockerignore': 'full',
  '.gitleaks.toml': 'full', '.gitleaksignore': 'full', '.npmrc': 'full', 'Dockerfile.onboarding': 'full',
  LICENSE: 'full', 'test-img-server.mjs': 'full', 'test-relay.mjs': 'full', 'zz-click-diag2.mjs': 'full',
}

/** The kind of a change to one path, by the queue's own rules. */
function kinds(paths: string[]): string[] {
  const out = execFileSync('bash', ['-c', `source scripts/lib/deploy-queue.sh
for p in "$@"; do
  if printf '%s\\n' "$p" | grep -qE "$DQ_NONRUNTIME_RE"; then echo none
  elif printf '%s\\n' "$p" | grep -qE "$DQ_WEB_RE"; then echo web
  else echo full; fi
done`, 'x', ...paths], { cwd: ROOT, encoding: 'utf8' })
  return out.trim().split('\n')
}

describe('what a deploy restarts production for', () => {
  it('every top-level entry of the repo is classified on purpose', () => {
    const entries = execFileSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: ROOT, env: gitChildEnv(), encoding: 'utf8' })
      .trim().split('\n')
    const got: Record<string, string> = {}
    const probes = entries.map((e) => (e.includes('.') && !e.startsWith('.') ? e : `${e}/x.ts`))
    kinds(probes).forEach((k, i) => { got[entries[i]] = k })
    const unlisted = entries.filter((e) => !(e in EXPECTED) && !/\.md$/.test(e) && !/^(vitest|playwright)[^/]*\.config\.[^/]+$/.test(e))
    expect(unlisted, 'a new top-level entry: add it to EXPECTED with the kind a change to it is').toEqual([])
    for (const e of entries) {
      const want = EXPECTED[e] ?? 'none' // the markdown and test configs the rules name
      expect(`${e}: ${got[e]}`).toBe(`${e}: ${want}`)
    }
  })

  it('markdown inside the server or the web app still counts as theirs, except AGENTS.md', () => {
    expect(kinds(['src/data/skills/s/SKILL.md', 'web/src/x.md', 'web/src/AGENTS.md', 'src/core/AGENTS.md', 'README.md']))
      .toEqual(['full', 'web', 'none', 'none', 'none'])
  })
})
