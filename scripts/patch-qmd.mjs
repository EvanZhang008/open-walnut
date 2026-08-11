#!/usr/bin/env node
/**
 * Post-install patch for @tobilu/qmd@2.1.0 — fixes two search-recall issues:
 *
 * 1. Hardcoded per-sub-search limit of 20 in hybridQuery() and structuredSearch()
 *    prevents documents ranked 21-40 from entering the RRF fusion pool. Replaced
 *    with candidateLimit (default RERANK_CANDIDATE_LIMIT = 40).
 *
 * 2. Dotted version tokens (e.g., "4.7", "v2.0.1") in buildFTS5Query() — the dot
 *    is stripped by sanitizeFTS5Term, collapsing "4.7" into "47" which never
 *    matches the FTS5 tokens "4" and "7". Added a dotted-token handler that
 *    splits on dots and creates a phrase query, matching the hyphenated-token pattern.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// QMD may be in root and/or web node_modules — patch all copies found.
const locations = [
  resolve(__dirname, '../node_modules/@tobilu/qmd'),
  resolve(__dirname, '../web/node_modules/@tobilu/qmd'),
];

// Published-package installs hoist qmd to a PARENT node_modules where neither
// hardcoded path exists — add wherever Node actually resolves it from. The
// package exports map blocks './package.json', so resolve the main entry
// (dist/index.js) and walk up to the package root.
try {
  const require_ = createRequire(import.meta.url);
  let dir = dirname(require_.resolve('@tobilu/qmd'));
  while (dir !== dirname(dir) && !existsSync(resolve(dir, 'package.json'))) dir = dirname(dir);
  if (!locations.includes(dir)) locations.push(dir);
} catch { /* not installed at all — the loop below reports it */ }

let anyVerified = false;

for (const qmdDir of locations) {
  const storeFile = resolve(qmdDir, 'dist/store.js');
  if (!existsSync(storeFile)) continue;

  // ── Version guard ──
  const pkgFile = resolve(qmdDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    throw new Error(`patch-qmd: could not read ${pkgFile}: ${error}`);
  }
  if (pkg.version !== '2.1.0') {
    throw new Error(
      `patch-qmd: expected @tobilu/qmd@2.1.0 but found @${pkg.version} at ${qmdDir}`,
    );
  }

  const originalSrc = readFileSync(storeFile, 'utf8');
  let src = originalSrc;
  let applied = 0;
  const expected = 6;

  // ── Fix 1: Replace hardcoded limit 20 with candidateLimit ──

  // hybridQuery: initial FTS probe
  const hq1 = 'const initialFts = store.searchFTS(query, 20, collection);';
  if (src.includes(hq1)) {
    src = src.replace(hq1, 'const initialFts = store.searchFTS(query, candidateLimit, collection);');
    applied++;
  }

  // hybridQuery: expanded lex FTS
  const hq2_old = 'const ftsResults = store.searchFTS(q.query, 20, collection);';
  if (src.includes(hq2_old)) {
    src = src.replace(hq2_old, 'const ftsResults = store.searchFTS(q.query, candidateLimit, collection);');
    applied++;
  }

  // hybridQuery: vec search
  const hq3_old = 'const vecResults = await store.searchVec(vecQueries[i].text, DEFAULT_EMBED_MODEL, 20, collection, undefined, embedding);';
  if (src.includes(hq3_old)) {
    src = src.replace(hq3_old,
      'const vecResults = await store.searchVec(vecQueries[i].text, DEFAULT_EMBED_MODEL, candidateLimit, collection, undefined, embedding);');
    applied++;
  }

  // structuredSearch: lex FTS (with coll parameter)
  const ss1_old = 'const ftsResults = store.searchFTS(search.query, 20, coll);';
  if (src.includes(ss1_old)) {
    src = src.replace(ss1_old, 'const ftsResults = store.searchFTS(search.query, candidateLimit, coll);');
    applied++;
  }

  // structuredSearch: vec search (with coll parameter)
  const ss2_old = 'const vecResults = await store.searchVec(vecSearches[i].query, DEFAULT_EMBED_MODEL, 20, coll, undefined, embedding);';
  if (src.includes(ss2_old)) {
    src = src.replace(ss2_old,
      'const vecResults = await store.searchVec(vecSearches[i].query, DEFAULT_EMBED_MODEL, candidateLimit, coll, undefined, embedding);');
    applied++;
  }

  // ── Fix 2: Handle dotted version tokens in buildFTS5Query ──

  const dottedInsertion = `            else if (/^[\\p{L}\\p{N}][\\p{L}\\p{N}.]*\\.[\\p{L}\\p{N}][\\p{L}\\p{N}.]*$/u.test(term)) {
                const sanitized = term.split('.').map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
                if (sanitized) {
                    const ftsPhrase = \`"\${sanitized}"\`; // Phrase match
                    if (negated) {
                        negative.push(ftsPhrase);
                    }
                    else {
                        positive.push(ftsPhrase);
                    }
                }
            }`;

  // Find the closing brace of the hyphenated-token block and insert after it
  const hyphenatedClose = `                }
            }
            else {
                const sanitized = sanitizeFTS5Term(term);`;

  // Idempotency: check for the actual injected regex code, not a comment string
  if (src.includes(hyphenatedClose) && !src.includes('else if (/^[\\p{L}\\p{N}]')) {
    src = src.replace(
      hyphenatedClose,
      `                }
            }
            // Handle dotted version tokens: 4.7, v2.0.1, 3.14
            // FTS5 tokenizer splits on dots, so "4.7" becomes tokens "4","7".
            // Without this, sanitizeFTS5Term strips the dot \u2192 "47" which never matches.
${dottedInsertion}
            else {
                const sanitized = sanitizeFTS5Term(term);`
    );
    applied++;
  }

  const requiredSnippets = [
    'store.searchFTS(query, candidateLimit, collection)',
    'store.searchFTS(q.query, candidateLimit, collection)',
    'store.searchVec(vecQueries[i].text, DEFAULT_EMBED_MODEL, candidateLimit, collection',
    'store.searchFTS(search.query, candidateLimit, coll)',
    'store.searchVec(vecSearches[i].query, DEFAULT_EMBED_MODEL, candidateLimit, coll',
    'Handle dotted version tokens:',
    "term.split('.').map",
  ];
  const missing = requiredSnippets.filter((snippet) => !src.includes(snippet));
  if (missing.length > 0) {
    throw new Error(
      `patch-qmd: patch contract incomplete at ${qmdDir} `
      + `(${applied}/${expected} replacements applied); missing: ${missing.join(', ')}`,
    );
  }

  if (src !== originalSrc) {
    writeFileSync(storeFile, src, 'utf8');
    console.log(`patch-qmd: patched ${storeFile} \u2714`);
  } else {
    console.log(`patch-qmd: ${storeFile} \u2014 patch contract verified`);
  }
  anyVerified = true;
}

if (!anyVerified) {
  // Check if we found any QMD at all
  const found = locations.some(d => existsSync(resolve(d, 'dist/store.js')));
  if (!found) {
    console.log('patch-qmd: @tobilu/qmd not installed, skipping');
  }
}
