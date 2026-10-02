import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { discoverFixtureRoot, loadHome, openDraftOnCwd } from './draft-helpers'
import { startSessionAt, openPanels, openPlusMenu, composerTextarea } from './engine-settings-popover-helpers'

let script = ''

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, {useState, useSyncExternalStore} from 'react';
        import {createRoot} from 'react-dom/client';
        import {MemoryRouter} from 'react-router-dom';
        import {ChatInput} from './src/components/chat/ChatInput';
        let revision = 0;
        const listeners = new Set();
        const subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };
        const snapshot = () => revision;
        setInterval(() => { revision++; for (const callback of listeners) callback(); }, 250);
        document.addEventListener('input', event => {
          if (!event.target.matches('.chat-input-textarea')) return;
          revision++;
          for (const callback of listeners) callback();
        }, true);
        const commands = [
          {name: 'review', description: 'Review changes', source: 'project', kind: 'command'},
          {name: 'deploy', description: 'Ship changes', source: 'skill', kind: 'skill'},
          {name: 'project-helper', description: 'Help with the project', source: 'project', kind: 'skill'},
          {name: 'compact', description: 'Compact context', source: 'built-in', kind: 'command'},
        ];
        const searchCommands = query => commands.filter(command => command.name.startsWith(query));
        function App() {
          const tick = useSyncExternalStore(subscribe, snapshot);
          const [draft, setDraft] = useState('a');
          const [mirror, setMirror] = useState('');
          const [sent, setSent] = useState([]);
          const [fail, setFail] = useState(false);
          const [prefill, setPrefill] = useState({nonce: 0, mode: 'replace', text: ''});
          return <MemoryRouter>
            <button onClick={() => { revision++; for (const callback of listeners) callback(); }}>Refresh status</button>
            <button onClick={() => setDraft(draft === 'a' ? 'b' : 'a')}>Switch draft</button>
            <button onClick={() => setFail(!fail)}>Reject send: {String(fail)}</button>
            {['replace', 'append', 'keep-draft'].map(mode => <button key={mode} onClick={() =>
              setPrefill({nonce: prefill.nonce + 1, mode, text: 'Prefill '})}>{mode}</button>)}
            <div>{Array.from({length: 200}, (_, i) => <span key={i}>{tick + i} </span>)}</div>
            <ChatInput draftKey={'input-state:' + draft} onValueChange={setMirror}
              mentionCwd={new URLSearchParams(location.search).get('cwd') || '/fixture'}
              mentionHost={new URLSearchParams(location.search).get('host') || undefined} enableEntityMention
              prefillNonce={prefill.nonce} prefillText={prefill.text} prefillMode={prefill.mode}
              sessionCommands={commands}
              searchSessionCommands={searchCommands}
              onSend={async text => { setSent(previous => [...previous, text]); return !fail; }} />
            <output data-testid="mirror">{mirror}</output>
            <output data-testid="sent">{JSON.stringify(sent)}</output>
            <output data-testid="revision">{tick}</output>
            <output data-testid="draft">{draft}</output>
          </MemoryRouter>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
      resolveDir: path.resolve('web'),
      sourcefile: 'composer-input-fixture.tsx',
      loader: 'tsx',
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    loader: { '.css': 'empty' },
    format: 'iife',
    platform: 'browser',
    alias: {
      react: path.resolve('web/node_modules/react'),
      'react-dom': path.resolve('web/node_modules/react-dom'),
      '@': path.resolve('web/src'),
      '@open-walnut/core': path.resolve('src/core/types.ts'),
      '@open-walnut/task-query': path.resolve('src/core/task-query.ts'),
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    logLevel: 'silent',
  })
  script = result.outputFiles[0].text
  expect(script).toContain('createRoot')
})

