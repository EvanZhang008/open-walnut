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

  it('injected context (a loaded skill, a note) folds with the steps beside it', () => {
    // The reported shape: a tool run, then two skill loads each after a note.
    type C = Row & { ctx?: boolean };
    const rows: C[] = [row('ask', null), row('run', [read('a'), read('b')]), { ...row('note1', null), ctx: true }, { ...row('skill1', null), ctx: true },
      { ...row('note2', null), ctx: true }, { ...row('skill2', null), ctx: true }, row('next', null)];
    const got = groupProcessParts(rows, (r) => r.tools, isOutbound, () => false, (r) => !!r.ctx)
      .map((g) => (g.kind === 'one' ? g.part.id : `[${g.parts.map((p) => p.id).join(',')}]`));
    expect(got).toEqual(['ask', '[run,note1,skill1,note2,skill2]', 'next']);
    // Context rows alone fold together too; a lone one stays its own row.
    expect(groupProcessParts(rows.slice(2, 4), (r) => r.tools, isOutbound, () => false, (r) => !!r.ctx).map((g) => g.kind)).toEqual(['process']);
    expect(groupProcessParts([rows[0], rows[2], rows[6]], (r) => r.tools, isOutbound, () => false, (r) => !!r.ctx).map((g) => g.kind)).toEqual(['one', 'one', 'one']);
    // Words between them split the run: each side folds on its own.
    const split = [rows[1], rows[2], row('words', null), rows[3], rows[4]];
    expect(groupProcessParts(split, (r) => r.tools, isOutbound, () => false, (r) => !!r.ctx)
      .map((g) => (g.kind === 'one' ? g.part.id : `[${g.parts.map((p) => p.id).join(',')}]`))).toEqual(['[run,note1]', 'words', '[skill1,note2]']);
  });

  it('reasoning between received messages and runs joins their row; among runs alone it keeps its own', () => {
    // The reported live shape (2026-10-26): Received, Thinking, Received, Ran 31 commands.
    type R = { id: string; tools: SessionHistoryTool[] | null; inbound?: boolean; quiet?: boolean };
    const rows: R[] = [
      { id: 'in1', tools: null, inbound: true }, { id: 'think', tools: null, quiet: true },
      { id: 'in2', tools: null, inbound: true }, { id: 'run', tools: [read('a')] }, { id: 'text', tools: null },
      { id: 'run2', tools: [read('b')] }, { id: 'think2', tools: null, quiet: true }, { id: 'answer', tools: null },
    ];
    const got = groupProcessParts(rows, (r) => r.tools, isOutbound, (r) => !!r.inbound, () => false, (r) => !!r.quiet)
      .map((g) => (g.kind === 'one' ? g.part.id : `[${g.parts.map((p) => p.id).join(',')}]`));
    expect(got).toEqual(['[in1,think,in2,run]', 'text', 'run2', 'think2', 'answer']);
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

  it('names loaded skills and injected context after the tools', () => {
    const bash = (c: string): SessionHistoryTool => ({ name: 'Bash', input: { command: c } });
    const skill = (n: string): SessionHistoryTool => ({ name: 'Skill', input: { skill: n } });
    const tools = [bash('a'), bash('b'), bash('c'), bash('d'), bash('e'), skill('x'), skill('y')];
    expect(processPhrase(tools, isOutbound, 0, { skills: 2, other: 2 })).toBe(`${processPhrase(tools, isOutbound)}, loaded 2 skills, injected context 2\u00d7`);
    expect(processPhrase([], isOutbound, 0, { skills: 1, other: 1 })).toBe('Loaded a skill, injected context');
    expect(processPhrase([send], isOutbound, 1, { skills: 0, other: 3 })).toBe('Received a message, injected context 3\u00d7, sent a message');
  });
});
