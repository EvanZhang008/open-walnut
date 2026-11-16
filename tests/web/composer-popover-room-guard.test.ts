/**
 * Every popover that opens upward from the composer (`position: absolute; bottom: 100%`) stops
 * at the window's top: its height is capped by --composer-popover-room, which ChatInput writes
 * while one is open (web/src/hooks/useRoomAbove.ts). 2026-11-16: with the session note band
 * inside the composer card, the @ palette on a 480px window ran 36px past the top, its source
 * tabs out of reach (composer-in-flow.spec.ts, "inside the header band the popup is on top").
 *
 * The members are found, not listed: a class rendered by ChatInput or a component it imports
 * from its own folder, whose CSS rule opens it upward. A new one fails here until it uses the room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const CHAT = path.join(ROOT, 'web/src/components/chat');
const STYLES = path.join(ROOT, 'web/src/styles');

function composerClasses(): Set<string> {
  const input = fs.readFileSync(path.join(CHAT, 'ChatInput.tsx'), 'utf8');
  const files = ['ChatInput.tsx', ...[...input.matchAll(/from '\.\/([^']+)'/g)].map((m) => `${m[1]}.tsx`)]
    .filter((f) => fs.existsSync(path.join(CHAT, f)));
  const classes = new Set<string>();
  for (const f of files) for (const m of fs.readFileSync(path.join(CHAT, f), 'utf8').matchAll(/className=\{?[`'"]([a-z0-9-]+)/g)) classes.add(m[1]!);
  return classes;
}

/** Single-class rules that open their element upward from its anchor. */
function upwardRules(css: string): Array<{ cls: string; body: string }> {
  return [...css.matchAll(/(?:^|\n)\.([a-z0-9-]+)\s*\{([^}]*)\}/g)]
    .filter((m) => /position:\s*absolute/.test(m[2]!) && /bottom:\s*100%/.test(m[2]!))
    .map((m) => ({ cls: m[1]!, body: m[2]! }));
}

describe('popovers above the composer stop at the window top', () => {
  it('every one caps its height with --composer-popover-room', () => {
    const classes = composerClasses();
    const found: string[] = [];
    const missing: string[] = [];
    for (const f of fs.readdirSync(STYLES).filter((n) => n.endsWith('.css'))) {
      for (const r of upwardRules(fs.readFileSync(path.join(STYLES, f), 'utf8'))) {
        if (!classes.has(r.cls)) continue;
        found.push(r.cls);
        if (!/max-height:[^;]*var\(--composer-popover-room/.test(r.body)) missing.push(`${f} .${r.cls}`);
      }
    }
    expect(found.sort(), 'the scan still finds the composer popovers').toEqual(expect.arrayContaining(['command-palette-wrap', 'file-mention-popup', 'mention-palette']));
    expect(missing).toEqual([]);
  });

  it('ChatInput writes the room while a popover is open', () => {
    const input = fs.readFileSync(path.join(CHAT, 'ChatInput.tsx'), 'utf8');
    expect(input).toMatch(/useRoomAbove\(containerRef, paletteOpen \|\| mentionOpen\)/);
  });

  it('the scan catches the shape it was written for', () => {
    const rules = upwardRules('.x-pop {\n  position: absolute;\n  bottom: 100%;\n  max-height: 60vh;\n}\n.y-pop { position: absolute; top: 100%; }');
    expect(rules.map((r) => r.cls)).toEqual(['x-pop']);
    expect(/max-height:[^;]*var\(--composer-popover-room/.test(rules[0]!.body)).toBe(false);
  });
});
