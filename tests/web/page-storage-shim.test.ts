/**
 * One storage stand-in for every page Walnut runs in an opaque origin (src/lib/page-storage-shim.ts),
 * and the Files preview's page state goes in before the page's own first script.
 *
 * Fails when a second copy of the shim appears (an island and the preview drifted apart once
 * already: the island's had the proxy fix, a copy would not), or when the preview's state script
 * moves after the bridge or out of the head's first script (its storage and hash must be back
 * before the page reads them).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PAGE_STORAGE_SHIM_JS } from '../../src/lib/page-storage-shim'
import { withPreviewBridge } from '../../src/web/preview-bridge'
import { PREVIEW_STATE_JS } from '../../src/web/preview-state-script'
import { islandRuntimeScript } from '../../web/src/components/chat/island-runtime'

const ROOT = join(__dirname, '..', '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('page storage shim', () => {
  it('has one definition, used by the island runtime and the preview state script', () => {
    const copies = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'web', 'src'))]
      .filter((p) => /getItem:function\(/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p))
    expect(copies).toEqual(['src/lib/page-storage-shim.ts'])
    expect(islandRuntimeScript('k', {})).toContain(PAGE_STORAGE_SHIM_JS)
    expect(PREVIEW_STATE_JS).toContain(PAGE_STORAGE_SHIM_JS)
  })

  it('puts the preview state script first in the head, before the bridge and the page', () => {
    const html = withPreviewBridge('<!doctype html><html><head><script>window.mine=1</script></head><body></body></html>')
    const tag = html.indexOf('<script data-walnut-preview>')
    expect(tag).toBeGreaterThan(html.indexOf('<head>'))
    const state = html.indexOf('__walnutPreviewState')
    const bridge = html.indexOf('window.__walnutPreview = 1')
    expect(state).toBeGreaterThan(tag)
    expect(bridge).toBeGreaterThan(state)
    expect(html.indexOf('window.mine=1')).toBeGreaterThan(bridge)
  })
})
