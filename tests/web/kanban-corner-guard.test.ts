/**
 * Every kanban browser spec that measures or drags the board keeps the notice corner to the
 * board's own toasts (keepCornerToBoard in tests/e2e/browser/board-kanban-corner.ts).
 *
 * The corner (web/src/components/common/corner-stack.tsx) shows every live notice of the shared
 * fixture server, and each kanban team seeds two Bash permission prompts. 2026-11-06, main CI:
 * another worker's prompts reached the corner mid-test, covered a card (C5's drag never started)
 * and gave the lanes 321px of room at their end (C45, C55). This reads every kanban spec and fails
 * on one that opens the Cards view without the helper, unless it is listed here with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');

/** Specs that read the corner's other notices themselves, so they keep the whole corner. */
const READS_CORNER: Record<string, string> = {
  'board-kanban.spec.ts': 'answers its own team\'s permission prompts',
  'board-kanban-controls.spec.ts': 'checks the corner\'s permission card beside the board',
  'board-kanban-prompt.spec.ts': 'tests a prompt card the corner shows',
};

const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));
const code = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const cardsUsers = specs.filter((f) => /\bpickCardsView\(/.test(code(f)));

describe('kanban corner isolation', () => {
  it('finds the specs it knows of (the matcher still matches)', () => {
    for (const known of ['board-kanban-dnd.spec.ts', 'board-kanban-narrow.spec.ts', ...Object.keys(READS_CORNER)]) {
      expect(cardsUsers, known).toContain(known);
    }
  });

  it('every spec that opens the Cards view keeps the corner to the board, or says why not', () => {
    const missing = cardsUsers.filter((f) => !READS_CORNER[f] && !/\bkeepCornerToBoard\(/.test(code(f)));
    expect(missing, 'call keepCornerToBoard(context) next to pickCardsView, or list the spec in READS_CORNER').toEqual([]);
  });

  it('a listed spec still reads the corner (else drop it from the list)', () => {
    const stale = Object.keys(READS_CORNER).filter((f) => !/corner-|permission|approve|Allow\b/.test(code(f)));
    expect(stale).toEqual([]);
  });
});
