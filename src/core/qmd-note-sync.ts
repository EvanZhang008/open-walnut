import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { QMDStore } from '@tobilu/qmd';
import { NOTES_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { parseFrontmatter } from './parse-frontmatter.js';
import {
  DEFAULT_QMD_MODEL,
  embedQmdStore,
  getNotesStore,
} from './qmd-store.js';
import { pruneStaleQmdDocuments } from './qmd-sync-utils.js';
import type { QmdEmbedProgress } from './qmd-worker-protocol.js';

const COLLECTION = 'vault';

interface SemanticNote {
  relPath: string;
  title: string;
  body: string;
}

function isIndexableRelPath(relPath: string): boolean {
  if (!relPath.endsWith('.md')) return false;
  return !relPath.split('/').some((part) => part.startsWith('.'));
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function firstH1(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

async function readSemanticNote(relPath: string): Promise<SemanticNote | null> {
  const normalized = normalizeRelPath(relPath);
  if (!isIndexableRelPath(normalized)) return null;

  try {
    const raw = await fsp.readFile(path.join(NOTES_DIR, normalized), 'utf-8');
    const parsed = parseFrontmatter(raw);
    const frontmatterTitle =
      typeof parsed.data.title === 'string' ? parsed.data.title.trim() : '';
    return {
      relPath: normalized,
      title: frontmatterTitle || firstH1(parsed.body) || path.basename(normalized, '.md'),
      body: parsed.body,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function upsertNote(
  store: QMDStore,
  note: SemanticNote,
): 'inserted' | 'updated' | 'retitled' | 'unchanged' {
  const hash = contentHash(note.body);
  const existing = store.internal.findActiveDocument(COLLECTION, note.relPath);
  const now = new Date().toISOString();
  if (existing && existing.hash === hash) {
    if (existing.title !== note.title) {
      store.internal.updateDocumentTitle(existing.id, note.title, now);
      return 'retitled';
    }
    return 'unchanged';
  }

  store.internal.insertContent(hash, note.body, now);
  if (existing) {
    store.internal.updateDocument(existing.id, note.title, hash, now);
    return 'updated';
  }
  store.internal.insertDocument(
    COLLECTION,
    note.relPath,
    note.title,
    hash,
    now,
    now,
  );
  return 'inserted';
}

async function collectNotePaths(): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A file or directory can disappear while a recursive scan is in
      // progress. Other failures do not prove the source is empty and must not
      // trigger stale-document pruning.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.name.endsWith('.md')) {
        result.push(normalizeRelPath(path.relative(NOTES_DIR, absolute)));
      }
    }
  }

  await walk(NOTES_DIR);
  return result;
}

export async function syncQmdNotePaths(
  relPaths: readonly string[],
  options: { onProgress?: (progress: QmdEmbedProgress) => void } = {},
): Promise<void> {
  if (relPaths.length === 0) return;

  const store = await getNotesStore();
  let changed = 0;
  let retitled = 0;
  let removed = 0;
  for (const rawPath of new Set(relPaths.map(normalizeRelPath))) {
    if (!isIndexableRelPath(rawPath)) continue;
    const note = await readSemanticNote(rawPath);
    if (!note) {
      store.internal.deactivateDocument(COLLECTION, rawPath);
      removed++;
      continue;
    }
    const result = upsertNote(store, note);
    if (result === 'retitled') retitled++;
    else if (result !== 'unchanged') changed++;
  }

  if (changed > 0) {
    await embedQmdStore(store, 'notes', {
      model: process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL,
      onProgress: options.onProgress,
    });
  }
  log.memory.info('QMD note incremental sync complete', {
    changed,
    retitled,
    removed,
    requested: relPaths.length,
  });
}

export async function syncAllQmdNotes(
  options: {
    force?: boolean;
    onProgress?: (progress: QmdEmbedProgress) => void;
  } = {},
): Promise<void> {
  const paths = await collectNotePaths();
  const store = await getNotesStore();
  let inserted = 0;
  let updated = 0;
  let retitled = 0;
  let unchanged = 0;

  for (const relPath of paths) {
    const note = await readSemanticNote(relPath);
    if (!note) continue;
    const result = upsertNote(store, note);
    if (result === 'inserted') inserted++;
    else if (result === 'updated') updated++;
    else if (result === 'retitled') retitled++;
    else unchanged++;
  }

  const pruned = pruneStaleQmdDocuments(store, COLLECTION, new Set(paths));
  const legacyPruned = pruneLegacyCollections(store);
  await embedQmdStore(store, 'notes', {
    ...(options.force ? { force: true } : {}),
    model: process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL,
    onProgress: options.onProgress,
  });
  log.memory.info('QMD note full sync complete', {
    inserted,
    updated,
    retitled,
    unchanged,
    pruned,
    legacyPruned,
  });
}

/**
 * Deactivate documents in collections OTHER than `vault`. Earlier index layouts
 * stored notes in per-PARA-folder collections (areas/archive/projects/resources);
 * those docs were left active after the vault-collection migration. They compete
 * in RRF top-k ranking and are only post-filtered afterward (memory-search.ts
 * filters on collection AFTER the store query), so every legacy hit crowds a
 * real result out of the fused window — recall loss, plus stale duplicates.
 *
 * Enumerates DISTINCT collection names from the documents table directly: the
 * legacy collections are exactly the ones no longer REGISTERED in
 * store_collections, so the registration-based listing APIs cannot see them.
 */
function pruneLegacyCollections(store: QMDStore): number {
  let deactivated = 0;
  try {
    const rows = store.internal.db
      .prepare(`SELECT DISTINCT collection FROM documents WHERE active = 1 AND collection != ?`)
      .all(COLLECTION) as Array<{ collection: string }>;
    for (const row of rows) {
      for (const stalePath of store.internal.getActiveDocumentPaths(row.collection)) {
        store.internal.deactivateDocument(row.collection, stalePath);
        deactivated++;
      }
    }
  } catch (error) {
    log.memory.warn('QMD legacy collection prune failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return deactivated;
}
