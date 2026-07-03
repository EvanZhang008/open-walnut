/**
 * Terminal RPC — thin typed wrappers over wsClient.sendRpc for the embedded
 * terminal (xterm.js ↔ node-pty/dtach). Shares the single /ws socket.
 */

import { wsClient } from './ws';

export interface TerminalOpenOk {
  ok: true;
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalNoDtach {
  ok: false;
  code: 'NO_DTACH';
  host?: string;
  installHint: string;
}

export type TerminalOpenResult = TerminalOpenOk | TerminalNoDtach;

export function terminalOpen(sessionId: string, cols: number, rows: number): Promise<TerminalOpenResult> {
  return wsClient.sendRpc<TerminalOpenResult>('terminal:open', { sessionId, cols, rows });
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
