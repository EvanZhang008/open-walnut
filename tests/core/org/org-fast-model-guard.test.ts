/**
 * Guard: a short fast-model check of the org's threads goes through the one helper
 * (src/core/fast-model-call.ts: the cheap model, the channel's budget, `purpose: 'background'`,
 * its usage source, never under a test run or with background AI off). 2026-11-25: the thread
 * check (thread-audit.ts) was about to copy the join check's private call; the call moved to one
 * place both use. Fails when a file under src/core/org/ reaches the model itself, unless it is
 * listed here with why.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const ORG = path.join(ROOT, 'src/core/org')
/** Files that call a model on their own path, and why. */
const OWN_CALL: Record<string, string> = {
  'reflection/judge.ts': 'the reflection judge uses the main model, not the fast one',
  'reflection/pipeline.ts': 'wires the reflection judge (callModelDefault), the main model',
  'avatars/avatar-store.ts': 'an image model makes the avatar',
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))
}

describe('the org\'s fast-model checks share one call', () => {
  it('no file under src/core/org reaches the model itself unless listed', () => {
    const direct = walk(ORG)
      .filter((f) => /model\/(?:model|micro-agent)\.js|\bfastModelFor\b|\bsendMessage(?:Stream)?\(|\bcallModelDefault\b|micro-claude/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ORG, f))
    expect(direct.filter((f) => !OWN_CALL[f]), 'call callFastModel from src/core/fast-model-call.ts instead').toEqual([])
  })
  it('the join check, the thread check and the answered check use it', () => {
    for (const f of ['thread-join-check.ts', 'thread-audit.ts', 'thread-answered-check.ts']) expect(fs.readFileSync(path.join(ORG, f), 'utf8'), f).toMatch(/fast-model-call\.js/)
  })
})