async function openComposer(page: Page, cwd = '/fixture', host?: string) {
  await page.route(/\/__composer-input-test(?:\?|$)/, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/__composer-input-test.js"></script>',
  }))
  await page.route('**/__composer-input-test.js', route => route.fulfill({ contentType: 'text/javascript', body: script }))
  await page.route('**/api/stt/status', route => route.fulfill({ json: { available: false } }))
  await page.route('**/api/files/list?**', route => {
    const dir = new URL(route.request().url()).searchParams.get('path')
    return route.fulfill({ json: { path: dir, entries: dir === '/fixture' ? [{ name: 'src', type: 'dir' }] : [{ name: 'sample.ts', type: 'file', size: 12 }] } })
  })
  // The fixture mounts ChatInput without a TasksContext, so the palette's Tasks
  // group is fed by the hybrid search alone: a task hit, and a hit on a session's
  // transcript whose slim row names the task that owns it (`id`), which the
  // palette folds into that task's row. No Sessions or Projects group exists.
  await page.route('**/api/search?**', route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    const results = /example/i.test(q) ? [
      { type: 'task', id: 'mt-example', title: 'Example', summary: 'An example task', phase: 'IN_PROGRESS', project: 'Demo', ref: '<task-ref id="mt-example" label="Example"/>' },
      { type: 'session', id: 'mt-example', title: 'Example session', summary: 'transcript', phase: 'IN_PROGRESS', project: 'Demo', ref: '<session-ref id="11111111-2222-3333-4444-555555555555" label="Example session"/>' },
      { type: 'session', id: 'mt-other', title: 'Example work (transcript)', summary: 'from a transcript', phase: 'TODO', ref: '<session-ref id="66666666-7777-8888-9999-000000000000" label="Example work"/>' },
    ] : []
    return route.fulfill({ json: { results } })
  })
  await page.setContent('<a href="/">Open composer</a>')
  await page.getByRole('link').evaluate((el, url) => { (el as HTMLAnchorElement).href = url },
    `http://localhost:${process.env.PW_TEST_PORT ?? 3457}/__composer-input-test?cwd=${encodeURIComponent(cwd)}${host ? `&host=${encodeURIComponent(host)}` : ''}`)
  const loaded = page.waitForResponse('**/__composer-input-test.js')
  await page.getByRole('link').click()
  expect((await loaded).status()).toBe(200)
  await expect(page.locator('.chat-input-textarea')).toBeVisible({ timeout: 20_000 })
  return page.locator('.chat-input-textarea')
}

for (const method of ['fill', 'typed'] as const) {
  test(`${method} survives synchronous store updates and sends the exact text`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const input = await openComposer(page)
    const sent: string[] = []
    for (let i = 0; i < 12; i++) {
      const text = `Draft ${i}: keep every character.`
      if (method === 'fill') await input.fill(text)
      else { await input.click(); await input.pressSequentially(text) }
      await input.press('ArrowLeft')
      await expect(input).toHaveValue(text)
      await expect(page.getByTestId('mirror')).toHaveText(text)
      await input.press('Enter')
      sent.push(text)
      await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(sent))
      await expect(input).toHaveValue('')
      await expect(page.getByTestId('mirror')).toHaveText('')
    }
    expect(Number(await page.getByTestId('revision').textContent())).toBeGreaterThanOrEqual(12)
    expect(errors).toEqual([])
  })
}

test('long Unicode drafts survive reload, switching, rejection and retry', async ({ page }) => {
  const input = await openComposer(page)
  const text = Array.from({ length: 120 }, (_, i) => `${i}: café é \u{4f60}\u{597d} \u{1f680} keep this line`).join('\n')
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a'))).toBe(text)
  await page.getByRole('button', { name: 'Switch draft' }).click()
  await expect(input).toHaveValue('')
  await input.fill('Second independent draft')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:b'))).toBe('Second independent draft')
  await page.getByRole('button', { name: 'Switch draft' }).click()
  await expect(input).toHaveValue(text)
  await page.reload()
  await expect(input).toHaveValue(text)
  await page.getByRole('button', { name: 'Reject send: false' }).click()
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify([text]))
  await expect(input).toHaveValue(text)
  await page.getByRole('button', { name: 'Reject send: true' }).click()
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify([text, text]))
  await expect(input).toHaveValue('')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a'))).toBeNull()
  await page.getByRole('button', { name: 'Switch draft' }).click()
  await expect(input).toHaveValue('Second independent draft')
})

