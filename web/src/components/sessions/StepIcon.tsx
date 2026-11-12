/**
 * The one icon set every step of a session turn wears (2026-11-11, the user picked
 * design 1 of session-chat-designs.html, learned from T3 Code): a 16px line icon
 * (lucide's paths) at the head of each row, whatever the row is: a command, a file
 * read or edit, a search, a Walnut op, a message sent or received, a subagent,
 * reasoning. The row's state never swaps the icon for a glyph; a failed or denied
 * step colours it (step-rows.css), and only a failure turns it into the alert.
 */
import type { SessionEnvelopeKind } from '@open-walnut/history-session-envelope';

export type StepIconName =
  | 'terminal' | 'eye' | 'pen' | 'search' | 'bot' | 'thought' | 'send' | 'reply-out' | 'received'
  | 'wrench' | 'alert' | 'ban' | 'chevron' | 'message' | 'monitor' | 'clock' | 'plus' | 'walnut'
  | 'globe' | 'list' | 'zap' | 'app' | 'bell' | 'question' | 'book';

const PATHS: Record<StepIconName, string[]> = {
  terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
  eye: ['M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6'],
  pen: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.38 2.63a1 1 0 0 1 3 3l-9.02 9.01a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 1 0 0-16', 'M21 21l-4.3-4.3'],
  bot: ['M12 8V4H8', 'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
  thought: ['M9 18h6', 'M10 22h4', 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z'],
  send: ['M7 7h10v10', 'M7 17L17 7'],
  'reply-out': ['M15 14l5-5-5-5', 'M4 20v-7a4 4 0 0 1 4-4h12'],
  received: ['M17 7L7 17', 'M17 17H7V7'],
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  alert: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20', 'M12 8v4', 'M12 16h.01'],
  ban: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20', 'M4.93 4.93l14.14 14.14'],
  chevron: ['M9 18l6-6-6-6'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2', 'M8 21h8', 'M12 17v4'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20', 'M12 6v6l4 2'],
  plus: ['M5 12h14', 'M12 5v14'],
  walnut: ['M12 3c-4.5 0-7 3.6-7 8s2.5 10 7 10 7-5.6 7-10-2.5-8-7-8z', 'M12 3v18'],
  globe: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20', 'M2 12h20', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'],
  list: ['M3 6h.01', 'M3 12h.01', 'M3 18h.01', 'M8 6h13', 'M8 12h13', 'M8 18h13'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  app: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2', 'M9 9h6v6H9z'],
  bell: ['M10.27 21a2 2 0 0 0 3.46 0', 'M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33'],
  question: ['M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  book: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20'],
};

export function StepIcon({ name, className = '' }: { name: StepIconName; className?: string }) {
  return (
    <svg className={`step-icon ${className}`.trim()} data-step-icon={name} viewBox="0 0 24 24" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** The icon a tool call's row wears, by what the tool does. */
export function toolStepIcon(name: string): StepIconName {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell' || name === 'KillBash') return 'terminal';
  if (name === 'Read' || name === 'NotebookRead' || name === 'LS') return 'eye';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'pen';
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return 'search';
  if (name === 'Agent' || name === 'Task') return 'bot';
  if (name === 'WebFetch' || name === 'WebSearch') return 'globe';
  if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList') return 'list';
  if (name === 'ScheduleWakeup' || name === 'CronCreate' || name === 'CronDelete' || name === 'CronList') return 'clock';
  if (name === 'AskUserQuestion') return 'question';
  if (name === 'Skill') return 'book';
  if (/^mcp__walnut__host_(exec|copy)/.test(name)) return 'monitor';
  // A light subagent on another engine (Walnut's subagent_run): an agent like the Agent tool's.
  if (/^mcp__walnut__subagent_/.test(name)) return 'bot';
  if (name.startsWith('mcp__walnut__')) return 'walnut';
  return 'wrench';
}

export { toolDisplayName } from '@open-walnut/tool-header-text';

/** A received message's icon, by what kind of message it is. */
export function envelopeStepIcon(kind: SessionEnvelopeKind): StepIconName {
  switch (kind) {
    case 'notification': return 'bell';
    case 'trigger': return 'zap';
    case 'app-state': return 'app';
    case 'reply-request': return 'message';
    default: return 'received';
  }
}
