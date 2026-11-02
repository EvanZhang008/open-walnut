/**
 * `walnut-plugin validate` (and build, dev, publish-check, which run it) warns on a view choice a
 * plugin's web code keeps only in `useState`: it comes back reset when the App mounts again (the
 * plugin reloads, the page reloads, the user visits another page). 2026-11-02, the user, on a
 * practice plugin that lost its open panes: "can we make it default feature in walnut no matter
 * where include plugin, remember the state". The matcher is the one tests/web/view-memory-guard
 * runs on Walnut's own code (packages/plugin-cli/src/view-state-scan.ts).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePlugin } from '../../packages/plugin-cli/src/manifest.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })))
})

async function plugin(files: Record<string, string>, manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-view-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    id: 'view-fixture', name: 'View fixture', version: '0.1.0', apiVersion: 1,
    engines: { walnut: '>=0.3.2' }, web: 'dist/web.js', ...manifest,
  }))
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), text)
  }
  return root
}

const APP = [
  "import { useState } from 'react'",
  'export function App() {',
  "  const [lastTab, setLastTab] = useState('topics')",
  '  const [showPartner, setShowPartner] = useState(true)',
  '  const [menuOpen, setMenuOpen] = useState(false)',
  '  const [busy, setBusy] = useState(false)',
  "  const [mode, setMode] = walnut.ui.useView('mode', 'day')",
  '  return null',
  '}',
].join('\n')

describe('walnut-plugin validate: view choices kept only in useState', () => {
  it('names each one with its file and line, and leaves passing things and kept ones alone', async () => {
    const root = await plugin({ 'src/web.tsx': "export { App } from './web/app'\n", 'src/web/app.tsx': APP })
    const result = await validatePlugin(root)
    expect(result.errors).toEqual([])
    const views = result.warnings.filter((w) => w.includes('walnut.ui.useView'))
    expect(views).toHaveLength(2)
    expect(views[0]).toMatch(/^src\/web\/app\.tsx:3 keeps "lastTab" only in useState/)
    expect(views[1]).toMatch(/^src\/web\/app\.tsx:4 keeps "showPartner" only in useState/)
  })

  it('looks at the web entry\'s folder from manifest.build.web, never node_modules, dist or tests', async () => {
    const root = await plugin({
      'client/main.tsx': APP,
      'client/node_modules/x/index.tsx': APP,
      'client/tests/app.tsx': APP,
      'src/web/app.tsx': APP,
    }, { build: { web: 'client/main.tsx' } })
    const views = (await validatePlugin(root)).warnings.filter((w) => w.includes('walnut.ui.useView'))
    expect(views.map((w) => w.split(' ')[0])).toEqual(['client/main.tsx:3', 'client/main.tsx:4'])
  })

  it('says nothing for a plugin without web code', async () => {
    const root = await plugin({ 'src/web/app.tsx': APP }, { web: undefined, server: 'dist/server.js' })
    expect((await validatePlugin(root)).warnings.filter((w) => w.includes('walnut.ui.useView'))).toEqual([])
  })
})
