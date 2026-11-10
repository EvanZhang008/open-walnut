import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let script = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {DrawingPad} from './src/components/chat/DrawingPad';
        function App() {
          const [open, setOpen] = useState(false);
          const [draft, setDraft] = useState('a');
          const [attached, setAttached] = useState([]);
          window.switchDrawingDraft = () => { setOpen(false); setDraft(v => v === 'a' ? 'b' : 'a'); };
          return <><button onClick={() => setOpen(true)}>Draw</button><button onClick={window.switchDrawingDraft}>Switch draft</button>
            <output>{draft}</output><output data-testid="attached">{JSON.stringify(attached)}</output>
            <DrawingPad open={open} draftId={draft} onClose={() => setOpen(false)} canAttach
              onAttach={async file => { await new Promise(r => { window.finishAttach = r; }); setAttached(v => [...v, {draft, name:file.name}]); return null; }} />
          </>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
      resolveDir: path.resolve('web'), sourcefile: 'drawing-fixture.tsx', loader: 'tsx',
    }, bundle: true, jsx: 'automatic', write: false, loader: { '.css': 'empty' }, format: 'iife', platform: 'browser',
    alias: { react: path.resolve('web/node_modules/react'), 'react-dom': path.resolve('web/node_modules/react-dom'), '@': path.resolve('web/src') },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  script = result.outputFiles[0].text;
});

test('draft switching preserves each sketch and an old attachment cannot close the new drawing', async ({ page }) => {
  await page.route('**/__drawing-lifecycle', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/__drawing-lifecycle.js"></script>' }));
  await page.route('**/__drawing-lifecycle.js', r => r.fulfill({ contentType: 'text/javascript', body: script }));
  await page.evaluate(() => { location.href = 'http://localhost:3457/__drawing-lifecycle'; });
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Drawing', exact: true });
  const canvas = dialog.getByLabel('Drawing canvas');
  await canvas.click({ position: { x: 100, y: 100 } });
  await dialog.getByRole('button', { name: 'Close drawing' }).click();
  await page.getByRole('button', { name: 'Switch draft' }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close drawing' }).click();
  await page.getByRole('button', { name: 'Switch draft' }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Attach drawing', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).finishAttach);
  await page.evaluate(() => (window as any).switchDrawingDraft());
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.evaluate(() => (window as any).finishAttach());
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Attach drawing', exact: true })).toBeDisabled();
  await expect(page.getByTestId('attached')).toContainText('"draft":"a"');
});
