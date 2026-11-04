/**
 * The latest few agent uses on the Passwords home (nothing selected): which task used which item,
 * and how (plaintext shown, given to a command, filled into a page). The whole log is Agent Activity.
 */
import { useEffect, useState } from 'react'
import { vaultApi, type AgentLogEntry } from '@/api/vault'
import { ago } from './passwords-model'

const SHOWN = 4
const HOW: Record<string, string> = { reveal: 'showed plaintext', env: 'gave it to a command', fill: 'filled it into a page' }

export function RecentAgentUse({ onSeeAll }: { onSeeAll: () => void }) {
  const [uses, setUses] = useState<AgentLogEntry[] | null>(null)
  useEffect(() => {
    let live = true
    vaultApi.agentLog().then((all) => { if (live) setUses(all.filter((e) => e.kind === 'released' || e.kind === 'fill').slice(0, SHOWN)) }).catch(() => { if (live) setUses([]) })
    return () => { live = false }
  }, [])
  if (!uses?.length) return null
  return (
    <div className="pw-card pw-recent-uses" data-testid="pw-recent-uses">
      <div className="pw-f-label pw-card-label">Recent agent use</div>
      {uses.map((e, i) => (
        <div key={`${e.at}-${i}`} className="pw-agent-row pw-agent-ok" data-testid="pw-recent-use">
          <span className="pw-agent-dot" />
          <span className="pw-agent-text">
            <span><b>{e.taskTitle ?? 'A script'}</b> used <b>{e.itemTitle ?? 'an item'}</b>: {e.use && HOW[e.use] ? HOW[e.use] : e.kind === 'fill' ? HOW.fill : 'got it'}</span>
            {e.purpose && <span className="pw-agent-why">“{e.purpose}”</span>}
          </span>
          <span className="pw-agent-when" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
        </div>
      ))}
      <button type="button" className="pw-btn pw-btn-small" onClick={onSeeAll}>See all in Agent Activity</button>
    </div>
  )
}
