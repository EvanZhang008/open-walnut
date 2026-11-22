/**
 * The top of a chat hidden to its one line ("1 thread (1 needs you) · Show") keeps its height under
 * the strip's items: squeezed, it drew over the chat (2026-11-22, the user: "this is fucking
 * flashing, the thread").
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '../../web/src/styles/top-thread.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the hidden top line of a chat', () => {
  it('never shrinks in the top, so it never draws over the chat', () => {
    expect(css).toMatch(/\.session-top\s*>\s*\.top-thread\.is-hidden\s*\{[^}]*flex:\s*none/);
  });
});
