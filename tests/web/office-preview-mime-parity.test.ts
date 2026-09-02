/**
 * Ratchet: the office extensions the WEB PREVIEW claims it can render must all
 * be on the SERVER's raw-byte lane.
 *
 * The two halves live in different files and are edited independently. If an
 * extension is in the client's set but missing from RAW_INLINE_MIME, the server
 * falls through to its text lane, utf-8-decodes the zip container, and the user
 * sees "Could not render this document — it may be corrupt": a server routing
 * bug that reads like a broken file. Nothing else in the suite catches that (no
 * jsdom tier renders the component), so pin it at the source level.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Extensions in a `const NAME = new Set([...])` declaration. */
function extSet(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(source)
  if (!m) throw new Error(`${name} not found — was it renamed?`)
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

describe('office preview MIME parity', () => {
  // The sets moved out of FileContentView when the tree's hover prefetch needed
  // the same "is this served as raw bytes" answer (web/src/utils/file-kind.ts).
  const client = fs.readFileSync(
    path.join(ROOT, 'web/src/utils/file-kind.ts'), 'utf-8',
  )
  const server = fs.readFileSync(
    path.join(ROOT, 'src/web/routes/file-content.ts'), 'utf-8',
  )
  const rawMime = /export const RAW_INLINE_MIME[^{]*\{([\s\S]*?)\n\}/.exec(server)?.[1] ?? ''
  const served = new Set([...rawMime.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!))

  it('every office extension the client renders is served as raw bytes', () => {
    const claimed = [
      ...extSet(client, 'WORD_EXTS'),
      ...extSet(client, 'SHEET_EXTS'),
      ...extSet(client, 'SLIDES_EXTS'),
    ]
    expect(claimed.length).toBeGreaterThan(0)
    expect(claimed.filter((e) => !served.has(e))).toEqual([])
  })

  it('the cloud bridge relay shares the ONE table instead of copying it', () => {
    // A hand-copied twin silently fell behind when office types were added.
    const bridge = fs.readFileSync(
      path.join(ROOT, 'src/web/routes/file-content-bridge.ts'), 'utf-8',
    )
    expect(bridge).toMatch(/import \{ RAW_INLINE_MIME \} from '\.\/file-content\.js'/)
    expect(bridge).not.toMatch(/const RAW_INLINE_MIME/)
  })
})
