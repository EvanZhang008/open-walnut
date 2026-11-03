/**
 * The words the terminal status pill shows for each state of useSessionTerminal.
 *
 * The hook's state is a code (`ssh_failed`, `end_unconfirmed`); the pill used to
 * print it raw, and CSS uppercased it to END_UNCONFIRMED. Every state has a plain
 * label here; the map is a Record over the one list the type is built from, so a
 * new state without a label fails the type check. A value no build knows (an
 * older or newer hook) reads "Unknown", never the code.
 */

export const TERMINAL_STATUSES = ['idle', 'connecting', 'ready', 'ssh_failed', 'error', 'exited', 'ending', 'end_unconfirmed'] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: 'Starting',
  connecting: 'Connecting',
  ready: 'Connected',
  ssh_failed: "Can't reach host",
  error: "Couldn't open",
  exited: 'Ended',
  ending: 'Ending',
  end_unconfirmed: 'End not confirmed',
};

export const UNKNOWN_TERMINAL_STATUS_LABEL = 'Unknown';

export function isTerminalStatus(value: unknown): value is TerminalStatus {
  return typeof value === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function terminalStatusLabel(status: unknown): string {
  return isTerminalStatus(status) ? TERMINAL_STATUS_LABEL[status] : UNKNOWN_TERMINAL_STATUS_LABEL;
}

/** The pill's colour class: by the code, `unknown` (neutral) for a value no build knows. */
export function terminalStatusClass(status: unknown): string {
  return `session-terminal-status session-terminal-status-${isTerminalStatus(status) ? status : 'unknown'}`;
}
