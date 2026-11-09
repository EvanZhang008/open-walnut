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
 *
 * `kill` resolves true only when the server confirmed the end. Otherwise the
 * status is `end_unconfirmed` with `endUnconfirmed` set to the reason, and the
 * terminal id is kept so a second End reaches the same dtach session. An End
 * answer that lands after the view unmounted or reopened resolves false and
 * changes nothing.
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
import { awaitEndAnswer, createEndGuard } from './terminal-end-model';
import type { TerminalStatus } from './terminal-status-label';
import { terminalKeyFor } from '@open-walnut/terminal-key';

// The states and their pill labels live in terminal-status-label.ts.
export type { TerminalStatus };

/** Keys typed before the open answers that are kept for it (a paste larger than this is dropped). */
const PENDING_INPUT_MAX = 4096;

export type TerminalEndedBy = 'window' | 'other' | null;

interface UseSessionTerminalOpts {
  sessionId: string;
  /** Which of the session's terminals (1 = its first; see `@open-walnut/terminal-key`). */
  slot?: number;
  enabled: boolean;
  /** Called with incoming terminal bytes (write to xterm). */
  onData: (data: string) => void;
  /**
   * Called when the pty exits. `endedBy`: 'window' when another window ended it
   * (End, or a reopen that replaced it), 'other' when something else did (a
   * tool, an agent, the server), null when the shell itself exited.
   */
  onExit?: (exitCode: number, signal: number | null, endedBy: TerminalEndedBy) => void;
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
  /** Why the last End could not be confirmed (status `end_unconfirmed`), else null. */
  endUnconfirmed: string | null;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Explicitly destroy (kills dtach). True only when the server confirmed the end. */
  kill: () => Promise<boolean>;
  /** Re-probe dtach and re-open (upgrades a plain shell when dtach is available). */
  retry: () => void;
}

