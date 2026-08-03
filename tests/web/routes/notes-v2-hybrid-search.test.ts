/**
 * HYBRID SEARCH + INDEX/IDENTITY coverage (IMPL-CONTRACT §1.2 #8, §7.1).
 *
 * The sibling `notes-v2.test.ts` stubs `memoryNotesSearch → []`, so it exercises
 * ONLY the structural (string) leg. This file drives the SEMANTIC leg with
 * controlled hits so the parts that are otherwise untested get asserted:
 *   - dedupe-by-id → exactly ONE row when a note is hit by BOTH legs
 *     (`matchType: 'both'`), proving `idFromQmdPath` maps the semantic leg's
 *     ABSOLUTE filepath back to the note's id (the "double-lists every both-leg
 *     note" trap).
 *   - FROZEN ranking: an exact/both hit is NEVER ordered below a purely-semantic
 *     hit, even when the semantic hit's raw score is higher.
 *   - a purely-semantic hit surfaces as `matchType: 'semantic'`.
 *   - graceful degradation: when the semantic leg rejects, string results still
 *     return and the payload carries `degraded: 'semantic-unavailable'`.
 *   - index rebuild reproduces state from disk (the rebuildable-sidecar invariant).
 *
 * The string leg stays REAL (reads the structural sidecar), so the both-leg
 * dedupe is genuine. Only the Claude-adjacent embedding engine is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-v2-hybrid-test'));

// A per-test controllable semantic leg. Each test sets `semanticHits` to the
// MemorySearchResult[] the QMD engine should "return" (or makes the mock throw
// to simulate an unavailable engine). filepath MUST be ABSOLUTE (that is what
// the real memoryNotesSearch emits; the route remaps it via idFromQmdPath).
let semanticHits: any[] = [];
let semanticThrows = false;
vi.mock('../../../src/core/memory-search.js', () => ({
  memoryNotesSearch: vi.fn(async () => {
    if (semanticThrows) throw new Error('embedding engine unavailable');
    return semanticHits;
  }),
}));

// Stub the QMD store so reconcile never opens a real notes-search.sqlite / loads
// an embedding model (same rationale as the sibling route test).
vi.mock('../../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  embedQmdStore: vi.fn(async (
    store: { embed: (options: unknown) => Promise<unknown> },
    _label: string,
    options: unknown,
  ) => store.embed(options)),
  getNotesStore: vi.fn(async () => ({
    internal: {
      findActiveDocument: () => undefined,
      insertContent: () => {},
      insertDocument: () => {},
      updateDocumentTitle: () => {},
      updateDocument: () => {},
      deactivateDocument: () => {},
      getActiveDocumentPaths: () => [],
      cleanupOrphanedVectors: () => 0,
      deleteInactiveDocuments: () => 0,
      cleanupOrphanedContent: () => 0,
    },
    embed: async () => {},
    getStatus: async () => ({ needsEmbedding: 0 }),
  })),
}));

import express from 'express';
import request from 'supertest';
import { notesV2Router, resetIndexBootstrap } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { closeNotesIndexDb, getNoteIdByPath } from '../../../src/core/notes-index.js';
import { rebuildIndex, stopNotesIndexer, resetNotesIndexer, scanForDrift } from '../../../src/core/notes-indexer.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

async function writeNote(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Absolute vault path for a relpath — the form the semantic leg emits. */
function absInVault(relPath: string): string {
  return path.join(NOTES_DIR, relPath);
}

/** Build a MemorySearchResult-shaped semantic hit. */
function semanticHit(relPath: string, score: number, title = '', snippet = 'semantic excerpt') {
  return {
    filepath: absInVault(relPath),
    title,
    snippet,
    score,
    finalScore: score,
    source: 'note_vault',
    collection: 'vault',
  };
}

async function syncIndex(): Promise<void> {
  await rebuildIndex();
}

async function quiesceIndex(): Promise<void> {
  resetIndexBootstrap();
  stopNotesIndexer();
  await new Promise((r) => setTimeout(r, 5));
  closeNotesIndexDb();
}

beforeEach(async () => {
  semanticHits = [];
  semanticThrows = false;
  await quiesceIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
  resetNotesIndexer();
});

