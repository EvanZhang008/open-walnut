/**
 * The process fold's grouping rules (web/src/components/sessions/process-fold.ts):
 * which rows join one folded "Read 2 files, edited 2 files, sent a message" row,
 * and which always stay on screen. The rows here are stand-ins: the caller (the
 * session timeline) decides what a process row is; these pin how runs of them
 * group and read.
 */
import { describe, expect, it } from 'vitest';
import { groupProcessParts, processPhrase } from '@/components/sessions/process-fold';
import type { SessionHistoryTool } from '@/types/session';

const read = (p: string): SessionHistoryTool => ({ name: 'Read', input: { file_path: p } });
const edit = (p: string): SessionHistoryTool => ({ name: 'Edit', input: { file_path: p } });
const send: SessionHistoryTool = { name: 'mcp__walnut__task_send', input: { to: 'lead', text: 'hi' } };
const isOutbound = (t: SessionHistoryTool) => t.name === 'mcp__walnut__task_send';

/** A stand-in row: `tools` null = not a process row (text, an error, a question). */
type Row = { id: string; tools: SessionHistoryTool[] | null };
const row = (id: string, tools: SessionHistoryTool[] | null): Row => ({ id, tools });
const shape = (rows: Row[]) => groupProcessParts(rows, (r) => r.tools, isOutbound)
  .map((g) => (g.kind === 'one' ? g.part.id : `[${g.parts.map((p) => p.id).join(',')}]`));

describe('groupProcessParts', () => {
  it('folds the reported turn: runs and a sent message after the text', () => {
    const rows = [row('text', null), row('reads', [read('a'), read('b')]), row('edits', [edit('a'), edit('b')]), row('to-lead', [send])];
    expect(shape(rows)).toEqual(['text', '[reads,edits,to-lead]']);
  });

  it('text between steps stays visible and splits the folds', () => {
    const rows = [row('r1', [read('a')]), row('s1', [send]), row('mid', null), row('r2', [read('b')]), row('e2', [edit('b')]), row('end', null)];
    expect(shape(rows)).toEqual(['[r1,s1]', 'mid', '[r2,e2]', 'end']);
  });

  it('one plain run is left as the folded row it already is', () => {
    expect(shape([row('t', null), row('r', [read('a')]), row('u', null)])).toEqual(['t', 'r', 'u']);
  });

  it('one sent message folds on its own', () => {
    expect(shape([row('t', null), row('s', [send])])).toEqual(['t', '[s]']);
  });

  it('a non-process row (error, question, plan, live tail) ends the group and stays', () => {
    const rows = [row('r1', [read('a')]), row('e1', [edit('a')]), row('failed', null), row('r2', [read('b')]), row('s2', [send])];
    expect(shape(rows)).toEqual(['[r1,e1]', 'failed', '[r2,s2]']);
  });

  it('keeps every row exactly once, in order', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`x${i}`, i % 7 === 3 ? null : i % 5 === 0 ? [send] : [read(`f${i}`)]));
    const flat = groupProcessParts(rows, (r) => r.tools, isOutbound)
      .flatMap((g) => (g.kind === 'one' ? [g.part.id] : g.parts.map((p) => p.id)));
    expect(flat).toEqual(rows.map((r) => r.id));
  });

  it('nothing in, nothing out', () => {
    expect(groupProcessParts([], (r: Row) => r.tools, isOutbound)).toEqual([]);
  });
});

describe('processPhrase', () => {
  it('reads like a tool run, then the messages sent', () => {
    expect(processPhrase([read('a'), read('b'), edit('a'), edit('b'), send], isOutbound)).toBe('Read 2 files, edited 2 files, sent a message');
    expect(processPhrase([send, send], isOutbound)).toBe('Sent 2 messages');
    expect(processPhrase([read('a')], isOutbound)).toBe('Read a file');
  });
});
