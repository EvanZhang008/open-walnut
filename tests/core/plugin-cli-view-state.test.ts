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

describe('walnut-plugin validate: a typed draft goes to walnut.ui.useDraft', () => {
  const EDITOR = [
    "import { useState } from 'react'",
    'export function Editor({ id }) {',
    "  const [draft, setDraft] = useState('')",
    "  const [codeDraft, setCodeDraft] = walnut.ui.useView<string>('codeDraft', '', { id })",
    "  const [code, setCode, clearCode] = walnut.ui.useDraft('code', { id })",
    '  const [draftOpen, setDraftOpen] = useState(false)',
    '  const [savingDraft, setSavingDraft] = useState(false)',
    '  const [drafts, setDrafts] = useState([])',
    "  localStorage.setItem(`acme-draft:${id}`, draft)",
    "  const kept = localStorage.getItem(`acme-draft:${id}`)",
    "  // localStorage.setItem('old-draft', draft) was the old way",
    "  const [file, setFile] = walnut.ui.useView('file', 'a.py')",
    '  return null',
    '}',
  ].join('\n')

  it('names a draft in useState, in useView and in its own localStorage key; leaves useDraft, flags, lists and comments alone', async () => {
    const root = await plugin({ 'src/web.tsx': EDITOR })
    const drafts = (await validatePlugin(root)).warnings.filter((w) => w.includes('walnut.ui.useDraft'))
    expect(drafts.map((w) => w.split(' ')[0])).toEqual(['src/web.tsx:3', 'src/web.tsx:4', 'src/web.tsx:9'])
    expect(drafts[0]).toMatch(/keeps the draft "draft" only in useState/)
    expect(drafts[1]).toMatch(/keeps the draft "codeDraft" in useView, which writes it into the synced settings/)
    expect(drafts[2]).toMatch(/keeps a draft in its own localStorage key `acme-draft:/)
  })
})

describe('walnut-plugin validate: judged by what the state holds and how it is set', () => {
  const PAGE = [
    "import { useEffect, useState } from 'react'",
    'export function Stats() {',
    '  const [view, setView] = useState(null)',
    "  useEffect(() => { walnut.api.get('/stats').then(setView) }, [])",
    '  const [page, setPage] = useState(null)',
    '  async function load() {',
    "    const res = await fetch('/rounds')",
    '    const data = await res.json()',
    '    setPage(data)',
    '  }',
    '  const [openError, setOpenError] = useState(null)',
    '  async function open() {',
    '    try { await walnut.api.post(\'/open\') } catch (err) { setOpenError(String(err)) }',
    '  }',
    "  const [lesson, setLesson] = useState('')",
    "  const [code, setCode] = useState('')",
    "  const [query, setQuery] = useState('')",
    "  const [tab, setTab] = useState('topics')",
    '  const [showAll, setShowAll] = useState(false)',
    "  const PREFIX = 'acme-draft:'",
    '  const keyOf = (id) => PREFIX + id',
    '  const save = (id, text) => localStorage.setItem(keyOf(id), text)',
    "  localStorage.setItem('acme-last-' + tab, lesson)",
    "  localStorage.setItem('acme-theme', 'dark')",
    '  return (<div>',
    '    <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} />',
    '    <Editor value={code} onChange={setCode} />',
    '    <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />',
    '    <select value={tab} onChange={(e) => setTab(e.target.value)}><option>topics</option></select>',
    '    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />',
    '    <button onClick={() => setView(null)}>Reset</button>',
    '  </div>)',
    '}',
  ].join('\n')

  it('a state filled from loaded data or set in a catch is no view choice; a tab and a checkbox still are', async () => {
    const root = await plugin({ 'src/web.tsx': PAGE })
    const views = (await validatePlugin(root)).warnings.filter((w) => w.includes('walnut.ui.useView(\''))
    expect(views.map((w) => /keeps "(\w+)"/.exec(w)?.[1])).toEqual(['tab', 'showAll'])
  })

  it('a draft is what the user types, whatever its name; a search is not; a localStorage key that says draft, or holds typed text, is named', async () => {
    const root = await plugin({ 'src/web.tsx': PAGE })
    const drafts = (await validatePlugin(root)).warnings.filter((w) => w.includes('walnut.ui.useDraft'))
    expect(drafts.map((w) => w.split(' ')[0])).toEqual(['src/web.tsx:15', 'src/web.tsx:16', 'src/web.tsx:22', 'src/web.tsx:23'])
    expect(drafts[0]).toMatch(/keeps the draft "lesson" only in useState/)
    expect(drafts[1]).toMatch(/keeps the draft "code" only in useState/)
    expect(drafts[2]).toMatch(/its own localStorage key keyOf\(id\),/)
    expect(drafts[3]).toMatch(/its own localStorage key 'acme-last-' \+ tab,/)
  })
})

