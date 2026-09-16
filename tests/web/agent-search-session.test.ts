/**
 * The seed message "Open as session" sends from the ✦ AI search card
 * (web/src/components/tasks/agent-search-session.ts).
 *
 * One click, no composer: the message alone has to tell the Ask Walnut session
 * what to do. These pin its shape across the states the card can be in when
 * the button is pressed (still searching, done with rows, done empty, failed).
 */
import { describe, expect, it } from 'vitest';
import { buildSearchSessionMessage } from '@/components/tasks/agent-search-session';
import type { AgentSearchPayload } from '@/api/agentSearch';

const QUERY = 'resume session walnut always show resume instead of working';

const row = (n: number, extra: Partial<AgentSearchPayload['results'][number]> = {}) => ({
  taskId: `task-${n}`,
  title: `Task number ${n}`,
  phase: 'TODO',
  project: 'Walnut',
  evidence: `evidence ${n}`,
  ...extra,
});

describe('buildSearchSessionMessage', () => {
  it('names the question on the first line and asks for the full search when nothing is known yet', () => {
    const msg = buildSearchSessionMessage(QUERY);
    const lines = msg.split('\n');
    expect(lines[0]).toBe(`Find everything about: ${QUERY}`);
    expect(msg).toMatch(/tasks, sessions \(including their transcripts\), memory and notes/);
    expect(msg).toMatch(/resolved or still open/);
    expect(msg).not.toMatch(/quick AI search already found/);
    expect(msg).not.toMatch(/summary:/);
  });

  it('collapses whitespace in the query so the title line stays one line', () => {
    const msg = buildSearchSessionMessage('  resume\n\n session   walnut ');
    expect(msg.split('\n')[0]).toBe('Find everything about: resume session walnut');
  });

  it('keeps quotes and non-ASCII in the query verbatim', () => {
    const q = 'why does "Resuming session" show 恢复按钮';
    expect(buildSearchSessionMessage(q).split('\n')[0]).toBe(`Find everything about: ${q}`);
  });

  it('seeds a finished search: one line per row with project, phase, id and clipped evidence', () => {
    const found: AgentSearchPayload = {
      summary: '  The resume button work lives in two tasks.  ',
      results: [
        row(1, { project: 'Walnut', phase: 'NEED_ACTION', evidence: 'the composer Stop killed the CLI' }),
        row(2, { project: '', phase: undefined, evidence: 'x'.repeat(400) }),
      ],
      model: 'haiku',
      tookMs: 10,
    };
    const msg = buildSearchSessionMessage(QUERY, found);
    expect(msg).toMatch(/quick AI search already found these; start from them and go deeper:/);
    expect(msg).toContain('- Task number 1 (Walnut · NEED_ACTION), task task-1: “the composer Stop killed the CLI”');
    // No project → Inbox; no phase → just the project; long evidence clipped with an ellipsis.
    const line2 = msg.split('\n').find((l) => l.includes('task task-2'))!;
    expect(line2.startsWith('- Task number 2 (Inbox), task task-2: “')).toBe(true);
    expect(line2.length).toBeLessThan(230);
    expect(line2.endsWith('…”')).toBe(true);
    expect(msg).toContain('That quick search summed it up as “The resume button work lives in two tasks.” — verify it.');
  });

  it('caps the seeded rows and says how many more there were', () => {
    const found: AgentSearchPayload = {
      results: Array.from({ length: 12 }, (_, i) => row(i + 1)),
      model: 'haiku',
      tookMs: 10,
    };
    const msg = buildSearchSessionMessage(QUERY, found);
    expect(msg.match(/^- Task number \d+/gm)).toHaveLength(8);
    expect(msg).toContain('- …and 4 more');
  });

  it('a finished search with zero rows sends the bare briefing — its summary is DROPPED, not handed over as a premise', () => {
    // The real shape of a zero-row answer: the quick search states it found
    // nothing. That verdict comes from a weaker one-shot run, and this session's
    // whole job is to look harder — passing it along (and, with the candidates
    // gone, with nothing for "it" to refer to) would anchor the session on the
    // conclusion it exists to re-test.
    const msg = buildSearchSessionMessage(QUERY, { summary: 'Nothing matched.', results: [], model: 'haiku', tookMs: 5 });
    expect(msg).not.toMatch(/already found/);
    expect(msg).not.toMatch(/and \d+ more/);
    expect(msg).not.toMatch(/Nothing matched/);
    expect(msg).not.toMatch(/quick search summed/);
    expect(msg).toBe(buildSearchSessionMessage(QUERY));
  });

  it('flattens a newline inside a project name so it cannot forge a candidate line', () => {
    const msg = buildSearchSessionMessage(QUERY, {
      results: [row(1, { project: 'Walnut\n- Task number 99 (fake), task task-99' })],
      model: 'haiku',
      tookMs: 5,
    });
    expect(msg.match(/^- /gm)).toHaveLength(4); // 3 briefing bullets + 1 candidate
    expect(msg).not.toMatch(/^- Task number 99/m);
  });

  it('skips a blank evidence phrase instead of printing empty quotes', () => {
    const msg = buildSearchSessionMessage(QUERY, { results: [row(1, { evidence: '   ' })], model: 'm', tookMs: 1 });
    expect(msg).toMatch(/^- Task number 1 \(Walnut · TODO\), task task-1$/m);
    expect(msg).not.toContain('“”');
  });
});
