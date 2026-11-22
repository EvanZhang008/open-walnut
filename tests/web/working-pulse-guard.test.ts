/**
 * A Working task's status glyph breathes, and stops under reduced motion (2026-11-21, the user: a
 * working task should blink). One stylesheet, web/src/styles/working-pulse.css, owns the motion for
 * every working glyph; no other stylesheet animates one of them on its own.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'web/src');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PULSE = read('web/src/styles/working-pulse.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** The working glyphs and the source that gives each its class or attribute. */
const GLYPHS: Array<{ selector: string; source: string; mark: RegExp }> = [
  { selector: '.task-phase-icon-btn.task-circle-running', source: 'web/src/utils/session-status.ts', mark: /'task-circle-running'/ },
  { selector: '.task-quick-phase-btn.task-circle-running', source: 'web/src/components/sessions/TaskQuickActions.tsx', mark: /task-quick-phase-btn \$\{taskCircleClass/ },
  { selector: '.ask-walnut-drawer-dot.task-circle-running', source: 'web/src/components/chat/AskWalnutDrawerItem.tsx', mark: /running: 'task-circle-running'/ },
  { selector: '.org-state-dot.org-state-working', source: 'web/src/components/org/OrgAvatar.tsx', mark: /org-state-/ },
  { selector: '.session-taskbar-card[data-running] .session-taskbar-dot', source: 'web/src/components/sessions/SessionTaskbar.tsx', mark: /data-running/ },
  { selector: "a.task-link[data-user-state='working']::before", source: 'web/src/styles/globals.css', mark: /a\.task-link\[data-user-state\]::before/ },
  { selector: '.task-working-pulse', source: 'web/src/components/org/ThreadTaskChips.tsx', mark: /task-working-pulse/ },
];

function block(css: string, start: number): string {
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

const media = PULSE.indexOf('@media (prefers-reduced-motion: reduce)');
const MOTION = PULSE.slice(0, media);
const REDUCED = block(PULSE, media);

describe('a Working task glyph breathes', () => {
  it.each(GLYPHS)('$selector pulses its opacity', ({ selector }) => {
    const rule = MOTION.match(/([^{}]+)\{([^{}]*animation:[^{}]*)\}/);
    expect(rule, 'the working rule').toBeTruthy();
    expect(rule![1].split(',').map((s) => s.trim())).toContain(selector);
    const name = rule![2].match(/animation:\s*([\w-]+)[^;]*infinite/)?.[1];
    expect(name).toBe('task-working-pulse');
    const frames = block(PULSE, PULSE.indexOf(`@keyframes ${name}`));
    const props = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(props)).toEqual(new Set(['opacity']));
  });

  it.each(GLYPHS)('$selector is still under reduced motion', ({ selector }) => {
    const rule = REDUCED.match(/\{\s*([^{}]+)\{\s*animation:\s*none;?\s*\}/);
    expect(rule, 'the reduced-motion rule').toBeTruthy();
    expect(rule![1].split(',').map((s) => s.trim())).toContain(selector);
  });

  it.each(GLYPHS)('$selector is a class the app really draws', ({ source, mark }) => {
    expect(read(source)).toMatch(mark);
  });

  it('is loaded with the global styles', () => {
    expect(read('web/src/styles/global-styles.ts')).toMatch(/import '\.\/working-pulse\.css'/);
  });

  it('iOS breathes the same glyphs and holds still under Reduce Motion', () => {
    const pulse = read('ios-native/Walnut/Views/Shared/WorkingPulse.swift');
    expect(pulse).toMatch(/accessibilityReduceMotion/);
    expect(pulse).toMatch(/active && !reduceMotion/);
    expect(read('ios-native/Walnut/Views/Tasks/TeamStatusViews.swift').match(/\.workingPulse\(/g)).toHaveLength(2);
    expect(read('ios-native/Walnut/Views/Tasks/TaskRow.swift')).toMatch(/circle\.lefthalf\.filled"\)\s*\.foregroundStyle\(Theme\.tint\)\s*\.workingPulse\(true\)/);
  });

  it('no other stylesheet animates a working glyph on its own', () => {
    const others: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.css') && e.name !== 'working-pulse.css') others.push(full);
      }
    };
    walk(WEB);
    const hits: string[] = [];
    for (const f of others) {
      const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/animation(?:-name)?\s*:\s*(?!none)/.test(m[2])) continue;
        if (/task-circle-running|org-state-working|session-taskbar-dot|task-working-pulse/.test(m[1])) {
          hits.push(`${path.relative(ROOT, f)}: ${m[1].trim()}`);
        }
      }
    }
    expect(hits, 'animate a working glyph only in working-pulse.css').toEqual([]);
  });
});
