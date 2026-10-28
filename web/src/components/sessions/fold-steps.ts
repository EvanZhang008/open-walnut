/**
 * The line a fold of quiet steps reads: what happened, in order.
 *
 * A coordinating session takes in notices and peer messages between its answers
 * and works through each with a tool call or a one-line acknowledgement. Every
 * such stretch between two answers is one folded row (SessionChatHistory), and
 * its line says what the steps were, in the order they happened:
 * "From Walnut VP: Bun migration is top priority, acknowledged". A count ("4 hidden
 * turns", 2026-10-27, the user: "why show 4 hidden turns I am confused, just show
 * run xxx command receive xxx, and then ack xx") told the reader nothing.
 *
 * Neighbours of one kind read as one piece: two messages from the same sender are
 * "Received 2 messages from X", a stretch of tool calls is the tool-run phrase,
 * and the reasoning between two calls is part of them. Pure: the caller turns its
 * rows into steps.
 */
import type { EnvelopeSegment, SessionEnvelopePeer } from '@open-walnut/history-session-envelope';
import { noticeTitle } from './message-fold';
import { toolRunPhrase, type ToolRunMember } from './tool-run-phrase';

export type ReceivedKind = 'peer-note' | 'reply' | 'notification' | 'trigger' | 'other';

export type FoldStep =
  /** A message or notice the session received. `name`: who sent it, or for a
   *  notice whom it is about; `title`: its one-line TL;DR, when it has one. */
  | { kind: 'received'; from: ReceivedKind; name?: string; title?: string }
  /** Tool calls (not messages to someone). */
  | { kind: 'calls'; tools: ToolRunMember[] }
  /** A message the session sent to another task. */
  | { kind: 'sent' }
  /** A letter the session wrote to the person's inbox. */
  | { kind: 'inbox' }
  /** Reasoning with no words and no call. */
  | { kind: 'thought' }
  /** Context the CLI injected. */
  | { kind: 'context'; skill: boolean }
  /** The no-action line alone: the turn needed nothing. */
  | { kind: 'ack' }
  /** Words the session wrote on the way (folded before an answer). */
  | { kind: 'update' };

/** A received row's steps, one per envelope it holds; a row with none is one
 *  message from no one in particular. `nameOf` names a sender (peer-name.ts). */
export function envelopeSteps(
  segments: readonly EnvelopeSegment[] | null | undefined,
  nameOf: (peer: SessionEnvelopePeer) => string | undefined = (p) => p.title,
): FoldStep[] {
  const out: FoldStep[] = [];
  for (const s of segments ?? []) {
    if (s.kind !== 'envelope') continue;
    const e = s.envelope;
    const from = e.kind === 'peer-note' || e.kind === 'reply' || e.kind === 'notification' || e.kind === 'trigger' ? e.kind : 'other';
    // A notice's outcome sentence is its title; a trigger's note is only its clock.
    const title = e.kind === 'notification' ? noticeTitle(e.statusLine) : e.kind === 'trigger' ? undefined : e.title;
    const name = nameOf(e.peer);
    out.push({ kind: 'received', from, ...(name ? { name } : {}), ...(title ? { title } : {}) });
  }
  return out.length > 0 ? out : [{ kind: 'received', from: 'other' }];
}

const NAME_MAX = 40;
const TITLE_MAX = 64;

function clip(text: string, max: number): string {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  if (points.length <= max) return points.join('');
  const cut = points.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** "walnut tools call task_get" from a command line: its leading plain words, up to the first flag. */
export function commandHead(command: string): string | undefined {
  let line = command.split('\n').find((l) => l.trim())?.trim() ?? '';
  // A leading `cd <dir> &&` (or `;`), env assignments and wrappers such as
  // `sudo` say where or how, not what.
  for (;;) {
    const next = line
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
      .replace(/^(?:sudo|env|exec|nohup|time)\s+/, '');
    if (next === line) break;
    line = next;
  }
  const words: string[] = [];
  for (const w of line.split(/\s+/)) {
    if (!/^[\w./:@+-]+$/.test(w) || w.startsWith('-') || words.length >= 4) break;
    // A path reads as its file name; an address stays whole.
    words.push(w.includes('/') && !w.includes('://') ? basename(w) : w);
  }
  const head = words.join(' ');
  return head ? clip(head, NAME_MAX) : undefined;
}

/** One call, named: "ran walnut tools call task_get", "read a.ts", "used task_get". */
function oneCall(t: ToolRunMember): string | undefined {
  const input = t.input ?? {};
  const str = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : undefined);
  if (t.name === 'Bash') {
    const head = str('command') ? commandHead(str('command')!) : undefined;
    return head ? `ran ${head}` : undefined;
  }
  if (t.name === 'Read' && str('file_path')) return `read ${basename(str('file_path')!)}`;
  if ((t.name === 'Edit' || t.name === 'Write') && str('file_path')) return `edited ${basename(str('file_path')!)}`;
  const mcp = /^mcp__.+__(.+)$/.exec(t.name);
  if (!mcp) return undefined;
  // A Walnut send reads as the run phrase does ("sent a message").
  const phrase = toolRunPhrase([t]);
  if (/^(?:Sent|Wrote|Replied|Posted)\b/.test(phrase)) return phrase.replace(/^./, (c) => c.toLowerCase());
  return `used ${mcp[1]}`;
  return undefined;
}

