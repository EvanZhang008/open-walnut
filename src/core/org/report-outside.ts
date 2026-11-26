/**
 * The org report (morning-report.ts) as an agent reads it from org_report. Pure.
 */
import { frameOutsideData } from '../outside-content.js';
import type { MorningReport } from './morning-report.js';

/** Where an agent's report names a quoted outside subject: the subject itself is in `quoted_subjects`. */
export const quotedSubjectRef = (letterId: string): string => `[letter ${letterId}: its subject is in quoted_subjects]`;

/**
 * The report as an agent reads it (org_report): Walnut's own lines stay as they are, and each subject
 * it quotes of a letter whose words are outside (a mail plugin's approval letter, a router's "For you")
 * is replaced by a reference, the subjects themselves riding one outside-data envelope. The person's
 * letter keeps the subjects in place. 2026-11-26 review M4.
 */
export function agentReport(report: MorningReport): Record<string, unknown> {
  const { quoted, ...rest } = report;
  if (!quoted?.length) return rest;
  let markdown = report.markdown;
  let text = report.text;
  // The templates quote a subject in ASCII double quotes in every language (walnut-letters/org-report.ts).
  // Longest first: a subject that holds another's quoted form (`Re: "Invoice"` beside `Invoice`) is
  // swapped whole before the shorter one could break it apart and leave the rest of it in place.
  const longestFirst = [...quoted].sort((a, b) => b.subject.length - a.subject.length);
  for (const q of longestFirst) {
    const shown = `"${q.subject}"`;
    markdown = markdown.split(shown).join(quotedSubjectRef(q.letterId));
    text = text.split(shown).join(quotedSubjectRef(q.letterId));
  }
  const subjects = quoted.map((q) => ({ letterId: q.letterId, from: q.source, subject: q.subject }));
  return { ...rest, markdown, text, quoted_subjects: frameOutsideData({ source: 'letter subjects' }, subjects) };
}
