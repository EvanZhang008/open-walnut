/**
 * Ratchet: every place that fills a launch cwd from the record (a task's or an ancestor's
 * cwd, a project's default_cwd) goes through src/core/sessions/launch-place.ts, so a start
 * that names a host never takes a folder from another machine (2026-10-31: a task created
 * with host "clouddev" started in its lead's Mac folder and died at once).
 *
 * Counted from the source: each read of `default_cwd`, each call of recordedCwd /
 * recordedPlace, and each hand-written parent-chain walk (`cwd = current.cwd`). A line is fine when it
 * sits beside the host-aware twin (`defaultCwdOnHost` / `recordedCwdOnHost` on the same
 * line, the unnamed-host branch) or in a file listed below with why it is not a launch.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

/** Files that read the record for something other than a launch folder. */
const NOT_A_LAUNCH: Record<string, string> = {
  'src/core/sessions/launch-place.ts': 'the rule itself',
  'src/core/sessions/task-start.ts': 'defines recordedCwd / recordedPlace',
  'src/core/sessions/caller-placement.ts': 'compares a caller cwd with the default, to decide what a create records',
  'src/core/sessions/folder-project.ts': 'maps a folder to the project that declares it',
  'src/ops/work.ts': 'validates a project_metadata_update body',
}

const PATTERN = /\??\.default_cwd\b|\brecordedCwd\(|\brecordedPlace\(|\bcwd\s*=\s*current\.cwd\b/

// Matched here, not with `git grep -E`: macOS's git takes its ERE from the system regex
// library, which has no \b or \s, so the grep found nothing, exited 1 and threw on the Mac.
function matches(): Array<{ file: string; line: number; text: string }> {
  const files = execFileSync('git', ['ls-files', '--', 'src/*.ts', 'src/**/*.ts'], { cwd: ROOT }).toString('utf8').split('\n').filter(Boolean)
  return files.flatMap((file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    .map((text, i) => ({ file, line: i + 1, text }))
    .filter((m) => PATTERN.test(m.text)))
    .filter((m) => !/^\s*(\*|\/\/)/.test(m.text))
}

describe('launch folders from the record go through launch-place.ts', () => {
  it('every reader is host-aware or not a launch', () => {
    const bad = matches().filter((m) => !NOT_A_LAUNCH[m.file] && !/\b(defaultCwdOnHost|recordedCwdOnHost)\(/.test(m.text))
    expect(bad.map((m) => `${m.file}:${m.line}: ${m.text.trim()}`)).toEqual([])
  })

  it('the list holds no file that no longer reads the record', () => {
    const files = new Set(matches().map((m) => m.file))
    expect(Object.keys(NOT_A_LAUNCH).filter((f) => !files.has(f))).toEqual([])
  })

  it('the ratchet sees the launch paths it guards', () => {
    const guarded = new Set(matches().filter((m) => /\b(defaultCwdOnHost|recordedCwdOnHost)\(/.test(m.text)).map((m) => m.file))
    expect([...guarded].sort()).toEqual(['src/core/sessions/task-launch-plan.ts', 'src/providers/claude-code-session.ts'])
  })
})
