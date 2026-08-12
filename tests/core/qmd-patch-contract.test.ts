import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { optionalDependencies: Record<string, string> };
const qmdPackage = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'node_modules/@tobilu/qmd/package.json'),
    'utf8',
  ),
) as { version: string };
const qmdStoreSource = fs.readFileSync(
  path.join(repoRoot, 'node_modules/@tobilu/qmd/dist/store.js'),
  'utf8',
);

describe('QMD postinstall patch contract', () => {
  it('pins the exact dependency version supported by the patch', () => {
    expect(packageJson.optionalDependencies['@tobilu/qmd']).toBe('2.1.0');
    expect(qmdPackage.version).toBe('2.1.0');
  });

  it('keeps depth-40 candidates and dotted-token matching installed', () => {
    const requiredSnippets = [
      'store.searchFTS(query, candidateLimit, collection)',
      'store.searchFTS(q.query, candidateLimit, collection)',
      'store.searchVec(vecQueries[i].text, DEFAULT_EMBED_MODEL, candidateLimit, collection',
      'store.searchFTS(search.query, candidateLimit, coll)',
      'store.searchVec(vecSearches[i].query, DEFAULT_EMBED_MODEL, candidateLimit, coll',
      'Handle dotted version tokens:',
      "term.split('.').map",
    ];

    for (const snippet of requiredSnippets) {
      expect(qmdStoreSource).toContain(snippet);
    }
  });
});
