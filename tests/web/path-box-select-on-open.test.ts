/**
 * A path box that opens pre-filled with the folder on show selects it, so the
 * path a person types replaces it (2026-11-08: the Files path box read
 * ".../Project-002~/Documents/Project-003" after typing). The class: every
 * auto-focused picker input with a default value, found from the source.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('pre-filled path boxes', () => {
  it('every auto-focused picker input with a default value selects it on focus', () => {
    const found: string[] = []
    for (const file of tsxFiles('web/src')) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/<input\b[\s\S]*?\/>/g)) {
        const tag = m[0]
        if (!tag.includes('data-no-draft="picker"') || !tag.includes('autoFocus') || !tag.includes('defaultValue=')) continue
        found.push(file)
        expect(tag, file).toContain('onFocus={(e) => e.currentTarget.select()}')
      }
    }
    expect(found.sort()).toEqual(['web/src/components/chat/FileMentionPopup.tsx', 'web/src/components/sessions/SessionFileExplorer.tsx'])
  })
})