afterEach(async () => {
  await quiesceIndex();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── Dedupe by id + matchType labeling ──────────────────────────────────────

describe('hybrid search: dedupe-by-id + labels', () => {
  it('a note hit by BOTH legs collapses to ONE row labeled "both"', async () => {
    await writeNote('apollo.md', '# Apollo\n\nLaunch sequence and rocket fuel.');
    await writeNote('other.md', '# Other\n\nUnrelated content.');
    await syncIndex();

    // Semantic leg also returns apollo.md (by ABSOLUTE path) → must merge to one
    // row keyed on apollo's id, NOT double-list.
    semanticHits = [semanticHit('apollo.md', 0.9, 'Apollo')];

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=launch');

    expect(res.status).toBe(200);
    const apolloRows = res.body.results.filter((r: any) => r.path === 'apollo.md');
    expect(apolloRows).toHaveLength(1); // deduped — the whole point
    expect(apolloRows[0].matchType).toBe('both');
    // Both transparency scores present on a both-leg hit.
    expect(apolloRows[0].semanticScore).toBeCloseTo(0.9);
    expect(apolloRows[0].stringScore).toBeGreaterThan(0);
  });

  it('a note hit ONLY by the semantic leg surfaces as matchType "semantic"', async () => {
    // "synergy" does NOT appear in the body, so the string leg misses it; only
    // the semantic leg returns it.
    await writeNote('vision.md', '# Vision\n\nWe align teams toward shared outcomes.');
    await syncIndex();
    semanticHits = [semanticHit('vision.md', 0.8, 'Vision')];

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=synergy');

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === 'vision.md');
    expect(row).toBeDefined();
    expect(row.matchType).toBe('semantic');
    expect(row.id).toBe(getNoteIdByPath('vision.md'));
  });

  it('a note hit ONLY by the string leg surfaces as matchType "exact"', async () => {
    await writeNote('recipe.md', '# Chocolate Cake\n\nMix flour and cocoa.');
    await syncIndex();
    semanticHits = []; // semantic finds nothing

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=chocolate');

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === 'recipe.md');
    expect(row.matchType).toBe('exact');
    expect(row.snippet.toLowerCase()).toContain('<mark>chocolate</mark>');
  });
});

// ─── FROZEN ranking: exact/both NEVER below purely-semantic ──────────────────

describe('hybrid search: exact-never-below-semantic ranking', () => {
  it('an exact-only hit ranks above a higher-scored purely-semantic hit', async () => {
    // exactNote matches the query string (exact leg). semanticOnly does NOT
    // contain the query, but the (mocked) semantic engine scores it very high.
    await writeNote('exact-note.md', '# Budget\n\nThe quarterly budget figures.');
    await writeNote('semantic-only.md', '# Finance\n\nRevenue projections and forecasts.');
    await syncIndex();

    // semantic-only gets a near-perfect score; exact-note is not in the semantic
    // list at all. The frozen tiering must STILL place exact-note first.
    semanticHits = [semanticHit('semantic-only.md', 0.99, 'Finance')];

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=budget');

    expect(res.status).toBe(200);
    const order = res.body.results.map((r: any) => r.path);
    const iExact = order.indexOf('exact-note.md');
    const iSemantic = order.indexOf('semantic-only.md');
    expect(iExact).toBeGreaterThanOrEqual(0);
    expect(iSemantic).toBeGreaterThanOrEqual(0);
    expect(iExact).toBeLessThan(iSemantic); // exact never buried below semantic

    // And the labels are right.
    expect(res.body.results[iExact].matchType).toBe('exact');
    expect(res.body.results[iSemantic].matchType).toBe('semantic');
  });

  it('a "both" hit also ranks above a purely-semantic hit', async () => {
    await writeNote('apollo.md', '# Apollo\n\nLaunch readiness review.');
    await writeNote('semantic-only.md', '# Gemini\n\nCrew rotation notes.');
    await syncIndex();

    semanticHits = [
      semanticHit('apollo.md', 0.5, 'Apollo'),         // both (string also matches "launch")
      semanticHit('semantic-only.md', 0.95, 'Gemini'), // semantic only, higher raw score
    ];

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=launch');

    expect(res.status).toBe(200);
    const order = res.body.results.map((r: any) => r.path);
    expect(order.indexOf('apollo.md')).toBeLessThan(order.indexOf('semantic-only.md'));
    expect(res.body.results[order.indexOf('apollo.md')].matchType).toBe('both');
  });
});

// ─── Semantic-path normalization (the double-list trap) ──────────────────────

