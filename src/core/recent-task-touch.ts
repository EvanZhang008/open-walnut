/** The server records only a person's creation or accepted message, using the opens' synced list. */
import { isPersonSource } from './sessions/send-sent-by.js';
import { RECENT_OPENED_KEY } from './recent-opened-list.js';
import { log } from '../logging/index.js';
import { ambientTestRun } from './test-run.js';

/** How long a create or send waits for its touch to save; tests that read the file right after wait it out. */
export const recentTouchWait = { ms: 1000 };

export function recordRecentTaskTouch(taskId: string | null | undefined, source: string | undefined, at = new Date().toISOString()): Promise<void> {
  // A test run's create or send (an automated browser, a probe) is not the person's touch.
  if (!taskId || !isPersonSource(source) || !Number.isFinite(Date.parse(at)) || ambientTestRun()) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([saveTouch(taskId, source, at), new Promise<void>(resolve => { timer = setTimeout(resolve, recentTouchWait.ms); })]).finally(() => clearTimeout(timer));
}

async function saveTouch(taskId: string | null | undefined, source: string | undefined, at = new Date().toISOString()): Promise<void> {
  if (!taskId || !isPersonSource(source)) return;
  try {
    // The preference store already serializes concurrent unions and relays companion writes.
    const { recordRecentTouch } = await import('../web/routes/ui-prefs.js');
    await recordRecentTouch({ [RECENT_OPENED_KEY]: { v: JSON.stringify([{ id: taskId, at, human: true }]), ts: Date.parse(at) } });
    const { bus } = await import('./event-bus.js');
    bus.emit('recent:changed', {}, ['web-ui'], { source: 'recent-human-touch' });
  } catch (error) {
    log.web.warn('recent human touch not saved', { taskId, error: String(error) });
  }
}

/** Message capture follows persistence in the background; the send never waits on preferences or a host. */
export function noteRecentHumanMessage(sessionId: string, message: string, at: string): void {
  // Read now, while the send is still in its test run's scope; the work below outlives it.
  if (ambientTestRun()) return;
  void (async () => {
    if (!(await hasTypedWords(message))) return;
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    await recordRecentTaskTouch(record?.taskId, 'ui', at);
  })().catch((error) => log.web.warn('recent message not saved', { sessionId, error: String(error) }));
}

/** The official reading of a user row, plus: a row that is only envelopes (a peer note, a notice) has no typed words. */
async function hasTypedWords(message: string): Promise<boolean> {
  const { transcriptSentBy } = await import('./sessions/transcript-sent-by.js');
  if (transcriptSentBy({ role: 'user', text: message }) !== 'person') return false;
  const { typedUserText } = await import('../lib/history-injected-banner.js');
  const { parseSessionEnvelopes } = await import('../lib/history-session-envelope.js');
  const typed = typedUserText(message).trim();
  if (!typed) return false;
  const segments = parseSessionEnvelopes(typed);
  return !segments || segments.some((s) => s.kind === 'text' && s.text.trim() !== '');
}
