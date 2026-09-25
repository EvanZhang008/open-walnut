/**
 * The launcher's engine row (MetaFooter): Claude and Codex, every engine the
 * user launched before (working-dirs `lastLaunch`) and the current pick stay up
 * front; every other engine waits in More. Catalog order is kept on both sides.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENGINE_CATALOG, splitEngineRow, usedEngineIds, type EngineCatalog, type EngineCatalogEntry,
} from '../../web/src/utils/engines';

function acp(id: string, displayName: string): EngineCatalogEntry {
  return { ...DEFAULT_ENGINE_CATALOG[1], id: id as EngineCatalogEntry['id'], displayName };
}

const CATALOG: EngineCatalog = [
  DEFAULT_ENGINE_CATALOG[0],
  DEFAULT_ENGINE_CATALOG[1],
  acp('gemini', 'Gemini'),
  acp('opencode', 'OpenCode'),
  acp('goose', 'Goose'),
];

const ids = (list: EngineCatalogEntry[]) => list.map((e) => e.id);

describe('usedEngineIds', () => {
  it('reads each remembered launch; no engine means the default one', () => {
    const used = usedEngineIds([
      { lastLaunch: { engine: 'gemini' } },
      { lastLaunch: { model: 'opus' } },
      {},
    ]);
    expect([...used].sort()).toEqual(['claude', 'gemini']);
  });

  it('an empty history uses nothing', () => {
    expect(usedEngineIds([]).size).toBe(0);
  });
});

describe('splitEngineRow', () => {
  it('a fresh user sees Claude and Codex; the rest wait in More', () => {
    const { primary, more } = splitEngineRow(CATALOG, 'claude', new Set());
    expect(ids(primary)).toEqual(['claude', 'codex']);
    expect(ids(more)).toEqual(['gemini', 'opencode', 'goose']);
  });

  it('an engine used before joins the row, in catalog order', () => {
    const { primary, more } = splitEngineRow(CATALOG, 'claude', new Set(['goose']));
    expect(ids(primary)).toEqual(['claude', 'codex', 'goose']);
    expect(ids(more)).toEqual(['gemini', 'opencode']);
  });

  it('the current pick is always up front, even if never used', () => {
    const { primary, more } = splitEngineRow(CATALOG, 'opencode', new Set());
    expect(ids(primary)).toEqual(['claude', 'codex', 'opencode']);
    expect(ids(more)).toEqual(['gemini', 'goose']);
  });

  it('the compiled-in catalog has nothing for More', () => {
    const { primary, more } = splitEngineRow(DEFAULT_ENGINE_CATALOG, 'claude', new Set());
    expect(ids(primary)).toEqual(['claude', 'codex']);
    expect(more).toEqual([]);
  });
});