test('normalization, prefills and command insertion preserve state', async ({ page }) => {
  const input = await openComposer(page)
  // A bare tag becomes its inline token (an unlabeled tag shows its id); the
  // token alone is a complete message and goes out as the tag.
  await input.fill('<task-ref id="test-task"/>')
  await expect(input).toHaveValue('@[test-task]')
  await expect(page.getByTestId('mirror')).toContainText('<task-ref')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(['<task-ref id="test-task"/>']))
  await input.fill('Typed')
  await page.getByRole('button', { name: 'append', exact: true }).click()
  await expect(input).toHaveValue('Typed Prefill ')
  await page.getByRole('button', { name: 'keep-draft', exact: true }).click()
  await expect(input).toHaveValue('Prefill Typed Prefill ')
  await page.getByRole('button', { name: 'replace', exact: true }).click()
  await expect(input).toHaveValue('Prefill ')
  await input.fill('/rev')
  await input.press('Tab')
  await expect(input).toHaveValue('/review ')
  await expect(page.getByTestId('mirror')).toHaveText('/review')
})

test('the Skills shortcut shows skills first without hiding commands when slash is typed', async ({ page }) => {
  const input = await openComposer(page)
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: '/Skills' }).click()
  await expect(input).toHaveValue('/')
  const palette = page.locator('.command-palette')
  await expect(palette.locator('.command-palette-name')).toHaveText(['/deploy', '/project-helper'])
  await input.press('Escape')
  await input.fill('')
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: '/Skills' }).click()
  await expect(palette.locator('.command-palette-name')).toHaveText(['/deploy', '/project-helper'])
  await input.press('Escape')
  await input.fill('')
  await input.click()
  await input.pressSequentially('/r')
  await expect(palette.locator('.command-palette-name')).toHaveText(['/review'])
  await input.press('Backspace')
  await expect(palette.locator('.command-palette-name')).toHaveText(['/review', '/deploy', '/project-helper', '/compact'])
  await input.press('Escape')
  await input.fill('')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText('[]')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a'))).toBeNull()
})

test('the schedule shortcut preserves a draft and asks which timing fits', async ({ page }) => {
  const input = await openComposer(page)
  await input.fill('Send me a summary when it is ready')
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Set up a trigger or cron job' }).click()
  await expect(input).toHaveValue('Set up a trigger or cron job: Send me a summary when it is ready')
  await expect(page.getByTestId('sent')).toHaveText('[]')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a')))
    .toBe('Set up a trigger or cron job: Send me a summary when it is ready')
})

test('Find a folder searches recent and nearby directories without replacing the draft', async ({ page }) => {
  const paths = Array.from({ length: 260 }, (_, i) => `/fixture/work/projects/module-${i}`)
  paths.push('/fixture/work/projects/DeltaService', '/fixture/work/notes/weekly-reports')
  const listings: string[] = []
  await page.route('**/api/files/recent-dirs', route => route.fulfill({ json: {
    dirs: [{ cwd: '/fixture/old/DeltaArchive', host: null }, { cwd: '/other-host/DeltaService', host: 'remote' }],
  } }))
  await page.route('**/api/sessions/list-dirs?**', route => {
    const params = new URL(route.request().url()).searchParams
    const prefix = params.get('prefix') ?? ''
    listings.push(`${prefix}:${params.get('depth')}`)
    return route.fulfill({ json: { dirs: prefix === '/fixture/work/' ? paths : ['/fixture/work', '/fixture/sibling'], parent: prefix, exists: true } })
  })
  const input = await openComposer(page, '/fixture/work/')
  await input.fill('Review ')
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: /Find a folder$/ }).click()
  const picker = page.locator('.file-mention-popup')
  await expect(picker.locator('.fmp-recent-path')).toHaveText(['/fixture/old/DeltaArchive'])
  await expect(input).toHaveValue('Review @?')
  await input.pressSequentially('dlsrv')
  await expect(picker.locator('.fmp-recent-item', { hasText: '/fixture/work/projects/DeltaService' })).toBeVisible()
  await expect(picker.locator('.fmp-recent-path').first()).toHaveText('/fixture/work/projects/DeltaService')
  await expect(picker.locator('.fmp-recent-item', { hasText: '/other-host/DeltaService' })).toHaveCount(0)
  expect(await picker.locator('.fmp-recent-path').count()).toBeLessThanOrEqual(40)
  await picker.locator('.fmp-recent-item', { hasText: '/fixture/work/projects/DeltaService' }).getByRole('button', { name: 'Select' }).click()
  await expect(input).toHaveValue('Review @/fixture/work/projects/DeltaService ')
  await expect(page.getByTestId('sent')).toHaveText('[]')
  expect(listings.sort()).toEqual(['/fixture/:1', '/fixture/work/:3'])
})

