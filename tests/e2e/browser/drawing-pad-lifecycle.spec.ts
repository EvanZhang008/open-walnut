import { test, expect } from '@playwright/test';
import { bundleWebFixture } from './web-fixture-bundle';

let script = '';
test.beforeAll(async () => {
  script = await bundleWebFixture({
    contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ClassicDrawingPad as DrawingPad} from './src/components/chat/ClassicDrawingPad';
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
    sourcefile: 'drawing-fixture.tsx',
  });
});

test('draft switching preserves each sketch and an old attachment cannot close the new drawing', async ({ page }) => {
  await page.route('**/__drawing-lifecycle', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><div id="root"></div><script src="/__drawing-lifecycle.js"></script>' }));
  // The bundle carries raw non-ASCII regex ranges (the dictation's CJK test); without a charset
  // the browser reads it as Latin-1 and the script dies on an invalid character class.
  await page.route('**/__drawing-lifecycle.js', r => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script }));
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
