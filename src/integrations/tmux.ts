import { execSync } from 'node:child_process';

export interface TmuxSession {
  name: string;
  created: string;
  attached: boolean;
}

/**
 * Check if tmux is installed and available.
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we are currently inside a tmux session.
 */
export function isInsideTmux(): boolean {
  return !!process.env['TMUX'];
}

/**
 * Create a new tmux session with an optional command.
 */
export function createSession(name: string, cwd: string, command?: string): void {
  const cmd = command
    ? `tmux new-session -d -s ${esc(name)} -c ${esc(cwd)} ${esc(command)}`
    : `tmux new-session -d -s ${esc(name)} -c ${esc(cwd)}`;
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * List active tmux sessions.
 */
export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}\t#{session_created}\t#{session_attached}"',
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created, attached] = line.split('\t');
        return {
          name: name ?? '',
          created: created ?? '',
          attached: attached === '1',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Attach to an existing tmux session.
 * If already inside tmux, switch to the session instead.
 */
export function attachSession(name: string): void {
  if (isInsideTmux()) {
    execSync(`tmux switch-client -t ${esc(name)}`, { stdio: 'inherit' });
  } else {
    execSync(`tmux attach-session -t ${esc(name)}`, { stdio: 'inherit' });
  }
}

/**
 * Send keys to a tmux session.
 */
export function sendKeys(sessionName: string, keys: string): void {
  execSync(`tmux send-keys -t ${esc(sessionName)} ${esc(keys)} Enter`, { stdio: 'pipe' });
}

/**
 * Send literal text to a tmux session without appending Enter.
 * Uses `tmux send-keys -l` for literal mode.
 */
export function sendKeysLiteral(sessionName: string, text: string): void {
  execSync(`tmux send-keys -t ${esc(sessionName)} -l ${esc(text)}`, { stdio: 'pipe' });
}

/**
 * Send a raw tmux key (e.g. Enter, Tab, Escape) without literal mode.
 */
export function sendKeysRaw(sessionName: string, key: string): void {
  execSync(`tmux send-keys -t ${esc(sessionName)} ${key}`, { stdio: 'pipe' });
}

/**
 * Capture the visible pane text from a tmux session.
 * Returns an array of lines (plain text, no ANSI codes).
 */
export function capturePaneText(sessionName: string): string[] {
  const output = execSync(`tmux capture-pane -t ${esc(sessionName)} -p`, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return output.split('\n');
}

/**
 * Send an SGR mouse scroll event to a tmux session.
 * Writes the escape sequence directly to the pane's pty via tmux's
 * buffered-read file descriptor to ensure atomic delivery.
 * @param direction - 'up' or 'down'
 * @param col - 1-based column position
 * @param row - 1-based row position
 */
export function sendMouseScroll(
  sessionName: string,
  direction: 'up' | 'down',
  col: number,
  row: number,
): void {
  const btn = direction === 'up' ? 64 : 65;
  // Use bash $'...' syntax to embed ESC as \033, sent via -l (literal)
  // to ensure the entire sequence arrives as one atomic read
  execSync(
    `tmux send-keys -t ${esc(sessionName)} -l -- $'\\033[<${btn};${col};${row}M'`,
    { stdio: 'pipe', shell: '/bin/bash' },
  );
}

/**
 * Kill a tmux session.
 */
export function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${esc(name)}`, { stdio: 'pipe' });
  } catch {
    // Session may already be dead
  }
}

/**
 * Build the standard session name for a walnut-managed tmux session.
 */
export function buildSessionName(project: string, taskId?: string): string {
  const sanitized = project.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return taskId ? `walnut-${sanitized}-${taskId}` : `walnut-${sanitized}`;
}

/**
 * Shell-escape a string for use in execSync commands.
 */
function esc(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
