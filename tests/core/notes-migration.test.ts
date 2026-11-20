/**
 * Tests for the global notes migration (notes-migration.ts).
 *
 * B1: old root file only → migrated to globalNotesFile(), old file deleted
 * B2: both root and notes/global.md exist → root wins, both old files deleted; idempotent
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants BEFORE any source module imports
vi.mock('../../src/constants.js', () => createMockConstants('notes-migration-test'));

import { WALNUT_HOME, NOTES_DIR } from '../../src/constants.js';
import { globalNotesFile } from '../../src/core/notes/vault-files.js';
import { migrateGlobalNotes } from '../../src/core/notes-migration.js';

// Old paths that the migration code constructs from WALNUT_HOME / NOTES_DIR
const OLD_ROOT_FILE = path.join(WALNUT_HOME, 'global-notes.md');
const OLD_NOTES_GLOBAL = path.join(NOTES_DIR, 'global.md');

// ── Helpers ──

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── Lifecycle ──

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── B1: old root file only ────────────────────────────────────────────────

describe('B1: migration — old root file → new path + cleanup', () => {
  it('migrates content from root file to globalNotesFile()', async () => {
    const content = '# My Global Notes\n\nSome important content here.';
    await fs.writeFile(OLD_ROOT_FILE, content, 'utf-8');

    await migrateGlobalNotes();

    const migratedContent = await fs.readFile(globalNotesFile(), 'utf-8');
    expect(migratedContent).toBe(content);
  });

  it('deletes the old root file after migration', async () => {
    await fs.writeFile(OLD_ROOT_FILE, 'old root content', 'utf-8');

    await migrateGlobalNotes();

    expect(await fileExists(OLD_ROOT_FILE)).toBe(false);
  });

  it('creates the NOTES_DIR if it does not exist', async () => {
    await fs.writeFile(OLD_ROOT_FILE, 'content', 'utf-8');
    // NOTES_DIR should not exist yet
    expect(await fileExists(NOTES_DIR)).toBe(false);

    await migrateGlobalNotes();

    expect(await fileExists(NOTES_DIR)).toBe(true);
    expect(await fileExists(globalNotesFile())).toBe(true);
  });

  it('does nothing when no legacy files exist', async () => {
    // No old root file, no old notes/global.md
    await migrateGlobalNotes();

    expect(await fileExists(globalNotesFile())).toBe(false);
  });
});

// ── B2: both old files exist → root wins ─────────────────────────────────

describe('B2: migration — both old files exist → root wins, both deleted', () => {
  it('uses root file content when both old files exist', async () => {
    const rootContent = '# Root Content — this wins';
    const notesGlobalContent = '# notes/global.md content — this loses';

    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(OLD_ROOT_FILE, rootContent, 'utf-8');
    await fs.writeFile(OLD_NOTES_GLOBAL, notesGlobalContent, 'utf-8');

    await migrateGlobalNotes();

    const migratedContent = await fs.readFile(globalNotesFile(), 'utf-8');
    expect(migratedContent).toBe(rootContent);
  });

  it('deletes both old files after migration when both existed', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(OLD_ROOT_FILE, 'root', 'utf-8');
    await fs.writeFile(OLD_NOTES_GLOBAL, 'old notes global', 'utf-8');

    await migrateGlobalNotes();

    expect(await fileExists(OLD_ROOT_FILE)).toBe(false);
    expect(await fileExists(OLD_NOTES_GLOBAL)).toBe(false);
  });

  it('migrates notes/global.md when root file does not exist', async () => {
    const notesContent = '# Only notes/global.md exists';

    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(OLD_NOTES_GLOBAL, notesContent, 'utf-8');

    await migrateGlobalNotes();

    const migratedContent = await fs.readFile(globalNotesFile(), 'utf-8');
    expect(migratedContent).toBe(notesContent);
    expect(await fileExists(OLD_NOTES_GLOBAL)).toBe(false);
  });

  it('is idempotent — second run is a no-op when globalNotesFile() already exists', async () => {
    const originalContent = '# Original content';
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(OLD_ROOT_FILE, originalContent, 'utf-8');

    // First run
    await migrateGlobalNotes();

    const afterFirst = await fs.readFile(globalNotesFile(), 'utf-8');
    expect(afterFirst).toBe(originalContent);

    // Overwrite globalNotesFile() with different content to detect any re-migration
    const changedContent = '# Changed after first migration';
    await fs.writeFile(globalNotesFile(), changedContent, 'utf-8');

    // Second run — target already exists, so must be a no-op
    await migrateGlobalNotes();

    const afterSecond = await fs.readFile(globalNotesFile(), 'utf-8');
    expect(afterSecond).toBe(changedContent); // unchanged
  });
});
