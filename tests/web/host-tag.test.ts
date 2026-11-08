/**
 * A host's name is never cut in code (2026-11-10 review: the folder picker's host tag read
 * "demo-devbo" for demo-devbox, with no way to read the rest). The tag shows the whole name,
 * CSS ends a name too long for its row with an ellipsis, and the tooltip always names it.
 * The guard scans web/src for any host name or label taken through slice/substring.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hostTagTitle } from '@/components/sessions/path-selector/host-tag';

const WEB = path.resolve(__dirname, '../../web/src');

/** A cap on input, not a display cut, with why. */
const NOT_A_DISPLAY_CUT: Record<string, string> = {
  'popout/ext-panel-model.ts': 'bounds a page host taken from an extension message to 200 characters',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('host names are shown whole', () => {
  it('the tooltip names the host in full, then what its dot says', () => {
    expect(hostTagTitle('demo-devbox')).toBe('demo-devbox');
    expect(hostTagTitle('demo-devbox', 'demo-devbox: Connected')).toBe('demo-devbox: Connected');
    expect(hostTagTitle('demo-devbox', 'Connected')).toBe('demo-devbox: Connected');
    expect(hostTagTitle('demo-devbox', '  ')).toBe('demo-devbox');
  });

  it('no code cuts a host name or label with slice/substring', () => {
    const bad: string[] = [];
    for (const file of sources(WEB)) {
      const rel = path.relative(WEB, file);
      if (NOT_A_DISPLAY_CUT[rel]) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/\b\w*[hH]ost(?:Label|Name|name|Key)?\w*\??\.(?:slice|substring|substr)\(\s*0\s*,/.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, 'show the whole name; let CSS add the ellipsis and put the name in a tooltip').toEqual([]);
  });

  it('the folder row tag shows the whole label, cut only by CSS', () => {
    const list = fs.readFileSync(path.join(WEB, 'components/sessions/path-selector/PathList.tsx'), 'utf8');
    expect(list).toMatch(/className=\{`sps-path-host-tag[\s\S]{0,300}\{hostLabel\}\s*<\/span>/);
    const css = fs.readFileSync(path.join(WEB, 'styles/globals.css'), 'utf8');
    const rule = /\.sps-path-host-tag \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/max-width:\s*16em/);
  });

  it('the guard still sees the exempt input cap', () => {
    for (const rel of Object.keys(NOT_A_DISPLAY_CUT)) expect(fs.existsSync(path.join(WEB, rel)), rel).toBe(true);
  });
});
