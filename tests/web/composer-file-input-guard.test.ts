/**
 * The composer holds two file inputs: its attach input (data-testid="composer-file-input") and the
 * camera's capture input (camera-capture-input), which takes one picture or video. Code or a spec
 * that picks "the" file input by its type gets the wrong one or a strict-mode error (2026-11-22:
 * eleven composer-file-attachments specs failed on `input[type="file"]` once the camera input was
 * always there, and a refused Start put its pictures back through the capture input, one only).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const DIRS = ['web/src', 'tests/e2e']
const CODE = /\.(ts|tsx)$/
// A selector naming a file input by its type alone, in any quoting.
const BY_TYPE = /input\[type=["']?file["']?\]/

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out) } else if (CODE.test(e.name)) out.push(rel)
  }
  return out
}

describe("the composer's file inputs", () => {
  it('nothing picks a file input by its type: the attach input goes by its test id', () => {
    const hits: string[] = []
    for (const dir of DIRS) {
      for (const f of walk(dir, [])) {
        fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
          if (BY_TYPE.test(line)) hits.push(`${f}:${i + 1}`)
        })
      }
    }
    expect(hits, 'use [data-testid="composer-file-input"] (getByTestId) or the camera-capture-input id').toEqual([])
  })

  it('the attach input carries its test id', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/src/components/chat/ChatInput.tsx'), 'utf8')
    expect(src).toMatch(/ref=\{fileInputRef\}\s+type="file"[\s\S]{0,200}data-testid="composer-file-input"/)
  })
})