describe('hybrid search: semantic filepath → id normalization', () => {
  it('maps a SUBFOLDER absolute filepath back to the indexed id (no double-list)', async () => {
    await writeNote('projects/apollo.md', '# Apollo\n\nDeep in a folder, launch plan.');
    await syncIndex();
    const id = getNoteIdByPath('projects/apollo.md');
    expect(id).toMatch(/^n_/);

    // Semantic leg returns the absolute path to the subfolder note.
    semanticHits = [semanticHit('projects/apollo.md', 0.7, 'Apollo')];

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=launch');

    expect(res.status).toBe(200);
    const rows = res.body.results.filter((r: any) => r.path === 'projects/apollo.md');
    expect(rows).toHaveLength(1);          // not double-listed
    expect(rows[0].id).toBe(id);           // keyed on the real frontmatter id
    expect(rows[0].matchType).toBe('both');
  });
});

// ─── Folder-name recall (the "search can't find my notes" bug) ───────────────

describe('search: folder-name matching', () => {
  it('a query matching a FOLDER name returns that folder\'s notes + a folder row', async () => {
    // The reported symptom: journal entries live in `Areas/Journal/Dairy/` and are
    // TITLED BY DATE, so neither their title nor body ever says "dairy". Before the
    // folder leg existed, searching "dairy" returned none of them.
    await writeNote('Areas/Journal/Dairy/2026-04-03.md', '# 2026-04-03\n\nWoke up early.');
    await writeNote('Areas/Journal/Dairy/2026-04-13.md', '# 2026-04-13\n\nWent for a run.');
    await writeNote('unrelated.md', '# Unrelated\n\nNothing to do with it.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=dairy&mode=string');

    expect(res.status).toBe(200);
    const paths = res.body.results.map((r: any) => r.path);
    expect(paths).toContain('Areas/Journal/Dairy/2026-04-03.md');
    expect(paths).toContain('Areas/Journal/Dairy/2026-04-13.md');
    expect(paths).not.toContain('unrelated.md');

    // The folder itself is surfaced as its own row, with a TRUE recursive count.
    expect(res.body.folders).toEqual([
      { path: 'Areas/Journal/Dairy', name: 'Dairy', noteCount: 2 },
    ]);
  });

  it('a real TITLE match still outranks notes that merely live in the folder', async () => {
    await writeNote('Journal.md', '# Journal\n\nThe note actually called Journal.');
    await writeNote('Areas/Journal/2026-01-01.md', '# 2026-01-01\n\nA dated entry.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=journal&mode=string');

    expect(res.status).toBe(200);
    // Folder band (0.86–0.89) sits strictly below every title band (≥0.90).
    expect(res.body.results[0].path).toBe('Journal.md');
    const folderHit = res.body.results.find((r: any) => r.path === 'Areas/Journal/2026-01-01.md');
    expect(folderHit.stringScore).toBeLessThan(res.body.results[0].stringScore);
  });

  it('matches on path SEGMENTS only — a filename substring is not a folder hit', async () => {
    // 'diary' appears in the FILENAME, never as a directory. It must not produce a
    // folder row (that would invent folders out of arbitrary path substrings).
    await writeNote('Areas/my-diary-notes.md', '# Some Note\n\nBody text.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=diary&mode=string');

    expect(res.status).toBe(200);
    expect(res.body.folders).toBeUndefined();
  });

  it('caps folder-ONLY rows so a huge folder cannot flood the list', async () => {
    // 20 date-titled notes in an Archive/ folder; only the folder name matches.
    for (let i = 1; i <= 20; i++) {
      const dd = String(i).padStart(2, '0');
      await writeNote(`Archive/2026-02-${dd}.md`, `# 2026-02-${dd}\n\nDaily entry.`);
    }
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=archive&mode=string');

    expect(res.status).toBe(200);
    // Folder row states the real total…
    expect(res.body.folders[0]).toMatchObject({ name: 'Archive', noteCount: 20 });
    // …while only a small sample of its members occupies the note list.
    expect(res.body.results.length).toBeLessThanOrEqual(5);
  });
});

// ─── Graceful degradation ────────────────────────────────────────────────────

