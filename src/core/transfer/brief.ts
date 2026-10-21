/**
 * The handoff brief for a transfer in `brief` mode: what a fresh session on
 * another engine or host needs to pick the work up, written by the main model
 * from the source conversation. When the model is unavailable the brief is the
 * newest part of the transcript instead, so a transfer never fails on it.
 */
import type { SessionHistoryMessage } from '../session-history.js';
import { renderTranscriptSeed } from './transcript.js';
import { log } from '../../logging/index.js';

const BRIEF_INPUT_CHARS = 160_000;
const BRIEF_TIMEOUT_MS = 120_000;

const BRIEF_SYSTEM = [
  'You write handoff briefs. A coding session is moving to a new agent that cannot see the old conversation.',
  'From the transcript, write a brief in markdown with these sections, each short and concrete:',
  '## Goal (what the user wants, in their words where possible)',
  '## Where it stands (what is done, what is in progress, what was verified)',
  '## Decisions (choices made and why, including what the user approved or rejected)',
  '## Files and commands (files changed or important, commands that build, test or run it)',
  '## Environment needs (languages, tools, packages, services, credentials the work depends on; say how they were set up if the transcript shows it)',
  '## Open questions and risks',
  '## Next steps (ordered)',
  'Never invent facts the transcript does not support; write "unknown" instead. No preamble.',
  'Describe only the transcript: your own environment (working directory, tools, machine) is not the session\'s, so never mention it.',
].join('\n');

export interface HandoffBrief { text: string; byModel: boolean }

export async function writeHandoffBrief(
  messages: readonly SessionHistoryMessage[],
  meta: { title: string; sourceEngine: string; sourceHost: string },
): Promise<HandoffBrief> {
  const seed = renderTranscriptSeed(messages, BRIEF_INPUT_CHARS);
  if (!seed.text) return { text: '_The source conversation was empty._', byModel: false };
  try {
    const { sendMessage } = await import('../../model/model.js');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);
    try {
      const result = await sendMessage({
        system: BRIEF_SYSTEM,
        messages: [{
          role: 'user',
          content: `Task: ${meta.title}\nThe old session ran ${meta.sourceEngine} on ${meta.sourceHost}.\n\nTranscript:\n${seed.text}\n\nWrite the brief.`,
        }],
        config: { maxTokens: 4_000 },
        signal: controller.signal,
      });
      const text = (result.content ?? [])
        .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
        .join('')
        .trim();
      if (text) return { text, byModel: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.session.warn('transfer: the handoff brief model call failed; using the transcript tail', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const tail = renderTranscriptSeed(messages, 24_000);
  return { text: `_No summary could be written; the newest part of the conversation follows._\n\n${tail.text}`, byModel: false };
}
