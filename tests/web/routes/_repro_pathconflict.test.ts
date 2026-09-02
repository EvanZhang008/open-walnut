import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('notes-pathconflict'));
// Structural reconcile only: keep the search index (better-sqlite3 + sweep)
// out of this repro.
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => false,
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}));
import { WALNUT_HOME } from '../../../src/constants.js';
import { closeNotesIndexDb, listNotes, getNoteByPath } from '../../../src/core/notes-index.js';
import { reconcileNoteNow } from '../../../src/core/notes-indexer.js';
const NOTES_DIR = path.join(WALNUT_HOME, 'notes');
async function w(rel: string, c: string){ const f=path.join(NOTES_DIR,rel); await fs.mkdir(path.dirname(f),{recursive:true}); await fs.writeFile(f,c,'utf-8'); }
beforeEach(async()=>{ closeNotesIndexDb(); await fs.rm(WALNUT_HOME,{recursive:true,force:true}); await fs.mkdir(NOTES_DIR,{recursive:true}); });
afterEach(async()=>{ closeNotesIndexDb(); await fs.rm(WALNUT_HOME,{recursive:true,force:true}); });
describe('path-conflict repro', () => {
  it('two ids contending for the same path does not throw / does not drop the note', async () => {
    await w('b.md', '---\nid: n_B\n---\n# B');
    await reconcileNoteNow('b.md');
    expect(getNoteByPath('b.md')?.id).toBe('n_B');
    await w('b.md', '---\nid: n_A\n---\n# A now');
    await reconcileNoteNow('b.md');
    const row = getNoteByPath('b.md');
    expect(row).toBeDefined();
    expect(row?.id).toBe('n_A');
    expect(listNotes().filter(n=>n.path==='b.md')).toHaveLength(1);
  });
});
