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

/** `reprobe` (Retry): re-check dtach now and upgrade a plain shell if it is available. */
export function terminalOpen(sessionId: string, cols: number, rows: number, opts: { reprobe?: boolean } = {}): Promise<TerminalOpenResult> {
  return wsClient.sendRpc<TerminalOpenResult>('terminal:open', { sessionId, cols, rows, ...(opts.reprobe ? { reprobe: true } : {}) });
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

/** Explicitly destroy the terminal — kills the persistent dtach session. */
export function terminalKill(terminalId: string): Promise<{ killed: boolean }> {
  return wsClient.sendRpc<{ killed: boolean }>('terminal:kill', { terminalId });
}

/**
 * Prewarm the remote host's ssh ControlMaster + dtach ahead of the click, so a
 * later terminalOpen is ~0.2s instead of ~2.5s. Fire-and-forget; no-op for
 * local sessions (server returns warmed:false). Safe to call repeatedly.
 */
export function terminalPrewarm(sessionId: string): Promise<{ warmed: boolean }> {
  return wsClient.sendRpc<{ warmed: boolean }>('terminal:prewarm', { sessionId });
}