export function useSessionTerminal(opts: UseSessionTerminalOpts): UseSessionTerminalReturn {
  const { sessionId, enabled, onData, onExit, getSize } = opts;
  const slot = opts.slot ?? 1;
  // The terminal's key: its terminalId, and the name of its events. Known before
  // the open answers, since the server replays the backlog while it opens.
  const key = terminalKeyFor(sessionId, slot);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const statusRef = useRef(status);
  statusRef.current = status;
  const [plain, setPlain] = useState<TerminalOpenPlain | null>(null);
  const [sshFailed, setSshFailed] = useState<TerminalSshFailed | null>(null);
  // Read inside open() without making it depend on render state.
  const wasPlainRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [endUnconfirmed, setEndUnconfirmed] = useState<string | null>(null);
  // An End in flight (one per generation), and an End left unconfirmed: a reconnect
  // must not reopen then, since a reopen starts a new shell when the old one is gone.
  // Keyed by generation so a new session or reopen is never blocked by an old End.
  const [endGuard] = useState(createEndGuard);
  const unconfirmedRef = useRef(false);
  // Bumped by every (re)open and by unmount: an End answer that lands after
  // either belongs to a view that is gone, and is dropped (no state, no close).
  const genRef = useRef(0);

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
  const openPromiseRef = useRef<Promise<void> | null>(null);
  // An open that answers after the view unmounted detaches what it opened, so no
  // shell stays attached to this socket with nobody looking (the reapers would
  // count it as viewed forever). StrictMode's remount sets it back before then.
  const mountedRef = useRef(true);
  // Keys typed while the open is on its way (a new terminal takes the focus at
  // once): sent as soon as it answers, so the first keys are not lost.
  const pendingInputRef = useRef('');

  const openOnce = useCallback(async (opts: { reprobe?: boolean }) => {
    genRef.current++;
    const { cols, rows } = getSizeRef.current();
    setStatus('connecting');
    setSshFailed(null);
    setErrorMessage(null);
    setEndUnconfirmed(null);
    unconfirmedRef.current = false;
    try {
      const res = await terminalOpen(sessionId, cols, rows, { ...opts, slot });
      if (!mountedRef.current) {
        if (res.ok) terminalClose(res.terminalId).catch(() => { /* best-effort */ });
        log.info('terminal', 'open answered after the view closed; detached', { sessionId, slot });
        return;
      }
      if (!res.ok) {
        pendingInputRef.current = '';
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
      const pending = pendingInputRef.current;
      pendingInputRef.current = '';
      if (pending) terminalInput(res.terminalId, pending).catch(() => { /* dropped on disconnect */ });
      log.info('terminal', 'opened', { sessionId, terminalId: res.terminalId, persistent: res.persistent });
    } catch (err) {
      pendingInputRef.current = '';
      terminalIdRef.current = null;
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
      log.warn('terminal', 'open failed', { sessionId, error: String(err) });
    }
  }, [sessionId, slot]);

  const open = useCallback((opts: { reprobe?: boolean } = {}): Promise<void> => {
    if (openingRef.current) return openPromiseRef.current ?? Promise.resolve();
    openingRef.current = true;
    const p = openOnce(opts).finally(() => { openingRef.current = false; openPromiseRef.current = null; });
    openPromiseRef.current = p;
    return p;
  }, [openOnce]);

  // Open when enabled; tear down (detach, keep dtach session) when disabled/unmounted.
  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    void open();
    return () => {
      mountedRef.current = false;
      genRef.current++;
      const id = terminalIdRef.current;
      if (id) {
        terminalClose(id).catch(() => { /* best-effort */ });
      }
      terminalIdRef.current = null;
    };
  }, [enabled, open]);

  // Live output for this terminal, by its key: the server names the events by
  // the terminalId, which is the key (TerminalManager.spawnTerminal).
  useEvent(`terminal:data:${key}`, (data) => {
    const d = data as { data?: string };
    if (typeof d?.data === 'string') onDataRef.current(d.data);
  });

  // pty exit.
  useEvent(`terminal:exit:${key}`, (data) => {
    const d = data as { exitCode?: number; signal?: number | null; ended?: boolean; endedElsewhere?: boolean };
    setStatus('exited');
    onExitRef.current?.(d?.exitCode ?? 0, d?.signal ?? null, d?.endedElsewhere === true ? 'window' : d?.ended === true ? 'other' : null);
    log.info('terminal', 'exited', { sessionId, exitCode: d?.exitCode });
  });

  // On WS reconnect: try cheap attach (pty still alive in grace window);
  // on failure, reopen — server re-attaches the persistent dtach session.
  // An exited terminal stays ended: only Restart starts a new shell.
  useEvent('_ws:reconnected', () => {
    if (!enabled || unconfirmedRef.current || endGuard.busy(genRef.current) || statusRef.current === 'exited') return;
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
    else if (openingRef.current && pendingInputRef.current.length + data.length <= PENDING_INPUT_MAX) pendingInputRef.current += data;
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const id = terminalIdRef.current;
    if (id) terminalResize(id, cols, rows).catch(() => { /* dropped on disconnect */ });
  }, []);

  const kill = useCallback(async (): Promise<boolean> => {
    // An End while the open is still on its way ends the shell that open starts:
    // wait for it, else the shell would start after the End and outlive its pane.
    if (openingRef.current && openPromiseRef.current) await openPromiseRef.current;
    const id = terminalIdRef.current;
    if (!id) return true; // no terminal was open: nothing to end
    const gen = genRef.current;
    if (!endGuard.take(gen)) return false;
    setStatus('ending');
    try {
      const outcome = await awaitEndAnswer(terminalKill(id));
      if (genRef.current !== gen) {
        log.info('terminal', 'end answer dropped: the view closed or reopened', { sessionId, terminalId: id, ended: outcome.ended });
        return false;
      }
      if (outcome.ended) {
        if (terminalIdRef.current === id) terminalIdRef.current = null;
        unconfirmedRef.current = false;
        setEndUnconfirmed(null);
        setStatus('exited');
        return true;
      }
      unconfirmedRef.current = true;
      setEndUnconfirmed(outcome.reason);
      setStatus('end_unconfirmed');
      log.warn('terminal', 'end unconfirmed', { sessionId, terminalId: id, reason: outcome.reason, detail: outcome.detail });
      return false;
    } finally {
      endGuard.release(gen);
    }
  }, [sessionId, endGuard]);

  // Never while an End runs: a reopen then would take that End's answer.
  const retry = useCallback(() => { if (!endGuard.busy(genRef.current)) void open({ reprobe: true }); }, [open, endGuard]);

  return { status, plain, sshFailed, errorMessage, endUnconfirmed, sendInput, sendResize, kill, retry };
}
