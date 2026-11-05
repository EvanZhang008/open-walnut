/**
 * The servers a turn started, as one card at that turn's end in the session's chat
 * (SessionChatHistory places one slot before each turn's first row, and one at the
 * timeline's end). Each slot reads the session's servers from context, so the history
 * tree never re-renders for a scan: a slot with no server in its time window draws nothing.
 *
 * A server belongs to the turn its process started in: started at or after the turn's
 * first row, before the next turn's. The card is the same list as the Web view's and the
 * title row's (SessionServerList), with Open and Stop.
 */
import { createContext, useContext } from 'react';
import type { SessionServer } from '@/api/session-servers';
import type { SessionServersState } from '@/hooks/useSessionServers';
import { SessionServerList } from './SessionServerList';
import { serverStartedAt } from './session-server-label';

export interface SessionServersTurnContextValue {
  servers: SessionServersState;
  activePort: number | null;
  hostLabel: string;
  onOpen: (server: SessionServer) => void;
}

export const SessionServersTurnContext = createContext<SessionServersTurnContextValue | null>(null);

export function SessionServersTurnCard({ fromMs, toMs }: { fromMs: number; toMs: number }) {
  const ctx = useContext(SessionServersTurnContext);
  if (!ctx) return null;
  const now = Date.now();
  const mine = ctx.servers.servers.filter((s) => {
    const at = serverStartedAt(s, now);
    return at !== null && at >= fromMs && at < toMs;
  });
  if (mine.length === 0) return null;
  return (
    <div className="session-servers-turn-card" data-testid="session-servers-turn-card">
      <SessionServerList
        variant="list"
        dense
        title={mine.length === 1 ? 'A server this turn started' : 'Servers this turn started'}
        servers={mine}
        activePort={ctx.activePort}
        stopping={ctx.servers.stopping}
        stopErrors={ctx.servers.stopErrors}
        hostLabel={ctx.hostLabel}
        onOpen={ctx.onOpen}
        onStop={(s) => { void ctx.servers.stop(s); }}
      />
    </div>
  );
}
