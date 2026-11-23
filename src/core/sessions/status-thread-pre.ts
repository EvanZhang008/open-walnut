/**
 * What a status answer does to its threads before its lines, in the same locked write
 * (status-threads.ts applyThreadLines, threads-store.ts writeOwnThreads `pre`):
 *   1. its joins: a message it says is another subject is split out (status-thread-split.ts)
 *   2. its merges, and the held titles the question asked about: merged or titled (status-thread-title.ts)
 *   3. the titles it gives (its title lines and its splits'): one that repeats another open thread is held
 * then the lines and marks as they read on the threads that result. Each run starts from the answer
 * alone, since a store write may run it again.
 */
import type { ThreadsFile, ThreadWriter } from '../org/threads-model.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import type { StatusReport } from '../user-status.js';
import { linesAfterSplits, splitJoins, type JoinSplits } from './status-thread-split.js';
import { holdRepeatTitles, settleHeldTitles, throughMerges, type HeldMerge } from './status-thread-title.js';
import type { StatusThreadLine, ThreadMark, ThreadMarks } from './status-threads.js';

export interface AnswerSteps {
  /** The steps, or none when the answer has nothing for them. */
  pre?: (cur: ThreadsFile) => { file: ThreadsFile; out: string[] };
  /** The answer's lines and marks on the threads after the steps (call after `pre` ran). */
  after: (lines: readonly StatusThreadLine[], marks: ThreadMarks) => { lines: StatusThreadLine[]; marks: ThreadMarks };
  /** What the steps did, for the log. */
  done: () => { opened: string[]; merged: Array<{ from: string; into: string }>; held: string[] };
}

export function answerSteps(report: Pick<StatusReport, 'joins_checked' | 'threads_split' | 'merges_checked' | 'threads_merge'>, marks: ThreadMarks, by: ThreadWriter, lang: LetterLang): AnswerSteps {
  const joins = report.joins_checked?.length ? report.joins_checked : null;
  const checks = report.merges_checked?.length ? report.merges_checked : null;
  let split: JoinSplits | null = null;
  let merged: HeldMerge[] = [];
  let holding = new Set<string>();
  let titles: Array<ThreadMark & { besides?: string }> = [...(marks.titles ?? [])];
  const merges = report.threads_merge?.length ? report.threads_merge : null;
  const pre = joins || checks || merges || marks.titles ? (cur: ThreadsFile) => {
    const at = new Date().toISOString();
    const out: string[] = [];
    titles = [...(marks.titles ?? [])];
    split = null;
    merged = [];
    if (joins) {
      const s = splitJoins(cur, joins, report.threads_split ?? [], by, at, lang);
      split = s;
      cur = s.file;
      out.push(...s.opened.map((o) => o.id));
      // Not held for repeating the thread it was split from: the answer just said it is another subject.
      titles = [...titles, ...s.opened.map((o) => ({ id: o.id, title: o.line.title, besides: o.line.id }))];
    }
    if (checks || merges) {
      const s = settleHeldTitles(cur, checks ?? [], merges ?? [], by, at);
      ({ file: cur, merged } = s);
      out.push(...merged.map((m) => m.into), ...s.titled);
    }
    holding = new Set();
    if (titles.length) ({ file: cur, held: holding } = holdRepeatTitles(cur, titles, at));
    return { file: cur, out };
  } : undefined;
  return {
    ...(pre ? { pre } : {}),
    after: (lines, m) => {
      const s = split as JoinSplits | null;
      const named = titles.filter((t) => !holding.has(t.id));
      // A merged thread's line and marks speak for the thread it went into (review: neither is lost).
      const seen = throughMerges(m.seen ?? [], merged);
      const titled = throughMerges(named, merged);
      return {
        lines: throughMerges(s ? linesAfterSplits(lines, s) : lines, merged),
        marks: { ...(seen.length ? { seen } : {}), ...(titled.length ? { titles: titled } : {}) },
      };
    },
    done: () => ({
      opened: (split as JoinSplits | null)?.opened.map((o) => o.id) ?? [],
      merged: merged.map((m) => ({ from: m.from, into: m.into })),
      held: [...holding],
    }),
  };
}
