import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import path from 'node:path'

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
        const commands = [{name: 'review', description: 'Review changes', source: 'cli'}];
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
              mentionCwd="/fixture" enableEntityMention
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

async function openComposer(page: Page) {
  await page.route('**/__composer-input-test', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/__composer-input-test.js"></script>',
  }))
  await page.route('**/__composer-input-test.js', route => route.fulfill({ contentType: 'text/javascript', body: script }))
  await page.route('**/api/stt/status', route => route.fulfill({ json: { available: false } }))
  await page.route('**/api/files/list?**', route => {
    const dir = new URL(route.request().url()).searchParams.get('path')
    return route.fulfill({ json: { path: dir, entries: dir === '/fixture' ? [{ name: 'src', type: 'dir' }] : [{ name: 'sample.ts', type: 'file', size: 12 }] } })
  })
  await page.route('**/api/projects', route => route.fulfill({ json: {
    projects: [{ name: 'Example', source: 'local', favorite: true, counts: { active: 1, todo: 1, done: 0 } }],
    inbox: { counts: { active: 0, todo: 0, done: 0 } },
  } }))
  await page.route('**/api/sessions/mention-index', route => route.fulfill({ json: { sessions: [] } }))
  await page.route('**/api/search?**', route => route.fulfill({ json: { results: [] } }))
  await page.setContent('<a href="/">Open composer</a>')
  await page.getByRole('link').evaluate((el, url) => { (el as HTMLAnchorElement).href = url },
    `http://localhost:${process.env.PW_TEST_PORT ?? 3457}/__composer-input-test`)
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
  await input.fill('<task-ref id="test-task"/>')
  await expect(input).toHaveValue('')
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

test('deleting an inserted shortcut clears the draft and prevents an empty send', async ({ page }) => {
  const input = await openComposer(page)
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: /Commands$/ }).click()
  await expect(input).toHaveValue('/')
  await expect(page.getByTestId('mirror')).toHaveText('/')
  await input.press('Backspace')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('mirror')).toHaveText('')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText('[]')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('input-state:a'))).toBeNull()
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
  await picker.locator('.mention-row-project').click()
  await expect(input).toHaveValue('Review ')
  await expect(page.locator('.composer-ref-title')).toHaveText('Example')
  await input.pressSequentially('carefully')
  await expect(page.getByTestId('mirror')).toHaveText('<project-ref id="Example" label="Example"/> Review carefully')
  await page.getByRole('button', { name: 'Remove reference to Example' }).click()
  await expect(input).toHaveValue('Review carefully')
  await expect(page.getByTestId('mirror')).toHaveText('Review carefully')
  await input.press('Enter')
  await expect(page.getByTestId('sent')).toHaveText(JSON.stringify(['Review carefully']))
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
