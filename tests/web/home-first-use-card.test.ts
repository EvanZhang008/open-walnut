/**
 * The welcome card is on Home whatever the user opens or closes (home-first-use-card.ts;
 * 2026-11-11 review F4: the rail's Ask Walnut toggle closed the slot the card lived in and left
 * an empty white page).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { firstUseCardPlace } from '@/pages/home-first-use-card';

describe('where Home shows the welcome card', () => {
  it('leads the Ask slot while it is open, and moves to the task panel when it closes', () => {
    expect(firstUseCardPlace(true, true, false)).toBe('slot');
    expect(firstUseCardPlace(true, true, true)).toBe('slot');
    expect(firstUseCardPlace(true, false, true)).toBe('tasks');
  });

  it('shows nowhere once setup is done, or when neither place is on screen', () => {
    expect(firstUseCardPlace(false, true, true)).toBeNull();
    expect(firstUseCardPlace(false, false, true)).toBeNull();
    expect(firstUseCardPlace(true, false, false)).toBeNull();
  });

  it('guard: MainPage renders the card only through the rule, in both places', () => {
    const main = fs.readFileSync(path.join(__dirname, '../../web/src/pages/MainPage.tsx'), 'utf8');
    const renders = main.split('\n').filter((l) => l.includes('<FirstUseSetup '));
    expect(renders).toHaveLength(2);
    expect(renders.some((l) => l.includes("welcomeIn === 'tasks'"))).toBe(true);
    expect(renders.some((l) => l.includes("welcomeIn === 'slot'"))).toBe(true);
    expect(main).toMatch(/const welcomeIn = firstUseCardPlace\(needsFirstSetup, chatVisible, todoShown\);/);
  });
});
