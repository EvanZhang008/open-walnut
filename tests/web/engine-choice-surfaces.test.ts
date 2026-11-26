/**
 * Guard: every place outside Settings where a person picks an engine offers the same engines
 * as the model picker's rail: the ones Settings, Sessions turns on (by default the few common
 * ones), plus the one already chosen.
 *
 * Evan, 2026-11-20: the picker shows only the common engines, the others live in Settings. On 2026-11-25 he saw a
 * rail of nine engines ("why so many shit here, I said only these 4"): a proof video's frame,
 * recorded on the browser fixture, which turned every engine on. The class has two halves:
 *   - a surface that lists an engine list as it is (the rail, a project's default engine, the
 *     transfer dialog's harnesses) instead of through `offeredEngines` (web/src/utils/engines.ts);
 *   - the browser fixture turning engines on, so every proof video shows a rail nobody has.
 * The scan finds every file in web/src outside Settings that iterates an engine list, so a new
 * surface fails here until it lists through `offeredEngines` (or `pickerRailEngines`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_PICKER_ENGINES } from '../../src/core/types';
import { offeredEngines, pickerRailEngines, type EngineCatalog, type EngineCatalogEntry } from '../../web/src/utils/engines';

const WEB_SRC = join(__dirname, '../../web/src');

/** Settings is where every engine is listed, on purpose: the place to turn them on. */
const SETTINGS_DIR = 'components/settings/';
/** The helper itself. */
const HELPER = 'utils/engines.ts';

/** A file that iterates an engine list, and names one (so a mail label catalog is not one). */
const ITERATES = /\b(?:catalog|engineCatalog|engines|engineList|SESSION_ENGINE_IDS)\s*\??\.\s*(?:map|filter|flatMap|forEach)\(/;
const NAMES_ENGINES = /\b(?:useEngineCatalog|getEngineCatalog|EngineCatalog|TransferOptions|SESSION_ENGINE_IDS)\b/;
const LISTS_THROUGH = /\b(?:offeredEngines|pickerRailEngines)\(/;

/** The surfaces known today: the scan must keep finding each, so it is never vacuous. */
const KNOWN = [
  'components/sessions/ModelPicker.tsx',
  'components/tasks/ProjectLaunchDefaults.tsx',
  'components/transfer/TransferDialog.tsx',
];

/** A file that iterates an engine list for something other than a choice, and why. */
const NOT_A_CHOICE: Record<string, string> = {};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const sources = files(WEB_SRC).map((f) => ({ rel: relative(WEB_SRC, f), text: readFileSync(f, 'utf8') }));

describe('the picker shows the engines Evan named, and no other by default', () => {
  // Evan, 2026-11-20, named the four the model picker shows by default: Claude Code, Codex,
  // OpenCode and Pi; the rest are turned on in Settings, Sessions. A new engine joins this
  // list only when he names it (2026-11-23 Antigravity joined unasked and he asked why).
  it('is exactly Claude Code, Codex, OpenCode and Pi', () => {
    expect([...DEFAULT_PICKER_ENGINES]).toEqual(['claude', 'codex', 'opencode', 'pi']);
  });
});

describe('every engine choice outside Settings offers the picker engines', () => {
  it('lists engines through offeredEngines', () => {
    const members = sources.filter((s) => !s.rel.startsWith(SETTINGS_DIR) && s.rel !== HELPER
      && (ITERATES.test(s.text) || LISTS_THROUGH.test(s.text)) && NAMES_ENGINES.test(s.text));
    const raw = members.filter((s) => !LISTS_THROUGH.test(s.text) && !NOT_A_CHOICE[s.rel]).map((s) => s.rel);
    expect(raw, 'an engine choice that lists every engine: list it through offeredEngines (web/src/utils/engines.ts), or add it to NOT_A_CHOICE with why').toEqual([]);
    for (const known of KNOWN) expect(members.map((s) => s.rel), `${known} is found by the scan`).toContain(known);
  });

  it('the browser fixture keeps the installed default, so proof videos show the rail a person has', () => {
    const fixture = readFileSync(join(__dirname, '../e2e/browser/test-server.ts'), 'utf8');
    expect(fixture, 'turn an engine on for one page instead (showEnginesInPicker, draft-helpers.ts)').not.toMatch(/picker_engines\s*:/);
  });
});

const entry = (id: string, inPicker?: boolean) => ({ id, inPicker } as EngineCatalogEntry);

describe('offeredEngines', () => {
  const catalog: EngineCatalog = [entry('claude', true), entry('codex', true), entry('gemini', false), entry('goose', false), entry('pi', true)];

  it('keeps the picker engines and the ones already chosen, in the list order', () => {
    expect(offeredEngines(catalog, catalog).map((e) => e.id)).toEqual(['claude', 'codex', 'pi']);
    expect(offeredEngines(catalog, catalog, ['goose', null, undefined]).map((e) => e.id)).toEqual(['claude', 'codex', 'goose', 'pi']);
  });

  it('judges another list by the catalog, and an id the catalog lacks by the default list', () => {
    const harnesses = [{ id: 'gemini' }, { id: 'opencode' }, { id: 'pi' }, { id: 'claude' }];
    expect(offeredEngines(harnesses, catalog).map((e) => e.id)).toEqual(['opencode', 'pi', 'claude']);
  });

  it('an older server (no inPicker) offers the default list', () => {
    const old: EngineCatalog = [entry('claude'), entry('gemini'), entry('opencode'), entry('dsh')];
    expect(offeredEngines(old, old).map((e) => e.id)).toEqual(['claude', 'opencode']);
  });

  it('the rail keeps the engine in use', () => {
    expect(pickerRailEngines(catalog, 'gemini').map((e) => e.id)).toEqual(['claude', 'codex', 'gemini', 'pi']);
  });
});
