import type { QMDStore } from '@tobilu/qmd';

export interface QmdPruneStats {
  deactivated: number;
}

export interface QmdOrphanCleanupStats {
  deletedDocuments: number;
  deletedContent: number;
  deletedVectors: number;
}

/**
 * Physically remove data no active document references.
 *
 * This can execute a multi-minute synchronous sqlite-vec DELETE. It must only
 * run in the dedicated QMD worker process, never in the web server.
 */
export function cleanupOrphanedQmdData(store: QMDStore): QmdOrphanCleanupStats {
  if (process.env.WALNUT_QMD_WORKER !== '1') {
    throw new Error('Physical QMD cleanup is restricted to the QMD worker process');
  }
  // Vector search probes the virtual table before joining active documents.
  // Remove stale vectors first so they cannot crowd valid hits out of top-k.
  const deletedVectors = store.internal.cleanupOrphanedVectors();
  const deletedDocuments = store.internal.deleteInactiveDocuments();
  const deletedContent = store.internal.cleanupOrphanedContent();
  return { deletedDocuments, deletedContent, deletedVectors };
}

/**
 * Reconcile a collection with its source of truth by deactivating stale paths.
 *
 * Physical deletion is deliberately separate: better-sqlite3 and sqlite-vec
 * are synchronous, so deleting vectors here would freeze the HTTP event loop.
 * Search queries already join against active documents, making deactivation
 * the correct immediate consistency boundary.
 */
export function pruneStaleQmdDocuments(
  store: QMDStore,
  collection: string,
  expectedPaths: ReadonlySet<string>,
): QmdPruneStats {
  let deactivated = 0;
  for (const path of store.internal.getActiveDocumentPaths(collection)) {
    if (expectedPaths.has(path)) continue;
    store.internal.deactivateDocument(collection, path);
    deactivated++;
  }

  return { deactivated };
}
