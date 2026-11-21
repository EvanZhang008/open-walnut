/**
 * Adoption in one place (sessions/external-session-import.ts adoptImportedTask): a message into a
 * session takes the importer's tags off its task, whoever sent it. 2026-11-19: only the two send
 * handlers adopted, so a run a trigger, the router or a drained message wrote to stayed "the
 * program's" for good. Every path that puts a message into a session calls
 * applySessionPhase(..., 'session:input', ...), which calls phase.ts adoptOnInput, where adoption
 * lives (a host's replayed delivery into a task that is not complete calls it alone: it moves no
 * phase); a new call site of adoptImportedTask anywhere else fails here, and so does a session:input
 * edge that skips applySessionPhase. The behaviour is in tests/core/program-run-imports.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { loadSources, type SourceSet } from '../helpers/source-files.js'

const ROOT = path.resolve(__dirname, '../..')
let src: SourceSet

beforeAll(async () => { src = await loadSources(ROOT, ['src']) })

describe('adoption of an imported task happens in one place', () => {
  /** phase.ts adoptOnInput, the one place a message decides whose task it is. */
  const adoptOnInputBody = (): string => {
    const phase = src.code('src/core/phase.ts')
    return phase.slice(phase.indexOf('export async function adoptOnInput('), phase.indexOf('async function movePhase('))
  }

  it('adoptImportedTask is called only by adoptOnInput, which applySessionPhase calls for a session:input', () => {
    const callers = src.filesWith(/(?<!function )\badoptImportedTask\(/)
    expect(callers).toEqual(['src/core/phase.ts'])
    const phase = src.code('src/core/phase.ts')
    expect(phase.match(/\badoptImportedTask\(/g)).toHaveLength(1)
    expect(adoptOnInputBody()).toMatch(/if \(isExternalImportTask\(task\)\) \{[\s\S]*adoptImportedTask\(taskId, via, /)
    const entry = phase.slice(phase.indexOf('export async function applySessionPhase('), phase.indexOf('export async function adoptOnInput('))
    expect(entry).toMatch(/if \(trigger === 'session:input' && seen\) await adoptOnInput\(taskId, opts\?\.sendSource \?\? source, source, seen\)/)
    // Its callers: applySessionPhase, and a host's replayed delivery into a task that is not complete.
    expect(src.filesWith(/(?<!function )\badoptOnInput\(/)).toEqual(['src/core/offline-handover.ts', 'src/core/phase.ts'])
    expect(src.code('src/core/offline-handover.ts')).toMatch(/if \(task\.phase !== 'COMPLETE'\) \{\s*await adoptOnInput\(/)
  })

  it('a plugin\'s program run is adopted in the same place, and only there', () => {
    const callers = src.filesWith(/(?<!function )\badoptPluginRun\(/)
    expect(callers).toEqual(['src/core/phase.ts'])
    const phase = src.code('src/core/phase.ts')
    expect(phase.match(/\badoptPluginRun\(/g)).toHaveLength(1)
    expect(adoptOnInputBody()).toMatch(/let adoptsPluginRun(?:: boolean)? = isPluginRunTask\(task\) && inputAdoptsPluginRun\(input\)[\s\S]*if \(adoptsPluginRun\) \{[\s\S]*adoptPluginRun\(taskId, /)
  })

  it('every session:input edge goes through applySessionPhase, which only phase.ts can bypass', () => {
    const inputs = src.files.flatMap((f) => [...src.code(f).matchAll(/(\w+)\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*'session:input'/g)].map((m) => `${f}: ${m[1]}`))
    // The two send handlers, a drained message, a trigger's delivery, the router's reopen.
    for (const f of ['src/providers/claude-code-session.ts', 'src/core/offline-handover.ts', 'src/core/routines/trigger-events.ts', 'src/core/router/service.ts']) {
      expect(inputs.some((line) => line.startsWith(`${f}: applySessionPhase`)), f).toBe(true)
    }
    expect(inputs.filter((line) => !line.endsWith(': applySessionPhase') && !line.endsWith(': waitExitCause'))).toEqual([])
    // The inner mover is no export: nothing outside phase.ts can move a phase on input without adopting.
    expect(src.code('src/core/phase.ts')).not.toMatch(/export async function movePhase/)
  })
})
