/**
 * Every row kind the session timeline draws has a row in the measuring spec
 * (tests/e2e/browser/step-row-lines.spec.ts), so the one-line-or-two rule is
 * checked on it (2026-11-11, the user: "same for all the tools box"). The kinds
 * come from web/src/components/sessions/step-row-kinds.ts, whose tool and envelope
 * lists are typed over their unions: a new card or envelope kind does not
 * type-check until it is listed there, and this test fails until the spec draws it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_ROW_LINES, ENVELOPE_ROW_LINES, OTHER_ROW_LINES } from '@/components/sessions/step-row-kinds';

const spec = fs.readFileSync(path.join(__dirname, '../e2e/browser/step-row-lines.spec.ts'), 'utf8');
const markers = spec.slice(spec.indexOf('const MARKERS'), spec.indexOf('};', spec.indexOf('const MARKERS')));

describe('step row kinds', () => {
  const kinds = [...Object.keys(TOOL_ROW_LINES), ...Object.keys(ENVELOPE_ROW_LINES), ...Object.keys(OTHER_ROW_LINES)];
  it.each(kinds)('%s has a row in the measuring spec', (kind) => {
    const key = /^[a-z]+$/.test(kind) ? new RegExp(`(^|[\\s,{])${kind}:`) : new RegExp(`'${kind}':`);
    expect(key.test(markers), `MARKERS in step-row-lines.spec.ts has no "${kind}"`).toBe(true);
  });
});
