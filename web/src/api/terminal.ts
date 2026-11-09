/**
 * Terminal RPC — thin typed wrappers over wsClient.sendRpc for the embedded
 * terminal (xterm.js ↔ node-pty/dtach). Shares the single /ws socket.
 */

import { wsClient } from './ws';

interface TerminalOpenIds {
  ok: true;
  terminalId: string;
  cols: number;
  rows: number;
}

/** The shell runs under dtach on the target: it survives disconnects. */
export interface TerminalOpenPersistent extends TerminalOpenIds {
  persistent: true;
}

/**
 * dtach was unavailable, so the server opened a plain shell that dies with its
 * connection. The UI must say so (badge + notice) and offer Retry.
 */
export interface TerminalOpenPlain extends TerminalOpenIds {
  persistent: false;
  reason: 'no_compiler' | 'build_failed';
  host?: string;
  /** Full sentence (tooltip). */
  installHint: string;
  /** Just the command (what Copy copies). */
  installCommand: string;
  /** Compiler stderr tail for build_failed. */
  detail?: string;
}

/** ssh itself failed: nothing ran on the host, so there is no terminal. */
export interface TerminalSshFailed {
  ok: false;
  code: 'SSH_FAILED';
  host: string;
  detail: string;
  hint: string;
}

export type TerminalOpenResult = TerminalOpenPersistent | TerminalOpenPlain | TerminalSshFailed;

/**
 * `reprobe` (Retry): re-check dtach now and upgrade a plain shell if it is available.
 * `slot`: which of the session's terminals (1 to 8, default 1); the answer's
 * terminalId is its key (`@open-walnut/terminal-key`).
 */
export function terminalOpen(sessionId: string, cols: number, rows: number, opts: { reprobe?: boolean; slot?: number } = {}): Promise<TerminalOpenResult> {
  return wsClient.sendRpc<TerminalOpenResult>('terminal:open', {
    sessionId, cols, rows,
    ...(opts.reprobe ? { reprobe: true } : {}),
    ...(opts.slot && opts.slot !== 1 ? { slot: opts.slot } : {}),
  });
}

/**
 * The slots of a session's terminals that run now (a dtach socket on its host, or
 * a shell this server holds). `listed: false`: the host could not be asked, so
 * the slots are only the ones the server holds.
 */
export function terminalList(sessionId: string): Promise<{ slots: number[]; listed: boolean }> {
  return wsClient.sendRpc<{ slots: number[]; listed: boolean }>('terminal:list', { sessionId });
}

/**
 * The slot for a new terminal of a session: free on the host, in no other
 * window's layout lately (the server holds each answer for a minute), and not in
 * `exclude` (this page's own). null when every slot is taken.
 */
export function terminalReserve(sessionId: string, exclude: number[]): Promise<{ slot: number | null }> {
  return wsClient.sendRpc<{ slot: number | null }>('terminal:reserve', { sessionId, exclude });
}

/**
 * The directory the terminal's shell is in now (after a `cd`), and the root of
 * the git repository that holds it; null when it cannot be told / is in none.
 */
export function terminalCwd(terminalId: string): Promise<{ cwd: string | null; root?: string | null }> {
  return wsClient.sendRpc<{ cwd: string | null; root?: string | null }>('terminal:cwd', { terminalId });
}

export function terminalAttach(terminalId: string, cols: number, rows: number): Promise<{ ok: boolean }> {
  return wsClient.sendRpc<{ ok: boolean }>('terminal:attach', { terminalId, cols, rows });
}

export function terminalInput(terminalId: string, data: string): Promise<void> {
  return wsClient.sendRpc<void>('terminal:input', { terminalId, data });
}

export function terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return wsClient.sendRpc<void>('terminal:resize', { terminalId, cols, rows });
}

/** Collapse UI / detach — keeps the dtach session alive. */
export function terminalClose(terminalId: string): Promise<void> {
  return wsClient.sendRpc<void>('terminal:close', { terminalId });
}

/**
 * `killed: false, unconfirmed: true`: the dtach master could not be proved or
 * stopped, so the shell may still run. `reason` says why (short, English).
 */
export interface TerminalKillResult {
  killed: boolean;
  unconfirmed?: boolean;
  reason?: string;
}

/** Explicitly destroy the terminal — kills the persistent dtach session. */
export function terminalKill(terminalId: string): Promise<TerminalKillResult> {
  return wsClient.sendRpc<TerminalKillResult>('terminal:kill', { terminalId });
}

/**
 * Prewarm the remote host's ssh ControlMaster + dtach ahead of the click, so a
 * later terminalOpen is ~0.2s instead of ~2.5s. Fire-and-forget; no-op for
 * local sessions (server returns warmed:false). Safe to call repeatedly.
 */
export function terminalPrewarm(sessionId: string): Promise<{ warmed: boolean }> {
  return wsClient.sendRpc<{ warmed: boolean }>('terminal:prewarm', { sessionId });
}
