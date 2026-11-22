import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../../web/src', name), 'utf8');

it('mic recovery is a portalled measured child layer, never clipped inside its input menu', () => {
  const popup = read('components/common/MicPopover.tsx');
  expect(popup).toContain('createPortal(');
  expect(popup).toContain('useMenuPlacement(true, anchor, popup');
  expect(popup).toContain("overflowY: 'auto'");
  expect(popup).toContain('data-mic-owner={owner}');
  expect(popup).toContain('onPointerDown={(e) => e.stopPropagation()}');
  const button = read('components/common/MicButton.tsx');
  expect(button).toMatch(/<MicPopover[^>]*className="mic-retry-dropdown"/);
  expect(button).toMatch(/<MicPopover[^>]*className="mic-silence-warning mic-error-bubble"/);
  expect(button).toContain('ownsMicControl(');
  const field = read('components/common/BoxMic.tsx');
  expect(field).toContain('ownsMicControl(e.currentTarget.closest');
  expect(field).toContain('<span className={cls}>');
  expect(read('components/tasks/TaskKebabMenu.tsx')).toContain('.adopt-worker-flyout, .mic-popover');
});

it('the shared mic owns its phone-sized target outside overlay-only page styles', () => {
  const css = read('styles/box-mic.css');
  const query = read('hooks/usePhoneLayout.ts').match(/PHONE_LAYOUT_QUERY = '([^']+)'/)![1];
  expect(css).toContain(`@media ${query} {`);
  const mobile = css.slice(css.indexOf(`@media ${query} {`));
  expect(mobile).toContain('.box-mic .mic-btn-wrapper .mic-btn,');
  expect(mobile).toContain('.mic-field .mic-field-mic .mic-btn-wrapper .mic-btn');
  expect(mobile).toContain('min-width: 44px;');
  expect(mobile).toContain('min-height: 44px;');
  expect(mobile).toContain('padding-right: 52px;');
  // A search field's clear and mic are its keys (SearchField): one phone rule sizes both.
  const box = read('styles/input-box.css');
  const boxMobile = box.slice(box.indexOf(`@media ${query} {`));
  expect(boxMobile).toContain('.app-shell-navigation .wn-field-key,');
  expect(boxMobile).toContain('.app-shell-navigation .wn-field > .box-mic .mic-btn,');
  // The board's and the notes' searches are SearchFields too: no clear-key offsets of their own.
  for (const clear of ['.kanban-search-clear', '.notes-search-clear']) expect(css).not.toContain(clear);
  expect(mobile).toContain('min-width: 148px;');
  expect(mobile).toContain('.todo-panel-toolbar { flex-wrap: wrap; }');
  expect(mobile).not.toContain('.is-phone-layer');
});