describe('hybrid search: degraded semantic leg', () => {
  it('returns string results + degraded flag when the semantic engine throws', async () => {
    await writeNote('notes.md', '# Notes\n\nImportant meeting notes here.');
    await syncIndex();
    semanticThrows = true; // QMD leg rejects

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=meeting');

    expect(res.status).toBe(200);
    // String leg still succeeds…
    expect(res.body.results.some((r: any) => r.path === 'notes.md')).toBe(true);
    // …and the degradation is surfaced (Promise.allSettled, not all-or-nothing).
    expect(res.body.degraded).toBe('semantic-unavailable');
  });

  it('string-mode search ignores the semantic leg entirely (no degraded flag)', async () => {
    await writeNote('a.md', '# A\n\nfindable token');
    await syncIndex();
    semanticThrows = true; // would throw IF called

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=findable&mode=string');

    expect(res.status).toBe(200);
    expect(res.body.results.some((r: any) => r.path === 'a.md')).toBe(true);
    expect(res.body.degraded).toBeUndefined(); // semantic leg never ran
  });
});

// ─── Short-query noise + name/heading/tag recall (the "sin" bug class) ───────

describe('search: short-query substring noise stays below real matches', () => {
  it('mid-token title substrings ("sin" in "Business") rank below a basename word match', async () => {
    // The reported bug: query "sin" ranked "Business Idea", "using", "missing"
    // titles at 0.90 while the actual `SIN number.md` note (whose display title
    // is the H1 "Social Insurance Number Application Completed") sat below them.
    await writeNote('Business Idea.md', '# Business Idea\n\nStartup thoughts.');
    await writeNote('Deployment Tests.md', '# Deployment Safety Missing Tests\n\nRegional config.');
    await writeNote('SIN number.md', '# Social Insurance Number Application Completed\n\nApply within three days.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=sin&mode=string');

    expect(res.status).toBe(200);
    const order = res.body.results.map((r: any) => r.path);
    expect(order[0]).toBe('SIN number.md'); // basename word match wins
    const sinRow = res.body.results[0];
    for (const noisy of ['Business Idea.md', 'Deployment Tests.md']) {
      const row = res.body.results.find((r: any) => r.path === noisy);
      if (row) expect(row.stringScore).toBeLessThan(sinRow.stringScore);
    }
  });

  it('a SECTION HEADING match outranks body-only mentions and substring noise', async () => {
    // Grab-bag note: title says nothing, but an author-written `## SIN` section
    // holds the payload (the Gov document.md shape).
    await writeNote('Gov document.md', '# Gov document\n\n## US Visa\n\nphoto\n\n## SIN\n\nold 000000001\nNew 000000002');
    await writeNote('Business Idea.md', '# Business Idea\n\nStartup thoughts.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=sin&mode=string');

    expect(res.status).toBe(200);
    const gov = res.body.results.find((r: any) => r.path === 'Gov document.md');
    expect(gov).toBeDefined();
    expect(gov.headingMatch).toBe('SIN');
    expect(gov.stringScore).toBeCloseTo(0.87, 2);
    const noise = res.body.results.find((r: any) => r.path === 'Business Idea.md');
    if (noise) expect(noise.stringScore).toBeLessThan(gov.stringScore);
    // Snippet anchors on the heading's section, not a random body position.
    expect(gov.snippet.toLowerCase()).toContain('sin');
  });

  it('long mid-token substrings still match ("pollo" in "Apollo") at the title band', async () => {
    await writeNote('apollo.md', '# Apollo\n\nLaunch sequence.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=pollo&mode=string');

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === 'apollo.md');
    expect(row).toBeDefined();
    expect(row.stringScore).toBeCloseTo(0.9, 2);
  });

  it('a TAG match surfaces notes the query never appears in as text', async () => {
    await writeNote('immigration-log.md', '---\ntags: [perm, immigration]\n---\n# Timeline\n\nFiled I-140.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=perm&mode=string');

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === 'immigration-log.md');
    expect(row).toBeDefined();
    expect(row.matchedTags).toEqual(['perm']);
  });
});

