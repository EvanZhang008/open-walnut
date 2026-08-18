import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
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
    // qmd moved to optionalDependencies (native-addon install may fail on
    // unsupported platforms; npx install must survive that) — the pin contract
    // holds wherever the dep is declared.
    const declared = packageJson.dependencies?.['@tobilu/qmd']
      ?? packageJson.optionalDependencies?.['@tobilu/qmd'];
    expect(declared).toBe('2.1.0');
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

  it('writes seq=0 last and withholds it after another chunk fails', () => {
    const requiredSnippets = [
      'const failedHashes = new Set();',
      'const chunkOrder = chunks.length > 0',
      '[...chunks.keys()].slice(1).concat(0)',
      'Keep the run incomplete even when expiry lands between batches.',
      'chunk.seq !== 0 || !failedHashes.has(chunk.hash)',
      'failedHashes.add(chunk.hash)',
      'seq=0 is the document completion marker. Its vectors_vec row is inserted first,',
      'Publish the completion row only after its searchable vector exists.',
    ];

    for (const snippet of requiredSnippets) {
      expect(qmdStoreSource).toContain(snippet);
    }

    expect(
      qmdStoreSource.match(
        /chunk\.seq !== 0 \|\| !failedHashes\.has\(chunk\.hash\)/g,
      ),
    ).toHaveLength(2);

    const completionBranch = qmdStoreSource.slice(
      qmdStoreSource.indexOf('if (seq === 0) {'),
      qmdStoreSource.indexOf('else {', qmdStoreSource.indexOf('if (seq === 0) {')),
    );
    expect(completionBranch.indexOf('insertVecStmt.run')).toBeLessThan(
      completionBranch.indexOf('insertContentVectorStmt.run'),
    );
  });
});