test('folder search ignores old responses, shows failures, and retries without losing the query', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let release: (() => void) | undefined
  let attempts = 0
  await page.route('**/api/files/recent-dirs', route => route.fulfill({ json: { dirs: [] } }))
  await page.route('**/api/sessions/list-dirs?**', async route => {
    const prefix = new URL(route.request().url()).searchParams.get('prefix')
    if (prefix !== '/fixture/') return route.fulfill({ json: { dirs: [], parent: prefix, exists: true } })
    attempts++
    if (attempts === 1) {
      await new Promise<void>(resolve => { release = resolve })
      await route.fulfill({ json: { dirs: ['/fixture/old/MarinaArchive'], parent: '/fixture/', exists: true } }).catch(() => {})
    } else if (attempts === 2) {
      await route.fulfill({ status: 503, body: 'Host unavailable' })
    } else {
      await route.fulfill({ json: { dirs: ['/fixture/private/MarinaProject'], parent: '/fixture/', exists: true } })
    }
  })
  const input = await openComposer(page, '/fixture/')
  try {
    await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
    await page.getByRole('menuitem', { name: /Find a folder$/ }).click()
    await input.pressSequentially('marina')
    await expect.poll(() => attempts).toBe(1)
    await input.press('Escape')
    await expect(page.locator('.file-mention-popup')).toHaveCount(0)
    await input.fill('Keep this draft @?marina')
    await expect(page.locator('.file-mention-popup .fmp-error')).toBeVisible()
    release?.()
    await expect(page.locator('.fmp-recent-item', { hasText: 'MarinaArchive' })).toHaveCount(0)
    await page.locator('.file-mention-popup').getByRole('button', { name: 'Retry' }).click()
    await expect(page.locator('.fmp-recent-path')).toHaveText(['/fixture/private/MarinaProject'])
    await expect(input).toHaveValue('Keep this draft @?marina')
    expect(errors).toEqual([])
  } finally {
    release?.()
  }
})

test('pending folder listings recover without losing the query', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/files/recent-dirs', route => route.fulfill({ json: { dirs: [] } }))
  await page.route('**/api/sessions/list-dirs?**', route => {
    const params = new URL(route.request().url()).searchParams
    expect(params.get('host')).toBe('test-host')
    expect(params.get('pending')).toBe('1')
    expect(params.get('wait')).toBe('500')
    const prefix = params.get('prefix')
    if (prefix !== '/fixture/') return route.fulfill({ json: { dirs: [], parent: prefix, exists: true } })
    attempts++
    return route.fulfill({ json: attempts === 1
      ? { dirs: [], parent: '/fixture/', exists: true, pending: { phase: 'connecting', label: 'Connecting', elapsedMs: 100 } }
      : { dirs: ['/fixture/RecoveredFolder'], parent: '/fixture/', exists: true },
    })
  })
  const input = await openComposer(page, '/fixture/', 'test-host')
  await input.fill('@?recovered')
  const picker = page.locator('.file-mention-popup')
  await expect(picker.locator('.fmp-empty')).toContainText('Searching nearby folders')
  await expect(picker.locator('.fmp-error')).toHaveCount(0)
  await expect(picker.locator('.fmp-recent-path')).toHaveText(['/fixture/RecoveredFolder'], { timeout: 10_000 })
  await expect(input).toHaveValue('@?recovered')
  expect(attempts).toBe(2)
})

test('incomplete folder listings keep their matches visible and offer retry', async ({ page }) => {
  let attempts = 0
  let release: (() => void) | undefined
  await page.route('**/api/files/recent-dirs', route => route.fulfill({ json: { dirs: [] } }))
  await page.route('**/api/sessions/list-dirs?**', async route => {
    const prefix = new URL(route.request().url()).searchParams.get('prefix')
    if (prefix !== '/fixture/') return route.fulfill({ json: { dirs: [], parent: prefix, exists: true } })
    attempts++
    if (attempts === 2) await new Promise<void>(resolve => { release = resolve })
    return route.fulfill({ json: {
      dirs: attempts === 1 ? ['/fixture/PartialMatch'] : ['/fixture/PartialMatch', '/fixture/CompleteMatch'],
      parent: '/fixture/', exists: true,
      ...(attempts === 1 ? { incomplete: { unanswered: 1, message: 'listing incomplete' } } : {}),
    } })
  })
  const input = await openComposer(page, '/fixture/')
  await input.fill('@?match')
  const picker = page.locator('.file-mention-popup')
  await expect(picker.locator('.fmp-recent-item', { hasText: 'PartialMatch' })).toBeVisible()
  await expect(picker.locator('.fmp-error')).toContainText('incomplete')
  try {
    await picker.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => attempts).toBe(2)
    await expect(picker.locator('.fmp-recent-item', { hasText: 'PartialMatch' })).toBeVisible()
    release?.()
    await expect(picker.locator('.fmp-recent-item', { hasText: 'CompleteMatch' })).toBeVisible()
    await expect(picker.locator('.fmp-error')).toHaveCount(0)
  } finally {
    release?.()
  }
})

