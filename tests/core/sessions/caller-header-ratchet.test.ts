/**
 * The web console and the phone never send `x-walnut-caller-sid`. Every session rule
 * on a create (placement, project_reason, the title brake, the related-open-tasks
 * check in src/core/sessions/related-open-tasks.ts) keys on that header, so a human
 * surface that started sending it would put the user's own creates through them.
 * A source ratchet over the two client trees.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const TREES = [
  { dir: 'web/src', ext: /\.(ts|tsx|js|jsx)$/ },
  { dir: 'ios-native/Walnut', ext: /\.swift$/ },
]

function* files(dir: string, ext: RegExp): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* files(full, ext) }
    else if (ext.test(entry.name)) yield full
  }
}

describe('human clients never send the caller header', () => {
  for (const { dir, ext } of TREES) {
    it(`${dir} has no x-walnut-caller-sid`, () => {
      const root = path.join(ROOT, dir)
      expect(fs.existsSync(root)).toBe(true)
      const hits: string[] = []
      let scanned = 0
      for (const file of files(root, ext)) {
        scanned++
        if (/x-walnut-caller-sid/i.test(fs.readFileSync(file, 'utf8'))) hits.push(path.relative(ROOT, file))
      }
      expect(scanned).toBeGreaterThan(10)
      expect(hits).toEqual([])
    })
  }
})
