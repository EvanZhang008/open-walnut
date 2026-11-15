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