test('Find a folder works in a real session and keeps its draft in a short viewport', async ({ page, request }) => {
  const root = await discoverFixtureRoot()
  const cwd = `${root}/projects/walnut`
  const sibling = `${root}/projects/zmarinax`
  const nearbyDir = `${cwd}/web`
  const deepDir = `${cwd}/search-target/level/two`
  await fs.mkdir(deepDir, { recursive: true })
  const sid = await startSessionAt(request, cwd)
  await page.setViewportSize({ width: 960, height: 560 })
  const [panel] = await openPanels(page, [sid])
  const input = composerTextarea(panel)
  await input.fill('Review ')
  const menu = await openPlusMenu(panel)
  await expect(menu.getByRole('menuitem', { name: /Find a folder$/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /Find a folder$/ }).click()
  const picker = panel.locator('.file-mention-popup')
  await expect(picker).toBeVisible()
  await input.pressSequentially('zmarinax')
  await expect(picker.locator('.fmp-recent-item', { hasText: sibling })).toBeVisible({ timeout: 20_000 })
  await input.fill('Review @?two')
  await expect(picker.locator('.fmp-recent-item', { hasText: deepDir })).toBeVisible({ timeout: 20_000 })
  await input.fill('Review @?web')
  await expect(picker.locator('.fmp-recent-item', { hasText: nearbyDir })).toBeVisible({ timeout: 20_000 })
  const popupBox = await picker.boundingBox()
  expect(popupBox).toBeTruthy()
  expect(popupBox!.y).toBeGreaterThanOrEqual(0)
  expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(560)
  await fs.mkdir('/tmp/folder-search-v3', { recursive: true })
  await picker.screenshot({ path: `/tmp/folder-search-v3/real-session-${test.info().project.name}.png`, animations: 'disabled' })
  await picker.locator('.fmp-recent-item', { hasText: nearbyDir }).getByRole('button', { name: 'Select' }).click()
  await expect(input).toHaveValue(`Review @${nearbyDir} `)
  await expect(picker).toBeHidden()
})

test('Find a folder also searches from a draft column', async ({ page }) => {
  const root = await discoverFixtureRoot()
  const cwd = `${root}/projects/walnut`
  await loadHome(page)
  const panel = await openDraftOnCwd(page, cwd)
  const input = composerTextarea(panel)
  await input.fill('Check ')
  await openPlusMenu(panel)
  await panel.getByRole('menuitem', { name: /Find a folder$/ }).click()
  const picker = panel.locator('.file-mention-popup')
  await input.pressSequentially('web')
  await expect(picker.locator('.fmp-recent-item', { hasText: `${cwd}/web` })).toBeVisible({ timeout: 20_000 })
  await input.press('Escape')
  await expect(input).toHaveValue('Check @?web')
})

test('file navigation, reference selection and removal keep prose and payload aligned', async ({ page }) => {
  const input = await openComposer(page)
  await input.fill('Read @')
  const picker = page.getByRole('listbox', { name: 'Mention picker' })
  await picker.locator('.mention-row[title="/fixture/src"]').click()
  await expect(input).toHaveValue('Read @src/')
  await picker.locator('.mention-row[title="/fixture/src/sample.ts"]').click()
  await expect(input).toHaveValue('Read @/fixture/src/sample.ts ')
  await input.pressSequentially('please')
  await expect(page.getByTestId('mirror')).toHaveText('Read @/fixture/src/sample.ts please')
  await page.getByRole('button', { name: 'Refresh status' }).click()
  await expect(input).toHaveValue('Read @/fixture/src/sample.ts please')
  await input.fill('Review @Example')
  // Tasks only: the task hit and its transcript hit are ONE row, the other
  // transcript hit is its owning task's row, and there is no Sessions / Projects
  // group to pick from.
  await expect(picker.locator('.mention-row-task')).toHaveCount(2)
  await expect(picker.locator('.mention-group-name')).toHaveText(['Tasks', 'Files'])
  await expect(picker.locator('.mention-row-task').first()).toContainText('IN_PROGRESS · Demo')
  await expect(picker.locator('.mention-row-task').nth(1)).toContainText('TODO · Inbox')
  await picker.locator('.mention-row-task').first().click()
  // The pick lands IN the box as a readable token where the "@" was, like a
  // file's @path; the payload carries the tag in that place.
  await expect(input).toHaveValue('Review @[Example] ')
  await expect(picker).toBeHidden()
  await input.pressSequentially('carefully')
  await expect(page.getByTestId('mirror')).toHaveText('Review <task-ref id="mt-example" label="Example"/> carefully')
  // A caret right after the token does not reopen the palette.
  await input.press('Home')
  await input.press('End')
  await expect(picker).toBeHidden()
  // Backspace right after the token removes the whole token, not one bracket.
  const tokenEnd = 'Review @[Example]'.length
  await input.evaluate((el: HTMLTextAreaElement, pos: number) => el.setSelectionRange(pos, pos), tokenEnd)
  await input.press('Backspace')
  await expect(input).toHaveValue('Review carefully')
  await expect(page.getByTestId('mirror')).toHaveText('Review carefully')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(['Review carefully']))
})

