/**
 * Unit tests for session-content-indexer (src/core/session-content-indexer.ts).
 * Covers code-block collapsing, tool/thinking filtering, blob stripping,
 * size cap (tail-keep), turn headings, and empty input.
 */
import { describe, it, expect } from 'vitest';
import { buildIndexedContent, extractCommitShas } from '../../src/core/session-content-indexer.js';
import type { SessionHistoryMessage } from '../../src/core/session-history.js';

function msg(partial: Partial<SessionHistoryMessage> & { role: 'user' | 'assistant' }): SessionHistoryMessage {
  return { text: '', timestamp: '2026-05-05T10:00:00.000Z', ...partial };
}

describe('buildIndexedContent', () => {
  it('returns empty body for no messages', () => {
    const out = buildIndexedContent([]);
    expect(out.body).toBe('');
    expect(out.turnCount).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('injects a ## Turn heading per kept turn with short timestamp', () => {
    const out = buildIndexedContent([
      msg({ role: 'user', text: 'hello' }),
      msg({ role: 'assistant', text: 'hi there', timestamp: '2026-05-05T10:02:00.000Z' }),
    ]);
    expect(out.turnCount).toBe(2);
    expect(out.body).toContain('## Turn 1 (2026-05-05 10:00)');
    expect(out.body).toContain('## Turn 2 (2026-05-05 10:02)');
    expect(out.body).toContain('User: hello');
    expect(out.body).toContain('Assistant: hi there');
  });

  it('collapses code blocks longer than the threshold', () => {
    const bigCode = '```ts\n' + Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```';
    const out = buildIndexedContent([msg({ role: 'assistant', text: `Here is code:\n${bigCode}` })]);
    expect(out.body).toContain('lines omitted>');
    expect(out.body).toContain('lang=ts');
    expect(out.body).not.toContain('const x15 = 15;');
  });

  it('keeps small code blocks intact', () => {
    const smallCode = '```js\nconst a = 1;\nconst b = 2;\n```';
    const out = buildIndexedContent([msg({ role: 'assistant', text: smallCode })]);
    expect(out.body).toContain('const a = 1;');
    expect(out.body).not.toContain('lines omitted>');
  });

  it('drops tool RESULTS but keeps names, file paths, and command heads', () => {
    // CONTRACT CHANGE (2026-08-16): tool results stay excluded (secrets/bulk),
    // but file paths and Bash command first-lines are now indexed — they are
    // what makes "which session edited X" answerable.
    const out = buildIndexedContent([
      msg({
        role: 'assistant',
        text: 'Let me check that file.',
        tools: [
          { name: 'Bash', input: { command: 'cat /etc/passwd' }, result: 'root:x:0:0:secret' },
          { name: 'Read', input: { file_path: '/foo' }, result: 'file contents here' },
          { name: 'Bash', input: { command: 'ls' } },
        ],
      }),
    ]);
    expect(out.body).toContain('Tools: Bash, Read');
    expect(out.body).toContain('Files: /foo');
    expect(out.body).toContain('Commands: cat /etc/passwd | ls');
    // Results must never leak.
    expect(out.body).not.toContain('root:x:0:0');
    expect(out.body).not.toContain('file contents here');
  });

  it('caps footer paths at 10 and command heads at 3, deduped', () => {
    const tools = [
      ...Array.from({ length: 14 }, (_, i) => ({ name: 'Edit', input: { file_path: `/f${i}.ts` } })),
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'Bash', input: { command: 'git status' } },
      { name: 'Bash', input: { command: 'git diff' } },
      { name: 'Bash', input: { command: 'git log' } },
    ];
    const out = buildIndexedContent([msg({ role: 'assistant', text: 'work', tools })]);
    expect(out.body).toContain('/f9.ts');
    expect(out.body).not.toContain('/f10.ts');
    expect(out.body).toContain('npm test | git status | git diff');
    expect(out.body).not.toContain('git log');
  });

  it('multi-line Bash commands contribute only their first line', () => {
    const out = buildIndexedContent([
      msg({
        role: 'assistant', text: 'commit',
        tools: [{ name: 'Bash', input: { command: 'git commit -m "feat: retire stars"\nSECRET_HEREDOC_BODY' } }],
      }),
    ]);
    expect(out.body).toContain('git commit -m "feat: retire stars"');
    expect(out.body).not.toContain('SECRET_HEREDOC_BODY');
  });

  it('does not index thinking content', () => {
    const out = buildIndexedContent([
      msg({ role: 'assistant', text: 'visible answer', thinking: 'secret chain of thought reasoning' }),
    ]);
    expect(out.body).toContain('visible answer');
    expect(out.body).not.toContain('secret chain of thought');
  });

  it('strips base64 data URIs and long blobs', () => {
    const b64 = 'data:image/png;base64,' + 'A'.repeat(2000);
    const blob = 'Z'.repeat(800);
    const out = buildIndexedContent([msg({ role: 'user', text: `image ${b64} and ${blob} end` })]);
    expect(out.body).toContain('<blob omitted>');
    expect(out.body).not.toContain('AAAA');
    expect(out.body).not.toContain('ZZZZ');
  });

  it('skips turns with neither text nor tools', () => {
    const out = buildIndexedContent([
      msg({ role: 'user', text: '' }),
      msg({ role: 'assistant', text: 'real reply' }),
    ]);
    expect(out.turnCount).toBe(1);
    expect(out.body).toContain('## Turn 1');
    expect(out.body).not.toContain('## Turn 2');
  });

  it('truncates a single oversized turn mid-text', () => {
    const huge = 'word '.repeat(2_000); // spaced text — not caught by blob stripper
    const out = buildIndexedContent([msg({ role: 'user', text: huge })], { maxCharsPerTurn: 100 });
    expect(out.body).toContain('... [truncated]');
    expect(out.body.length).toBeLessThan(1_000);
  });

  it('enforces maxBytes via tail-keep, dropping oldest turns', () => {
    const turns: SessionHistoryMessage[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push(msg({ role: 'user', text: `turn ${i} ` + 'word '.repeat(200) }));
    }
    const out = buildIndexedContent(turns, { maxBytes: 5_000 });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.body)).toBeLessThanOrEqual(5_000 + 100);
    expect(out.body).toContain('[...earlier turns omitted]');
    // Oldest turn dropped, newest retained
    expect(out.body).not.toContain('turn 0 ');
    expect(out.body).toContain('turn 49 ');
  });

  it('does not mark truncated when under cap', () => {
    const out = buildIndexedContent([msg({ role: 'user', text: 'short' })], { maxBytes: 50_000 });
    expect(out.truncated).toBe(false);
    expect(out.body).not.toContain('earlier turns omitted');
  });
});

describe('extractCommitShas', () => {
  const gitCommit = (result: string, over?: Partial<import('../../src/core/session-history.js').SessionHistoryTool>) => msg({
    role: 'assistant' as const,
    text: 'committing',
    tools: [{ name: 'Bash', input: { command: 'git commit -m "fix: something"' }, result, ...over }],
  });

  it('extracts the SHA from porcelain commit output', () => {
    const out = extractCommitShas([gitCommit('[main a00ee84] fix: retire the star system\n 3 files changed')]);
    expect(out).toEqual(['a00ee84']);
  });

  it('extracts full 40-char SHAs and preserves order across turns', () => {
    const out = extractCommitShas([
      gitCommit('[main 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] first'),
      gitCommit('[feature-x 2222222] second'),
    ]);
    expect(out).toEqual(['1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2222222']);
  });

  it('dedupes a SHA reported twice', () => {
    const out = extractCommitShas([
      gitCommit('[main abc1234] msg'),
      gitCommit('[main abc1234] msg (re-run echoed same output)'),
    ]);
    expect(out).toEqual(['abc1234']);
  });

  it('ignores failed git commit tool calls', () => {
    const out = extractCommitShas([gitCommit('[main abc1234] msg', { isError: true })]);
    expect(out).toEqual([]);
  });

  it('ignores Bash calls that are not git commit', () => {
    const out = extractCommitShas([msg({
      role: 'assistant',
      text: '',
      tools: [{ name: 'Bash', input: { command: 'git log --oneline' }, result: '[main abc1234] old commit' }],
    })]);
    expect(out).toEqual([]);
  });

  it('ignores non-Bash tools and prose that merely looks bracketed', () => {
    const out = extractCommitShas([
      msg({ role: 'assistant', text: 'see [branch deadbeef] in the docs' }),
      msg({ role: 'assistant', text: '', tools: [{ name: 'Read', input: { command: 'git commit' }, result: '[main abc1234] x' }] }),
    ]);
    expect(out).toEqual([]);
  });

  it('does not match non-hex or too-short bracket contents', () => {
    const out = extractCommitShas([
      gitCommit('[main HEAD] weird'),
      gitCommit('[main abc12] too short'),
    ]);
    expect(out).toEqual([]);
  });

  it('extracts from a git log --oneline -1 confirmation probe (redirected-commit case)', () => {
    // The real a00ee84c escape: commit output was `> /tmp/x.txt`-redirected, so
    // the SHA only ever appeared in the follow-up confirmation command.
    const out = extractCommitShas([msg({
      role: 'assistant',
      text: '',
      tools: [{
        name: 'Bash',
        input: { command: 'rm -rf /tmp/scratch 2>/dev/null; git log --oneline -1; git status --short | grep -c "^ M"' },
        result: 'a00ee84c feat(tasks): retire the star system — pin + focus tiers are the working set\n99',
      }],
    })]);
    expect(out).toEqual(['a00ee84c']);
  });

  it('extracts regardless of git log flag order (-1 --oneline)', () => {
    const out = extractCommitShas([msg({
      role: 'assistant',
      text: '',
      tools: [{
        name: 'Bash',
        input: { command: 'git log -1 --oneline' },
        result: 'cafe123 fix: something',
      }],
    })]);
    expect(out).toEqual(['cafe123']);
  });

  it('extracts from git rev-parse HEAD output', () => {
    const out = extractCommitShas([msg({
      role: 'assistant',
      text: '',
      tools: [{
        name: 'Bash',
        input: { command: 'git rev-parse --short HEAD' },
        result: 'deadbee12\n',
      }],
    })]);
    expect(out).toEqual(['deadbee12']);
  });

  it('does NOT extract from multi-commit history browsing (git log without -1)', () => {
    const out = extractCommitShas([msg({
      role: 'assistant',
      text: '',
      tools: [{
        name: 'Bash',
        input: { command: 'git log --oneline -5' },
        result: 'abc1234 someone elses commit\ndef5678 another one',
      }],
    })]);
    expect(out).toEqual([]);
  });

  it('survives the tail-keep cap: SHA from a dropped early turn still returned', () => {
    const turns: SessionHistoryMessage[] = [gitCommit('[main abc1234] early commit')];
    for (let i = 0; i < 50; i++) {
      turns.push(msg({ role: 'user', text: `turn ${i} ` + 'word '.repeat(200) }));
    }
    const out = buildIndexedContent(turns, { maxBytes: 5_000 });
    expect(out.truncated).toBe(true);
    expect(out.body).not.toContain('early commit');
    expect(out.commitShas).toEqual(['abc1234']);
  });
});
