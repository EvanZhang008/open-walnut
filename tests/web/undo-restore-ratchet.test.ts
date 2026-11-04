/**
 * Every Undo that puts a task's phase back goes through TaskUndo.restorePhase
 * (web/src/undo/TaskUndoContext.tsx): a plain phase write of NEED_ACTION reads as the person's
 * own ask on the server (src/core/sessions/person-needs.ts), so an undone completion came back
 * as "It was set to need you by hand" instead of what its session had said.
 *
 * A phase write fed from a saved "before" phase outside that one function fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const HOME = 'web/src/undo/TaskUndoContext.tsx'

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe('phase restores', () => {
  it('only restorePhase writes a remembered phase back', () => {
    const offenders: string[] = []
    for (const file of files(path.join(root, 'web/src'))) {
      const rel = path.relative(root, file)
      if (rel === HOME) continue
      const text = fs.readFileSync(file, 'utf8')
      // setPhase(id, before.phase) / setPhase(id, entry.from) / update(id, { phase: before.phase })
      const re = /(setPhase\([^)\n]*(?:before|prior|snapshot|saved|prev)\w*\.phase|setPhase\([^)\n]*\.from\b|phase:\s*(?:before|prior|snapshot|saved|prev)\w*\.phase)/g
      for (const m of text.matchAll(re)) offenders.push(`${rel}: ${m[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('the one home sends a NEED_ACTION back as an Undo, with the time of the phase it restores', () => {
    const text = fs.readFileSync(path.join(root, HOME), 'utf8')
    expect(text).toMatch(/undoOf: before\.phase_changed_at/)
  })
})