describe('search: CJK queries', () => {
  it('finds CJK body text (FTS5 cannot tokenize it) at the body band, not noise band', async () => {
    await writeNote('tax-notes.md', '# Tax 2025\n\n投机与空置税需要每年申报。');
    await writeNote('unrelated.md', '# Other\n\nNothing here.');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=%E7%A9%BA%E7%BD%AE%E7%A8%8E&mode=string'); // 空置税

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === 'tax-notes.md');
    expect(row).toBeDefined();
    expect(row.stringScore).toBeGreaterThanOrEqual(0.5); // body band, not 0.1 noise
    expect(res.body.results.map((r: any) => r.path)).not.toContain('unrelated.md');
  });

  it('matches a CJK substring of a title at the title band', async () => {
    await writeNote('身份记录.md', '# 身份证 生日记录\n\n家人生日。');
    await syncIndex();

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=%E8%BA%AB%E4%BB%BD%E8%AF%81&mode=string'); // 身份证

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.path === '身份记录.md');
    expect(row).toBeDefined();
    expect(row.stringScore).toBeGreaterThanOrEqual(0.9);
  });
});

// ─── Boot drift scan (offline edits reconciled without a rebuild) ────────────

describe('drift scan: offline changes reconciled at boot', () => {
  it('picks up files created, edited, and deleted while the watcher was down', async () => {
    await writeNote('stays.md', '# Stays\n\nUnchanged content.');
    await writeNote('edited.md', '# Edited\n\nOriginal words here.');
    await writeNote('doomed.md', '# Doomed\n\nWill be deleted offline.');
    await syncIndex();

    // Simulate downtime: stop the watcher-driven reconciler, then mutate the
    // vault directly on disk (what Obsidian / an agent / git pull does).
    stopNotesIndexer();
    await writeNote('edited.md', '# Edited\n\nCompletely new searchable zebra.');
    await writeNote('born-offline.md', '# Born Offline\n\nCreated with no server.');
    await fs.rm(path.join(NOTES_DIR, 'doomed.md'));
    resetNotesIndexer();

    const { changed, deleted } = await scanForDrift();
    expect(changed).toBeGreaterThanOrEqual(2); // edited + born-offline
    expect(deleted).toBe(1); // doomed

    const app = createApp();
    const zebra = await request(app).get('/api/notes-v2/search?q=zebra&mode=string');
    expect(zebra.body.results.map((r: any) => r.path)).toContain('edited.md');
    const born = await request(app).get('/api/notes-v2/search?q=born&mode=string');
    expect(born.body.results.map((r: any) => r.path)).toContain('born-offline.md');
    const doomed = await request(app).get('/api/notes-v2/search?q=doomed&mode=string');
    expect(doomed.body.results.map((r: any) => r.path)).not.toContain('doomed.md');
  });

  it('is a no-op when nothing changed offline', async () => {
    await writeNote('calm.md', '# Calm\n\nNothing happens to this note.');
    await syncIndex();

    const { changed, deleted } = await scanForDrift();
    expect(changed).toBe(0);
    expect(deleted).toBe(0);
  });
});

// ─── Index rebuild reproduces state (rebuildable sidecar) ────────────────────

describe('index rebuild reproduces state from disk', () => {
  it('a fresh rebuild yields identical ids, list, backlinks, and search hits', async () => {
    await writeNote('target.md', '---\nid: n_target\n---\n# Target\n\nThe canonical note.');
    await writeNote('linker.md', '---\nid: n_linker\n---\nSee [[target]] for the launch plan.');
    await syncIndex();

    const app = createApp();

    // Snapshot state after the first build.
    const list1 = (await request(app).get('/api/notes-v2/list')).body.notes
      .map((n: any) => `${n.path}:${n.id}`)
      .sort();
    const backlinks1 = (await request(app).get('/api/notes-v2/backlinks/target.md')).body.backlinks
      .map((b: any) => b.path)
      .sort();
    semanticHits = [];
    const search1 = (await request(app).get('/api/notes-v2/search?q=launch')).body.results
      .map((r: any) => r.path)
      .sort();

    // Drop + rebuild the entire sidecar from disk.
    await rebuildIndex();

    const list2 = (await request(app).get('/api/notes-v2/list')).body.notes
      .map((n: any) => `${n.path}:${n.id}`)
      .sort();
    const backlinks2 = (await request(app).get('/api/notes-v2/backlinks/target.md')).body.backlinks
      .map((b: any) => b.path)
      .sort();
    const search2 = (await request(app).get('/api/notes-v2/search?q=launch')).body.results
      .map((r: any) => r.path)
      .sort();

    // Files are the source of truth → a rebuild reproduces structure exactly.
    expect(list2).toEqual(list1);
    expect(list2).toContain('target.md:n_target');
    expect(backlinks2).toEqual(backlinks1);
    expect(backlinks2).toEqual(['linker.md']);
    expect(search2).toEqual(search1);
  });
});
