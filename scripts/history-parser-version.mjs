#!/usr/bin/env bun
/**
 * The version of what a ready view holds (src/core/history-parser-version.ts).
 *
 * A host's daemon parses its own transcripts for the first paint (history-ready-core.ts) with
 * the parser it was built with, and a daemon update can wait hours. The server keeps such a view
 * only when the daemon's parser is the server's own, so the version is a hash of the source of
 * everything that decides a view's rows: the runtime import closure of the parser
 * (src/core/history-parse.ts) and of the ready-view builder (src/providers/history-ready-core.ts).
 * Modules that only find files (LOCATE_ONLY) are not followed: they change no row.
 *
 *   bun scripts/history-parser-version.mjs          print the hash and the files
 *   bun scripts/history-parser-version.mjs --write  write it into the version file
 *   bun scripts/history-parser-version.mjs --check  exit 1 when the file is stale
 *
 * tests/core/history-parser-version-ratchet.test.ts runs the check.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION_FILE = 'src/core/history-parser-version.ts';
export const ROOTS = ['src/core/history-parse.ts', 'src/providers/history-ready-core.ts'];
/** Path helpers: they decide where a transcript is, never what its rows are. */
export const LOCATE_ONLY = new Set([
  'src/providers/session-changes-core.ts',
  'src/providers/transcript-archive.ts',
  'src/core/bash-file-ops.ts',
]);

const IMPORT_RE = /^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"](\.[^'"]+)['"]/gm;

/** Every repo file the roots load at run time (type-only imports are not followed). */
export function parserClosure(root = ROOT) {
  const seen = new Set();
  const todo = [...ROOTS];
  while (todo.length > 0) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      if (m[2]) continue;
      let next = path.posix.join(path.posix.dirname(rel), m[3]).replace(/\.js$/, '.ts');
      if (!fs.existsSync(path.join(root, next)) && fs.existsSync(path.join(root, next.replace(/\.ts$/, '/index.ts')))) {
        next = next.replace(/\.ts$/, '/index.ts');
      }
      if (next === VERSION_FILE || LOCATE_ONLY.has(next)) continue;
      if (!fs.existsSync(path.join(root, next))) throw new Error(`${rel}: cannot find ${m[3]}`);
      todo.push(next);
    }
  }
  return [...seen].sort();
}

/** The hash of those files: their paths and bytes, in path order, 16 hex characters. */
export function parserVersion(root = ROOT) {
  const h = createHash('sha256');
  for (const rel of parserClosure(root)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function versionFileText(version) {
  return `/**
 * The version of the parse a ready view holds: a hash of the parser's and the ready-view
 * builder's source (scripts/history-parser-version.mjs, which writes this file). A host's
 * daemon answers it with every ready view, and the server keeps a view only when it is its own
 * (history-ready-view.ts), so a daemon on an older parser never paints this server's history.
 * Generated: run \`bun scripts/history-parser-version.mjs --write\` after editing a file it lists.
 */
export const HISTORY_PARSER_VERSION = '${version}';
`;
}

/** The version the file holds now, or null. */
export function writtenVersion(root = ROOT) {
  try {
    return /HISTORY_PARSER_VERSION = '([0-9a-f]+)'/.exec(fs.readFileSync(path.join(root, VERSION_FILE), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = parserVersion();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(ROOT, VERSION_FILE), versionFileText(version));
    console.log(`${VERSION_FILE}: ${version}`);
  } else if (process.argv.includes('--check')) {
    const written = writtenVersion();
    if (written !== version) {
      console.error(`${VERSION_FILE} says ${written}, the source hashes to ${version}: run bun scripts/history-parser-version.mjs --write`);
      process.exit(1);
    }
  } else {
    console.log(version);
    for (const f of parserClosure()) console.log(`  ${f}`);
  }
}
