/**
 * `dev:ephemeral` copies the data dir into $TMPDIR for a throwaway server. The
 * Apple Health store is private and must never ride along. This runs the
 * launcher's own copy step (copyDataSnapshot, the function runEphemeralLauncher
 * calls) on a real temp tree, so a change to the filter or to the rule it applies
 * is judged by what actually lands in the snapshot. The rule is matched on the
 * FIRST path segment under the data dir, so a note folder named "health" deeper
 * down still copies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyDataSnapshot } from '../../src/commands/ephemeral-snapshot.js'

let root: string
let home: string
let dest: string

function write(rel: string, text = 'x'): void {
  const file = path.join(home, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapshot-health-'))
  home = path.join(root, 'home')
  dest = path.join(root, 'snapshot')
  fs.mkdirSync(home)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ephemeral snapshot copy', () => {
  it('never copies the Apple Health store, whatever file types it holds', () => {
    // Not only the SQLite files (those are skipped everywhere): an export or a
    // journal under health/ must stay home too.
    write(path.join('health', 'health.sqlite'))
    write(path.join('health', 'health.sqlite-wal'))
    write(path.join('health', 'export.json'), '{"note":"invented"}')
    write(path.join('health', 'nested', 'part.txt'))
    write('tasks.json', '{"tasks":[]}')

    copyDataSnapshot(home, dest)

    expect(fs.existsSync(path.join(dest, 'health'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'tasks.json'), 'utf-8')).toBe('{"tasks":[]}')
  })

  it('never copies the Places store either', () => {
    write(path.join('places', 'places.sqlite'))
    write(path.join('places', 'export.json'), '{"note":"invented"}')
    write(path.join('notes', 'places', 'list.md'), '# list')

    copyDataSnapshot(home, dest)

    expect(fs.existsSync(path.join(dest, 'places'))).toBe(false)
    expect(fs.readFileSync(path.join(dest, 'notes', 'places', 'list.md'), 'utf-8')).toBe('# list')
  })

  it('still copies ordinary data, including a nested folder named health', () => {
    write(path.join('notes', 'health', 'plan.md'), '# plan')
    write('health-notes.md', 'notes')
    write(path.join('cache', 'derived.bin'))
    write(path.join('tmp', 'runtime.txt'))

    copyDataSnapshot(home, dest)

    expect(fs.readFileSync(path.join(dest, 'notes', 'health', 'plan.md'), 'utf-8')).toBe('# plan')
    expect(fs.readFileSync(path.join(dest, 'health-notes.md'), 'utf-8')).toBe('notes')
    // The regenerable top-level dirs the same rule names stay out as before.
    expect(fs.existsSync(path.join(dest, 'cache'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'tmp'))).toBe(false)
  })
})
