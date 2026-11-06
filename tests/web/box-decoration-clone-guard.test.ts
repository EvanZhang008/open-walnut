/**
 * An inline box that clones its decoration at each line break carries no padding or border.
 *
 * Line breaking leaves a cloned end's padding and border out of the line, so a line whose last
 * word just fits ran that much past the text's edge, and a clamped or clipped container cut it
 * (2026-11-06: a corner notice's command box, 2 to 5px at about one corner width in eight in
 * Chromium and at the open sidebar's 228px in WebKit; corner-stack.css .notice-cmd-code now
 * slices). A clone with only a background and a radius changes no width and is fine.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = path.resolve(__dirname, '../../web/src')

/** Every rule block of a stylesheet (selector and body), nested @media blocks included. */
function blocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{};]+)\{([^{}]*)\}/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ selector: m[1]!.trim(), body: m[2]! })
  return out
}

const CLONES = /(?:^|;|\s)(?:-webkit-)?box-decoration-break\s*:\s*clone/
/** A padding or border that takes width at a line's end (zero and none take none). */
const TAKES_WIDTH = /(?:^|;|\s)(padding|padding-(?:right|left|inline(?:-end|-start)?)|border|border-(?:right|left|inline(?:-end|-start)?)(?:-width)?)\s*:\s*([^;]+)/g

function offenders(css: string): string[] {
  return blocks(css).filter(({ body }) => CLONES.test(body)).flatMap(({ selector, body }) =>
    [...body.matchAll(TAKES_WIDTH)]
      .filter(([, , value]) => !/^\s*(?:0(?:px)?(?:\s+0(?:px)?)*|none)\s*$/.test(value!))
      .map(([decl]) => `${selector}: ${decl!.trim()}`))
}

describe('box-decoration-break: clone', () => {
  it('no stylesheet clones a decoration that takes width', () => {
    const found = fs.readdirSync(STYLES, { recursive: true }).map(String).filter((f) => f.endsWith('.css'))
      .flatMap((f) => offenders(fs.readFileSync(path.join(STYLES, f), 'utf8')).map((o) => `${f} ${o}`))
    expect(found).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(offenders('.notice-cmd-code { border: 1px solid red; padding: 0 4px; box-decoration-break: clone; }')).toHaveLength(2)
    expect(offenders('.pill { background: red; border-radius: 4px; -webkit-box-decoration-break: clone; }')).toEqual([])
    expect(offenders('.x { padding: 0; border: none; box-decoration-break: clone; }')).toEqual([])
    expect(offenders('.x { padding: 0 4px; box-decoration-break: slice; }')).toEqual([])
  })
})
