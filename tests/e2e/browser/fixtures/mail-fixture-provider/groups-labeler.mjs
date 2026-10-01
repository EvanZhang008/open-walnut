/**
 * The fixture's stand-in for the model that labels unread mail (sort-ai.ts). A test server never
 * reaches a real model, so this answers the labeling prompt deterministically from the words in each
 * mail, the way a model would: people writing to Robin are important, everything else is named by
 * its KIND ("Pager alerts", "Ticket updates"), and a name already in `groups` is reused verbatim.
 *
 * Modes (`POST /__fixture/label-model?mode=`): `ok` (default), `down` (throws), `invalid` (not JSON),
 * `partial` (answers only every other mail), `slow` (answers after 8 s). The mode lives on the shared
 * fixture state so a spec can flip it mid-run.
 */

/** Kind rules, first match wins: [pattern over "from subject", group name]. */
const KINDS = [
  [/\b(page|pager|on-?call|sensor|offline|gauge)\b/i, 'Pager alerts'],
  [/\b(ticket|change \d+|approval)\b/i, 'Ticket updates'],
  [/\b(pull request|review desk|code host|comment on)\b/i, 'Code reviews'],
  [/\b(build|deploy|pipeline)\b/i, 'Build results'],
  [/\b(automatic reply|out of (the )?office|away until)\b/i, 'Out of office'],
  [/\b(survey|tell us)\b/i, 'Surveys'],
  [/\b(payslip|payroll|statement|invoice|receipt)\b/i, 'Pay & statements'],
  [/\b(invitation|calendar|crew sync)\b/i, 'Calendar'],
  [/\b(bulletin|almanac|digest|weekly|newsletter|issue \d+|this month)\b/i, 'Newsletters'],
  [/\b(offer|deal|percent|arrivals|collection|picks|stock|colours|chandlery|shop|brand)\b/i, 'Shopping'],
  [/\b(timetable|terminal notice|crossing operations|ferry line)\b/i, 'Ferry notices'],
];

export function fixtureLabelAnswer(userContent, mode = 'ok') {
  if (mode === 'down') throw new Error('The fixture labeling model is down.');
  if (mode === 'invalid') return 'Here is how I would group these: mostly notifications.';
  let parsed = {};
  try { parsed = JSON.parse(userContent); } catch { /* answers even a prompt it cannot read */ }
  const known = Array.isArray(parsed.groups) ? parsed.groups : [];
  const reuse = (name) => known.find((one) => String(one).toLowerCase() === name.toLowerCase()) ?? name;
  const mails = Array.isArray(parsed.mails) ? parsed.mails : [];
  const answers = [];
  for (const mail of mails) {
    if (mode === 'partial' && mail.i % 2 === 1) continue;
    const text = `${mail.from ?? ''} ${mail.subject ?? ''}`;
    const person = mail.sender === 'person' || mail.sender === 'unknown';
    const kind = KINDS.find(([pattern]) => pattern.test(text));
    // A person writing to Robin (or in Cc) is important unless the mail is plainly automated.
    if (person && !kind && (mail.to === 'you' || mail.to === 'cc' || mail.to === 'unknown') && !mail.list) {
      answers.push({ i: mail.i, important: true, why: 'A person wrote to you' });
      continue;
    }
    if (person && !kind && mail.to === 'group') {
      answers.push({ i: mail.i, important: false, group: reuse('Group mail'), why: 'Sent to a group you are on' });
      continue;
    }
    const name = kind ? kind[1] : mail.list || mail.sender === 'marketing' ? 'Shopping' : 'Notifications';
    answers.push({ i: mail.i, important: false, group: reuse(name), why: kind ? `Automated ${name.toLowerCase()}` : 'Automated mail' });
  }
  return JSON.stringify({ mails: answers });
}

/** True for the labeling call (the rule model shares the seam but not the system prompt). */
export function isLabelRequest(request) {
  return typeof request?.system === 'string' && request.system.startsWith("You sort a person's unread email");
}

/** True for the group summary call (sort-group-summary.ts), which shares the labeling model. */
export function isSummaryRequest(request) {
  return typeof request?.system === 'string' && request.system.startsWith('You write the one-line summary under each group');
}

/** The first `n` words of a subject, without a reply prefix or a trailing number. */
function lead(subject, n = 4) {
  return String(subject ?? '').replace(/^(re|fwd?):\s*/i, '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

/**
 * A line per group the way a model would write one: what its two newest distinct mails are about.
 * Same modes as the labeling answer (`partial` answers every other group).
 */
export function fixtureSummaryAnswer(userContent, mode = 'ok') {
  if (mode === 'down') throw new Error('The fixture labeling model is down.');
  if (mode === 'invalid') return 'These groups are mostly notifications.';
  let parsed = {};
  try { parsed = JSON.parse(userContent); } catch { /* answers even a prompt it cannot read */ }
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  const out = [];
  for (const group of groups) {
    if (mode === 'partial' && group.g % 2 === 1) continue;
    const seen = [];
    for (const mail of Array.isArray(group.mails) ? group.mails : []) {
      const words = lead(mail.subject);
      if (words && !seen.some((one) => one.toLowerCase() === words.toLowerCase())) seen.push(words);
      if (seen.length === 2) break;
    }
    out.push({ g: group.g, summary: seen.length ? seen.join(' and ') : `About ${String(group.name ?? '').toLowerCase()}` });
  }
  return JSON.stringify({ groups: out });
}
