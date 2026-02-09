/**
 * Terminal utilities for TUI rendering.
 * Uses raw ANSI escape codes - zero external dependencies.
 */

export interface TerminalSize {
  width: number;
  height: number;
}

/**
 * Get current terminal dimensions, clamped to sane bounds.
 */
export function getTerminalSize(): TerminalSize {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return {
    width: Math.max(cols, 80),
    height: Math.max(rows, 24),
  };
}

/**
 * Enter the alternate screen buffer.
 */
export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h');
}

/**
 * Exit the alternate screen buffer.
 */
export function exitAltScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

/**
 * Hide the terminal cursor.
 */
export function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

/**
 * Show the terminal cursor.
 */
export function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

/**
 * Move cursor to a specific row and column (1-indexed).
 */
export function moveTo(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

/**
 * Clear the entire screen.
 */
export function clearScreen(): void {
  process.stdout.write('\x1b[2J');
}

/**
 * Enable raw mode on stdin so we get individual key presses.
 */
export function enableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
  }
}

/**
 * Disable raw mode on stdin.
 */
export function disableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/**
 * Enable SGR mouse mode (scroll events with coordinates).
 * SGR mode uses \x1b[<btn;col;row[Mm] format.
 */
export function enableMouseMode(): void {
  // Enable mouse tracking (any-event) + SGR extended coordinates
  process.stdout.write('\x1b[?1003h\x1b[?1006h');
}

/**
 * Disable SGR mouse mode.
 */
export function disableMouseMode(): void {
  process.stdout.write('\x1b[?1006l\x1b[?1003l');
}
