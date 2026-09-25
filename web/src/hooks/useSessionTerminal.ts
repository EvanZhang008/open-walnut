/**
 * useSessionTerminal — drives the WS lifecycle for one embedded terminal.
 *
 * Owns: open/attach RPC, subscription to `terminal:data:<id>` / `terminal:exit:<id>`,
 * and reconnect handling (`_ws:reconnected` → try attach, fall back to open which
 * re-attaches the persistent dtach session). The xterm instance itself is owned by
 * the component — this hook just calls `onData` with incoming bytes and exposes
 * `sendInput` / `sendResize` / `kill` / `retry`.
 *
 * Open outcomes: a persistent terminal (dtach), a PLAIN one (`plain` is set:
 * dtach unavailable, the shell dies with its connection, the UI must say so),
 * or `ssh_failed` (blocking, no terminal). `retry` re-probes on the server and
 * upgrades a plain shell to a persistent one when dtach became available.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from './useWebSocket';
import {
  terminalOpen,
  terminalAttach,
  terminalInput,
  terminalResize,
  terminalClose,
  terminalKill,
  type TerminalOpenPlain,
  type TerminalSshFailed,
} from '@/api/terminal';
import { log } from '@/utils/log';

export type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'ssh_failed' | 'error' | 'exited';

interface UseSessionTerminalOpts {
  sessionId: string;
  enabled: boolean;
  /** Called with incoming terminal bytes (write to xterm). */
  onData: (data: string) => void;
  /** Called when the pty exits. */
  onExit?: (exitCode: number, signal: number | null) => void;
  /** Current terminal size — read at open/attach time. */
  getSize: () => { cols: number; rows: number };
}

interface UseSessionTerminalReturn {
  status: TerminalStatus;
  /** Set while the open terminal is a plain, non-persistent shell. */
  plain: TerminalOpenPlain | null;
  /** Set when ssh failed and there is no terminal (blocking card). */
  sshFailed: TerminalSshFailed | null;
  errorMessage: string | null;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Explicitly destroy (kills dtach). */
  kill: () => void;
  /** Re-probe dtach and re-open (upgrades a plain shell when dtach is available). */
  retry: () => void;
}

export function useSessionTerminal(opts: UseSessionTerminalOpts): UseSessionTerminalReturn {
  const { sessionId, enabled, onData, onExit, getSize } = opts;
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [plain, setPlain] = useState<TerminalOpenPlain | null>(null);
  const [sshFailed, setSshFailed] = useState<TerminalSshFailed | null>(null);
  // Read inside open() without making it depend on render state.
  const wasPlainRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const terminalIdRef = useRef<string | null>(null);
  // Keep latest callbacks in refs so the open/attach logic stays stable.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const getSizeRef = useRef(getSize);
  getSizeRef.current = getSize;
  // Coalesce concurrent open() calls. The mount effect and the
  // `_ws:reconnected` handler can both fire open() before the first RPC
  // resolves; without this guard we'd send two terminal:open RPCs.
  const openingRef = useRef(false);

  const open = useCallback(async (opts: { reprobe?: boolean } = {}) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const { cols, rows } = getSizeRef.current();
    setStatus('connecting');
    setSshFailed(null);
    setErrorMessage(null);
    try {
      const res = await terminalOpen(sessionId, cols, rows, opts);
      if (!res.ok) {
        terminalIdRef.current = null;
        wasPlainRef.current = false;
        setPlain(null);
        setSshFailed(res);
        setStatus('ssh_failed');
        log.warn('terminal', 'open rejected: SSH_FAILED', { sessionId, host: res.host });
        return;
      }
      terminalIdRef.current = res.terminalId;
      if (res.persistent) {
        // The upgrade kept this xterm; mark where the new shell begins.
        if (wasPlainRef.current) onDataRef.current('\r\n\x1b[90m[persistent shell started]\x1b[0m\r\n');
        wasPlainRef.current = false;
        setPlain(null);
      } else {
        wasPlainRef.current = true;
        setPlain(res);
        log.warn('terminal', 'opened a plain shell (not persistent)', { sessionId, host: res.host, reason: res.reason });
      }
      setStatus('ready');
      log.info('terminal', 'opened', { sessionId, terminalId: res.terminalId, persistent: res.persistent });
    } catch (err) {
      terminalIdRef.current = null;
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
      log.warn('terminal', 'open failed', { sessionId, error: String(err) });
    } finally {
      openingRef.current = false;
    }
  }, [sessionId]);

  // Open when enabled; tear down (detach, keep dtach session) when disabled/unmounted.
  useEffect(() => {
    if (!enabled) return;
    void open();
    return () => {
      const id = terminalIdRef.current;
      if (id) {
        terminalClose(id).catch(() => { /* best-effort */ });
      }
      terminalIdRef.current = null;
    };
  }, [enabled, open]);

  // Live output for this terminal. NOTE: we subscribe by sessionId because the
  // backend sets terminalId == sessionId (one terminal per session — see
  // TerminalManager.spawnTerminal). If that coupling is ever broken (e.g.
  // terminalId becomes a UUID), this subscription must switch to terminalIdRef
  // or events will silently stop arriving.
  useEvent(`terminal:data:${sessionId}`, (data) => {
    const d = data as { data?: string };
    if (typeof d?.data === 'string') onDataRef.current(d.data);
  });

  // pty exit.
  useEvent(`terminal:exit:${sessionId}`, (data) => {
    const d = data as { exitCode?: number; signal?: number | null };
    setStatus('exited');
    onExitRef.current?.(d?.exitCode ?? 0, d?.signal ?? null);
    log.info('terminal', 'exited', { sessionId, exitCode: d?.exitCode });
  });

  // On WS reconnect: try cheap attach (pty still alive in grace window);
  // on failure, reopen — server re-attaches the persistent dtach session.
  useEvent('_ws:reconnected', () => {
    if (!enabled) return;
    const id = terminalIdRef.current;
    const { cols, rows } = getSizeRef.current();
    if (id) {
      terminalAttach(id, cols, rows)
        .then((r) => {
          if (r.ok) {
            setStatus('ready');
            log.info('terminal', 'reattached', { sessionId, terminalId: id });
          } else {
            void open();
          }
        })
        .catch(() => { void open(); });
    } else {
      void open();
    }
  });

  const sendInput = useCallback((data: string) => {
    const id = terminalIdRef.current;
    if (id) terminalInput(id, data).catch(() => { /* dropped on disconnect */ });
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const id = terminalIdRef.current;
    if (id) terminalResize(id, cols, rows).catch(() => { /* dropped on disconnect */ });
  }, []);

  const kill = useCallback(() => {
    const id = terminalIdRef.current;
    if (id) {
      terminalKill(id).catch(() => { /* best-effort */ });
      terminalIdRef.current = null;
      setStatus('exited');
    }
  }, []);

  const retry = useCallback(() => { void open({ reprobe: true }); }, [open]);

  return { status, plain, sshFailed, errorMessage, sendInput, sendResize, kill, retry };
}
