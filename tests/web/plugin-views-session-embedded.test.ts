import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// A plugin's SessionView sits inside the plugin's own App, never in the home page's column
// layout, so it must draw the session panel as `embedded`. A column's crash fallback Close
// also wipes the saved home column layout (SessionPanelErrorBoundary clearsColumnLayout),
// which a plugin pane must never do: the user's unrelated session columns would vanish.
//
// Read from source: the views facade renders real console components, and their React
// lives in web/node_modules, out of reach of the repo-root test config.

const VIEWS = path.resolve(import.meta.dirname, '../../web/src/plugins/views.tsx')
const PANEL = path.resolve(import.meta.dirname, '../../web/src/components/sessions/SessionPanel.tsx')

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('plugin SessionView', () => {
  it('draws the session panel as embedded', () => {
    const body = functionBody(fs.readFileSync(VIEWS, 'utf8'), 'SessionView')
    const panel = body.slice(body.indexOf('<SessionPanel'), body.indexOf('/>', body.indexOf('<SessionPanel')))
    expect(panel).toMatch(/\n\s*embedded\n/)
    expect(panel).toMatch(/onClose=\{\(\) => onClose\(\)\}/)
  })

  it('embedded is what keeps the crash fallback away from the column layout', () => {
    const source = fs.readFileSync(PANEL, 'utf8')
    expect(source).toContain('clearsColumnLayout={!embedded}')
  })
})