function callsPhrase(tools: ToolRunMember[]): string {
  if (tools.length === 1) {
    const named = oneCall(tools[0]);
    if (named) return named;
  }
  return toolRunPhrase(tools).replace(/^./, (c) => c.toLowerCase());
}

function receivedPhrase(from: ReceivedKind, n: number, name?: string, title?: string): string {
  const who = name ? clip(name, NAME_MAX) : undefined;
  // A title is a clause in the line: no closing colon or full stop.
  const what = title ? clip(title.replace(/[\s:.\u3002]+$/, ''), TITLE_MAX) : undefined;
  if (from === 'trigger') {
    const label = who?.replace(/^Trigger:\s*/i, '');
    const base = label ? `trigger ${label}` : 'a trigger';
    return n === 1 ? `${base} fired` : `${base} fired ${n} times`;
  }
  if (n > 1) {
    if (from === 'notification') return who ? `${n} notices about ${who}` : `${n} notices`;
    return who ? `received ${n} messages from ${who}` : `received ${n} messages`;
  }
  if (from === 'notification') return who ? `notice about ${who}${what ? `: ${what}` : ''}` : `a notice${what ? `: ${what}` : ''}`;
  if (from === 'reply') return who ? `reply from ${who}${what ? `: ${what}` : ''}` : `a reply${what ? `: ${what}` : ''}`;
  if (who) return what ? `from ${who}: ${what}` : `received a message from ${who}`;
  return what ? `received a message: ${what}` : 'received a message';
}

/** The fold's line. Empty steps read "Thinking", the old empty-fold line. */
export function foldStepsPhrase(steps: readonly FoldStep[]): string {
  // Reasoning next to a call is that call's reasoning: it reads with it.
  const kept = steps.filter((s, i) => s.kind !== 'thought'
    || (steps[i - 1]?.kind !== 'calls' && steps[i + 1]?.kind !== 'calls'));
  const pieces: string[] = [];
  let k = 0;
  while (k < kept.length) {
    const s = kept[k];
    let j = k + 1;
    if (s.kind === 'received') {
      while (j < kept.length) {
        const n = kept[j];
        if (n.kind !== 'received' || n.from !== s.from || n.name !== s.name) break;
        j++;
      }
      pieces.push(receivedPhrase(s.from, j - k, s.name, s.title));
    } else if (s.kind === 'calls') {
      const tools = [...s.tools];
      for (; j < kept.length; j++) {
        const n = kept[j];
        if (n.kind === 'calls') tools.push(...n.tools);
        else if (n.kind !== 'thought') break;
      }
      pieces.push(callsPhrase(tools));
    } else if (s.kind === 'context') {
      let skills = 0;
      let other = 0;
      for (j = k; j < kept.length; j++) {
        const n = kept[j];
        if (n.kind !== 'context') break;
        if (n.skill) skills++; else other++;
      }
      if (skills > 0) pieces.push(skills === 1 ? 'loaded a skill' : `loaded ${skills} skills`);
      if (other > 0) pieces.push(other === 1 ? 'injected context' : `injected context ${other}×`);
    } else {
      while (j < kept.length && kept[j].kind === s.kind) j++;
      const n = j - k;
      if (s.kind === 'sent') pieces.push(n === 1 ? 'sent a message' : `sent ${n} messages`);
      else if (s.kind === 'inbox') pieces.push(n === 1 ? 'wrote to your inbox' : `wrote to your inbox ${n}\u00d7`);
      else if (s.kind === 'update') pieces.push(n === 1 ? 'an update' : `${n} updates`);
      else if (s.kind === 'thought') pieces.push('thought');
      else pieces.push('acknowledged');
    }
    k = j;
  }
  const phrase = pieces.join(', ');
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : 'Thinking';
}
