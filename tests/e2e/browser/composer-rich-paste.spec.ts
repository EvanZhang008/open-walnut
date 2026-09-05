/**
 * Playwright: pasting rich text into the composer keeps its list structure.
 *
 * A nested numbered list copied from a wiki editor used to land in the
 * <textarea> as the clipboard's text/plain flavour: no markers, no nesting,
 * blank lines between every block (2026-09-03). The composer now rebuilds
 * markdown from the text/html flavour. Prose-only HTML must still go through
 * the browser's native paste so nothing changes for ordinary text.
 */
import { test, expect, type Page } from '@playwright/test';

const WIKI_HTML = `<meta charset='utf-8'><p></p><p>AI</p>
<ol>
  <li><p>Why EKS over SFN</p>
    <ol>
      <li><p>My thinking is</p>
        <ol><li><p>SFN is hard to test</p></li><li><p>More flexible</p></li></ol>
      </li>
      <li><p>The downside is maintenance</p></li>
    </ol>
  </li>
  <li><p>Permission</p></li>
  <li><p></p></li>
</ol>
<p></p><p>Non goal :</p><ol><li><p>20h</p></li></ol>`;

// What the same selection looks like as text/plain: every marker gone.
const WIKI_PLAIN = '\n\nAI\n\nWhy EKS over SFN\n\nMy thinking is\n\nSFN is hard to test\n\nMore flexible\n\nThe downside is maintenance\n\nPermission\n\n\n\nNon goal :\n\n20h\n';

const EXPECTED_MD = [
  'AI',
  '',
  '1. Why EKS over SFN',
  '   1. My thinking is',
  '      1. SFN is hard to test',
  '      2. More flexible',
  '   2. The downside is maintenance',
  '2. Permission',
  '',
  'Non goal :',
  '',
  '1. 20h',
].join('\n');

/**
 * Paste through a ClipboardEvent carrying both flavours, exactly what the
 * browser hands the handler on Cmd+V. (Headless Chromium has no system
 * clipboard to press Cmd+V against, so the event is dispatched directly; a
 * synthetic paste has no default action, which is also why the plain-text
 * control below asserts the handler left the event alone.)
 */
async function paste(page: Page, selector: string, flavours: Record<string, string>, withImageFile = false) {
  return page.evaluate(({ selector, flavours, withImageFile }) => {
    const el = document.querySelector(selector) as HTMLTextAreaElement;
    el.focus();
    const dt = new DataTransfer();
    for (const [type, data] of Object.entries(flavours)) dt.setData(type, data);
    // Office also puts a rendered picture of the selection on the clipboard.
    if (withImageFile) dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, value: el.value };
  }, { selector, flavours, withImageFile });
}

test.describe('Composer: rich paste keeps list structure', () => {
  test('nested numbered list from a wiki editor pastes as markdown, and undo removes it', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await expect(textarea).toBeVisible();
    await textarea.click();

    const result = await paste(page, '.chat-input-textarea', { 'text/html': WIKI_HTML, 'text/plain': WIKI_PLAIN });
    expect(result.defaultPrevented).toBe(true);
    await expect(textarea).toHaveValue(EXPECTED_MD);
    await page.screenshot({ path: '/tmp/composer-rich-paste/pasted-list.png', clip: { x: 0, y: 0, width: 1280, height: 900 } });

    // Native undo still covers the paste (execCommand path).
    await page.keyboard.press('ControlOrMeta+z');
    await expect(textarea).toHaveValue('');
  });

  test('prose-only HTML is left to the native paste', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await textarea.click();

    const result = await paste(page, '.chat-input-textarea', {
      'text/html': '<meta charset="utf-8"><p>Just a <b>sentence</b>.</p>',
      'text/plain': 'Just a sentence.',
    });
    expect(result.defaultPrevented).toBe(false);
    expect(result.value).toBe('');
  });

  test('typing after the paste appends at the caret', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await textarea.click();
    await paste(page, '.chat-input-textarea', { 'text/html': '<ul><li>one</li><li>two</li></ul>', 'text/plain': 'one\ntwo' });
    await expect(textarea).toHaveValue('- one\n- two');
    await page.keyboard.type(' three');
    await expect(textarea).toHaveValue('- one\n- two three');
  });
});

/**
 * Copying cells out of Excel pasted a SCREENSHOT of the cells: Office puts a
 * rendered picture on the clipboard next to the real HTML, and the composer's
 * image branch ran first (2026-09-04). The sniff for Office HTML now wins.
 */
test.describe('Composer: Excel cells paste as text, not a picture', () => {
  const EXCEL_HTML = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta name=Generator content="Microsoft Excel 15">`
    + `<style>.xl65 { mso-number-format:General; }</style></head><body><table>`
    + `<tr><td class=xl65>Region</td><td class=xl65>Cost</td></tr><tr><td>us-west-2</td><td>412</td></tr></table></body></html>`;

  test('an Excel range becomes a markdown table and attaches no image', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await expect(textarea).toBeVisible();
    await textarea.click();

    const result = await paste(page, '.chat-input-textarea', {
      'text/html': EXCEL_HTML,
      'text/plain': 'Region\tCost\nus-west-2\t412',
    }, true);
    expect(result.defaultPrevented).toBe(true);
    await expect(textarea).toHaveValue('| Region | Cost |\n| --- | --- |\n| us-west-2 | 412 |');
    await expect(page.locator('.chat-image-preview')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/composer-rich-paste/excel-as-table.png', clip: { x: 0, y: 0, width: 1280, height: 900 } });
  });

  test('a plain screenshot (image only, no Office HTML) still attaches as an image', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const textarea = page.locator('.chat-input-textarea').first();
    await textarea.click();

    await paste(page, '.chat-input-textarea', {}, true);
    await expect(page.locator('.chat-image-preview')).toHaveCount(1);
    await expect(textarea).toHaveValue('');
  });
});
