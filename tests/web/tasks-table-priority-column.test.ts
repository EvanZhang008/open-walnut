/**
 * The /tasks table's header, rows and grid tracks can never disagree.
 *
 * History: `.tp-thead`, `.tp-row` and `.tp-ghost` are three separate grids. They
 * used to share a hard-coded `grid-template-columns` class per column count, and
 * hiding the priority CELL without its TRACK shifted Due/Session/Project one column
 * left in the rows while the header kept its tracks — every value under the wrong
 * heading, invisible in a header-only screenshot.
 *
 * The 2026-09 column chooser replaced the classes with ONE source: TasksPageTable
 * computes `visibleColumns(...)` once and maps over it for the header cells, the row
 * cells and the `--tp-cols` CSS variable (tasks-table-columns.ts). This file pins
 * that structure in the SOURCE, so a future "just add a cell" edit that bypasses
 * the list is caught here rather than by eye.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../../web/src');
const CSS_SRC = fs.readFileSync(path.join(WEB, 'styles/tasks-page.css'), 'utf8');
const TABLE_SRC = fs.readFileSync(path.join(WEB, 'components/tasks/TasksPageTable.tsx'), 'utf8');

describe('tasks table column alignment', () => {
  it('header, row and ghost grids all take their tracks from the --tp-cols variable', () => {
    const idx = CSS_SRC.indexOf('.tp-thead,\n.tp-row,\n.tp-ghost {');
    expect(idx, 'the shared grid rule for thead/row/ghost is gone').toBeGreaterThan(-1);
    const body = CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
    expect(body).toMatch(/grid-template-columns:\s*var\(--tp-cols/);
    // No hard-coded per-count templates may come back.
    expect(CSS_SRC).not.toMatch(/\.tp-cols-\d/);
    expect(CSS_SRC).not.toMatch(/tp-nopri/);
  });

  it('the table sets --tp-cols from the same visible list that renders header and cells', () => {
    expect(TABLE_SRC).toMatch(/const visible = useMemo\(\(\) => visibleColumns\(columns, scope\)/);
    expect(TABLE_SRC).toMatch(/'--tp-cols': gridTemplate\(visible\)/);
    // Header: Title, then one <Th> per visible column.
    expect(TABLE_SRC).toMatch(/\{visible\.map\(\(col\) => \(\s*<Th key=\{col\.id\}/);
    // Rows: Title cell, then one cell per visible column.
    expect(TABLE_SRC).toMatch(/\{visible\.map\(\(col\) => cell\(col, t\)\)\}/);
    // Nothing renders a column cell on its own gate any more.
    expect(TABLE_SRC).not.toMatch(/\{showPriority && <span><PriorityCell/);
    expect(TABLE_SRC).not.toMatch(/\{isAll && \(\s*<span><ProjectCell/);
  });

  it('the cell switch covers every column id the model can offer', () => {
    const modelSrc = fs.readFileSync(path.join(WEB, 'components/tasks/tasks-table-columns.ts'), 'utf8');
    const ids = [...modelSrc.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    const switchStart = TABLE_SRC.indexOf('const cell = (col: TpColumnDef, t: Task)');
    expect(switchStart).toBeGreaterThan(-1);
    const switchSrc = TABLE_SRC.slice(switchStart, TABLE_SRC.indexOf('const groupHeader', switchStart));
    for (const id of ids) expect(switchSrc, `no cell for column '${id}'`).toMatch(new RegExp(`case '${id}'`));
  });
});
