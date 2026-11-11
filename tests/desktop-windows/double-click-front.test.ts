/**
 * The Windows double-click run (desktop-windows/test/*.ps1) clicks with the real mouse, at a point
 * on the screen. 2026-11-11, Release archives run 43013299448: the runner's own Terminal window sat
 * over Explorer, the double-click on the installer's row landed in that Terminal, nothing ran, and
 * the step failed four minutes later as "no Walnut window". So every real click goes through
 * Click-Element, which first makes sure the element's own window is the one under the point
 * (moving a window in the way, or failing by its name). This fails on a script that clicks the
 * mouse any other way.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join(__dirname, '../../desktop-windows/test')
const scripts = fs.readdirSync(DIR).filter((f) => f.endsWith('.ps1'))

/** The body of a PowerShell function, from its `function Name(` line to the closing brace at column 0. */
function body(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

describe('Windows desktop test clicks', () => {
  it('finds the scripts', () => {
    expect(scripts).toContain('double-click.ps1')
  })

  it.each(scripts)('%s clicks the real mouse only through Click-Element', (file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8')
    const click = body(src, 'Click-Element')
    const outside = src.replace(click, '')
    expect(outside.match(/\[Mouse\]::Click\(/g) ?? [], 'a [Mouse]::Click outside Click-Element').toEqual([])
    // mouse_event only inside the C# Click that Click-Element calls.
    const native = src.slice(src.indexOf('public static void Click('), src.indexOf("'@"))
    expect(src.split('mouse_event(').length - 1, 'mouse_event outside the C# Click')
      .toBe(native.split('mouse_event(').length - 1 + (src.includes('extern void mouse_event(') ? 1 : 0))
  })

  it('Click-Element checks the window under the point before it clicks', () => {
    const src = fs.readFileSync(path.join(DIR, 'double-click.ps1'), 'utf8')
    const click = body(src, 'Click-Element')
    const check = click.indexOf('[Mouse]::RootAt(')
    const press = click.indexOf('[Mouse]::Click(')
    expect(check).toBeGreaterThan(0)
    expect(press).toBeGreaterThan(check)
    // A window in the way is minimized, and one that stays in the way fails the step by name.
    expect(click).toMatch(/\[Mouse\]::ShowWindow\(\$at, 6\)/)
    expect(click).toMatch(/throw \('a click on/)
    // The native side reads the top-level window at the point.
    expect(src).toMatch(/WindowFromPoint\(POINT p\)/)
    expect(src).toMatch(/GetAncestor\(h, 2\)/)
  })
})
