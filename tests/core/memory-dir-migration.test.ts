/**
 * Tests for the one-shot project-memory flatten
 * (`memory/projects/<cat>/<proj>/` → `memory/projects/<proj>/`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-memory-dir-migration'));

import { WALNUT_HOME, PROJECTS_MEMORY_DIR } from '../../src/constants.js';
import {
  migrateProjectMemoryDirs,
  mergeMemoryContents,
  MEMORY_DIR_MIGRATION_MARKER,
} from '../../src/core/memory-dir-migration.js';

function memoryDoc(name: string, description: string, body = ''): string {
  return `---\nname: ${name}\ndescription: '${description}'\n---\n${body}`;
}

async function writeMemory(rel: string, content: string, mtime?: Date): Promise<string> {
  const dir = path.join(PROJECTS_MEMORY_DIR, rel);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'MEMORY.md');
  await fs.writeFile(file, content, 'utf-8');
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(PROJECTS_MEMORY_DIR, rel, 'MEMORY.md'), 'utf-8');
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(PROJECTS_MEMORY_DIR, rel)).then(() => true, () => false);
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('migrateProjectMemoryDirs', () => {
  it('is a no-op when the legacy tree does not exist (and creates no marker)', async () => {
    const result = await migrateProjectMemoryDirs();
    expect(result).toEqual({ ran: false, moved: 0, merged: 0 });
    expect(await fs.access(MEMORY_DIR_MIGRATION_MARKER).then(() => true, () => false)).toBe(false);
  });

  it('flattens two-level dirs and carries sibling subdirs with them', async () => {
    await writeMemory('passion/walnut', memoryDoc('Walnut', 'the butler'));
    await writeMemory('passion/walnut/triage', memoryDoc('Walnut triage', 'triage state'));
    await writeMemory('life/tax', memoryDoc('Tax', 'filings'));

    const result = await migrateProjectMemoryDirs();
    expect(result).toMatchObject({ ran: true, moved: 2, merged: 0 });

    expect(await read('walnut')).toContain('name: Walnut');
    // The nested `triage/` sub-store travelled with the project dir.
    expect(await read('walnut/triage')).toContain('name: Walnut triage');
    expect(await read('tax')).toContain('name: Tax');
    // Empty legacy category dirs are removed.
    expect(await exists('passion')).toBe(false);
    expect(await exists('life')).toBe(false);
  });

  it('leaves a one-level project dir (already target shape) untouched', async () => {
    await writeMemory('walnut', memoryDoc('Walnut', 'already flat'));
    await writeMemory('walnut/triage', memoryDoc('Walnut triage', 'nested store'));

    const result = await migrateProjectMemoryDirs();
    expect(result).toMatchObject({ ran: true, moved: 0, merged: 0 });
    expect(await read('walnut')).toContain('already flat');
    // The nested store must NOT be promoted to a top-level "triage" project.
    expect(await read('walnut/triage')).toContain('nested store');
    expect(await exists('triage')).toBe(false);
  });

  it('skips a two-level dir whose MEMORY.md lives only deeper (opaque agent path)', async () => {
    await writeMemory('work/service/deep', memoryDoc('Deep', 'three levels'));

    const result = await migrateProjectMemoryDirs();
    expect(result).toMatchObject({ ran: true, moved: 0, merged: 0 });
    expect(await read('work/service/deep')).toContain('three levels');
  });

  it('merges a collision, keeping the newest MEMORY.md as the base', async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    // Same project name under two categories.
    await writeMemory('work/marina', memoryDoc('Marina (work)', 'work notes', '## log\nwork body\n'), newer);
    await writeMemory('life/marina', memoryDoc('Marina (life)', 'life notes', '## log\nlife body\n'), older);

    const result = await migrateProjectMemoryDirs();
    expect(result).toMatchObject({ ran: true, moved: 1, merged: 1 });

    const merged = await read('marina');
    // The newest copy's frontmatter (a stateful agent's carry-forward) survives verbatim.
    expect(merged).toContain('name: Marina (work)');
    expect(merged).toContain('work body');
    // The older body is preserved under an explicit legacy heading.
    expect(merged).toMatch(/## Merged from (life\/marina|marina) \(legacy\)/);
    expect(merged).toContain('life body');
    // Nothing left behind at the old locations.
    expect(await exists('work')).toBe(false);
    expect(await exists('life')).toBe(false);
  });

  it('merges into an EXISTING top-level project when one already has that name', async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    await writeMemory('marina', memoryDoc('Marina', 'already flat', '## log\nflat body\n'), older);
    await writeMemory('work/marina', memoryDoc('Marina (work)', 'legacy', '## log\nlegacy body\n'), newer);

    const result = await migrateProjectMemoryDirs();
    expect(result).toMatchObject({ ran: true, merged: 1 });

    const merged = await read('marina');
    expect(merged).toContain('name: Marina (work)'); // newer wins as base
    expect(merged).toContain('legacy body');
    expect(merged).toContain('flat body');
  });

  it('is idempotent: a second run is a marker-guarded no-op and does not re-merge', async () => {
    await writeMemory('work/marina', memoryDoc('Marina', 'work notes', '## log\nwork body\n'));
    await writeMemory('life/marina', memoryDoc('Marina', 'life notes', '## log\nlife body\n'));

    await migrateProjectMemoryDirs();
    const afterFirst = await read('marina');

    const second = await migrateProjectMemoryDirs();
    expect(second).toEqual({ ran: false, moved: 0, merged: 0 });
    expect(await read('marina')).toBe(afterFirst);
  });

  it('writes the marker even when there is nothing to move', async () => {
    await fs.mkdir(PROJECTS_MEMORY_DIR, { recursive: true });
    const result = await migrateProjectMemoryDirs();
    expect(result).toEqual({ ran: true, moved: 0, merged: 0 });
    expect(await fs.access(MEMORY_DIR_MIGRATION_MARKER).then(() => true, () => false)).toBe(true);
  });
});

describe('mergeMemoryContents', () => {
  it('appends only the legacy BODY (its frontmatter is dropped)', () => {
    const out = mergeMemoryContents(
      memoryDoc('Base', 'base desc', '## log\nbase body\n'),
      memoryDoc('Legacy', 'legacy desc', '## log\nlegacy body\n'),
      'work/marina',
    );
    expect(out).toContain('name: Base');
    expect(out).not.toContain('name: Legacy');
    expect(out).toContain('## Merged from work/marina (legacy)');
    expect(out).toContain('legacy body');
  });

  it('returns the base unchanged when the legacy file has no body', () => {
    const base = memoryDoc('Base', 'base desc', '## log\nbase body\n');
    expect(mergeMemoryContents(base, memoryDoc('Legacy', 'legacy desc'), 'work/marina')).toBe(base);
  });
});
