/**
 * A plugin's App or page draws only inside its own box (web/src/plugins/plugin-bounds.ts).
 *
 * The report (2026-10-28): an App's pause screen covered the whole window, the Walnut sidebar
 * included. An App renders in Walnut's own document, so nothing stopped a modal <dialog> (the
 * browser's top layer) or a `position: fixed` overlay from drawing over Walnut. The browser half
 * of this (a real App, a real dialog, the sidebar still clickable) is in
 * tests/e2e/browser/native-plugin.spec.ts; these checks keep the pieces from being taken out.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { capped, clipTo, movedBy, overlap, shiftInto } from '../../web/src/plugins/plugin-bounds'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

describe('shiftInto: the least move that puts a top-layer element inside the box', () => {
  const box = { left: 260, top: 0, width: 1000, height: 800 }

  it('leaves one already inside alone', () => {
    expect(shiftInto({ left: 400, top: 100, width: 200, height: 300 }, box)).toEqual({ x: 0, y: 0 })
  })

  it('moves a full-window screen onto the box, off the sidebar', () => {
    // A dialog sized to the box by its max-width, still at the window's left edge.
    expect(shiftInto({ left: 0, top: 0, width: 1000, height: 800 }, box)).toEqual({ x: 260, y: 0 })
  })

  it('slides a menu by the box edge in only as far as it must', () => {
    expect(shiftInto({ left: 200, top: 40, width: 180, height: 120 }, box)).toEqual({ x: 60, y: 0 })
    expect(shiftInto({ left: 1200, top: 760, width: 180, height: 120 }, box)).toEqual({ x: -120, y: -80 })
  })

  it('pins one larger than the box to its top left', () => {
    expect(shiftInto({ left: 0, top: -50, width: 1400, height: 900 }, box)).toEqual({ x: 260, y: 50 })
  })
})

describe('capped: the plugin keeps its own limit under ours', () => {
  it('ours alone when it set none', () => {
    expect(capped('none', 1000)).toBe('1000px')
    expect(capped('', 1000)).toBe('1000px')
  })
  it('the smaller of both', () => {
    expect(capped('320px', 1000)).toBe('min(320px, 1000px)')
    expect(capped('90%', 640)).toBe('min(90%, 640px)')
  })
})

describe('movedBy: our move on top of the plugin\'s own translate', () => {
  it('a plain move when it has none', () => {
    expect(movedBy('none', 260, 0)).toBe('260px 0px')
    expect(movedBy('', -12, 40)).toBe('-12px 40px')
    expect(movedBy('0px', 5, 6)).toBe('5px 6px')
  })
  it('keeps its centring and its depth', () => {
    expect(movedBy('-50% -50%', 260, 0)).toBe('calc(-50% + 260px) calc(-50% + 0px)')
    expect(movedBy('10px', 0, -8)).toBe('calc(10px + 0px) -8px')
    expect(movedBy('calc(-50% + 4px) 2px 3px', 1, 1)).toBe('calc(calc(-50% + 4px) + 1px) calc(2px + 1px) 3px')
  })
})

describe('overlap: where the box shows', () => {
  it('cut by its scroller and by the window', () => {
    expect(overlap({ left: 260, top: -400, width: 1000, height: 3000 }, { left: 260, top: 40, width: 1000, height: 760 })).toEqual({ left: 260, top: 40, width: 1000, height: 760 })
    expect(overlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 20, width: 10, height: 10 })).toEqual({ left: 20, top: 20, width: 0, height: 0 })
  })
})

describe('clipTo: what an open dialog draws stops at the box', () => {
  it('reaches out to the box edges, and cuts where the dialog passes them', () => {
    const box = { left: 260, top: 0, width: 1000, height: 800 }
    expect(clipTo({ left: 400, top: 100, width: 200, height: 300 }, box)).toBe('inset(-100px -660px -400px -140px)')
    expect(clipTo({ left: 260, top: 0, width: 1000, height: 800 }, box)).toBe('inset(0px 0px 0px 0px)')
  })
})

describe('every plugin App and page renders in a bounded box', () => {
  it('the box is clipped and isolated, never contained, and top-layer backdrops show nothing', () => {
    const css = read('web/src/styles/plugin-bounds.css')
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.()>[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(rule('.plugin-bounds')).toMatch(/isolation:\s*isolate/)
    expect(rule('.plugin-native-app.plugin-bounds')).toMatch(/clip-path:\s*inset\(0\)/)
    // A page is cut where it scrolls, so a wide one still scrolls sideways.
    expect(rule('.app-content-area:has(> .plugin-native-page)')).toMatch(/clip-path:\s*inset\(0\)/)
    // Containment would make the box the frame of Walnut's own fixed menus inside an App.
    expect(css).not.toMatch(/^\s*contain:/m)
    // A backdrop covers the box alone, and has no size where the box's insets do not reach it.
    for (const selector of ['.plugin-bounds dialog::backdrop', '.plugin-bounds [popover]::backdrop']) {
      expect(rule(selector)).toMatch(/inset: var\(--plugin-box-top, 50vh\) var\(--plugin-box-right, 50vw\) var\(--plugin-box-bottom, 50vh\) var\(--plugin-box-left, 50vw\) !important/)
    }
    // Walnut's own full-screen sheets inside a box cover the box.
    expect(rule('html .plugin-bounds .open-walnut-fullscreen.is-changed-open')).toMatch(/left: calc\(var\(--plugin-box-left, 0px\)/)
    expect(rule('html .plugin-bounds .file-content-view.fv-fullscreen')).toMatch(/inset: var\(--plugin-box-top, 0px\)/)
  })

  it('the App host and the plugin page route both use it', () => {
    const host = read('web/src/apps/AppHostPage.tsx')
    expect(host).toMatch(/<PluginBounds\s+className="plugin-native-app"/)
    expect(host).not.toMatch(/<div\s+className="plugin-native-app"/)
    const app = read('web/src/App.tsx')
    expect(app).toMatch(/<PluginBounds className="plugin-native-page"/)
    expect(app).not.toMatch(/<div className="plugin-native-page"/)
  })

  it('a full-screen sheet of Walnut\'s inside a box keeps its backdrop beside it, not on the body', () => {
    const hook = read('web/src/hooks/useFullscreen.tsx')
    expect(hook).toMatch(/useContext\(PluginBoxContext\)/)
    expect(hook).toMatch(/backdrop && !inPluginBox \? createPortal\(backdrop, document\.body\) : backdrop/)
    expect(read('web/src/plugins/PluginBounds.tsx')).toMatch(/<PluginBoxContext\.Provider value=\{true\}>/)
  })

  it('the box keeps what the plugin opens in the top layer, and refuses fullscreen but a player\'s', () => {
    const src = read('web/src/plugins/plugin-bounds.ts')
    expect(src).toMatch(/addEventListener\('beforetoggle', onToggle, true\)/)
    expect(src).toMatch(/addEventListener\('toggle', onToggle, true\)/)
    expect(src).toMatch(/attributeFilter: \['open'\]/)
    expect(src).toMatch(/exitFullscreen\(\)/)
    expect(src).toMatch(/el instanceof HTMLMediaElement \|\| el instanceof HTMLIFrameElement \|\| el\.querySelector\('video, audio, iframe'\)/)
    expect(read('web/src/plugins/PluginBounds.tsx')).toMatch(/useLayoutEffect\(\(\) => \(ref\.current \? keepInBox\(ref\.current\)/)
  })
})