test('a reference token survives a reload and a pasted tag becomes a token', async ({ page }) => {
  const input = await openComposer(page)
  await input.fill('Review @Example')
  const picker = page.getByRole('listbox', { name: 'Mention picker' })
  await picker.locator('.mention-row-task').first().click()
  await expect(input).toHaveValue('Review @[Example] ')
  await input.pressSequentially('now')
  // The draft is persisted in its composed form and comes back as the same token.
  const composed = 'Review <task-ref id="mt-example" label="Example"/> now'
  await expect(page.getByTestId('mirror')).toHaveText(composed)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a'))).toBe(composed)
  await page.reload()
  await expect(input).toHaveValue('Review @[Example] now')
  await expect(page.getByTestId('mirror')).toHaveText(composed)
  // Raw markup typed or pasted into the box becomes its token too.
  await input.fill('see <task-ref id="mt-other" label="Other one"/> please')
  await expect(input).toHaveValue('see @[Other one] please')
  await expect(page.getByTestId('mirror')).toHaveText('see <task-ref id="mt-other" label="Other one"/> please')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(['see <task-ref id="mt-other" label="Other one"/> please']))
})

test('browser IME composition survives store refresh before committing and sending', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP IME composition is only available in Chromium')
  const input = await openComposer(page)
  const cdp = await page.context().newCDPSession(page)
  const text = '\u{4f60}\u{597d}'
  await input.click()
  await cdp.send('Input.imeSetComposition', { text, selectionStart: 2, selectionEnd: 2 })
  await expect(input).toHaveValue(text)
  await expect(page.getByTestId('mirror')).toHaveText(text)
  await page.evaluate(() => (document.querySelector('button') as HTMLButtonElement).click())
  await expect(input).toHaveValue(text)
  await cdp.send('Input.insertText', { text })
  await expect(input).toHaveValue(text)
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify([text]))
  await cdp.detach()
})

test('native undo and composition-key guards preserve the state and send payload', async ({ page }) => {
  const input = await openComposer(page)
  await input.click()
  await input.pressSequentially('Undo this')
  await input.press('ControlOrMeta+z')
  await expect.poll(async () => (await input.inputValue()).length).toBeLessThan('Undo this'.length)
  await expect(page.getByTestId('mirror')).toHaveText((await input.inputValue()).trim())
  await input.fill('')
  await input.pressSequentially('Keep composition')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })
  await expect(page.getByTestId('sent')).toHaveText('[]')
  await expect(input).toHaveValue('Keep composition')
  await input.press('Shift+Enter')
  await input.pressSequentially('Next line')
  await expect(input).toHaveValue('Keep composition\nNext line')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(['Keep composition\nNext line']))
})
