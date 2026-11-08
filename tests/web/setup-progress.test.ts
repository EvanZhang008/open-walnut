import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { SetupProgress } from '../../web/src/components/common/SetupProgress';

const render = (props: Parameters<typeof SetupProgress>[0]) => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(SetupProgress, props)));
  return { document, bar: document.querySelector('[role="progressbar"]')! };
};

describe('setup progress', () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'unknown progress (%s) has a named bar, no measured value or invented percentage', (percent) => {
      const { document, bar } = render({ label: 'Installing Claude Code...', percent });
      expect(bar.getAttribute('aria-label')).toBe('Installing Claude Code...');
      expect(bar.hasAttribute('aria-valuenow')).toBe(false);
      expect(bar.getAttribute('aria-valuetext')).toBe('In progress');
      expect(document.querySelector('.setup-progress')?.getAttribute('data-progress')).toBe('unknown');
      expect(document.querySelector('.setup-progress-fill')?.hasAttribute('style')).toBe(false);
      expect(document.querySelector('.setup-progress-value')).toBeNull();
      expect(document.querySelector('.setup-progress-label')?.textContent).toBe('Installing Claude Code...');
    },
  );

  it.each([[0, 0], [42.5, 42.5], [100, 100], [-3, 0], [105, 100]])(
    'a measured percentage %s stays in the accessible and visual range (%s)', (percent, value) => {
      const { document, bar } = render({ label: 'Downloading model', percent });
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
      expect(bar.getAttribute('aria-valuenow')).toBe(String(value));
      expect(bar.hasAttribute('aria-valuetext')).toBe(false);
      expect(document.querySelector('.setup-progress-fill')?.getAttribute('style')).toBe(`width:${value}%`);
      expect(document.querySelector('.setup-progress-value')?.textContent).toBe(`${Math.round(value)}%`);
    },
  );

  it('step progress names the stage and reports the actual completed step count, not a download percentage', () => {
    const { document, bar } = render({ label: 'Upload daemon', percent: 3 / 7 * 100, valueText: '3 of 7 steps complete' });
    expect(bar.getAttribute('aria-label')).toBe('Upload daemon');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeCloseTo(42.857);
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 7 steps complete');
    expect(document.querySelector('.setup-progress-value')?.textContent).toBe('3 of 7 steps complete');
  });

  it('a compact settings bar is still named, and a ticking elapsed label need not change its accessible name', () => {
    const { document, bar } = render({ label: 'Installing on Build box... 12s', ariaLabel: 'Installing on Build box', compact: true });
    expect(bar.getAttribute('aria-label')).toBe('Installing on Build box');
    expect(document.querySelector('.setup-progress-label')).toBeNull();
    expect(document.querySelector('.setup-progress')?.classList.contains('setup-progress-compact')).toBe(true);
  });

  it('stage text is escaped and can remain complete instead of clipped by the old phase class', () => {
    const label = 'Installing runtime on <build-box> & waiting for the package manager to finish';
    const { document, bar } = render({ label, inline: true });
    expect(bar.getAttribute('aria-label')).toBe(label);
    expect(document.querySelector('.setup-progress-label')?.textContent).toBe(label);
    expect(document.querySelector('build-box')).toBeNull();
    expect(document.querySelector('.setup-progress')?.classList.contains('setup-progress-inline')).toBe(true);
  });
});
